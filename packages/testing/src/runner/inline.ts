import { Array as Arr, Context, Effect, Option, type Scope } from "effect"
import type { NeedContext, Property } from "#property.ts"
import { LateUses, NeedCache, needCacheOf, Stopped, stoppedOf, withLateUses } from "#runner/case.ts"
import { type Limits, runnerLimits } from "#runner/limits.ts"
import { Perception, perceptionOf } from "#runner/perceive.ts"
import type {
	Batch,
	CaseOrder,
	CaseResult,
	Evaluator,
	Printed,
	Reach,
	Verdict
} from "#runner/protocol.ts"
import { WorkerIndex } from "#runner/services.ts"

/** What a search run in this process needs from its caller: every need's context but the worker index, which is 0. */
type InlineContext = Exclude<NeedContext, WorkerIndex>

/**
 * The evaluator of one property in this process: each batch evaluated in turn, here, with the needs it takes opened in
 * the caller's scope and services. A meta-test of the library's own searches, and a search nested inside a case, run
 * on it: a search finds on it exactly what it finds on the pool.
 */
export const inlineEvaluator = (
	property: Property
): Effect.Effect<Evaluator, never, Scope.Scope | InlineContext> =>
	Effect.gen(function* () {
		const caller = yield* Effect.context<InlineContext | Scope.Scope>()
		const context = Context.add(caller, WorkerIndex, { index: 0, workers: 1 })
		const perception = yield* perceptionOf
		const cache = needCacheOf(Effect.succeed(context))
		const lateUses = new Map<CaseOrder, Printed>()
		const stopped = stoppedOf()
		const evaluateOne = (batch: Batch) =>
			property.evaluate(batch).pipe(
				Effect.provideService(NeedCache, cache),
				Effect.provideService(Perception, perception),
				Effect.provideService(Stopped, stopped),
				Effect.provideService(LateUses, {
					report: (order, printed) => {
						lateUses.set(order, printed)
					}
				}),
				Effect.provideContext(context)
			)
		const evaluator: Evaluator = {
			evaluate: (batches, stop) =>
				Effect.gen(function* () {
					const results: Array<ReadonlyArray<CaseResult>> = []
					const judged = () =>
						withLateUses(
							results,
							(batchAt, at) =>
								Option.flatMap(
									Option.flatMap(Arr.get(batches, batchAt), (batch) => Arr.get(batch, at)),
									(order) => Option.fromUndefinedOr(lateUses.get(order))
								),
							stop
						)
					for (const batch of batches) {
						const evaluated = yield* evaluateOne(batch)
						yield* stopped.drained
						results.push(evaluated)
						if (Arr.some(evaluated, stop)) {
							return judged()
						}
					}
					return judged()
				}),
			width: Effect.succeed(1)
		}
		return evaluator
	})

/** How a search run in this process is identified and bounded: its identity, run seed, reach and limits. */
export type InlineRun = Readonly<{ id: string; seed: number; reach: Reach; limits: Limits }>

/** The runner's own limits for a search run inline, with this identity and run seed, every phase run. */
export const inlineRun = (id: string, seed: number): InlineRun => ({
	id,
	seed,
	reach: "full",
	limits: runnerLimits
})

/**
 * Runs one property's search in this process (inlineEvaluator) and gives its verdict: a meta-test states the property
 * it searches as a value, runs it here, and judges the verdict, a finding included, as data.
 */
export const searchInline = (
	property: Property,
	run: InlineRun
): Effect.Effect<Verdict, never, Scope.Scope | InlineContext> =>
	Effect.flatMap(inlineEvaluator(property), (evaluator) => property.search({ ...run, evaluator }))

/** Replays one token of a property in this process, as `toolchain-test replay` does on the pool. */
export const replayInline = (
	property: Property,
	run: InlineRun,
	token: string
): Effect.Effect<Verdict, never, Scope.Scope | InlineContext> =>
	Effect.flatMap(inlineEvaluator(property), (evaluator) =>
		property.replay({ ...run, evaluator }, token)
	)
