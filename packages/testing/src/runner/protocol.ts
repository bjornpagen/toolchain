import { Array as Arr, type Effect, Option, Schema } from "effect"
import type { Residual } from "#features.ts"
import { Reservation } from "#pg/lease.ts"
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
 * perceives, how long it may run before it is hung (milliseconds), how long its property's needs may take to open on a
 * process that has not opened them (milliseconds, before the case and outside its deadline), and whether a passing
 * case is printed too (a failing or hung case always is).
 */
const CaseOrder = Schema.Struct({
	property: Schema.String,
	chooser: ChooserSpec,
	drawn: Drawn,
	keep: Schema.Literals(["nothing", "tape"]),
	sense: Sense,
	deadline: Schema.Finite,
	open: Schema.Finite,
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
 * deadline (`hung`); its process ended while it ran (`lost`: a blocked event loop its watchdog ended, a crash), which
 * the parent reports with what the process last wrote; or it could not have its resources, because a need of its
 * property did not open on its process or failed the case (its check failed with a NeedFailed: a take of a need, or a
 * need the check opened itself), `unopened`, which is no fact of the case's value. A failed or hung case carries its
 * tape and its printed form.
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
	Schema.Struct({ kind: Schema.Literal("hung"), leg: Schema.String, tape: Tape, printed: Printed }),
	Schema.Struct({ kind: Schema.Literal("lost"), report: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("unopened"), need: Schema.String, message: Schema.String })
])

export type CaseOutcome = typeof CaseOutcome.Type

/**
 * One case's trace under the `blocks` sense: each range of code it ran, keyed by its script's URL and its offsets
 * (`<url>:<start>:<end>`), so traces from different processes merge, with the class of its count there.
 */
const Trace = Schema.Array(Schema.Tuple([Schema.String, Schema.Finite]))

export type Trace = typeof Trace.Type

/**
 * How a case's draw ended: every decision it made, its count, or a forced chooser (a replay's, a kept case's) ran out or
 * no longer fit, where its count says nothing of the values it was given (`overrun`).
 */
const Drew = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("complete"), decisions: Schema.Finite }),
	Schema.Struct({ kind: Schema.Literal("overrun") })
])

export type Drew = typeof Drew.Type

/**
 * One case's result: how its draw ended, the situations it noted, what it measured (Case.measure, by name), its trace,
 * how it ended, how long it took in milliseconds, and how many milliseconds of its process's CPU (user and system) it
 * took meanwhile.
 */
const CaseResult = Schema.Struct({
	drew: Drew,
	notes: Schema.Array(Schema.String),
	measures: Schema.Array(Schema.Tuple([Schema.String, Schema.Finite])),
	trace: Trace,
	outcome: CaseOutcome,
	millis: Schema.Finite,
	cpu: Schema.Finite
})

export type CaseResult = typeof CaseResult.Type

/**
 * Where a series' cases come from, which its process draws itself: an exhaustion's sketches, `count` of them enumerated
 * over the property's space from the branch of the first (the first `length` of `start`), a sketch being one case of the
 * space and every case its property's own draws enumerate from it, fewer when the space ends first; or a stream of an
 * exploration's cases, one a seed, each drawn from its case seed (random.ts caseSeed) under the stream's steering: the
 * rotating stream's unsteered, the floor's of a property that requires no situation, steered toward none.
 */
const SeriesFrom = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("sketches"),
		start: Float64s,
		length: Schema.Finite,
		count: Schema.Finite
	}),
	Schema.Struct({ kind: Schema.Literal("stream"), seeds: Float64s, drawn: Drawn })
])

export type SeriesFrom = typeof SeriesFrom.Type

/**
 * A series of one property's cases on one process, the unit an exhaustion and an exploration's rotating stream are sent
 * in: its property, where its cases come from, how many of them one evaluation takes (`group`: one, or a batched
 * property's batch size), and each case's deadline and its needs' open bound. The process draws the cases itself, runs
 * them in order, and gives back one summary, so its cases cross no process boundary one by one.
 */
const SeriesOrder = Schema.Struct({
	property: Schema.String,
	from: SeriesFrom,
	group: Schema.Finite,
	deadline: Schema.Finite,
	open: Schema.Finite
})

export type SeriesOrder = typeof SeriesOrder.Type

/** How many cases a series' source names: its sketches (one deadline each), or its stream's seeds. */
const seriesCases = (from: SeriesFrom): number => {
	switch (from.kind) {
		case "sketches":
			return from.count
		case "stream":
			return from.seeds.length
	}
}

/**
 * A situation the cases of a series noted: its key, how many of the series' passing cases noted it, and the place among
 * them of the first that did, from 0, so a search adds a series to its tally as it would add its cases one by one.
 */
const Noted = Schema.Tuple([Schema.String, Schema.Finite, Schema.Finite])

export type Noted = typeof Noted.Type

/**
 * What a series found, in order through its first case that stopped (every case, when none did): how many of those
 * cases passed, the situations they noted, what they measured (by name, summed), and the first case that did not pass,
 * if one did; and how many cases the process ran for it in all, with their milliseconds and CPU (cases of later
 * sketches that ran in the same rounds among them).
 */
const SeriesRan = Schema.Struct({
	ran: Schema.Finite,
	passed: Schema.Finite,
	notes: Schema.Array(Noted),
	measures: Schema.Array(Schema.Tuple([Schema.String, Schema.Finite])),
	millis: Schema.Finite,
	cpu: Schema.Finite,
	stopped: Schema.Union([
		Schema.Struct({ kind: Schema.Literal("none") }),
		Schema.Struct({ kind: Schema.Literal("stopped"), result: CaseResult })
	])
})

export type SeriesRan = typeof SeriesRan.Type

/**
 * An order to count an exhaustion's space on the process it is sent to, before any of its cases runs: its property,
 * every how many cases to give the branch of (where the exhaustion's series start), the CPU the count may spend before
 * the space is uncountable (enumerate.ts countWithin), and its needs' open bound, within which the process readies the
 * property it counts the space of.
 */
const CountOrder = Schema.Struct({
	property: Schema.String,
	every: Schema.Finite,
	cpu: Schema.Finite,
	open: Schema.Finite
})

export type CountOrder = typeof CountOrder.Type

/** A point in enumeration order, as a count gives it back (enumerate.ts Branch). */
const Branch = Schema.Struct({ values: Float64s, length: Schema.Finite })

/**
 * What a count gave back: the space counted (how many cases, and the branch of every `every`-th from the first); a space
 * whose count took more than its CPU, too large to exhaust; or the result that stopped it before it counted, its
 * property not readied on its process (a need that did not open, a module that did not load) or its process lost.
 */
const CountAnswer = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("counted"),
		cases: Schema.Finite,
		starts: Schema.Array(Branch)
	}),
	Schema.Struct({ kind: Schema.Literal("uncountable") }),
	Schema.Struct({ kind: Schema.Literal("stopped"), result: CaseResult })
])

export type CountAnswer = typeof CountAnswer.Type

/**
 * What a unit holds: a batch of one property's cases, a series of them its process draws, or the count of an
 * exhaustion's space.
 */
const Work = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("cases"), batch: Batch }),
	Schema.Struct({ kind: Schema.Literal("series"), series: SeriesOrder }),
	Schema.Struct({ kind: Schema.Literal("count"), count: CountOrder })
])

export type Work = typeof Work.Type

/** The property a unit's work is of, and its needs' open bound, as its orders carry them. */
export const workOf = (work: Work): Readonly<{ property: string; open: number; cases: number }> => {
	switch (work.kind) {
		case "cases": {
			const first = Arr.headNonEmpty(work.batch)
			return { property: first.property, open: first.open, cases: work.batch.length }
		}
		case "series":
			return {
				property: work.series.property,
				open: work.series.open,
				cases: seriesCases(work.series.from)
			}
		case "count":
			return { property: work.count.property, open: work.count.open, cases: 0 }
	}
}

/** What a unit gave back: its batch's results, one an order, its series' summary, or its count's answer. */
const Done = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("cases"), results: Schema.Array(CaseResult) }),
	Schema.Struct({ kind: Schema.Literal("series"), ran: SeriesRan }),
	Schema.Struct({ kind: Schema.Literal("count"), answer: CountAnswer, cpu: Schema.Finite })
])

export type Done = typeof Done.Type

/** The result of a case that never ran: no decision made, nothing noted, measured or traced, and why. */
const unranResult = (outcome: CaseOutcome): CaseResult => ({
	drew: { kind: "complete", decisions: 0 },
	notes: [],
	measures: [],
	trace: [],
	outcome,
	millis: 0,
	cpu: 0
})

/**
 * What bounds a unit's evaluation on a worker: each of its cases' deadlines, added up; a series, one deadline a case of
 * its source (a sketch, a stream's case); a count, the CPU it may spend.
 */
export const deadlinesOf = (work: Work): number => {
	switch (work.kind) {
		case "cases":
			return Arr.reduce(work.batch, 0, (total, order) => total + order.deadline)
		case "series":
			return seriesCases(work.series.from) * work.series.deadline
		case "count":
			return work.count.cpu
	}
}

/** How many cases a unit's answer says its worker ran, and their milliseconds and CPU. */
export const ranOf = (done: Done): Readonly<{ cases: number; millis: number; cpu: number }> => {
	switch (done.kind) {
		case "cases":
			return {
				cases: done.results.length,
				millis: Arr.reduce(done.results, 0, (total, result) => total + result.millis),
				cpu: Arr.reduce(done.results, 0, (total, result) => total + result.cpu)
			}
		case "series":
			return { cases: done.ran.ran, millis: done.ran.millis, cpu: done.ran.cpu }
		case "count":
			return { cases: 0, millis: 0, cpu: done.cpu }
	}
}

/** The report of a worker that answered a unit with the other kind of answer: a defect of its process. */
const misanswered = "its worker answered it with the other kind of answer than its unit holds"

/** A batch's results, as its worker answered them; a series' summary in their place is a lost case. */
export const resultsOf = (done: Done): ReadonlyArray<CaseResult> => {
	switch (done.kind) {
		case "cases":
			return done.results
		case "series":
		case "count":
			return [lostResult(misanswered)]
	}
}

/** A series' summary, as its worker answered it; a batch's results in its place stop it, lost. */
export const seriesRanOf = (done: Done): SeriesRan => {
	switch (done.kind) {
		case "series":
			return done.ran
		case "cases":
		case "count":
			return {
				ran: 0,
				passed: 0,
				notes: [],
				measures: [],
				millis: 0,
				cpu: 0,
				stopped: { kind: "stopped", result: lostResult(misanswered) }
			}
	}
}

/** A count's answer, as its worker answered it; any other answer in its place stops it, lost. */
export const countAnswerOf = (done: Done): CountAnswer => {
	switch (done.kind) {
		case "count":
			return done.answer
		case "cases":
		case "series":
			return { kind: "stopped", result: lostResult(misanswered) }
	}
}

/**
 * A case's result as its search judges it once it knows whether the case was used after it ended (`late`, printed as
 * it ran): a passing case so used is misused, whichever evaluation ran it, a batch or a series; any other stands.
 */
export const judgedLate = (result: CaseResult, late: Option.Option<Printed>): CaseResult =>
	Option.match(late, {
		onNone: () => result,
		onSome: (printed) =>
			result.outcome.kind === "passed"
				? { ...result, outcome: { kind: "misused", printed } }
				: result
	})

/** A result no process gave: the case's process ended while it ran, with what the process last wrote. */
export const lostResult = (report: string): CaseResult => unranResult({ kind: "lost", report })

/** What a unit no process could run gives back: each of its cases, or its series, ended as `result` says. */
export const doneWith = (work: Work, result: CaseResult): Done => {
	switch (work.kind) {
		case "cases":
			return { kind: "cases", results: Arr.map(work.batch, () => result) }
		case "series":
			return {
				kind: "series",
				ran: {
					ran: 0,
					passed: 0,
					notes: [],
					measures: [],
					millis: 0,
					cpu: 0,
					stopped: { kind: "stopped", result }
				}
			}
		case "count":
			return { kind: "count", answer: { kind: "stopped", result }, cpu: 0 }
	}
}

/**
 * The result of a case whose property's need `need` did not open on its process: why (its NeedFailed's message, its
 * open past the open bound among them).
 */
export const unopenedResult = (need: string, message: string): CaseResult =>
	unranResult({ kind: "unopened", need, message })

/**
 * Where a search's cases evaluate. `evaluate` runs batches and gives back each batch's results in order, ending with the
 * first batch in order that holds a result `stop` holds of (a window whose case failed, a shrink whose candidate
 * failed); the batches after it that have not started are dropped, and those that have run to their end unread.
 * `series` runs series of cases their processes draw and gives back each one's summary in order, ending with the first
 * whose case stopped, the same way. `count` counts an exhaustion's space where its cases run (on a worker of the pool,
 * so no count holds the pool's parent, which answers every worker). `width` is how many batches could start at once now, at least one, what a shrink
 * speculates over and a window of series counts them by. `workers` is how many processes may ever run its units at
 * once, the most a search's sample can spread over, which a search cuts its streams and spaces into no more series
 * than. Two exist: the pool (a worker a core) and inline (this process, one batch at a time), and a search finds the
 * same on either.
 */
export type Evaluator = Readonly<{
	evaluate: (
		batches: ReadonlyArray<Batch>,
		stop: (result: CaseResult) => boolean
	) => Effect.Effect<ReadonlyArray<ReadonlyArray<CaseResult>>>
	series: (orders: ReadonlyArray<SeriesOrder>) => Effect.Effect<ReadonlyArray<SeriesRan>>
	count: (order: CountOrder) => Effect.Effect<CountAnswer>
	width: Effect.Effect<number>
	workers: number
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

/**
 * How far a failing case was shrunk: no candidate made progress, its budget ran out, a candidate's need failed
 * (`unopened`: the need and why, after which no candidate ran, since every one would take the need again), or it was
 * not shrunk.
 */
export type Shrinking =
	| Readonly<{ kind: "minimal"; candidates: number }>
	| Readonly<{ kind: "budget"; candidates: number }>
	| Readonly<{ kind: "unopened"; candidates: number; need: string; message: string }>
	| Readonly<{ kind: "unshrunk" }>

/** The witnesses a coverage verdict was judged on: an exploration's floor and steered cases, or an exhaustion's every
 * case. */
export type Witnessed =
	| Readonly<{ kind: "streams"; floor: number; steered: number }>
	| Readonly<{ kind: "space"; cases: number }>

/**
 * Why a property failed: a case failed (shrunk as far as it went), hung, used its case after it ended, or was lost
 * with its process; a need of the property did not open on a process or failed a case there, so no case of it was
 * judged (`unopened`, borne by no case, printed once, never shrunk); a required situation no witness reached; a kept or replayed token that no longer runs as it
 * says (`stale`); or an exhaustion's space too large to count within the case deadline. Every case-borne finding names
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
	| Readonly<{
			kind: "hung"
			phase: CasePhase
			where: string
			/** What the case's guard read as it stopped it (runner/work.ts overrunText): its CPU spent, or its stall. */
			leg: string
			printed: Printed
			token: string
	  }>
	| Readonly<{ kind: "misused"; phase: CasePhase; where: string; printed: Printed }>
	| Readonly<{ kind: "lost"; phase: CasePhase; where: string; report: string }>
	| Readonly<{ kind: "unopened"; need: string; message: string }>
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

/**
 * A message from the parent to a worker: evaluate these units, each a batch under its id; give back these unstarted
 * units; the closure hash of a module it asked for (runner/closure-requests.ts); a property retired, its search
 * ended, so no unit of it comes after the ones already sent; or the run's lease on a cluster it asked for, held or
 * refused (runner/leases.ts).
 */
export const ToWorker = Schema.Union([
	Schema.Struct({
		kind: Schema.Literal("evaluate"),
		units: Schema.NonEmptyArray(Schema.Struct({ unit: Schema.Finite, work: Work }))
	}),
	Schema.Struct({ kind: Schema.Literal("revoke"), units: Schema.Array(Schema.Finite) }),
	Schema.Struct({ kind: Schema.Literal("closure"), module: Schema.String, answer: ClosureAnswer }),
	Schema.Struct({ kind: Schema.Literal("retire"), property: Schema.String }),
	Schema.Struct({
		kind: Schema.Literal("lease"),
		gate: Schema.String,
		answer: Schema.Union([
			Schema.Struct({ kind: Schema.Literal("leased") }),
			Schema.Struct({ kind: Schema.Literal("refused"), message: Schema.String })
		])
	})
])

export type ToWorker = typeof ToWorker.Type

/**
 * The CPU (ms) a worker's children took while it did one thing (readied a property, ran a unit): those it waited for,
 * user and system, as its system states them (runner/usage.ts childrenCpuNow); or that its system states none.
 */
const ChildrenCpu = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("stated"), millis: Schema.Finite }),
	Schema.Struct({ kind: Schema.Literal("unstated") })
])

export type ChildrenCpu = typeof ChildrenCpu.Type

/**
 * A message from a worker to the parent: it is ready, and how many milliseconds it took to start, and of CPU; it is readying
 * a unit's property, the first unit of it the worker took (importing its module and opening its needs, within the open
 * bound); it readied it, in how many milliseconds, of which how many importing its module (none when it had before),
 * what scheduling measures readying by, and how many of CPU, its children's beside; it started a unit's cases; it finished one, with each order's result, the worker's CPU so
 * far and its children's CPU while it ran; it gave back
 * these units, of those the parent revoked, none of which it had started; a case (a unit's `at`-th order) was used
 * after it ended, printed as it ran; it failed, and why (before it was ready, it cannot start; after, it ends, and the
 * unit it ran is lost with this as the last it wrote); it asks for a module's closure hash, which the parent
 * computes once for the whole pool; it asks for the run's lease on a cluster (`lease`, runner/leases.ts), which the
 * parent holds once for the whole run; or it began waiting on a resource other processes hold (`waiting`: its first
 * declared wait opened, runner/work.ts Waits) or stopped (`waited`: its last one closed), whose wall time the parent's
 * watch of it counts as no stall.
 */
export const FromWorker = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("ready"), cpu: Schema.Finite, millis: Schema.Finite }),
	Schema.Struct({ kind: Schema.Literal("readying"), unit: Schema.Finite }),
	Schema.Struct({
		kind: Schema.Literal("readied"),
		unit: Schema.Finite,
		millis: Schema.Finite,
		imported: Schema.Finite,
		cpu: Schema.Finite,
		children: ChildrenCpu
	}),
	Schema.Struct({ kind: Schema.Literal("started"), unit: Schema.Finite }),
	Schema.Struct({
		kind: Schema.Literal("done"),
		unit: Schema.Finite,
		done: Done,
		cpu: Schema.Finite,
		children: ChildrenCpu
	}),
	Schema.Struct({ kind: Schema.Literal("revoked"), units: Schema.Array(Schema.Finite) }),
	Schema.Struct({
		kind: Schema.Literal("misused"),
		unit: Schema.Finite,
		at: Schema.Finite,
		printed: Printed
	}),
	Schema.Struct({ kind: Schema.Literal("failed"), message: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("closure"), module: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("lease"), reservation: Reservation }),
	Schema.Struct({ kind: Schema.Literal("waiting") }),
	Schema.Struct({ kind: Schema.Literal("waited") })
])

export type FromWorker = typeof FromWorker.Type

/** Whether a result ends its window: a case that did not pass. */
export const stops = (result: CaseResult): boolean => result.outcome.kind !== "passed"
