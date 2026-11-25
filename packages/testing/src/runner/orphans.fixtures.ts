import * as NodeServices from "@effect/platform-node/NodeServices"
import { Array as Arr, Effect, FileSystem, Option, String as Str } from "effect"
import { ChildProcess } from "effect/process"
import { liveSleep } from "#live.ts"
import type { CheckoutDir } from "#mutate/checkout.ts"
import { sharedStore } from "#runner/compile-cache.ts"
import { HARDENED_FLAGS } from "#runner/config.ts"
import { CHILD_FILE } from "#runner/pool.fixtures.ts"
import { placesOf, poolOf } from "#runner/pool.ts"
import { WORKER_ENTRY } from "#runner/run.ts"
import { widthOf } from "#workers.ts"

/**
 * The binding's property (pool.test.ts workersEndWithTheirParent) kills a parent whose worker is held for ever, a
 * program of its own, since it is killed: this module is that program when run, and the support of the property that
 * runs it. The program forks a pool of one worker over the root it is given, its environment naming the file a planted
 * case writes its child's process id to (pool.fixtures.ts CHILD_FILE), queues one case of the property it is given so
 * the pool forks the worker, writes the worker's process id to a file, and waits for ever.
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

/**
 * The program: a pool held over `root` with one case of `held` queued, whose one worker's process id it writes to
 * `pidFile`, then a wait for ever.
 */
const heldAsProgram = (root: string, held: string, pidFile: string, childFile: string) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const pool = yield* poolOf({
				entry: WORKER_ENTRY,
				root,
				cwd: root,
				env: { [CHILD_FILE]: childFile },
				compile: sharedStore,
				places: placesOf(widthOf(1)),
				execArgv: process.execArgv,
				served: Option.none(),
				guide: "notes",
				runs: [],
				stall: 3_600_000,
				bounding: "summed"
			})
			yield* Effect.forkScoped(
				pool.evaluator.evaluate(
					[
						[
							{
								property: held,
								chooser: { kind: "simplest" },
								drawn: { kind: "unsteered" },
								keep: "nothing",
								sense: { kind: "notes" },
								deadline: 3_600_000,
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
 * What a held program is told: the root its pool's worker loads, the property whose one case it runs, the file it
 * writes the worker's process id to, the file the case writes its child's process id to, and whether that case starts
 * a child (runs away with one) or is never reached (its worker held loading).
 */
export type Holding = Readonly<{
	root: string
	held: string
	pidFile: string
	childFile: string
	child: boolean
}>

/** The process ids a file holds once written, none before. */
const writtenIn = (file: string) =>
	Effect.map(
		Effect.flatMap(FileSystem.FileSystem, (fs) =>
			Effect.orElseSucceed(fs.readFileString(file), () => "")
		),
		(written) => Option.filter(Option.some(Str.trim(written)), Str.isNonEmpty)
	)

/**
 * The program started from `program` as `holding` says: the program's own process id and every process its pool's
 * worker holds (the worker, and the child its case started when it starts one), once their files hold them, however
 * long its start takes: no clock decides, as one did (half a case deadline, which a start under load outran), and a
 * program that never writes them holds its case, whose guard reports it hung.
 */
export const heldProgram = (program: string, holding: Holding) =>
	Effect.gen(function* () {
		const handle = yield* ChildProcess.make(
			process.execPath,
			[...HARDENED_FLAGS, program, holding.root, holding.held, holding.pidFile, holding.childFile],
			{ stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: false }
		)
		for (;;) {
			const worker = yield* writtenIn(holding.pidFile)
			const child = holding.child ? yield* writtenIn(holding.childFile) : Option.some("")
			if (Option.isSome(worker) && Option.isSome(child)) {
				return {
					program: Number(handle.pid),
					held: Arr.map(Arr.filter([worker.value, child.value], Str.isNonEmpty), Number)
				}
			}
			yield* liveSleep("50 millis")
		}
	})

if (import.meta.main) {
	const [root, held, pidFile, childFile] = process.argv.slice(2)
	if (
		root !== undefined &&
		held !== undefined &&
		pidFile !== undefined &&
		childFile !== undefined
	) {
		await Effect.runPromise(
			heldAsProgram(root, held, pidFile, childFile).pipe(Effect.provide(NodeServices.layer))
		)
	}
}
