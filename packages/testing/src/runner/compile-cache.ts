import { Config, Effect, Option } from "effect"

/**
 * Node's compile cache for a run's processes: V8's compiled code for every module a process loads, kept on disk by
 * Node (module.enableCompileCache, NODE_COMPILE_CACHE) and keyed by the module's content and the runtime's version, so
 * a process that loads the modules an earlier process loaded compiles none of them again. It lives under
 * toolchain-test's cache and is shared by every checkout. It is never used by a process that reads V8's coverage (a
 * guided search's workers, a mutation's coverage pass, NODE_V8_COVERAGE set), since Node documents that the cache makes
 * coverage imprecise.
 */

/** The compile cache's directory: `${XDG_CACHE_HOME:-~/.cache}/toolchain-test/compile`. */
export const compileCacheDirectory = Effect.gen(function* () {
	const home = yield* Config.String("HOME")
	const cacheHome = yield* Config.withDefault(Config.String("XDG_CACHE_HOME"), `${home}/.cache`)
	return `${cacheHome}/toolchain-test/compile`
})

/** Whether this process reads V8's coverage through NODE_V8_COVERAGE. */
export const readsCoverage = Effect.map(
	Config.option(Config.String("NODE_V8_COVERAGE")),
	Option.isSome
)

/** Enables the compile cache for the rest of this process's loads, unless it reads V8's coverage. */
export const compileCached = Effect.gen(function* () {
	if (yield* readsCoverage) {
		return
	}
	const directory = yield* compileCacheDirectory
	yield* Effect.sync(() => process.getBuiltinModule("node:module").enableCompileCache(directory))
})
