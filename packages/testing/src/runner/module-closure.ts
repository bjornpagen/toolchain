import { fileURLToPath } from "node:url"
import { layerDigest } from "@effect/platform-node/NodeCrypto"
import { layer as fileSystemLayer } from "@effect/platform-node/NodeFileSystem"
import {
	Array as Arr,
	Context,
	Deferred,
	Effect,
	Exit,
	FileSystem,
	Inspectable,
	Layer,
	Option,
	Predicate,
	Scope,
	String as Str
} from "effect"
import type { MutatedFile } from "#mutate/mutated.ts"
import type { ClosureHash } from "#runner/closure-hash.ts"
import type { Files, RepoPath, Walk } from "#runner/closure.ts"
import { ModuleClosure, NeedFailed } from "#runner/services.ts"

/**
 * ModuleClosure computed in this process: a module's import-closure hash, as closure.ts computes it for a verdict key,
 * over the files as the workers it answers load them, so a need whose identity reads it (a template, by the module that
 * declares it) changes identity exactly when that module or anything it loads changes, a mutant's text included. The
 * pool's parent holds one for the pool's root and the mutant its workers serve (runner/pool.ts PoolSpec served), and
 * answers every worker's request from it (runner/closure-requests.ts), so a run hashes each module once, not once a
 * worker; an inline search holds its own. The modules resolve under the conditions this process runs with (the runner
 * config's, which every process of a run is started with), over the workspace whose lockfile is nearest above the root:
 * the checkout's, or a worker tree's.
 *
 * Nothing here loads the compiler until a hash is first asked for: closure.ts, and TypeScript's native parser with it
 * (an optional peer of the library), are imported then; the parser is the process's (syntax.ts, read through closure.ts moduleSyntax), shared
 * by every pool, so a module's text is parsed once a process whichever mutant a pool serves. A module's walk is the
 * process's too (`sharedWalk`): a pool reads every file the walk read, and where only modules' bytes differ, its served
 * mutant's or a worker tree's, and each loads what it did, hashes the walk with those bytes (closure.ts walkHolds)
 * without resolving a specifier; only a file it read that changed otherwise, or a module that loads other specifiers,
 * walks the pool's tree again. Each module's hash is kept for the ModuleClosure's life, every request for it after the
 * first awaiting the same computation.
 */

/** The export conditions a process was started with: each `--conditions=<c>`, `--conditions <c>` or `-C <c>`. */
const conditionsOf = (flags: ReadonlyArray<string>): ReadonlyArray<string> =>
	Arr.flatMap(flags, (flag, at) => {
		if (Str.startsWith("--conditions=")(flag)) {
			return [Str.slice("--conditions=".length)(flag)]
		}
		return flag === "--conditions" || flag === "-C" ? Option.toArray(Arr.get(flags, at + 1)) : []
	})

/** The workspace a directory lies in: the nearest directory at or above it holding pnpm-lock.yaml. */
const workspaceOf = (
	fs: FileSystem.FileSystem,
	directory: string
): Effect.Effect<Option.Option<string>, NeedFailed> =>
	Effect.flatMap(
		Effect.mapError(fs.exists(`${directory}/pnpm-lock.yaml`), (error) =>
			NeedFailed.make({ need: "ModuleClosure", message: error.message })
		),
		(found) => {
			if (found) {
				return Effect.succeedSome(directory)
			}
			const parent = Arr.join(Arr.initNonEmpty(Str.split("/")(directory)), "/")
			return Str.isNonEmpty(parent) ? workspaceOf(fs, parent) : Effect.succeedNone
		}
	)

/**
 * The files of the workspace at `workspace` as a worker serving `served` loads them: the working tree's, but the served
 * mutant's file, which holds the mutant's text (mutate/hook.ts serves it so), by its path from the workspace (`pathOf`,
 * closure.ts repoPathOf). A mutant outside the workspace is in no closure: a closure hashes an external package by its
 * lockfile entry, never by its files.
 */
const loadedFiles = (
	tree: Files,
	workspace: string,
	served: Option.Option<MutatedFile>,
	pathOf: (relative: string) => Option.Option<RepoPath>
): Files =>
	Option.match(
		Option.flatMap(served, (mutant) =>
			Option.map(
				Option.flatMap(
					Option.liftPredicate(mutant.target, Str.startsWith(`${workspace}/`)),
					(target) => pathOf(Str.slice(workspace.length + 1)(target))
				),
				(path) => ({ path, bytes: new TextEncoder().encode(mutant.text) })
			)
		),
		{
			onNone: () => tree,
			onSome: (replaced) => ({
				read: (path) =>
					path === replaced.path ? Effect.succeedSome(replaced.bytes) : tree.read(path)
			})
		}
	)

declare global {
	var bjornpagenTestingWalks: Map<string, Deferred.Deferred<Walk, NeedFailed>> | undefined
}

/**
 * This process's walk of a module (closure.ts Walk), by its workspace, its path and the conditions it resolves under:
 * the first pool to ask walks it, detached from that pool's scope, which may close before the walk ends, and every
 * pool after it reads that walk, as it holds over its own tree (closure.ts walkHolds). A walk that fails is forgotten,
 * so the next pool to ask walks again.
 */
const sharedWalk = (key: string, walk: Effect.Effect<Walk, NeedFailed>) =>
	Effect.suspend(() => {
		globalThis.bjornpagenTestingWalks ??= new Map()
		const walks = globalThis.bjornpagenTestingWalks
		const held = walks.get(key)
		if (held !== undefined) {
			return Deferred.await(held)
		}
		const made = Deferred.makeUnsafe<Walk, NeedFailed>()
		walks.set(key, made)
		return Effect.andThen(
			Effect.forkDetach(
				Effect.onExit(walk, (exit) =>
					Effect.andThen(
						Effect.sync(() => {
							if (Exit.isFailure(exit)) {
								walks.delete(key)
							}
						}),
						Deferred.done(made, exit)
					)
				)
			),
			Deferred.await(made)
		)
	})

/**
 * The ModuleClosure of the package at `root` as its workers load it, serving `served` (mutate/pool.ts Served) or no
 * mutant, its compiler and hashes held in the enclosing scope's lifetime: the pool's, or an inline search's caller's.
 */
export const moduleClosureAt = (
	root: string,
	served: Option.Option<MutatedFile>
): Effect.Effect<Context.Service.Shape<typeof ModuleClosure>, never, Scope.Scope> =>
	Effect.gen(function* () {
		const scope = yield* Scope.Scope
		const platform = yield* Layer.build(fileSystemLayer)
		const fs = Context.get(platform, FileSystem.FileSystem)
		const failed = (module: string) => (cause: unknown) =>
			NeedFailed.make({
				need: "ModuleClosure",
				message: `the closure of ${module} could not be hashed: ${Inspectable.toStringUnknown(cause)}`
			})
		const compiler = yield* Effect.cached(
			Effect.gen(function* () {
				const closure = yield* Effect.tryPromise({
					try: () => import("#runner/closure.ts"),
					catch: (cause) =>
						NeedFailed.make({
							need: "ModuleClosure",
							message: `the closure hasher did not load (TypeScript 7, an optional peer, must be installed): ${Predicate.isError(cause) ? cause.message : Inspectable.toStringUnknown(cause)}`
						})
				})
				const services = yield* Scope.provide(scope)(
					Layer.build(Layer.merge(closure.moduleSyntax, layerDigest))
				)
				return { closure, services }
			})
		)
		const conditions = conditionsOf(process.execArgv)
		const hashOf = (module: string): Effect.Effect<ClosureHash, NeedFailed> =>
			Effect.gen(function* () {
				const { closure, services } = yield* compiler
				const found = yield* workspaceOf(fs, root)
				const nearest = yield* Effect.mapError(Effect.fromOption(found), () =>
					NeedFailed.make({ need: "ModuleClosure", message: `${root} lies in no pnpm workspace` })
				)
				const workspace = yield* Effect.mapError(fs.realPath(nearest), failed(module))
				const real = yield* Effect.mapError(fs.realPath(fileURLToPath(module)), failed(module))
				const path = yield* Effect.mapError(
					Effect.fromOption(
						Str.startsWith(`${workspace}/`)(real)
							? closure.repoPathOf(Str.slice(workspace.length + 1)(real))
							: Option.none()
					),
					() =>
						NeedFailed.make({
							need: "ModuleClosure",
							message: `${module} lies outside the workspace ${workspace}`
						})
				)
				const working = yield* closure
					.workingTree(workspace)
					.pipe(Effect.provideService(FileSystem.FileSystem, fs))
				const tree = loadedFiles(working, workspace, served, closure.repoPathOf)
				const walkOf = Effect.mapError(
					closure
						.walkOf({ tree, conditions, runtime: process.version, roots: [path] })
						.pipe(Effect.provideContext(services)),
					failed(module)
				)
				const shared = yield* sharedWalk(
					Arr.join([workspace, path, ...conditions], "\u0000"),
					walkOf
				)
				const held = yield* Effect.mapError(
					closure.walkHolds(shared, tree).pipe(Effect.provideContext(services)),
					failed(module)
				)
				const walk = yield* Option.match(held, { onSome: Effect.succeed, onNone: () => walkOf })
				const closures = yield* Effect.mapError(
					closure.closuresOfWalk(walk).pipe(Effect.provideContext(services)),
					failed(module)
				)
				const hashed = yield* Effect.mapError(
					Effect.fromOption(Option.fromUndefinedOr(closures.get(path))),
					failed(module)
				)
				return hashed.hash
			})
		const hashes = new Map<string, Deferred.Deferred<ClosureHash, NeedFailed>>()
		return ModuleClosure.of({
			root,
			hashOf: (module) =>
				Effect.suspend(() => {
					const held = hashes.get(module)
					if (held !== undefined) {
						return Deferred.await(held)
					}
					const made = Deferred.makeUnsafe<ClosureHash, NeedFailed>()
					hashes.set(module, made)
					return Effect.andThen(
						Effect.onExit(hashOf(module), (exit) => Deferred.done(made, exit)),
						Deferred.await(made)
					)
				})
		})
	})
