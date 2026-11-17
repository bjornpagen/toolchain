import * as NodeServices from "@effect/platform-node/NodeServices"
import { Array as Arr, Effect, FileSystem, Option, String as Str } from "effect"
import { ChildProcess } from "effect/process"
import { liveMillis, liveSleep } from "#live.ts"
import type { CheckoutDir } from "#mutate/checkout.ts"
import { HARDENED_FLAGS } from "#runner/config.ts"
import { placesOf, poolOf } from "#runner/pool.ts"
import { WORKER_ENTRY } from "#runner/run.ts"

/**
 * The orphan guard's property (pool.test.ts workersOutliveNoParent) kills a parent whose worker is held for ever, a
 * program of its own, since it is killed: this module is that program when run, and the support of the property that
 * runs it. The program forks a pool of one worker over the root it is given (a runner config whose load never ends,
 * pool.fixtures.ts unreadyRoot), queues
 * one unit so the pool forks it, writes the worker's process id to a file, and waits for ever.
 */

/** The program's path in a checkout of the testing package. */
export const orphansProgram = (checkout: CheckoutDir): string =>
	`${checkout}/src/runner/orphans.fixtures.ts`

/** This process's children's process ids, as Linux lists them for its main thread. */
const children = Effect.map(
	Effect.flatMap(FileSystem.FileSystem, (fs) =>
		Effect.orElseSucceed(fs.readFileString(`/proc/self/task/${process.pid}/children`), () => "")
	),
	(listed) => Arr.filter(Str.split(" ")(Str.trim(listed)), Str.isNonEmpty)
)

/** The program: a pool held over `root` whose one worker's process id it writes to `pidFile`, then a wait for ever. */
const heldAsProgram = (root: string, pidFile: string) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const pool = yield* poolOf({
				entry: WORKER_ENTRY,
				root,
				cwd: root,
				env: {},
				places: placesOf(1),
				execArgv: process.execArgv,
				served: Option.none(),
				guide: "notes",
				open: 3_600_000
			})
			yield* Effect.forkScoped(
				pool.evaluator.evaluate(
					[
						[
							{
								property: "src/runner/loops.fixtures.ts#withoutNeeds",
								chooser: { kind: "simplest" },
								drawn: { kind: "unsteered" },
								keep: "nothing",
								sense: { kind: "notes" },
								deadline: 3_600_000,
								open: 3_600_000,
								print: "failing"
							}
						]
					],
					() => true
				)
			)
			for (;;) {
				const forked = yield* children
				if (Arr.isReadonlyArrayNonEmpty(forked)) {
					yield* fs.writeFileString(pidFile, Arr.headNonEmpty(forked))
					return yield* Effect.never
				}
				yield* liveSleep("20 millis")
			}
		})
	)

/**
 * The program started from `program` over `root`, writing its worker's process id to `pidFile`: the program's own
 * process id once the file holds the worker's, within `within` milliseconds, or none.
 */
export const heldProgram = (program: string, root: string, pidFile: string, within: number) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const handle = yield* ChildProcess.make(
			process.execPath,
			[...HARDENED_FLAGS, program, root, pidFile],
			{ stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: false }
		)
		const began = yield* liveMillis
		for (;;) {
			const written = yield* Effect.orElseSucceed(fs.readFileString(pidFile), () => "")
			if (Str.isNonEmpty(Str.trim(written))) {
				return Option.some({ program: Number(handle.pid), worker: Number(Str.trim(written)) })
			}
			if ((yield* liveMillis) - began >= within) {
				return Option.none<Readonly<{ program: number; worker: number }>>()
			}
			yield* liveSleep("50 millis")
		}
	})

if (import.meta.main) {
	const [root, pidFile] = process.argv.slice(2)
	if (root !== undefined && pidFile !== undefined) {
		await Effect.runPromise(heldAsProgram(root, pidFile).pipe(Effect.provide(NodeServices.layer)))
	}
}
