import { Config, Effect, Option, String as Str } from "effect"
import { toolchainTestCache } from "#runner/cache-home.ts"

/**
 * Node's compile cache for a run's processes: V8's compiled code for every module a process loads, kept on disk by
 * Node (module.enableCompileCache, NODE_COMPILE_CACHE), so a process that loads the modules an earlier process loaded
 * compiles none of them again. It is never used by a process that reads V8's coverage (a guided search's workers, a
 * mutation's coverage pass, NODE_V8_COVERAGE set), since Node documents that the cache makes coverage imprecise.
 *
 * Node owns the layout inside the directory it is given: one flat directory per runtime version, one entry per module,
 * named by a CRC of the module's real path (Node checks a hash of its source inside the entry). So an entry is reused
 * only by a later process that loads the same file from the same path, and the one thing a caller chooses is which
 * directory each process gets. Measured on cassowary (2026-11-21, lane COMPILECACHE), loading the runner's module
 * graph: a second run from the same checkout accepted 317 entries and wrote none; the same graph from another checkout
 * (nodeLinker hoisted, so node_modules too is each checkout's own) wrote 238 and accepted 2. One directory shared by
 * every checkout (`toolchain-test/compile`, before this store) therefore held a copy of every module of every checkout
 * and every mutation run's worker trees (whose paths are new each run), millions of entries, and every process
 * creating and renaming its entries in it queued on the one directory's lock (~800 processes in D state, load ~1000).
 *
 * So each root a process loads its modules from (a package root, a repository root) has a directory of its own, in a
 * store sharded by its root's digest (compileCacheIn): no directory of the store holds more than FANOUT entries at its
 * two shard levels, and a root's directory holds that root's modules alone, which later runs of the same root reuse
 * whole. A store is toolchain-test's (sharedStoreDirectory), or a run's own, removed with the run, for roots no later run has (a
 * mutation run's worker trees, mutate/tree.ts).
 */

/** The digits of a shard level: two hex digits of the root's digest, so a level holds at most 256 directories. */
const SHARD_DIGITS = 2

/** The most entries a shard level of a store holds: every value of its digits. */
export const FANOUT = 16 ** SHARD_DIGITS

/**
 * The store of toolchain-test's cache, `${XDG_CACHE_HOME:-~/.cache}/toolchain-test/compile-v2`. Its name is its
 * layout's version: the flat `compile` beside it was the one every checkout shared.
 */
const sharedStoreDirectory = Effect.map(toolchainTestCache, (cache) => `${cache}/compile-v2`)

/**
 * The directory of `root`'s compile cache in `store`: `<store>/<d0d1>/<d2d3>/<d>`, `d` the SHA-256 of the root's path
 * in hex. Two roots never share a directory, and each shard level holds at most FANOUT directories.
 */
export const compileCacheIn = (store: string, root: string): string => {
	const digest = process
		.getBuiltinModule("node:crypto")
		.createHash("sha256")
		.update(root)
		.digest("hex")
	const first = Str.slice(0, SHARD_DIGITS)(digest)
	const second = Str.slice(SHARD_DIGITS, 2 * SHARD_DIGITS)(digest)
	return `${store}/${first}/${second}/${digest}`
}

/** The directory of `root`'s compile cache in toolchain-test's store. */
export const compileCacheOf = (root: string) =>
	Effect.map(sharedStoreDirectory, (store) => compileCacheIn(store, root))

/**
 * Where a pool's workers keep Node's compile cache: toolchain-test's store, whose directory for their root later runs
 * of the root reuse, or a store of the run's own, removed with the run, for a root no later run has (a mutation run's
 * worker tree).
 */
export type CompileStore =
	| Readonly<{ kind: "shared" }>
	| Readonly<{ kind: "run"; directory: string }>

/** toolchain-test's store, as a pool's workers keep their compile cache in it. */
export const sharedStore: CompileStore = { kind: "shared" }

/** The store's directory. */
export const storeDirectory = (store: CompileStore) => {
	switch (store.kind) {
		case "shared":
			return sharedStoreDirectory
		case "run":
			return Effect.succeed(store.directory)
	}
}

/**
 * A child's compile cache, as its environment states it: none (Node's own switch, which also turns off a cache an
 * inherited NODE_COMPILE_CACHE names, the account's among them), or the directory it keeps its entries in, which
 * NODE_DISABLE_COMPILE_CACHE in what the child inherits still turns off.
 */
type CompileCache = Readonly<{ kind: "off" }> | Readonly<{ kind: "at"; directory: string }>

/** What a child's environment adds for its compile cache. */
export const compileEnvOf = (cache: CompileCache): Readonly<Record<string, string>> => {
	switch (cache.kind) {
		case "off":
			return { NODE_DISABLE_COMPILE_CACHE: "1" }
		case "at":
			return { NODE_COMPILE_CACHE: cache.directory }
	}
}

/** Whether this process reads V8's coverage through NODE_V8_COVERAGE. */
export const readsCoverage = Effect.map(
	Config.option(Config.String("NODE_V8_COVERAGE")),
	Option.isSome
)

/**
 * Enables the compile cache of `root` for the rest of this process's loads, unless it reads V8's coverage, and answers
 * the directory Node took, if any (none when NODE_DISABLE_COMPILE_CACHE turns it off).
 */
export const compileCached = (root: string) =>
	Effect.gen(function* () {
		if (yield* readsCoverage) {
			return Option.none<string>()
		}
		const directory = yield* compileCacheOf(root)
		const enabled = yield* Effect.sync(() =>
			process.getBuiltinModule("node:module").enableCompileCache(directory)
		)
		return Option.fromUndefinedOr(enabled.directory)
	})
