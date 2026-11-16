import { Context, Schema } from "effect"

/** A need failed to open or to give a case its resource: the case fails with it, never the run silently. */
export class NeedFailed extends Schema.TaggedError<NeedFailed, { readonly brand: unique symbol }>()(
	"NeedFailed",
	{ need: Schema.String, message: Schema.String }
) {}

/**
 * Which worker of the run a need opens in: its index among the run's workers, from 0, and how many there are, so a need
 * that maps workers onto shared members (a cluster's databases) spreads them, as VITEST_POOL_ID once did. An inline
 * evaluation is worker 0 of 1.
 */
export class WorkerIndex extends Context.Service<
	WorkerIndex,
	Readonly<{ index: number; workers: number }>
>()("@bjornpagen/testing/runner/services/WorkerIndex") {}
