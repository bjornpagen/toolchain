import { Array as Arr, Cause, type Context, Effect, Option, Schema } from "effect"
import { failureText } from "#failure.ts"
import type { RunNeed, RunNeedContext } from "#property.ts"
import { judgedGroup } from "#runner/opening.ts"
import type { RunValue } from "#runner/protocol.ts"
import { NeedFailed, type RunValues } from "#runner/services.ts"

/**
 * A run's run needs (property.ts RunNeed): opened ONCE, in the runner's own process, before it forks a worker of the
 * run, and their values sent to every worker it forks as data (runner/pool.ts PoolSpec runs), so no worker builds what
 * they make or waits on another that does. A run opens those its properties read (property.ts runNeedsOf); a kill
 * trial's lease opens its properties' in the image it runs, before the lease's workers start.
 */

/**
 * One run need opened here, its value encoded by its schema as JSON: what crosses to the workers, or why it did not
 * open or encode.
 */
const openedOne = (
	run: RunNeed<unknown>,
	directory: string,
	within: <A, R>(
		key: string,
		open: Effect.Effect<A, NeedFailed, R>
	) => Effect.Effect<A, NeedFailed, R>
): Effect.Effect<RunValue, never, RunNeedContext> =>
	Effect.match(
		Effect.catchCauseIf(
			within(
				run.key,
				Effect.flatMap(run.open(directory), (value) =>
					Effect.mapError(Schema.encodeEffect(run.value)(value), (error) =>
						NeedFailed.make({
							need: run.key,
							message: `its value does not encode as its schema states: ${error.message}`
						})
					)
				)
			),
			(cause) => !Cause.hasInterruptsOnly(cause),
			(cause) =>
				Effect.fail(
					Option.getOrElse(Cause.findErrorOption(cause), () =>
						NeedFailed.make({ need: run.key, message: failureText(cause) })
					)
				)
		),
		{
			onFailure: (failed): RunValue => ({ kind: "failed", key: run.key, message: failed.message }),
			onSuccess: (value): RunValue => ({ kind: "opened", key: run.key, value })
		}
	)

/**
 * Opens `runs` here, each key once and all at once, given `directory`, the directory the run's workers run in: judged
 * as one group of work under their budgets summed and `stall`, the stall window (runner/opening.ts judgedGroup), in the
 * caller's scope, which holds what they make until the run's pools have closed. Each gives its value's JSON encoding, or
 * the NeedFailed it failed with, which every need reading it fails with on every worker, unopened: a run need that does
 * not open fails the properties that read it, never the run.
 */
export const openedRuns = (
	runs: ReadonlyArray<RunNeed<unknown>>,
	directory: string,
	stall: number
): Effect.Effect<ReadonlyArray<RunValue>, never, RunNeedContext> =>
	Arr.match(
		Arr.dedupeWith(runs, (one, other) => one.key === other.key),
		{
			onEmpty: () => Effect.succeed([]),
			onNonEmpty: (distinct) =>
				Effect.flatMap(judgedGroup(distinct, stall), (judged) =>
					Effect.ensuring(
						Effect.forEach(distinct, (run) => openedOne(run, directory, judged.within), {
							concurrency: "unbounded"
						}),
						judged.ended
					)
				)
		}
	)

/**
 * The run need values a process was sent, as its needs read them (RunValues): each key's JSON value, or the NeedFailed
 * it failed with in the runner's process; a key with no value fails, naming it, since only a need that declares its run
 * need (Need.overRun) has the runner open it.
 */
export const runValuesOf = (
	values: ReadonlyArray<RunValue>
): Context.Service.Shape<typeof RunValues> => {
	const byKey = new Map(Arr.map(values, (value) => [value.key, value] as const))
	return {
		encoded: (key) =>
			Option.match(Option.fromUndefinedOr(byKey.get(key)), {
				onNone: () =>
					Effect.fail(
						NeedFailed.make({
							need: key,
							message:
								"no value of this run need was sent: a need reads a run need only through Need.overRun, which declares it, so the runner opens it before its workers start"
						})
					),
				onSome: (value) => {
					switch (value.kind) {
						case "opened":
							return Effect.succeed(value.value)
						case "failed":
							return Effect.fail(
								NeedFailed.make({
									need: key,
									message: `it did not open in the runner's process: ${value.message}`
								})
							)
					}
				}
			})
	}
}
