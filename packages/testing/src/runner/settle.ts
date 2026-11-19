import { Effect, Inspectable, Predicate, Result, Schema } from "effect"
import { type RunOutcome, unjudgeable } from "#runner/run.ts"

/** The closure hasher did not load: TypeScript 7, an optional peer of the library, is not installed. */
class HasherUnloaded extends Schema.TaggedError<
	HasherUnloaded,
	{ readonly brand: unique symbol }
>()("HasherUnloaded", { message: Schema.String }) {}

/**
 * The verdict cache's module (affected.ts, with closure.ts), which loads TypeScript's native compiler, an optional peer
 * of the library: only what uses it loads it, so `run` starts without TypeScript installed.
 */
export const affectedModule = Effect.tryPromise({
	try: () => import("#runner/affected.ts"),
	catch: (cause) =>
		HasherUnloaded.make({
			message: `the closure hasher did not load (TypeScript 7, an optional peer, must be installed): ${Predicate.isError(cause) ? cause.message : Inspectable.toStringUnknown(cause)}`
		})
})

/**
 * What `toolchain-test run` settles to once its searches ran (`outcome`): its kills judged and its verdicts recorded
 * (affected.ts recordedRun), or, where the closure hasher does not load, no kill judged, each failing its property for
 * that (run.ts unjudgeable).
 */
export const settledRun = (root: string, selected: ReadonlyArray<string>, outcome: RunOutcome) =>
	Effect.flatMap(
		Effect.result(affectedModule),
		Result.match({
			onSuccess: (module) => module.recordedRun(root, selected, outcome),
			onFailure: (unloaded) => unjudgeable(outcome, unloaded.message)
		})
	)
