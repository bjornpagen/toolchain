import { fileURLToPath } from "node:url"
import { layerDigest } from "@effect/platform-node/NodeCrypto"
import { layer as fileSystemLayer } from "@effect/platform-node/NodeFileSystem"
import {
	Array as Arr,
	Context,
	Deferred,
	Effect,
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
import type { Files, RepoPath } from "#runner/closure.ts"
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
 * (an optional peer of the library), are imported then, in this process's scope; each module's hash is kept for the
 * process's life, every request for it after the first awaiting the same computation.
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
): Effect.Effect<Option.Option<string>> =>
	Effect.flatMap(
		Effect.orElseSucceed(fs.exists(`${directory}/pnpm-lock.yaml`), () => false),
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
				const services = yield* Effect.mapError(
					Scope.provide(scope)(Layer.build(Layer.merge(closure.nativeSyntax, layerDigest))),
					(cause) => NeedFailed.make({ need: "ModuleClosure", message: cause.message })
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
				const closures = yield* Effect.mapError(
					closure
						.closuresOf({ tree, conditions, runtime: process.version, roots: [path] })
						.pipe(Effect.provideContext(services)),
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
