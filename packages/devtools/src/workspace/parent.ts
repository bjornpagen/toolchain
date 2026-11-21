import { Array as Arr, Effect, Option, Stream, String as Str } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { DevtoolFailure } from "#shared/devtool.ts"
import { QUARANTINE, type Snapshot } from "#workspace/quarantine.ts"

/** A git command's standard output and exit status, run in a directory. */
const gitIn = (directory: string, args: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		return yield* Effect.scoped(
			Effect.flatMap(
				spawner.spawn(ChildProcess.make("git", [...args], { cwd: directory })),
				(handle) =>
					Effect.all([Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode], {
						concurrency: "unbounded"
					})
			)
		).pipe(
			Effect.mapError((cause) =>
				DevtoolFailure.make({
					detail: `git ${Arr.join(args, " ")} could not run in ${directory}`,
					cause
				})
			)
		)
	})

/** The commit the gate's tree was made from has a parent: the commit it is checked against. */
const PARENT = "HEAD^"

/**
 * The parent commit of the commit the gate checks, as the quarantine reads it: its files, and the text of each
 * quarantine it held. The gate checks a checkout whose HEAD is the commit it lets through (trunk@<repo>'s worktree of
 * the hub's trunk), so the parent is HEAD's first parent; none for a root commit.
 */
export const parentSnapshot = (root: string) =>
	Effect.gen(function* () {
		const [, verified] = yield* gitIn(root, [
			"rev-parse",
			"--verify",
			"--quiet",
			`${PARENT}^{commit}`
		])
		if (verified !== 0) {
			return Option.none<Snapshot>()
		}
		const [listed, listedExit] = yield* gitIn(root, ["ls-tree", "-r", "--name-only", "-z", PARENT])
		if (listedExit !== 0) {
			return yield* DevtoolFailure.make({
				detail: `git ls-tree ${PARENT} exited with ${listedExit} in ${root}`
			})
		}
		const files = Arr.filter(Str.split("\0")(listed), Str.isNonEmpty)
		const quarantines = Arr.filter(
			files,
			(file) => file === QUARANTINE || Str.endsWith(`/${QUARANTINE}`)(file)
		)
		const texts = yield* Effect.forEach(
			quarantines,
			(path) =>
				Effect.flatMap(gitIn(root, ["show", `${PARENT}:${path}`]), ([text, exit]) =>
					exit === 0
						? Effect.succeed([path, text] as const)
						: DevtoolFailure.make({
								detail: `git show ${PARENT}:${path} exited with ${exit} in ${root}`
							})
				),
			{ concurrency: "unbounded" }
		)
		const byPath = new Map(texts)
		return Option.some<Snapshot>({
			files,
			textOf: (path) => Option.fromUndefinedOr(byPath.get(path))
		})
	})
