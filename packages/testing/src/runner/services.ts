import { Context, type Effect, Schema } from "effect"
import type { ClosureHash } from "#runner/closure-hash.ts"

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

/**
 * A module's import-closure hash, as the runner computes it for a verdict key (runner/closure.ts), over the files as the
 * asking worker loads them, the mutant its module hook serves in place of its file's text (runner/module-closure.ts):
 * what a need whose identity is a module reads, so a template declared in a module is a new template exactly when that
 * module or anything it loads changed, on disk or under a kill trial's mutant. `hashOf` takes the module's URL
 * (`import.meta.url`); each process hashes a module once.
 */
export class ModuleClosure extends Context.Service<
	ModuleClosure,
	Readonly<{ hashOf: (module: string) => Effect.Effect<ClosureHash, NeedFailed> }>
>()("@bjornpagen/testing/runner/services/ModuleClosure") {}
