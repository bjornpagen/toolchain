import { Array as Arr, Effect, FileSystem, Order, Stream, String as Str } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { DevtoolFailure } from "#shared/devtool.ts"

const inspectionFailure = (subject: string) => (cause: unknown) =>
	DevtoolFailure.make({ detail: `${subject} could not be read`, cause })

/**
 * The paths .gitmodules under a directory names: each holds another repository's files, not this one's. A directory
 * with no .gitmodules has none.
 */
const submodulePathsUnder = Effect.fn("submodulePathsUnder")(function* (directory: string) {
	const fs = yield* FileSystem.FileSystem
	const manifest = `${directory}/.gitmodules`
	const present = yield* fs.exists(manifest).pipe(Effect.mapError(inspectionFailure(manifest)))
	if (!present) {
		return []
	}
	const text = yield* fs.readFileString(manifest).pipe(Effect.mapError(inspectionFailure(manifest)))
	return Arr.flatMap(Str.split("\n")(text), (line) => {
		const [key, ...value] = Str.split("=")(line)
		return Str.trim(key) === "path" && value.length > 0
			? [`${directory}/${Str.trim(Arr.join(value, "="))}`]
			: []
	})
})

/** Whether a file is a submodule's, one of `submodules` (absolute paths) or under one. */
const inSubmodule =
	(submodules: ReadonlyArray<string>) =>
	(file: string): boolean =>
		Arr.some(submodules, (path) => file === path || Str.startsWith(`${path}/`)(file))

/**
 * The files git shows under a directory, tracked or untracked but not ignored, that still exist, in path order, leaving
 * out each submodule's files. A working tree lists a submodule as its one gitlink, but the gate's snapshot (a fresh git
 * repository with each submodule filled in as plain files) would list every file in it as untracked, so a check reading
 * this list would judge another repository's files in the snapshot and not in the tree. Leaving the submodule's paths
 * out makes the two lists the same.
 */
export const gitFilesUnder = Effect.fn("gitFilesUnder")(function* (directory: string) {
	const fs = yield* FileSystem.FileSystem
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const command = ChildProcess.make(
		"git",
		["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
		{ cwd: directory }
	)
	const [output, exitCode] = yield* Effect.scoped(
		Effect.flatMap(spawner.spawn(command), (handle) =>
			Effect.all([Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode], {
				concurrency: "unbounded"
			})
		)
	).pipe(Effect.mapError(inspectionFailure(`The git file list of ${directory}`)))
	if (exitCode !== 0) {
		return yield* DevtoolFailure.make({
			detail: `git ls-files exited with ${exitCode} in ${directory}`
		})
	}
	const submodules = yield* submodulePathsUnder(directory)
	const files = Arr.filter(
		Arr.map(
			Arr.filter(Str.split("\0")(output), Str.isNonEmpty),
			(relative) => `${directory}/${relative}`
		),
		(file) => !inSubmodule(submodules)(file)
	)
	return yield* Effect.filter(Arr.sort(files, Order.String), (file) =>
		fs.exists(file).pipe(Effect.mapError(inspectionFailure(file)))
	)
})

/**
 * The files the repository-relative paths `named` (style/paths.ts) name inside a submodule of `directory` that exist on
 * disk, in path order: a check may read such a file as an input, an option naming a source of another repository the
 * root holds as a submodule (edullm's qti-app style options name plate's vocabulary under packages/qti-pie), though it
 * never lists, lints or reports a submodule's files (gitFilesUnder). The gate's snapshot fills every submodule, so the
 * file is there in a snapshot as in the working tree. A path that names a directory (ending in `/`) names no input: an
 * input is one file.
 */
export const submoduleInputsUnder = Effect.fn("submoduleInputsUnder")(function* (
	directory: string,
	named: ReadonlyArray<string>
) {
	const fs = yield* FileSystem.FileSystem
	const submodules = yield* submodulePathsUnder(directory)
	const candidates = Arr.dedupe(
		Arr.filter(
			Arr.map(
				Arr.filter(named, (path) => !Str.endsWith("/")(path)),
				(path) => `${directory}/${path}`
			),
			inSubmodule(submodules)
		)
	)
	return yield* Effect.filter(Arr.sort(candidates, Order.String), (file) =>
		fs.exists(file).pipe(Effect.mapError(inspectionFailure(file)))
	)
})

/**
 * The packages of `packages` (absolute roots) that are the repository at `directory`'s own: every one but those at or
 * under a submodule .gitmodules lists, which hold another repository's packages (a vendored toolchain, edullm's
 * qti-pie, and whatever that repository vendors in turn, which lies under it), so no check of this repository judges
 * them. A vendored directory is one case of this: every repository vendors by submodule.
 */
export const ownPackagesUnder = Effect.fn("ownPackagesUnder")(function* (
	directory: string,
	packages: ReadonlyArray<string>
) {
	const submodules = yield* submodulePathsUnder(directory)
	return Arr.filter(packages, (root) => !inSubmodule(submodules)(root))
})
