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
		(file) => !Arr.some(submodules, (path) => file === path || Str.startsWith(`${path}/`)(file))
	)
	return yield* Effect.filter(Arr.sort(files, Order.String), (file) =>
		fs.exists(file).pipe(Effect.mapError(inspectionFailure(file)))
	)
})
