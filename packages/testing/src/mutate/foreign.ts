import { Array as Arr, type Context, Effect, Stream, String as Str } from "effect"
import { ChildProcess, type ChildProcessSpawner } from "effect/process"
import type { MutantPool } from "#mutate/pool.ts"
import type { Subject } from "#mutate/schedule.ts"
import { Property, PropertyId } from "#property.ts"
import { runnerLimits } from "#runner/limits.ts"
import { type Batch, type CaseResult, lostOtherwise } from "#runner/protocol.ts"
import { testWorkers } from "#workers.ts"

/**
 * A foreign test command (Bjorn's ruling through grizzle main, 2026-11-19: judge a test where it is, never convert it
 * before its verdict): a test module another runner runs, a Vitest file among them, judged by the census as a witness
 * of its own. Its witness is the command run whole with the module's path appended, in the package's directory of a
 * fresh image, a worker tree for a mutant (so the other runner reads the mutant from disk, as it reads every file) and
 * the checkout for its coverage pass (NODE_V8_COVERAGE, which every process the command starts inherits): green when the
 * command exits 0, red otherwise. It states no kill and no kept case, so only an operator mutant shows it caught a bug,
 * and a module red with no mutant is unjudged, as any property is.
 */

/** A foreign test command: its argument vector, run from `directory` (a path from the checkout's root). */
export type Foreign = Readonly<{ argv: Arr.NonEmptyReadonlyArray<string>; directory: string }>

/** A case that passed or was lost, as a worker would answer it. */
const answered = (green: boolean, report: string): CaseResult => ({
	drew: { kind: "complete", decisions: 0 },
	notes: [],
	measures: [],
	trace: [],
	outcome: green
		? { kind: "passed", kept: { kind: "nothing" }, shown: { kind: "unshown" } }
		: { kind: "lost", by: lostOtherwise, report },
	millis: 0,
	cpu: 0
})

/** One case of property `id`, as its search orders it: the module's one run. */
const oneRun = (id: string): Batch => [
	{
		property: id,
		chooser: { kind: "simplest" },
		drawn: { kind: "unsteered" },
		keep: "nothing",
		sense: { kind: "notes" },
		deadline: runnerLimits.deadline,
		print: "failing"
	}
]

/**
 * A module of a foreign command as the census judges it: a subject whose search is the module's one run on the search's
 * evaluator (foreignPool's), red when it did not pass, loaded from a worker tree.
 */
export const foreignSubject = (module: string): Subject => ({
	id: PropertyId(module),
	loading: "tree",
	property: new Property({
		kind: "explore",
		guide: { kind: "notes" },
		needs: {},
		oracle: { kind: "unstated" },
		kept: [],
		kills: [],
		search: (run) =>
			Effect.map(
				run.evaluator.evaluate([oneRun(run.id)], () => true),
				(results) =>
					Arr.every(Arr.flatten(results), (result) => result.outcome.kind === "passed")
						? { kind: "exhausted", cases: 1, box: "the module's run", measures: [] }
						: {
								kind: "failed",
								finding: {
									kind: "lost",
									phase: "floor",
									where: run.id,
									by: lostOtherwise,
									report: "red"
								}
							}
			),
		keep: () => ({ kind: "unfound", why: "a foreign module keeps nothing" }),
		replay: () =>
			Effect.succeed({ kind: "exhausted", cases: 1, box: "the module's run", measures: [] }),
		translate: () =>
			Effect.succeed({ kind: "untranslated", why: "a foreign module keeps no token" }),
		ready: Effect.succeed({
			cases: () => Effect.succeed([]),
			series: () =>
				Effect.succeed({
					ran: 0,
					passed: 0,
					notes: [],
					measures: [],
					millis: 0,
					cpu: 0,
					stopped: { kind: "none" }
				} as const),
			count: () => Effect.succeed({ kind: "uncountable" } as const)
		})
	})
})

/**
 * The pool a foreign command's modules are judged on, the machine's width: a lease's evaluator runs each case's module
 * as the command with the module's path appended, in the command's directory of the lease's image, with the image's
 * environment (its coverage directory), green when it exits 0.
 */
export const foreignPool = (
	foreign: Foreign,
	services: Context.Context<ChildProcessSpawner.ChildProcessSpawner>
): MutantPool<never> => ({
	width: testWorkers,
	lease: (image) =>
		Effect.succeed({
			series: () => Effect.succeed([]),
			count: () => Effect.succeed({ kind: "uncountable" } as const),
			evaluate: (batches) =>
				Effect.forEach(batches, (batch) =>
					Effect.forEach(batch, (order) =>
						Effect.scoped(
							Effect.gen(function* () {
								const [command, ...rest] = foreign.argv
								const handle = yield* ChildProcess.make(command, [...rest, order.property], {
									cwd: `${image.root}/${foreign.directory}`,
									env: image.env,
									extendEnv: true,
									stdin: "ignore"
								})
								const [printed, , code] = yield* Effect.all(
									[
										Stream.mkString(Stream.decodeText(handle.stdout)),
										Stream.runDrain(handle.stderr),
										handle.exitCode
									],
									{ concurrency: "unbounded" }
								)
								return answered(code === 0, Str.slice(-2000)(printed))
							})
						).pipe(
							Effect.provideContext(services),
							Effect.catch((cause) => Effect.succeed(answered(false, String(cause))))
						)
					)
				),
			width: Effect.succeed(1),
			workers: 1
		})
})
