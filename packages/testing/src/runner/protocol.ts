import type { Array as Arr, Effect } from "effect"
import type { Residual } from "#features.ts"
import { wordsOf } from "#random.ts"
import type { Drawn } from "#replay.ts"
import type { Limits } from "#runner/limits.ts"
import {
	type Chooser,
	forcedChooser,
	prefixChooser,
	randomChooser,
	simplestChooser
} from "#source.ts"
import type { Tape } from "#tape.ts"

/**
 * The seam between a search and the processes that evaluate its cases. A search (the parent's state machine) never
 * runs a case: it sends a CaseOrder, data that crosses a process boundary by structured cloning, and reads back a
 * CaseResult, data too, so a case evaluates the same in-process (the inline evaluator) or on any worker of the pool,
 * and nothing a search finds depends on where a case ran or how many workers exist.
 */

/**
 * How a case's decisions are chosen, as data a process rebuilds its chooser from: a random stream (a case seed, after
 * `skip` words its search already drew from it, as a mutation draws its edits first), exactly given values (a replay,
 * a shrink candidate), given values and then another chooser (a mutant, an enumeration's branch), or every decision at
 * its simplest.
 */
export type ChooserSpec =
	| Readonly<{ kind: "random"; seed: number; skip: number }>
	| Readonly<{ kind: "forced"; values: Float64Array }>
	| Readonly<{ kind: "prefix"; values: Float64Array; rest: ChooserSpec }>
	| Readonly<{ kind: "simplest" }>

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

/**
 * One case, as a search orders it: the property (by identity), how its decisions are chosen, the steering it is drawn
 * under, whether its tape comes back when it passes (`tape`, for a seed or an enumeration's next branch), what it
 * perceives, how long it may run before it is hung (milliseconds), and whether a passing case is printed too (a
 * failing or hung case always is). A case perceives what its property notes; nothing else steers it.
 */
export type CaseOrder = Readonly<{
	property: string
	chooser: ChooserSpec
	drawn: Drawn
	keep: "nothing" | "tape"
	deadline: number
	print: "failing" | "always"
}>

/**
 * The orders one evaluation takes at once, all of one property: one case, or a batched property's batch, whose cases
 * its check takes together.
 */
export type Batch = Arr.NonEmptyReadonlyArray<CaseOrder>

/**
 * A case as the report prints it: its value as it ran (the property's show, or its structural form), or `undrawn`
 * when its generator never finished drawing it, and what the property drew from the case's own tape.
 */
export type Printed =
	| Readonly<{ kind: "drawn"; value: string; draws: ReadonlyArray<string> }>
	| Readonly<{ kind: "undrawn"; why: string }>

/** What a passing case keeps of its recording: nothing, or its tape, as its order asked. */
export type Kept = Readonly<{ kind: "nothing" }> | Readonly<{ kind: "tape"; tape: Tape }>

/** Whether a passing case is printed: as its order asked. */
export type Shown = Readonly<{ kind: "unshown" }> | Readonly<{ kind: "shown"; printed: Printed }>

/**
 * How a case ended: it passed; it passed but used its case after the case ended (`misused`); its check failed, with
 * the failure as its report states it; it ran past its deadline (`hung`);
 * or its process ended while it ran (`lost`: a blocked event loop its watchdog ended, a crash), which the parent
 * reports with what the process last wrote. A failed or hung case carries its tape and its printed form.
 */
export type CaseOutcome =
	| Readonly<{ kind: "passed"; kept: Kept; shown: Shown }>
	| Readonly<{ kind: "misused"; printed: Printed }>
	| Readonly<{ kind: "failed"; failure: string; tape: Tape; printed: Printed }>
	| Readonly<{ kind: "hung"; tape: Tape; printed: Printed }>
	| Readonly<{ kind: "lost"; report: string }>

/**
 * One case's result: how many decisions it made, how many of them drew its value (the rest are its property's own
 * draws), whether a forced chooser ran out or no longer fit (`overrun`), the situations it noted, how it
 * ended, and how long it took in milliseconds.
 */
export type CaseResult = Readonly<{
	decisions: number
	sketchDecisions: number
	overrun: boolean
	notes: ReadonlyArray<string>
	outcome: CaseOutcome
	millis: number
}>

/**
 * Where a search's cases evaluate. `evaluate` runs batches and gives back each batch's results in order; once a
 * result `stop` holds of has come back, no batch after its own starts, and the results end with its batch: a window
 * whose case failed, a shrink whose candidate failed. `width` is how many batches could start at once now, at least
 * one, what a shrink speculates over. Two exist: the pool (a worker a core) and inline (this process, one batch at a
 * time), and a search finds the same on either.
 */
export type Evaluator = Readonly<{
	evaluate: (
		batches: ReadonlyArray<Batch>,
		stop: (result: CaseResult) => boolean
	) => Effect.Effect<ReadonlyArray<ReadonlyArray<CaseResult>>>
	width: Effect.Effect<number>
}>

/**
 * Which cases a search runs: every phase (`full`), or its witnesses alone (the floor and steered phase, an
 * exhaustion's every case), as a kill's verdict reads them.
 */
export type Reach = "full" | "witnesses"

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

/**
 * Why a property failed: a case failed (shrunk as far as it went), hung, used its case after it ended, or was
 * lost with its process; a required situation no witness reached; a kept or replayed token that no longer runs as it
 * says (`stale`); or an exhaustion's space too large to count within the case deadline. Every case-borne finding names
 * where its case came from, prints it as it ran, and carries its replay token where it has one.
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

/** The witnesses a coverage verdict was judged on: an exploration's floor and steered cases, or an exhaustion's every
 * case. */
export type Witnessed =
	| Readonly<{ kind: "streams"; floor: number; steered: number }>
	| Readonly<{ kind: "space"; cases: number }>

/**
 * What a search concluded: an exploration's residual over its independent cases and what its coverage cost, an
 * exhaustion's proof inside its box, a replayed case that passed, or a finding.
 */
export type Verdict =
	| Readonly<{
			kind: "explored"
			cases: number
			floor: number
			steered: number
			residual: Residual
	  }>
	| Readonly<{ kind: "exhausted"; cases: number; box: string }>
	| Readonly<{ kind: "replayed"; printed: Printed }>
	| Readonly<{ kind: "failed"; finding: Finding }>
