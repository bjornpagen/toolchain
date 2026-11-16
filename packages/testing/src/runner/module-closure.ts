import { fileURLToPath } from "node:url"
import { layerDigest } from "@effect/platform-node/NodeCrypto"
import {
	Array as Arr,
	type Context,
	Effect,
	FileSystem,
	Inspectable,
	Layer,
	Option,
	Scope,
	String as Str
} from "effect"
import {
	type ClosureHash,
	closuresOf,
	nativeSyntax,
	repoPathOf,
	workingTree
} from "#runner/closure.ts"
import { ModuleClosure, NeedFailed } from "#runner/services.ts"

/**
 * The runner's ModuleClosure in one process: a module's import-closure hash, as closure.ts computes it for a verdict
 * key, so a need whose identity reads it (a template, by the module that declares it) changes identity exactly when
 * that module or anything it loads changes. The modules resolve under the conditions this process runs with (the
 * runner config's, which every process of a run is started with), over the workspace whose lockfile is nearest above
 * the package root: the checkout's, or a worker tree's, which then hashes the tree's files.
 *
 * The parser starts the first time a hash is asked for, in the process's scope, and each module's hash is kept for the
 * process's life: a run's files do not change under it.
 */

/** The export conditions a process was started with: each `--conditions=<c>`, `--conditions <c>` or `-C <c>`. */
const conditionsOf = (flags: ReadonlyArray<string>): ReadonlyArray<string> =>
	Arr.flatMap(flags, (flag, at) => {
		if (Str.startsWith("--conditions=")(flag)) {
			return [Str.slice("--conditions=".length)(flag)]
		}
		return flag === "--conditions" || flag === "-C" ? Option.toArray(Arr.get(flags, at + 1)) : []
	})

/** The workspace a package root lies in: the nearest directory at or above it holding pnpm-lock.yaml. */
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
 * The ModuleClosure of the package at `root` (a real path), its parser and hashes held in `scope`'s lifetime: the
 * worker's, or an inline search's caller's.
 */
export const moduleClosureAt = (
	root: string
): Effect.Effect<
	Context.Service.Shape<typeof ModuleClosure>,
	never,
	Scope.Scope | FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const scope = yield* Scope.Scope
		const hashing = yield* Effect.cached(
			Scope.provide(scope)(Layer.build(Layer.merge(nativeSyntax, layerDigest)))
		)
		const conditions = conditionsOf(process.execArgv)
		const hashes = new Map<string, Effect.Effect<ClosureHash, NeedFailed>>()
		const failed = (module: string) => (cause: unknown) =>
			NeedFailed.make({
				need: "ModuleClosure",
				message: `the closure of ${module} could not be hashed: ${Inspectable.toStringUnknown(cause)}`
			})
		const hashOf = (module: string): Effect.Effect<ClosureHash, NeedFailed> =>
			Effect.gen(function* () {
				const found = yield* workspaceOf(fs, root)
				const nearest = yield* Effect.mapError(Effect.fromOption(found), () =>
					NeedFailed.make({ need: "ModuleClosure", message: `${root} lies in no pnpm workspace` })
				)
				const workspace = yield* Effect.mapError(fs.realPath(nearest), failed(module))
				const real = yield* Effect.mapError(fs.realPath(fileURLToPath(module)), failed(module))
				const path = yield* Effect.mapError(
					Effect.fromOption(
						Str.startsWith(`${workspace}/`)(real)
							? repoPathOf(Str.slice(workspace.length + 1)(real))
							: Option.none()
					),
					() =>
						NeedFailed.make({
							need: "ModuleClosure",
							message: `${module} lies outside the workspace ${workspace}`
						})
				)
				const services = yield* Effect.mapError(hashing, failed(module))
				const tree = yield* workingTree(workspace)
				const closures = yield* Effect.mapError(
					closuresOf({ tree, conditions, runtime: process.version, roots: [path] }).pipe(
						Effect.provideContext(services)
					),
					failed(module)
				)
				const closure = yield* Effect.mapError(
					Effect.fromOption(Option.fromUndefinedOr(closures.get(path))),
					failed(module)
				)
				return closure.hash
			}).pipe(Effect.provideService(FileSystem.FileSystem, fs))
		return ModuleClosure.of({
			hashOf: (module) =>
				Option.match(Option.fromUndefinedOr(hashes.get(module)), {
					onSome: (held) => held,
					onNone: () =>
						Effect.flatMap(Effect.cached(hashOf(module)), (held) => {
							hashes.set(module, held)
							return held
						})
				})
		})
	})
