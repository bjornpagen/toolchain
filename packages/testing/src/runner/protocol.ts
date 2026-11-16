import { Array as Arr, type Effect, Schema } from "effect"
import type { Residual } from "#features.ts"
import { wordsOf } from "#random.ts"
import { ClosureAnswer } from "#runner/closure-hash.ts"
import type { Limits } from "#runner/limits.ts"
import {
	type Chooser,
	forcedChooser,
	prefixChooser,
	randomChooser,
	simplestChooser
} from "#source.ts"

/**
 * The seam between a search and the processes that evaluate its cases. A search (the parent's state machine) never
 * runs a case: it sends a CaseOrder, data that crosses a process boundary by structured cloning, and reads back a
 * CaseResult, data too, decoded at the boundary, so a case evaluates the same in-process (the inline evaluator) or on
 * any worker of the pool, and nothing a search finds depends on where a case ran or how many workers exist.
 */

const Float64s = Schema.declare((input): input is Float64Array => input instanceof Float64Array)

const Int32s = Schema.declare((input): input is Int32Array => input instanceof Int32Array)

/**
 * How a case's decisions are chosen, as data a process rebuilds its chooser from: a random stream (a case seed, after
 * `skip` words its search already drew from it, as a mutation draws its edits first), exactly given values (a replay,
 * a shrink candidate), given values and then the `rest` chooser (a mutant, an enumeration's branch), or every decision
 * at its simplest.
 */
export type ChooserSpec =
	| Readonly<{ kind: "random"; seed: number; skip: number }>
	| Readonly<{ kind: "forced"; values: Float64Array }>
	| Readonly<{ kind: "prefix"; values: Float64Array; rest: ChooserSpec }>
	| Readonly<{ kind: "simplest" }>

const ChooserSpec: Schema.Codec<ChooserSpec> = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("random"), seed: Schema.Finite, skip: Schema.Finite }),
	Schema.Struct({ kind: Schema.Literal("forced"), values: Float64s }),
	Schema.Struct({
		kind: Schema.Literal("prefix"),
		values: Float64s,
		rest: Schema.suspend(() => ChooserSpec)
	}),
	Schema.Struct({ kind: Schema.Literal("simplest") })
])

/** The chooser a spec names. */
export const chooserOf = (spec: ChooserSpec): Chooser => {
	switch (spec.kind) {
		case "random": {
			const words = wordsOf(spec.seed)
			for (let used = 0; used < spec.skip; used += 1) {
				words.next()
			}
			return randomChooser(words)
		}
		case "forced":
			return forcedChooser(spec.values, spec.values.length)
		case "prefix":
			return prefixChooser(spec.values, spec.values.length, chooserOf(spec.rest))
		case "simplest":
			return simplestChooser
	}
}

/** What a case was drawn under (replay.ts Drawn), as an order carries it. */
const Drawn = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("unsteered") }),
	Schema.Struct({ kind: Schema.Literal("steered"), pending: Schema.Array(Schema.Finite) })
])

/**
 * What a case perceives beyond its notes: nothing (`notes`), or V8's block coverage of the files whose URL ends with
 * one of `files` (`blocks`), a trace a steered search keeps seeds by.
 */
const Sense = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("notes") }),
	Schema.Struct({ kind: Schema.Literal("blocks"), files: Schema.NonEmptyArray(Schema.String) })
])

export type Sense = typeof Sense.Type

/**
 * One case, as a search orders it: the property (by identity), how its decisions are chosen, the steering it is drawn
 * under, whether its tape comes back when it passes (`tape`, for a seed or an enumeration's next branch), what it
 * perceives, how long it may run before it is hung (milliseconds), and whether a passing case is printed too (a
 * failing or hung case always is).
 */
const CaseOrder = Schema.Struct({
	property: Schema.String,
	chooser: ChooserSpec,
	drawn: Drawn,
	keep: Schema.Literals(["nothing", "tape"]),
	sense: Sense,
	deadline: Schema.Finite,
	print: Schema.Literals(["failing", "always"])
})

export type CaseOrder = typeof CaseOrder.Type

/**
 * The orders one evaluation takes at once, all of one property: one case, or a batched property's batch, whose cases
 * its check takes together.
 */
const Batch = Schema.NonEmptyArray(CaseOrder)

export type Batch = typeof Batch.Type

/** A case's tape (tape.ts Tape), as a result carries it. */
const Tape = Schema.Struct({
	length: Schema.Finite,
	values: Float64s,
	lo: Float64s,
	hi: Float64s,
	spanStart: Int32s,
	spanEnd: Int32s,
	spanDepth: Int32s,
	spanLabel: Schema.Array(Schema.String),
	status: Schema.Literals(["complete", "overrun"])
})

/**
 * A case as the report prints it: its value as it ran (the property's show, or its structural form) with what the
 * property drew from the case's own tape, or `undrawn` when its space never finished drawing it.
 */
const Printed = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("drawn"),
		value: Schema.String,
		draws: Schema.Array(Schema.String)
	}),
	Schema.Struct({ kind: Schema.Literal("undrawn"), why: Schema.String })
])

export type Printed = typeof Printed.Type

/**
 * How a case ended: it passed, keeping its tape and its printed form as its order asked; it passed but used its case
 * after the case ended (`misused`); its check failed, with the failure as its report states it; it ran past its
 * deadline (`hung`); or its process ended while it ran (`lost`: a blocked event loop its watchdog ended, a crash),
 * which the parent reports with what the process last wrote. A failed or hung case carries its tape and its printed
 * form.
 */
const CaseOutcome = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("passed"),
		kept: Schema.Union([
			Schema.Struct({ kind: Schema.Literal("nothing") }),
			Schema.Struct({ kind: Schema.Literal("tape"), tape: Tape })
		]),
		shown: Schema.Union([
			Schema.Struct({ kind: Schema.Literal("unshown") }),
			Schema.Struct({ kind: Schema.Literal("shown"), printed: Printed })
		])
	}),
	Schema.Struct({ kind: Schema.Literal("misused"), printed: Printed }),
	Schema.Struct({
		kind: Schema.Literal("failed"),
		failure: Schema.String,
		tape: Tape,
		printed: Printed
	}),
	Schema.Struct({ kind: Schema.Literal("hung"), tape: Tape, printed: Printed }),
	Schema.Struct({ kind: Schema.Literal("lost"), report: Schema.String })
])

export type CaseOutcome = typeof CaseOutcome.Type

/**
 * One case's trace under the `blocks` sense: each range of code it ran, keyed by its script's URL and its offsets
 * (`<url>:<start>:<end>`), so traces from different processes merge, with the class of its count there.
 */
const Trace = Schema.Array(Schema.Tuple([Schema.String, Schema.Finite]))

export type Trace = typeof Trace.Type

/**
 * One case's result: how many decisions it made, how many of them drew its value (the rest are its property's own
 * draws), whether a forced chooser ran out or no longer fit (`overrun`), the situations it noted, what it measured
 * (Case.measure, by name), its trace, how it ended, and how long it took in milliseconds.
 */
const CaseResult = Schema.Struct({
	decisions: Schema.Finite,
	sketchDecisions: Schema.Finite,
	overrun: Schema.Boolean,
	notes: Schema.Array(Schema.String),
	measures: Schema.Array(Schema.Tuple([Schema.String, Schema.Finite])),
	trace: Trace,
	outcome: CaseOutcome,
	millis: Schema.Finite
})

export type CaseResult = typeof CaseResult.Type

/** A result no process gave: the case's process ended while it ran, with what the process last wrote. */
export const lostResult = (report: string): CaseResult => ({
	decisions: 0,
	sketchDecisions: 0,
	overrun: false,
	notes: [],
	measures: [],
	trace: [],
	outcome: { kind: "lost", report },
	millis: 0
})

/**
 * Where a search's cases evaluate. `evaluate` runs batches and gives back each batch's results in order, ending with the
 * first batch in order that holds a result `stop` holds of (a window whose case failed, a shrink whose candidate
 * failed); the batches after it that have not started are dropped, and those that have run to their end unread. `width` is how many batches could start at
 * once now, at least one, what a shrink speculates over. Two exist: the pool (a worker a core) and inline (this
 * process, one batch at a time), and a search finds the same on either.
 */
export type Evaluator = Readonly<{
	evaluate: (
		batches: ReadonlyArray<Batch>,
		stop: (result: CaseResult) => boolean
	) => Effect.Effect<ReadonlyArray<ReadonlyArray<CaseResult>>>
	width: Effect.Effect<number>
}>

/**
 * Which cases a search runs: every phase (`full`); its witnesses alone (kept tokens, the floor and steered phase, an
 * exhaustion's every case), as a kill's verdict reads them; or its rotating stream alone, as a fuzz round runs one, its
 * witnesses being the same on every seed. An exhaustion has no rotating stream and runs its every case at any reach.
 */
export type Reach = "full" | "witnesses" | "rotating"

/** What a search runs with: its property's identity, the run's seed, the runner's limits, its evaluator and reach. */
export type SearchRun = Readonly<{
	id: string
	seed: number
	limits: Limits
	evaluator: Evaluator
	reach: Reach
}>

/**
 * Where a case was drawn: a kept token, a phase of its search (the witnesses `floor`, `steered` and `exhaustive`, the
 * run's `independent` sample), or the case a replay names.
 */
export type CasePhase = "kept" | "floor" | "steered" | "exhaustive" | "independent" | "replayed"

/** How far a failing case was shrunk: no candidate made progress, its budget ran out, or it was not shrunk. */
export type Shrinking =
	| Readonly<{ kind: "minimal"; candidates: number }>
	| Readonly<{ kind: "budget"; candidates: number }>
	| Readonly<{ kind: "unshrunk" }>

/** The witnesses a coverage verdict was judged on: an exploration's floor and steered cases, or an exhaustion's every
 * case. */
export type Witnessed =
	| Readonly<{ kind: "streams"; floor: number; steered: number }>
	| Readonly<{ kind: "space"; cases: number }>

/**
 * Why a property failed: a case failed (shrunk as far as it went), hung, used its case after it ended, or was lost
 * with its process; a required situation no witness reached; a kept or replayed token that no longer runs as it says
 * (`stale`); or an exhaustion's space too large to count within the case deadline. Every case-borne finding names
 * where its case came from and prints it as it ran, with its replay token where it has one.
 */
export type Finding =
	| Readonly<{
			kind: "falsified"
			phase: CasePhase
			where: string
			printed: Printed
			failure: string
			shrinking: Shrinking
			token: string
	  }>
	| Readonly<{ kind: "hung"; phase: CasePhase; where: string; printed: Printed; token: string }>
	| Readonly<{ kind: "misused"; phase: CasePhase; where: string; printed: Printed }>
	| Readonly<{ kind: "lost"; phase: CasePhase; where: string; report: string }>
	| Readonly<{
			kind: "unreached"
			missing: Arr.NonEmptyReadonlyArray<string>
			witnessed: Witnessed
	  }>
	| Readonly<{ kind: "stale"; phase: CasePhase; where: string; why: string }>
	| Readonly<{ kind: "uncountable"; box: string; deadline: number }>

/** What a property's cases measured (Case.measure): each name's sum over every case its search ran, by first use. */
export type Measures = ReadonlyArray<readonly [name: string, sum: number]>

/**
 * What a search concluded: an exploration's residual over its independent cases and what its coverage cost, an
 * exhaustion's proof inside its box, a replayed case that passed, or a finding; each with what its cases measured.
 */
export type Verdict =
	| Readonly<{
			kind: "explored"
			cases: number
			floor: number
			steered: number
			residual: Residual
			measures: Measures
	  }>
	| Readonly<{ kind: "exhausted"; cases: number; box: string; measures: Measures }>
	| Readonly<{ kind: "replayed"; printed: Printed }>
	| Readonly<{ kind: "failed"; finding: Finding }>

/** A message from the parent to a worker: evaluate these units, each a batch under its id; give back these
 * unstarted units; or the closure hash of a module it asked for (runner/closure-requests.ts). */
export const ToWorker = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("evaluate"),
		units: Schema.NonEmptyArray(Schema.Struct({ unit: Schema.Finite, batch: Batch }))
	}),
	Schema.Struct({ kind: Schema.Literal("revoke"), units: Schema.Array(Schema.Finite) }),
	Schema.Struct({ kind: Schema.Literal("closure"), module: Schema.String, answer: ClosureAnswer })
])

export type ToWorker = typeof ToWorker.Type

/**
 * A message from a worker to the parent: it is ready; it started a unit; it finished one, with each order's result; it
 * gave back these units, of those the parent revoked, none of which it had started; a case (a unit's `at`-th order) was
 * used after it ended, printed as it ran; it cannot start, and why; or it asks for a module's closure hash, which the
 * parent computes once for the whole pool.
 */
export const FromWorker = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("ready") }),
	Schema.Struct({ kind: Schema.Literal("started"), unit: Schema.Finite }),
	Schema.Struct({
		kind: Schema.Literal("done"),
		unit: Schema.Finite,
		results: Schema.Array(CaseResult)
	}),
	Schema.Struct({ kind: Schema.Literal("revoked"), units: Schema.Array(Schema.Finite) }),
	Schema.Struct({
		kind: Schema.Literal("misused"),
		unit: Schema.Finite,
		at: Schema.Finite,
		printed: Printed
	}),
	Schema.Struct({ kind: Schema.Literal("failed"), message: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("closure"), module: Schema.String })
])

export type FromWorker = typeof FromWorker.Type

/** Whether a result ends its window: a case that did not pass. */
export const stops = (result: CaseResult): boolean => result.outcome.kind !== "passed"
