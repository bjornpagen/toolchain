import { Array as Arr, Duration, Effect, Option, String as Str } from "effect"
import {
	type Branch,
	type Enumerated,
	enumerated,
	firstBranch,
	nextBranch,
	sizeOf
} from "#enumerate.ts"
import { residualOf, type SteeringPhase, type Tally, tallyOf, turnsOf } from "#features.ts"
import type { Gen } from "#gen.ts"
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
import type {
	Batch,
	CasePhase,
	CaseResult,
	ChooserSpec,
	Finding,
	SearchRun,
	Verdict
} from "#runner/protocol.ts"
import { seedsOf } from "#seeds.ts"
import {
	boundedShrink,
	completeShrink,
	type Judged,
	type ShrinkBudget,
	shrinkInOrder
} from "#shrink.ts"
import { recorder } from "#source.ts"
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

/** What every kind of search reads of its property: its required situations (by key, in declared order) and kept tokens. */
export type Searched = Readonly<{
	situations: ReadonlyArray<string>
	kept: ReadonlyArray<KeptToken>
}>

/** One steered case in this many is a fresh draw rather than a mutant of a seed. */
const FRESH_EVERY = 4

const hex = (seed: number) => `0x${Str.padStart(8, "0")((seed >>> 0).toString(16))}`

/** A case's replay token: its property's identity, the steering it was drawn under, and its tape's values. */
const tokenOf = (id: string, drawn: Drawn, tape: Tape): string =>
	replayTokenOf(id, { drawn, values: Arr.fromIterable(tape.values.subarray(0, tape.length)) })

/** Whether a result ends its window: a case that did not pass. */
const stops = (result: CaseResult): boolean => result.outcome.kind !== "passed"

/** One case of a search, as it is drawn: its chooser and its steering. */
type Draw = Readonly<{ chooser: ChooserSpec; drawn: Drawn }>

/** The order of one drawn case of a search's property. */
const orderOf = (run: SearchRun, draw: Draw, keep: "nothing" | "tape") => ({
	property: run.id,
	chooser: draw.chooser,
	drawn: draw.drawn,
	keep,
	deadline: run.limits.deadline,
	print: "failing" as const
})

/**
 * A window's results, in case order, its orders evaluated `group` to a batch (a batched property's size, one
 * otherwise): one result per order up to the first that did not pass, which ends it.
 */
const windowOf = (
	run: SearchRun,
	draws: ReadonlyArray<Draw>,
	keep: "nothing" | "tape",
	group: number
): Effect.Effect<ReadonlyArray<CaseResult>> =>
	Effect.map(
		run.evaluator.evaluate(
			Arr.chunksOf(
				Arr.map(draws, (draw) => orderOf(run, draw, keep)),
				group
			),
			stops
		),
		Arr.flatten
	)

/** A shrink candidate's verdict: a smaller case of the failure only when its check failed. */
const judgedOf = (result: CaseResult): Judged<CaseResult> => {
	switch (result.outcome.kind) {
		case "failed":
			return { kind: "fails", tape: result.outcome.tape, failure: result }
		case "passed":
		case "misused":
		case "hung":
		case "lost":
			return { kind: "holds" }
	}
}

/** Shrink candidates' verdicts, judged together: each its values forced, under the steering its failure was drawn
 * under, alone in its evaluation. */
const candidatesOf =
	(run: SearchRun, drawn: Drawn) =>
	(
		candidates: Arr.NonEmptyReadonlyArray<Float64Array>
	): Effect.Effect<ReadonlyArray<Judged<CaseResult>>> =>
		Effect.map(
			windowOf(
				run,
				Arr.map(candidates, (values): Draw => ({ chooser: { kind: "forced", values }, drawn })),
				"nothing",
				1
			),
			Arr.map(judgedOf)
		)

/** Where a case of a search came from, as a finding names it, and what a failure there is shrunk under. */
type Origin = Readonly<{ phase: CasePhase; where: string; drawn: Drawn; budget: ShrinkBudget }>

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
		case "hung":
			return Effect.succeedSome({
				kind: "hung",
				phase,
				where,
				printed: outcome.printed,
				token: tokenOf(run.id, drawn, outcome.tape)
			})
		case "failed":
			return Effect.map(
				shrinkInOrder(
					{ tape: outcome.tape, failure: result },
					candidatesOf(run, drawn),
					run.evaluator.width,
					origin.budget
				),
				(shrunk): Option.Option<Finding> => {
					const best = shrunk.best.failure.outcome
					return Option.some({
						kind: "falsified",
						phase,
						where,
						printed: best.kind === "failed" ? best.printed : outcome.printed,
						failure: best.kind === "failed" ? best.failure : outcome.failure,
						shrinking:
							shrunk.ended === "minimal"
								? { kind: "minimal", candidates: shrunk.candidates }
								: { kind: "budget", candidates: shrunk.candidates },
						token: tokenOf(run.id, drawn, shrunk.best.tape)
					})
				}
			)
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
			if (replay.suite !== run.id) {
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
		deadline: run.limits.deadline,
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
								return Effect.map(
									findingOf(run, result, {
										phase,
										where,
										drawn: replayed.drawn,
										budget: completeShrink
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

/** A random case of a stream: its case seed, nothing skipped. */
const randomOf = (stream: Stream, index: number): ChooserSpec => ({
	kind: "random",
	seed: caseSeed(stream, index),
	skip: 0
})

/**
 * An exploration's search, `group` cases to a batch: kept tokens first; then the witnesses, the floor stream and, while
 * a required situation is unreached, the steered phase grown from it, both fixed by the property's identity; then,
 * for a full run, the rotating stream, fresh each run seed. Cases run in windows of the runner's steering window, each
 * drawn under the snapshot of what was pending when its window began; each window's results are judged in case order,
 * so width changes how fast a search runs and never what it finds. A failing case is shrunk by editing its tape,
 * property draws included, under the steering it was drawn under. The coverage verdict is judged on the witnesses
 * alone, before the rotating stream runs, so it is the same on every run seed. The residual comes from the rotating
 * stream's independent cases alone.
 */
export const exploreSearch =
	(searched: Searched, group: number) =>
	(run: SearchRun): Effect.Effect<Verdict> =>
		Effect.gen(function* () {
			const kept = yield* keptFinding(run, searched)
			if (Option.isSome(kept)) {
				return failed(kept.value)
			}
			const { situations } = searched
			const { limits } = run
			const required = Arr.isReadonlyArrayNonEmpty(situations)
			const keep = required ? "tape" : "nothing"
			const floor = floorSeed(run.id)
			const floorTally = tallyOf("floor")
			const steeredTally = tallyOf("steered")
			const independentTally = tallyOf("independent")
			const seeds = seedsOf()
			let cases = 0

			const floorTurns = turnsOf()
			for (let start = 0; start < limits.floor; start += limits.window) {
				const indices = indicesOf(start, limits.window, limits.floor)
				const turnAt = floorTurns.window(
					pendingOf(situations, [floorTally.tally()]),
					indices.length
				)
				const draws = Arr.map(indices, (index, offset): Draw => ({
					chooser: randomOf(floor, index),
					drawn: { kind: "steered", pending: turnAt(offset) }
				}))
				const results = yield* windowOf(run, draws, keep, group)
				for (const [offset, result] of results.entries()) {
					const draw = Arr.getUnsafe(draws, offset)
					const found = yield* findingOf(run, result, {
						phase: "floor",
						where: `the floor stream (seed ${hex(floor)}), case ${start + offset}`,
						drawn: draw.drawn,
						budget: completeShrink
					})
					if (Option.isSome(found)) {
						return failed(found.value)
					}
					cases += 1
					floorTally.add(new Set(result.notes))
					if (result.outcome.kind === "passed" && result.outcome.kept.kind === "tape") {
						seeds.keep(result.outcome.kept.tape, new Set(result.notes), new Uint8Array(0))
					}
				}
			}

			if (required) {
				const stream = steeredSeed(floor)
				const turns = turnsOf()
				for (
					let start = 0;
					start < limits.steered &&
					Arr.isReadonlyArrayNonEmpty(
						unreachedOf(situations, [floorTally.tally(), steeredTally.tally()])
					);
					start += limits.window
				) {
					const indices = indicesOf(start, limits.window, limits.steered)
					const tallies = [floorTally.tally(), steeredTally.tally()]
					const turnAt = turns.window(pendingOf(situations, tallies), indices.length)
					const pick = seeds.picker(tallies)
					const draws = Arr.map(indices, (index, offset): Draw => {
						const seed = caseSeed(stream, index)
						const counted = countedWords(seed)
						const picked =
							between(counted.words, 0, FRESH_EVERY - 1) === 0 ? Option.none() : pick(counted.words)
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
					const results = yield* windowOf(run, draws, "tape", group)
					for (const [offset, result] of results.entries()) {
						const draw = Arr.getUnsafe(draws, offset)
						const found = yield* findingOf(run, result, {
							phase: "steered",
							where: `the steered phase (seed ${hex(stream)}), case ${start + offset}`,
							drawn: draw.drawn,
							budget: completeShrink
						})
						if (Option.isSome(found)) {
							return failed(found.value)
						}
						cases += 1
						const notes = new Set(result.notes)
						steeredTally.add(notes)
						if (result.outcome.kind === "passed" && result.outcome.kept.kind === "tape") {
							seeds.keep(result.outcome.kept.tape, notes, new Uint8Array(0))
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

			if (run.reach === "full") {
				const rotating = rotatingSeed(run.seed, floor)
				for (let start = 0; start < limits.runs; start += limits.window) {
					const draws = Arr.map(indicesOf(start, limits.window, limits.runs), (index): Draw => ({
						chooser: randomOf(rotating, index),
						drawn: { kind: "unsteered" }
					}))
					const results = yield* windowOf(run, draws, "nothing", group)
					for (const [offset, result] of results.entries()) {
						const found = yield* findingOf(run, result, {
							phase: "independent",
							where: `the rotating stream (seed ${hex(rotating)}), case ${start + offset}`,
							drawn: { kind: "unsteered" },
							budget: completeShrink
						})
						if (Option.isSome(found)) {
							return failed(found.value)
						}
						cases += 1
						independentTally.add(new Set(result.notes))
					}
				}
			}
			return {
				kind: "explored",
				cases,
				floor: floorTally.tally().cases,
				steered: steeredTally.tally().cases,
				residual: residualOf(independentTally.tally())
			}
		})

/** One sketch of an exhaustion's space: the branch its cases start at, and how many decisions its space draws there. */
type Sketch = Readonly<{ start: Branch; decisions: number }>

/** What one sketch's run found: each case that passed, its notes in order, and the first case that did not. */
type SketchRan = Readonly<{
	passed: ReadonlyArray<ReadonlyArray<string>>
	stopped: Option.Option<CaseResult>
}>

/** The chooser of an enumeration's branch: its fixed decisions, every later one at its simplest. */
const branchChooser = (branch: Branch): ChooserSpec => ({
	kind: "prefix",
	values: branch.values.slice(0, branch.length),
	rest: { kind: "simplest" }
})

/** A sketch's cases from its start, one after another, through its first case that did not pass or its last. */
const sketchRun = (run: SearchRun, sketch: Sketch): Effect.Effect<SketchRan> =>
	Effect.gen(function* () {
		const passed: Array<ReadonlyArray<string>> = []
		let branch: Option.Option<Branch> = Option.some(sketch.start)
		while (Option.isSome(branch)) {
			const results = yield* windowOf(
				run,
				[{ chooser: branchChooser(branch.value), drawn: { kind: "unsteered" } }],
				"tape",
				1
			)
			const result = Arr.head(results)
			if (Option.isNone(result) || result.value.outcome.kind !== "passed") {
				return { passed, stopped: result }
			}
			passed.push(result.value.notes)
			const outcome = result.value.outcome
			branch =
				outcome.kept.kind === "tape"
					? Option.filter(nextBranch(outcome.kept.tape), (after) => after.length > sketch.decisions)
					: Option.none()
		}
		return { passed, stopped: Option.none() }
	})

/**
 * An exhaustion's search: kept tokens first; then its space counted before any case runs, within the case deadline,
 * since a space too large to count is too large to exhaust; then every case in enumeration order. The space is run by
 * sketches, one case of the space alone with every case its property's draws enumerate from it, as many sketches at
 * once as the evaluator has room for, each sketch's cases one after another; the results are judged in enumeration
 * order, so the first failing case is the same at any width, and it is shrunk for at most as many candidates as the
 * space holds cases. Every case is a witness, so every required situation must be reached by one of them.
 */
export const exhaustSearch =
	(searched: Searched, space: Gen<unknown>, box: string) =>
	(run: SearchRun): Effect.Effect<Verdict> =>
		Effect.gen(function* () {
			const kept = yield* keptFinding(run, searched)
			if (Option.isSome(kept)) {
				return failed(kept.value)
			}
			const counted = yield* Effect.timeoutOption(
				sizeOf(space),
				Duration.millis(run.limits.deadline)
			)
			if (Option.isNone(counted)) {
				return failed({ kind: "uncountable", box, deadline: run.limits.deadline })
			}
			const size = counted.value
			const tally = tallyOf("exhaustive")
			const sketches = recorder()
			let next: Option.Option<Branch> = Option.some(firstBranch)
			let cases = 0
			while (Option.isSome(next)) {
				const room = (yield* run.evaluator.width) * run.limits.window
				const window: Array<Sketch> = []
				while (Option.isSome(next) && window.length < room) {
					const step: Enumerated<unknown> = enumerated(sketches, space, next.value)
					window.push({ start: next.value, decisions: step.generated.tape.length })
					next = step.next
				}
				const ran = yield* Effect.forEach(window, (sketch) => sketchRun(run, sketch), {
					concurrency: "unbounded"
				})
				for (const sketchRan of ran) {
					for (const notes of sketchRan.passed) {
						cases += 1
						tally.add(new Set(notes))
					}
					if (Option.isSome(sketchRan.stopped)) {
						const found = yield* findingOf(run, sketchRan.stopped.value, {
							phase: "exhaustive",
							where: `case ${cases} of the exhaustive space of ${size} cases`,
							drawn: { kind: "unsteered" },
							budget: boundedShrink(size)
						})
						if (Option.isSome(found)) {
							return failed(found.value)
						}
					}
				}
			}
			const missing = unreachedOf(searched.situations, [tally.tally()])
			if (Arr.isReadonlyArrayNonEmpty(missing)) {
				return failed({ kind: "unreached", missing, witnessed: { kind: "space", cases } })
			}
			return { kind: "exhausted", cases, box }
		})
