import { Array as Arr, Effect, Fiber, Option, String as Str } from "effect"
import { residualOf, type SteeringPhase, type Tally, tallyOf, turnsOf } from "#features.ts"
import { mutate } from "#mutate.ts"
import {
	between,
	caseSeed,
	countedWords,
	floorSeed,
	rotatingSeed,
	type Stream,
	steeredSeed
} from "#random.ts"
import { type Drawn, type ReplayCase, replayOf, replayTokenOf } from "#replay.ts"
import {
	type Batch,
	type CaseOrder,
	type CaseOutcome,
	type CasePhase,
	type CaseResult,
	type Measures,
	type Reach,
	type Sense,
	stops,
	type Trace,
	type ChooserSpec,
	type Finding,
	type SearchRun,
	type Noted,
	type SeriesOrder,
	type SeriesRan,
	type Shrinking,
	type Verdict
} from "#runner/protocol.ts"
import { runOfLabel } from "#runner/stack.ts"
import { seedsOf } from "#seeds.ts"
import {
	boundedShrink,
	completeShrink,
	type Judged,
	type Ordered,
	type ShrinkBudget,
	shrinkInOrder
} from "#shrink.ts"
import type { Tape } from "#tape.ts"

/**
 * The parent's side of every search: the state machines that choose each case (kept tokens first, the floor stream,
 * the steered phase, the rotating stream, an exhaustion's enumeration), judge each window's results in case order,
 * keep the coverage verdict on the witnesses alone, and shrink a failure. Cases evaluate wherever the run's Evaluator
 * sends them; every case is fixed by its index in its stream and the window it is drawn under, never by when or where
 * it ran, so a search finds the same at any width.
 */

/** A kept regression as a search reads it: its replay token, and why it is kept. */
export type KeptToken = Readonly<{ token: string; reason: string }>

/**
 * What every kind of search reads of its property: its required situations (by key, in declared order), its kept
 * tokens, and what its steered phase perceives (its guide).
 */
export type Searched = Readonly<{
	situations: ReadonlyArray<string>
	kept: ReadonlyArray<KeptToken>
	guide: Sense
}>

/** One steered case in this many is a fresh draw rather than a mutant of a seed. */
const FRESH_EVERY = 4

const hex = (seed: number) => `0x${Str.padStart(8, "0")((seed >>> 0).toString(16))}`

/** A case's replay token: its property's identity, the steering it was drawn under, and its tape's values. */
const tokenOf = (id: string, drawn: Drawn, tape: Tape): string =>
	replayTokenOf(id, { drawn, values: Arr.fromIterable(tape.values.subarray(0, tape.length)) })

/** One case of a search, as it is drawn: its chooser and its steering. */
type Draw = Readonly<{ chooser: ChooserSpec; drawn: Drawn }>

/** How a window's cases are ordered: whether their tapes come back, what they perceive, and how many to a batch. */
type Ordering = Readonly<{ keep: "nothing" | "tape"; sense: Sense; group: number }>

/** Cases ordered one to a batch, perceiving their notes alone, keeping `keep`. */
const plainly = (keep: "nothing" | "tape"): Ordering => ({ keep, sense: notesOnly, group: 1 })

/** The sense that perceives notes alone. */
const notesOnly: Sense = { kind: "notes" }

/** The order of one drawn case of a search's property. */
const orderOf = (run: SearchRun, draw: Draw, ordering: Ordering): CaseOrder => ({
	property: run.id,
	chooser: draw.chooser,
	drawn: draw.drawn,
	keep: ordering.keep,
	sense: ordering.sense,
	deadline: run.limits.deadline,
	open: run.limits.open,
	print: "failing"
})

/**
 * A window's results, in case order, its orders evaluated `ordering.group` to a batch (a batched property's size, one
 * otherwise): one result per order up to the first that did not pass, which ends it.
 */
const windowOf = (
	run: SearchRun,
	draws: ReadonlyArray<Draw>,
	ordering: Ordering
): Effect.Effect<ReadonlyArray<CaseResult>> =>
	Effect.map(
		run.evaluator.evaluate(
			Arr.chunksOf(
				Arr.map(draws, (draw) => orderOf(run, draw, ordering)),
				ordering.group
			),
			stops
		),
		Arr.flatten
	)

/**
 * A search's numbering of the ranges its cases' traces name, in the order it first meets them, so a trace from any
 * process becomes the dense trace its seeds are kept by (seeds.ts).
 */
const tracerOf = (): ((trace: Trace) => Uint8Array) => {
	const numbers = new Map<string, number>()
	return (trace) => {
		for (const [range] of trace) {
			if (!numbers.has(range)) {
				numbers.set(range, numbers.size)
			}
		}
		const dense = new Uint8Array(numbers.size)
		for (const [range, traced] of trace) {
			const at = numbers.get(range) ?? 0
			dense[at] = Math.max(dense[at] ?? 0, traced)
		}
		return dense
	}
}

/** A search's measures being summed: `add` takes a passing case's, `sums` gives them by first use. */
const measuring = () => {
	const sums = new Map<string, number>()
	const addAll = (measured: ReadonlyArray<readonly [string, number]>) => {
		for (const [name, amount] of measured) {
			sums.set(name, (sums.get(name) ?? 0) + amount)
		}
	}
	return {
		add: (result: CaseResult) => addAll(result.measures),
		addAll,
		sums: (): Measures => Arr.fromIterable(sums.entries())
	}
}

/** A case that could not have a need's resource: the need, and why. */
type Unopened = Extract<CaseOutcome, Readonly<{ kind: "unopened" }>>

/**
 * A shrink candidate's verdict: a smaller case of the failure only when its check failed; never judged when a need of
 * its property failed it (unopened), which ends the shrink, since every later candidate would take that need again.
 */
const judgedOf = (result: CaseResult): Judged<CaseResult, Unopened> => {
	const outcome = result.outcome
	switch (outcome.kind) {
		case "failed":
			return { kind: "fails", tape: outcome.tape, failure: result }
		case "unopened":
			return { kind: "unjudged", why: outcome }
		case "passed":
		case "misused":
		case "hung":
		case "lost":
			return { kind: "holds" }
	}
}

/** How far a shrink in candidate order went, as a finding states it. */
const shrinkingOf = (shrunk: Ordered<CaseResult, Unopened>): Shrinking => {
	switch (shrunk.ended) {
		case "minimal":
			return { kind: "minimal", candidates: shrunk.candidates }
		case "budget":
			return { kind: "budget", candidates: shrunk.candidates }
		case "unjudged":
			return {
				kind: "unopened",
				candidates: shrunk.candidates,
				need: shrunk.why.need,
				message: shrunk.why.message
			}
	}
}

/** Shrink candidates' verdicts, judged together: each its values forced, under the steering its failure was drawn
 * under, alone in its evaluation. */
const candidatesOf =
	(run: SearchRun, drawn: Drawn) =>
	(
		candidates: Arr.NonEmptyReadonlyArray<Float64Array>
	): Effect.Effect<ReadonlyArray<Judged<CaseResult, Unopened>>> =>
		Effect.map(
			windowOf(
				run,
				Arr.map(candidates, (values): Draw => ({ chooser: { kind: "forced", values }, drawn })),
				plainly("nothing")
			),
			Arr.map(judgedOf)
		)

/**
 * How a failing case is reported: shrunk within a budget, or as it ran. A kill's verdict reads witnesses alone and only
 * whether they went red, so a search of reach `witnesses` never shrinks (shrinkOf).
 */
type Shrink = Readonly<{ kind: "unshrunk" }> | Readonly<{ kind: "shrunk"; budget: ShrinkBudget }>

/** How a search of `run` reports a failing case: unshrunk under reach `witnesses`, shrunk within `budget` otherwise. */
const shrinkOf = (run: SearchRun, budget: ShrinkBudget): Shrink => {
	switch (run.reach) {
		case "witnesses":
			return { kind: "unshrunk" }
		case "full":
		case "rotating":
			return { kind: "shrunk", budget }
	}
}

/** Where a case of a search came from, as a finding names it, and how a failure there is reported. */
type Origin = Readonly<{ phase: CasePhase; where: string; drawn: Drawn; shrink: Shrink }>

/**
 * A case that did not pass, as its search reports it: a failure shrunk under the steering it was drawn under, and
 * reported with its phase and token; a hang, a misuse and a lost case as drawn.
 */
const findingOf = (
	run: SearchRun,
	result: CaseResult,
	origin: Origin
): Effect.Effect<Option.Option<Finding>> => {
	const { phase, where, drawn } = origin
	const outcome = result.outcome
	switch (outcome.kind) {
		case "passed":
			return Effect.succeedNone
		case "misused":
			return Effect.succeedSome({ kind: "misused", phase, where, printed: outcome.printed })
		case "lost":
			return Effect.succeedSome({ kind: "lost", phase, where, report: outcome.report })
		case "unopened":
			return Effect.succeedSome({ kind: "unopened", need: outcome.need, message: outcome.message })
		case "hung":
			return Effect.succeedSome({
				kind: "hung",
				phase,
				where,
				leg: outcome.leg,
				printed: outcome.printed,
				token: tokenOf(run.id, drawn, outcome.tape)
			})
		case "failed": {
			const shrink = origin.shrink
			if (shrink.kind === "unshrunk") {
				return Effect.succeedSome({
					kind: "falsified",
					phase,
					where,
					printed: outcome.printed,
					failure: outcome.failure,
					shrinking: { kind: "unshrunk" },
					token: tokenOf(run.id, drawn, outcome.tape)
				})
			}
			return Effect.map(
				shrinkInOrder(
					{ tape: outcome.tape, failure: result },
					candidatesOf(run, drawn),
					run.evaluator.width,
					shrink.budget
				),
				(shrunk): Option.Option<Finding> => {
					const best = shrunk.best.failure.outcome
					return Option.some({
						kind: "falsified",
						phase,
						where,
						printed: best.kind === "failed" ? best.printed : outcome.printed,
						failure: best.kind === "failed" ? best.failure : outcome.failure,
						shrinking: shrinkingOf(shrunk),
						token: tokenOf(run.id, drawn, shrunk.best.tape)
					})
				}
			)
		}
	}
}

/** Whether a case replayed from given values ran exactly them: none ran out or no longer fit, none was left over. */
const ranExactly = (result: CaseResult, given: number): boolean =>
	!result.overrun && result.decisions >= given

/** How a stale case's values differ from what its property now draws. */
const drewInstead = (result: CaseResult, given: number): string =>
	`it gives ${given} decisions, and its property now draws ${result.overrun ? "others than those" : `${result.decisions}`}`

/** The first requirement a token's steering names that a property of `declared` requirements does not have. */
const undeclaredIn = (drawn: Drawn, declared: number): Option.Option<number> => {
	switch (drawn.kind) {
		case "unsteered":
			return Option.none()
		case "steered":
			return Arr.findFirst(drawn.pending, (place) => place >= declared)
	}
}

/** The case a token names, when it names this property and only requirements it declares; why not, otherwise. */
const tokenCaseOf = (
	run: SearchRun,
	searched: Searched,
	token: string
): Effect.Effect<ReplayCase, string> =>
	Effect.flatMap(
		Effect.mapError(replayOf(token), (unreadable) => unreadable.message),
		(replay) => {
			if (runOfLabel(replay.suite).id !== runOfLabel(run.id).id) {
				return Effect.fail(`the token names ${replay.suite}, not ${run.id}`)
			}
			return Option.match(undeclaredIn(replay.replayed.drawn, searched.situations.length), {
				onNone: () => Effect.succeed(replay.replayed),
				onSome: (place) =>
					Effect.fail(
						`the token steers by requirement ${place}, and the property declares ${searched.situations.length}`
					)
			})
		}
	)

/** A case a token names, as an order printed whether it passes or not. */
const tokenOrderOf = (run: SearchRun, replayed: ReplayCase): Batch => [
	{
		property: run.id,
		chooser: { kind: "forced", values: Float64Array.from(replayed.values) },
		drawn: replayed.drawn,
		keep: "nothing",
		sense: notesOnly,
		deadline: run.limits.deadline,
		open: run.limits.open,
		print: "always"
	}
]

/** How a token's case ran: it passed as its token says, or a finding. */
type TokenRan =
	| Readonly<{ kind: "passed"; result: CaseResult }>
	| Readonly<{ kind: "found"; finding: Finding }>

/**
 * Runs the case a token names, in place of every stream: a pass that ran exactly its values passes; a pass that did
 * not, or a token that names another property or a requirement the property no longer declares, is stale; anything
 * else is reported as it ran, unshrunk, with its token again.
 */
const tokenRun = (
	run: SearchRun,
	searched: Searched,
	token: string,
	phase: CasePhase,
	where: string
): Effect.Effect<TokenRan> =>
	Effect.matchEffect(tokenCaseOf(run, searched, token), {
		onFailure: (why) =>
			Effect.succeed<TokenRan>({ kind: "found", finding: { kind: "stale", phase, where, why } }),
		onSuccess: (replayed) =>
			Effect.flatMap(run.evaluator.evaluate([tokenOrderOf(run, replayed)], stops), (batches) =>
				Option.match(Arr.head(Arr.flatten(batches)), {
					onNone: () => Effect.die(`${run.id}: ${where} came back with no result`),
					onSome: (result): Effect.Effect<TokenRan> => {
						const outcome = result.outcome
						switch (outcome.kind) {
							case "passed":
								return Effect.succeed<TokenRan>(
									ranExactly(result, replayed.values.length)
										? { kind: "passed", result }
										: {
												kind: "found",
												finding: {
													kind: "stale",
													phase,
													where,
													why: `${where} passed, but not as its token says: ${drewInstead(result, replayed.values.length)}; replay it from a fresh failure`
												}
											}
								)
							case "failed":
								return Effect.succeed<TokenRan>({
									kind: "found",
									finding: {
										kind: "falsified",
										phase,
										where,
										printed: outcome.printed,
										failure: outcome.failure,
										shrinking: { kind: "unshrunk" },
										token: tokenOf(run.id, replayed.drawn, outcome.tape)
									}
								})
							case "misused":
							case "hung":
							case "lost":
							case "unopened":
								return Effect.map(
									findingOf(run, result, {
										phase,
										where,
										drawn: replayed.drawn,
										shrink: { kind: "unshrunk" }
									}),
									(found): TokenRan =>
										Option.match(found, {
											onNone: () => ({ kind: "passed", result }),
											onSome: (finding) => ({ kind: "found", finding })
										})
								)
						}
					}
				})
			)
	})

/** A search's verdict on a finding. */
const failed = (finding: Finding): Verdict => ({ kind: "failed", finding })

/** The kept tokens' cases, in the order kept, before any stream: the first that does not pass as kept is the finding. */
const keptFinding = (run: SearchRun, searched: Searched): Effect.Effect<Option.Option<Finding>> =>
	Effect.gen(function* () {
		for (const kept of searched.kept) {
			const ran = yield* tokenRun(
				run,
				searched,
				kept.token,
				"kept",
				`the kept case "${kept.reason}"`
			)
			if (ran.kind === "found") {
				return Option.some(ran.finding)
			}
		}
		return Option.none()
	})

/**
 * Replays the one case a token names, printed as it ran: `replayed` with its printed form when it passes as its token
 * says, its finding otherwise.
 */
export const replay =
	(searched: Searched) =>
	(run: SearchRun, token: string): Effect.Effect<Verdict> =>
		Effect.map(tokenRun(run, searched, token, "replayed", "the replayed case"), (ran): Verdict => {
			switch (ran.kind) {
				case "found":
					return failed(ran.finding)
				case "passed":
					return {
						kind: "replayed",
						printed:
							ran.result.outcome.kind === "passed" && ran.result.outcome.shown.kind === "shown"
								? ran.result.outcome.shown.printed
								: { kind: "undrawn", why: "the case passed unprinted" }
					}
			}
		})

/** The places, in declared order, of the required situations no case of these tallies reached. */
const pendingOf = (
	situations: ReadonlyArray<string>,
	tallies: ReadonlyArray<Tally<SteeringPhase>>
): ReadonlyArray<number> =>
	Arr.flatMap(situations, (key, place) =>
		Arr.some(tallies, (tally) => tally.counts.has(key)) ? [] : [place]
	)

/** The keys of the required situations no witness tally reached, in declared order. */
const unreachedOf = (
	situations: ReadonlyArray<string>,
	tallies: ReadonlyArray<Tally<SteeringPhase>>
): ReadonlyArray<string> =>
	Arr.filter(situations, (key) => !Arr.some(tallies, (tally) => tally.counts.has(key)))

/** A window's indices from `start`, `size` of them at most, below `end`. */
const indicesOf = (start: number, size: number, end: number): ReadonlyArray<number> =>
	Array.from({ length: Math.max(0, Math.min(size, end - start)) }, (_, offset) => start + offset)

/** The phases of an exploration each reach runs: its witnesses (kept tokens, floor, steered phase), its rotating stream. */
const PHASES: Readonly<Record<Reach, Readonly<{ witnesses: boolean; rotating: boolean }>>> = {
	full: { witnesses: true, rotating: true },
	witnesses: { witnesses: true, rotating: false },
	rotating: { witnesses: false, rotating: true }
}

/** A random case of a stream: its case seed, nothing skipped. */
const randomOf = (stream: Stream, index: number): ChooserSpec => ({
	kind: "random",
	seed: caseSeed(stream, index),
	skip: 0
})

/** Where a stream sent as series is: its search phase, its steering, and how a case at a place in it is named. */
type StreamPlace = Readonly<{ phase: CasePhase; drawn: Drawn; where: (place: number) => string }>

/** A stream's series, each with the place of its first case in the stream. */
type StreamSeries = ReadonlyArray<readonly [first: number, series: SeriesOrder]>

/**
 * How many cases each series of a stream or space of `count` cases holds: `window` (a steering window, a batch's worth
 * at least), or an even share of the whole for each process the evaluator may run at once when that is more, so no
 * stream or space is cut into more series than its work can spread over. A series is the unit the evaluator's parent
 * answers one at a time, so every series past that many costs the parent an answer and spreads nothing (grizzle's unit
 * tier: 66,103 series of 16 cases each, 3.9 ms of parent time apiece, its parent busy throughout).
 */
const seriesSizeOf = (run: SearchRun, count: number, window: number): number =>
	Math.max(window, Math.ceil(count / run.evaluator.workers))

/**
 * A stream's first `count` cases as series (their case seeds) of seriesSizeOf's size, each to be drawn, run and summed
 * up by the process it is sent to (runner/series.ts) under the stream's steering.
 */
const streamSeriesOf = (
	run: SearchRun,
	stream: Stream,
	count: number,
	window: number,
	group: number,
	drawn: Drawn
): StreamSeries => {
	const series: Array<readonly [number, SeriesOrder]> = []
	const size = seriesSizeOf(run, count, window)
	for (let start = 0; start < count;) {
		const indices = indicesOf(start, size, count)
		series.push([
			start,
			{
				property: run.id,
				from: {
					kind: "stream",
					seeds: Float64Array.from(indices, (index) => caseSeed(stream, index)),
					drawn
				},
				group,
				deadline: run.limits.deadline,
				open: run.limits.open
			}
		])
		start += indices.length
	}
	return series
}

/** Sends every series of a stream at once; the evaluator gives back their summaries in order through the first that stopped. */
const dispatched = (
	run: SearchRun,
	series: StreamSeries
): Effect.Effect<ReadonlyArray<SeriesRan>> =>
	run.evaluator.series(Arr.map(series, ([, order]) => order))

/**
 * A stream's summaries read in stream order into `noted` and `measures` through its first case that stopped: how many
 * passed, and the finding of the one that stopped, when it fails the search.
 */
const judgedStream = (
	run: SearchRun,
	series: StreamSeries,
	ran: ReadonlyArray<SeriesRan>,
	place: StreamPlace,
	noted: (cases: number, notes: ReadonlyArray<Noted>) => void,
	measures: Readonly<{ addAll: (measured: ReadonlyArray<readonly [string, number]>) => void }>
): Effect.Effect<Readonly<{ passed: number; found: Option.Option<Finding> }>> =>
	Effect.gen(function* () {
		let passed = 0
		for (const [at, summary] of ran.entries()) {
			noted(summary.passed, summary.notes)
			measures.addAll(summary.measures)
			passed += summary.passed
			if (summary.stopped.kind === "none") {
				continue
			}
			const firsts = Option.match(Arr.get(series, at), {
				onNone: () => 0,
				onSome: ([first]) => first
			})
			const found = yield* findingOf(run, summary.stopped.result, {
				phase: place.phase,
				where: place.where(firsts + summary.passed),
				drawn: place.drawn,
				shrink: shrinkOf(run, completeShrink)
			})
			if (Option.isSome(found)) {
				return { passed, found }
			}
		}
		return { passed, found: Option.none() }
	})

/**
 * An exploration's search, `group` cases to a batch: kept tokens first; then the witnesses, the floor stream and, while
 * a required situation is unreached, the steered phase grown from it, both fixed by the property's identity; then,
 * for a full run, the rotating stream, fresh each run seed. A property that requires situations runs its witnesses in
 * windows of the runner's steering window, each drawn under the snapshot of what was pending when its window began,
 * since each window's aims read the tallies before it. Its rotating stream, and both streams of a property that
 * requires none (whose floor is steered toward nothing), depend on no result: each is sent at once, every series of it
 * (a window's case seeds or more, seriesSizeOf, drawn, run and summed up by the process it is sent to,
 * runner/series.ts), the second as soon
 * as the property starts when no witness window precedes it, so a property's queued work is its whole sample and
 * spreads where that pays, with no round trip between its windows. Results are judged in case order, so width changes how fast a search runs and never what it finds. A failing case is shrunk by editing its tape,
 * property draws included, under the steering it was drawn under. The coverage verdict is judged on the witnesses
 * alone, before the rotating stream runs, so it is the same on every run seed. The residual comes from the rotating
 * stream's independent cases alone. A batched property's window holds one batch at least, so a batch is never cut
 * short by its window.
 */
export const exploreSearch =
	(searched: Searched, group: number) =>
	(run: SearchRun): Effect.Effect<Verdict> =>
		Effect.gen(function* () {
			const phases = PHASES[run.reach]
			const kept = phases.witnesses ? yield* keptFinding(run, searched) : Option.none()
			if (Option.isSome(kept)) {
				return failed(kept.value)
			}
			const { situations } = searched
			const { limits } = run
			const floorCases = phases.witnesses ? limits.floor : 0
			const window = Math.max(limits.window, group)
			const required = Arr.isReadonlyArrayNonEmpty(situations)
			const keep = required ? "tape" : "nothing"
			const floor = floorSeed(run.id)
			const floorTally = tallyOf("floor")
			const steeredTally = tallyOf("steered")
			const independentTally = tallyOf("independent")
			const seeds = seedsOf()
			const traced = tracerOf()
			const measures = measuring()
			let cases = 0
			const rotating = rotatingSeed(run.seed, floor)
			const rotatingSeries = phases.rotating
				? streamSeriesOf(run, rotating, limits.runs, window, group, { kind: "unsteered" })
				: []
			const floorSeries = required
				? []
				: streamSeriesOf(run, floor, floorCases, window, group, { kind: "steered", pending: [] })
			const floorSent = yield* Effect.forkChild(dispatched(run, floorSeries))
			const rotatingSent = yield* Effect.forkChild(
				required ? Effect.succeedNone : Effect.asSome(dispatched(run, rotatingSeries))
			)
			const witnessedAndSampled: Effect.Effect<Verdict> = Effect.gen(function* () {
				if (required) {
					const floorTurns = turnsOf()
					for (let start = 0; start < floorCases; start += window) {
						const indices = indicesOf(start, window, floorCases)
						const turnAt = floorTurns.window(
							pendingOf(situations, [floorTally.tally()]),
							indices.length
						)
						const draws = Arr.map(indices, (index, offset): Draw => ({
							chooser: randomOf(floor, index),
							drawn: { kind: "steered", pending: turnAt(offset) }
						}))
						const results = yield* windowOf(run, draws, { keep, sense: notesOnly, group })
						for (const [offset, result] of results.entries()) {
							const draw = Arr.getUnsafe(draws, offset)
							const found = yield* findingOf(run, result, {
								phase: "floor",
								where: `the floor stream (seed ${hex(floor)}), case ${start + offset}`,
								drawn: draw.drawn,
								shrink: shrinkOf(run, completeShrink)
							})
							if (Option.isSome(found)) {
								return failed(found.value)
							}
							cases += 1
							floorTally.add(new Set(result.notes))
							measures.add(result)
							if (result.outcome.kind === "passed" && result.outcome.kept.kind === "tape") {
								seeds.keep(result.outcome.kept.tape, new Set(result.notes), traced(result.trace))
							}
						}
					}
				} else {
					const floorSummaries = yield* Fiber.join(floorSent)
					const floorRan = yield* judgedStream(
						run,
						floorSeries,
						floorSummaries,
						{
							phase: "floor",
							drawn: { kind: "steered", pending: [] },
							where: (place) => `the floor stream (seed ${hex(floor)}), case ${place}`
						},
						floorTally.addCases,
						measures
					)
					cases += floorRan.passed
					if (Option.isSome(floorRan.found)) {
						return failed(floorRan.found.value)
					}
				}

				if (required && phases.witnesses) {
					const stream = steeredSeed(floor)
					const turns = turnsOf()
					for (
						let start = 0;
						start < limits.steered &&
						Arr.isReadonlyArrayNonEmpty(
							unreachedOf(situations, [floorTally.tally(), steeredTally.tally()])
						);
						start += window
					) {
						const indices = indicesOf(start, window, limits.steered)
						const tallies = [floorTally.tally(), steeredTally.tally()]
						const turnAt = turns.window(pendingOf(situations, tallies), indices.length)
						const pick = seeds.picker(tallies)
						const draws = Arr.map(indices, (index, offset): Draw => {
							const seed = caseSeed(stream, index)
							const counted = countedWords(seed)
							const picked =
								between(counted.words, 0, FRESH_EVERY - 1) === 0
									? Option.none()
									: pick(counted.words)
							const chooser = Option.match(picked, {
								onNone: (): ChooserSpec => ({ kind: "random", seed, skip: counted.used() }),
								onSome: ([mutated, donor]): ChooserSpec => {
									const mutant = mutate(mutated, Option.some(donor), counted.words)
									return {
										kind: "prefix",
										values: mutant.values.slice(0, mutant.length),
										rest: { kind: "random", seed, skip: counted.used() }
									}
								}
							})
							return { chooser, drawn: { kind: "steered", pending: turnAt(offset) } }
						})
						const results = yield* windowOf(run, draws, {
							keep: "tape",
							sense: searched.guide,
							group
						})
						for (const [offset, result] of results.entries()) {
							const draw = Arr.getUnsafe(draws, offset)
							const found = yield* findingOf(run, result, {
								phase: "steered",
								where: `the steered phase (seed ${hex(stream)}), case ${start + offset}`,
								drawn: draw.drawn,
								shrink: shrinkOf(run, completeShrink)
							})
							if (Option.isSome(found)) {
								return failed(found.value)
							}
							cases += 1
							const notes = new Set(result.notes)
							steeredTally.add(notes)
							measures.add(result)
							if (result.outcome.kind === "passed" && result.outcome.kept.kind === "tape") {
								seeds.keep(result.outcome.kept.tape, notes, traced(result.trace))
							}
						}
					}
					const missing = unreachedOf(situations, [floorTally.tally(), steeredTally.tally()])
					if (Arr.isReadonlyArrayNonEmpty(missing)) {
						return failed({
							kind: "unreached",
							missing,
							witnessed: {
								kind: "streams",
								floor: floorTally.tally().cases,
								steered: steeredTally.tally().cases
							}
						})
					}
				}

				if (phases.rotating) {
					const sent = yield* Fiber.join(rotatingSent)
					const rotatingSummaries = yield* Option.match(sent, {
						onNone: () => dispatched(run, rotatingSeries),
						onSome: Effect.succeed
					})
					const independent = yield* judgedStream(
						run,
						rotatingSeries,
						rotatingSummaries,
						{
							phase: "independent",
							drawn: { kind: "unsteered" },
							where: (place) => `the rotating stream (seed ${hex(rotating)}), case ${place}`
						},
						independentTally.addCases,
						measures
					)
					cases += independent.passed
					if (Option.isSome(independent.found)) {
						return failed(independent.found.value)
					}
				}
				return {
					kind: "explored",
					cases,
					floor: floorTally.tally().cases,
					steered: steeredTally.tally().cases,
					residual: residualOf(independentTally.tally()),
					measures: measures.sums()
				}
			})
			return yield* witnessedAndSampled.pipe(
				Effect.ensuring(Effect.andThen(Fiber.interrupt(floorSent), Fiber.interrupt(rotatingSent)))
			)
		})

/**
 * An exhaustion's search: kept tokens first; then its space counted before any case runs, within the case deadline of
 * CPU (enumerate.ts countWithin: the count's own CPU, which no load or other search stretches), since a space too large
 * to count is too large to exhaust; then every case in enumeration order. The space is run by
 * sketches, one case of the space alone with every case its property's draws enumerate from it, every series of them
 * sent at once, each the steering window's count of sketches (a batch's worth at least), or as many such windows as
 * leave no more series than the evaluator's workers (seriesSizeOf), sent to one process as one unit
 * (runner/series.ts), so the space's whole work is queued from the start and spreads where that pays: the process enumerates them from the series'
 * first branch, runs their cases `group` to an evaluation (one, or a batched exhaustion's batch size), and gives back
 * one summary, so no case crosses a process boundary alone. The series are judged in enumeration order, so the first failing case is the
 * same at any width, and it is shrunk alone for at most as many candidates as the space holds cases. Every case is a
 * witness, so every required situation must be reached by one of them.
 */
export const exhaustSearch =
	(searched: Searched, box: string, group: number) =>
	(run: SearchRun): Effect.Effect<Verdict> =>
		Effect.gen(function* () {
			const kept = yield* keptFinding(run, searched)
			if (Option.isSome(kept)) {
				return failed(kept.value)
			}
			const perSeries = Math.max(run.limits.window, group)
			const counted = yield* run.evaluator.count({
				property: run.id,
				every: perSeries,
				cpu: run.limits.deadline,
				open: run.limits.open
			})
			if (counted.kind === "uncountable") {
				return failed({ kind: "uncountable", box, deadline: run.limits.deadline })
			}
			if (counted.kind === "stopped") {
				const found = yield* findingOf(run, counted.result, {
					phase: "exhaustive",
					where: "the count of the exhaustive space",
					drawn: { kind: "unsteered" },
					shrink: shrinkOf(run, completeShrink)
				})
				return failed(
					Option.getOrElse(found, (): Finding => ({
						kind: "uncountable",
						box,
						deadline: run.limits.deadline
					}))
				)
			}
			const size = counted.cases
			const windows = seriesSizeOf(run, counted.starts.length, 1)
			const starts = Arr.filter(counted.starts, (_, at) => at % windows === 0)
			const tally = tallyOf("exhaustive")
			const measures = measuring()
			let cases = 0
			const ran = yield* run.evaluator.series(
				Arr.map(starts, (start, at): SeriesOrder => ({
					property: run.id,
					from: {
						kind: "sketches",
						start: start.values,
						length: start.length,
						count: Math.min(windows * perSeries, size - at * windows * perSeries)
					},
					group,
					deadline: run.limits.deadline,
					open: run.limits.open
				}))
			)
			for (const summary of ran) {
				cases += summary.passed
				tally.addCases(summary.passed, summary.notes)
				measures.addAll(summary.measures)
				if (summary.stopped.kind === "stopped") {
					const found = yield* findingOf(run, summary.stopped.result, {
						phase: "exhaustive",
						where: `case ${cases} of the exhaustive space of ${size} cases`,
						drawn: { kind: "unsteered" },
						shrink: shrinkOf(run, boundedShrink(size))
					})
					if (Option.isSome(found)) {
						return failed(found.value)
					}
				}
			}
			const missing = unreachedOf(searched.situations, [tally.tally()])
			if (Arr.isReadonlyArrayNonEmpty(missing)) {
				return failed({ kind: "unreached", missing, witnessed: { kind: "space", cases } })
			}
			return { kind: "exhausted", cases, box, measures: measures.sums() }
		})
