import { Array as Arr, Effect, Stream, String as Str } from "effect"
import { ChildProcess, type ChildProcessSpawner } from "effect/process"
import type { MutantPool } from "#mutate/pool.ts"
import { type Kill, Property } from "#property.ts"
import type { Batch, CaseResult } from "#runner/protocol.ts"

/** A case that passed, as a worker answers it. */
export const passed: CaseResult = {
	decisions: 0,
	sketchDecisions: 0,
	overrun: false,
	notes: [],
	measures: [],
	trace: [],
	outcome: { kind: "passed", kept: { kind: "nothing" }, shown: { kind: "unshown" } },
	millis: 0
}

/** A case whose worker answered it red, with what it printed. */
export const lost = (report: string): CaseResult => ({
	...passed,
	outcome: { kind: "lost", report }
})

/** One case of property `id`, as a search orders it. */
export const oneCase = (id: string, deadline: number): Batch => [
	{
		property: id,
		chooser: { kind: "simplest" },
		drawn: { kind: "unsteered" },
		keep: "nothing",
		sense: { kind: "notes" },
		deadline,
		print: "failing"
	}
]

/**
 * A property whose search is one case under its identity, run on the search's evaluator: red when the case did not
 * pass. A process pool (processPool) runs the case as a process of the property's own check.
 */
export const checkProperty = (kills: ReadonlyArray<Kill>): Property =>
	new Property({
		kind: "explore",
		guide: { kind: "notes" },
		needs: {},
		oracle: { kind: "unstated" },
		kills,
		search: (run) =>
			Effect.map(
				run.evaluator.evaluate([oneCase(run.id, run.limits.deadline)], () => true),
				(results) =>
					Arr.every(Arr.flatten(results), (result) => result.outcome.kind === "passed")
						? { kind: "exhausted", cases: 1, box: "the check", measures: [] }
						: {
								kind: "failed",
								finding: { kind: "lost", phase: "floor", where: run.id, report: "red" }
							}
			),
		keep: () => ({ kind: "unfound", why: "a fixture keeps nothing" }),
		replay: () => Effect.succeed({ kind: "exhausted", cases: 1, box: "the check", measures: [] }),
		evaluate: () => Effect.succeed([])
	})

/**
 * A pool whose workers are processes started from their image, its flags, root and environment: a case of property
 * `<name>` runs `<name>.ts` in the image's root, and passes when it prints green.
 */
export const processPool = Effect.map(
	Effect.context<ChildProcessSpawner.ChildProcessSpawner>(),
	(services): MutantPool<never> => ({
		width: 4,
		lease: (image) =>
			Effect.succeed({
				evaluate: (batches) =>
					Effect.forEach(batches, (batch) =>
						Effect.forEach(batch, (order) =>
							Effect.scoped(
								Effect.gen(function* () {
									const handle = yield* ChildProcess.make(
										process.execPath,
										[...image.execArgv, `${order.property}.ts`],
										{ cwd: image.root, env: image.env, extendEnv: true, stdin: "ignore" }
									)
									const [printed] = yield* Effect.all(
										[
											Stream.mkString(Stream.decodeText(handle.stdout)),
											Stream.runDrain(handle.stderr),
											handle.exitCode
										],
										{ concurrency: "unbounded" }
									)
									return Str.trim(printed) === "green" ? passed : lost(printed)
								})
							).pipe(Effect.orDie, Effect.provideContext(services))
						)
					),
				width: Effect.succeed(1)
			})
	})
)

/** Runs a shell command in `directory` to its end: the fixtures' git setup. */
export const shell = (directory: string, command: string) =>
	Effect.scoped(
		Effect.gen(function* () {
			const handle = yield* ChildProcess.make("sh", ["-c", command], {
				cwd: directory,
				extendEnv: true,
				stdin: "ignore"
			})
			const [, , code] = yield* Effect.all(
				[Stream.runDrain(handle.stdout), Stream.runDrain(handle.stderr), handle.exitCode],
				{ concurrency: "unbounded" }
			)
			return code
		})
	)
