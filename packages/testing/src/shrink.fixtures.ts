import { Array as Arr, Effect, Option } from "effect"
import { assert } from "#assert.ts"
import { everyCase } from "#chance.fixtures.ts"
import { array, boolean, element, type Gen, int, map, oneOf, span, weighted } from "#gen.ts"
import {
	type Failing,
	type Judged,
	type Ordered,
	type OrderedEnd,
	type ShrinkBudget,
	shrinkInOrder
} from "#shrink.ts"
import {
	type Chooser,
	forcedChooser,
	type Generated,
	generate,
	type Recorder,
	recorder,
	type Source
} from "#source.ts"
import { digestOf, shortlex, type Tape, valuesOf } from "#tape.ts"

/** A list known to be non-empty, as its type says; a list built to hold a case it was asked for holds one. */
const nonEmpty = <A>(values: ReadonlyArray<A>): Arr.NonEmptyReadonlyArray<A> =>
	Option.getOrThrow(Option.liftPredicate(values, Arr.isReadonlyArrayNonEmpty))

/**
 * A generator shape the shrinker is tested on: its items as a flat list, the largest item it draws and the most items,
 * so a predicate's threshold is drawn where some case reaches it. Each space is small enough to enumerate whole.
 */
type Shape = Readonly<{ generator: Gen<ReadonlyArray<number>>; top: number; items: number }>

/** The shapes the shrinker is tested on, by name. */
export const SHAPE_NAMES = ["list", "nested", "weighted", "branchy"] as const

/** A shape's name. */
export type ShapeName = (typeof SHAPE_NAMES)[number]

/** Each shape, by its name. */
const SHAPES: Readonly<Record<ShapeName, Shape>> = {
	list: { generator: array(int(0, 5), { min: 0, max: 3 }), top: 5, items: 3 },
	nested: {
		generator: map(array(array(int(0, 2), { min: 0, max: 2 }), { min: 0, max: 2 }), Arr.flatten),
		top: 2,
		items: 4
	},
	weighted: {
		generator: weighted([
			[1, map(int(0, 9), (item) => [item])],
			[2, array(int(0, 3), { min: 0, max: 2 })]
		]),
		top: 9,
		items: 2
	},
	branchy: {
		generator: (source) =>
			source.draw(boolean)
				? [source.draw(int(0, 5))]
				: [source.draw(int(0, 2)), source.draw(int(0, 2)), source.draw(int(0, 2))],
		top: 5,
		items: 3
	}
}

/** The predicate families a failure is drawn from: the first three are monotone, the last a pair of items in order. */
export const PREDICATES = [
	"an item at least k",
	"a sum at least k",
	"at least k items",
	"a descent"
] as const

/** A predicate family. */
export type Predicate = (typeof PREDICATES)[number]

/** Whether items fail by a predicate at threshold `k`. */
export const failsBy = (predicate: Predicate, k: number) => (items: ReadonlyArray<number>) => {
	switch (predicate) {
		case "an item at least k":
			return Arr.some(items, (item) => item >= k)
		case "a sum at least k":
			return Arr.reduce(items, 0, (sum, item) => sum + item) >= k
		case "at least k items":
			return items.length >= k
		case "a descent":
			return Arr.some(items, (item, at) =>
				Arr.some(Arr.drop(items, at + 1), (later) => later < item)
			)
	}
}

/** The least of failing cases in shortlex order, fewest decisions first: the order shrinking descends. */
export const leastOf = (
	failing: Arr.NonEmptyReadonlyArray<Generated<ReadonlyArray<number>>>
): Generated<ReadonlyArray<number>> =>
	Arr.reduce(failing, Arr.headNonEmpty(failing), (least, generated) =>
		shortlex(generated.tape.values, generated.tape.length, least.tape.values, least.tape.length) ===
		-1
			? generated
			: least
	)

/**
 * The problems whose least failing case every failing case of the space reaches by the shrinker's moves alone:
 * deleting an item or a span, lowering a decision, setting a span simplest and swapping two items. Those moves never
 * raise a decision, so they cannot merge two items into one larger item (a sum, or a length across nested lists),
 * move a value from one item to another, or switch a weighted choice or a branch to an arm that draws fewer decisions
 * with larger values; from such a case the shrunk case is a local least, no larger than where it began.
 */
export const reachesLeast = (shape: ShapeName, predicate: Predicate): boolean => {
	switch (shape) {
		case "list":
			return predicate !== "a sum at least k"
		case "nested":
			return predicate === "an item at least k"
		case "weighted":
			return predicate === "at least k items" || predicate === "a descent"
		case "branchy":
			return false
	}
}

/** A shrink problem: a shape, and a predicate with its threshold drawn where some case of the shape can reach it. */
export type Problem = Readonly<{ shape: ShapeName; predicate: Predicate; k: number }>

/**
 * The problems of a shape whose space holds a failing case: every predicate, with each k from 1 to the most its shape
 * allows, that some case of the space fails. A problem is drawn among them, so every problem has a case to shrink, by
 * construction.
 */
const failingProblemsOf = (shape: ShapeName): Arr.NonEmptyReadonlyArray<Problem> => {
	const { top, items, generator } = SHAPES[shape]
	const cases = everyCase(generator)
	return nonEmpty(
		Arr.flatMap(PREDICATES, (predicate) =>
			Arr.filter(
				Array.from(
					{
						length:
							predicate === "at least k items"
								? items
								: predicate === "a sum at least k"
									? top * items
									: top
					},
					(_, i): Problem => ({ shape, predicate, k: i + 1 })
				),
				(problem) =>
					Arr.some(cases, (generated) => failsBy(problem.predicate, problem.k)(generated.value))
			)
		)
	)
}

/** A shape, then one of its problems whose space holds a failing case. */
const problems: Gen<Problem> = (source) =>
	source.draw(element(failingProblemsOf(source.draw(element(SHAPE_NAMES)))))

/** A problem's shape's generator. */
export const generatorOfShape = (shape: ShapeName): Gen<ReadonlyArray<number>> =>
	SHAPES[shape].generator

/** The failing cases of a problem's space, in enumeration order, and the predicate they fail by. */
export const failingOf = (
	problem: Problem
): Readonly<{
	fails: (items: ReadonlyArray<number>) => boolean
	failing: Arr.NonEmptyReadonlyArray<Generated<ReadonlyArray<number>>>
}> => {
	const fails = failsBy(problem.predicate, problem.k)
	return {
		fails,
		failing: nonEmpty(
			Arr.filter(everyCase(SHAPES[problem.shape].generator), (generated) => fails(generated.value))
		)
	}
}

/**
 * How a judge gives a round's verdicts back, as shrinkInOrder admits either: every candidate's, or in candidate order
 * up to the first that fails.
 */
const GIVINGS = ["every verdict", "up to the first failure"] as const

/** How a judge gives a round's verdicts back. */
type Giving = (typeof GIVINGS)[number]

/**
 * How a shrink is judged: the widths it reads, one each time it reads its width and over again from the first, as a
 * pool's free width moves between rounds; and how its judge gives verdicts back.
 */
export type Judging = Readonly<{ widths: Arr.NonEmptyReadonlyArray<number>; giving: Giving }>

/** The sequential shrink every other judging must agree with: one candidate a round, every verdict given. */
export const sequential: Judging = { widths: [1], giving: "every verdict" }

/** A width a shrink reads: from one, the sequential shrink, to wider than a round of these small tapes proposes. */
const width = int(1, 16)

/** A judging: one to four widths, the first always there, and either way of giving verdicts. */
const judgings: Gen<Judging> = (source) => ({
	widths: [source.draw(width), ...source.draw(array(width, { min: 0, max: 3 }))],
	giving: source.draw(element(GIVINGS))
})

/** A shrink problem and how its shrink is judged. */
export const judgedProblems: Gen<Readonly<{ problem: Problem; judging: Judging }>> = (source) => ({
	problem: source.draw(problems),
	judging: source.draw(judgings)
})

/** A shrink problem, a budget of candidates from none to more than most of its shrinks spend, and its judging. */
export const budgetedProblems: Gen<
	Readonly<{ problem: Problem; budget: number; judging: Judging }>
> = (source) => ({
	problem: source.draw(problems),
	budget: source.draw(int(0, 40)),
	judging: source.draw(judgings)
})

/**
 * One round of judging as its judge saw it: the width read last before it, the best case its candidates were proposed
 * from, as the acceptance rule restated here tracks it, the candidates, how many verdicts were given back, how many of
 * them the shrink counted, and whether it accepted one.
 */
export type Round = Readonly<{
	width: number
	best: Tape
	proposed: Arr.NonEmptyReadonlyArray<Float64Array>
	given: number
	counted: number
	accepted: boolean
}>

/** What a shrink reached: its best case's values, and the candidates it counted. */
export type Reached = Readonly<{ values: ReadonlyArray<number>; candidates: number }>

/**
 * A shrink in candidate order, the rounds its judge saw, and what the judge saw it reach: the best case the acceptance
 * rule restated here tracked, and the verdicts it counted, round by round.
 */
export type Watched<X, U> = Readonly<{
	shrunk: Ordered<X, U>
	rounds: ReadonlyArray<Round>
	seen: Reached
}>

/** A round's verdicts, as a judging gives them back: every one, or in order up to the first that fails. */
const verdictsOf = <X, U>(
	giving: Giving,
	candidates: Arr.NonEmptyReadonlyArray<Float64Array>,
	run: (values: Float64Array) => Effect.Effect<Judged<X, U>>
): Effect.Effect<ReadonlyArray<Judged<X, U>>> => {
	switch (giving) {
		case "every verdict":
			return Effect.forEach(candidates, run)
		case "up to the first failure":
			return Effect.gen(function* () {
				const given: Array<Judged<X, U>> = []
				for (const values of candidates) {
					const verdict = yield* run(values)
					given.push(verdict)
					if (verdict.kind === "fails") {
						return given
					}
				}
				return given
			})
	}
}

/**
 * The verdict a shrink accepts among a round's, as its documentation states the rule: the first in candidate order
 * that fails with a tape smaller than the best, and where it stands.
 */
const acceptedOf = <X, U>(
	verdicts: ReadonlyArray<Judged<X, U>>,
	best: Tape
): Option.Option<Readonly<{ at: number; tape: Tape }>> => {
	for (const [at, verdict] of verdicts.entries()) {
		if (
			verdict.kind === "fails" &&
			shortlex(verdict.tape.values, verdict.tape.length, best.values, best.length) === -1
		) {
			return Option.some({ at, tape: verdict.tape })
		}
	}
	return Option.none()
}

/**
 * Shrinks a failing case in candidate order under a judging, each candidate run by `run`, and keeps what the judge saw
 * of every round (Round).
 */
export const shrunkUnder = <X, U>(
	judging: Judging,
	failing: Failing<X>,
	run: (values: Float64Array) => Effect.Effect<Judged<X, U>>,
	budget: ShrinkBudget
): Effect.Effect<Watched<X, U>> =>
	Effect.suspend(() => {
		const rounds: Array<Round> = []
		let reads = 0
		let read = Arr.headNonEmpty(judging.widths)
		let best = failing.tape
		const widthNow = Effect.sync(() => {
			read = Arr.getUnsafe(judging.widths, reads % judging.widths.length)
			reads += 1
			return read
		})
		const judge = (candidates: Arr.NonEmptyReadonlyArray<Float64Array>) =>
			Effect.map(verdictsOf(judging.giving, candidates, run), (verdicts) => {
				const accepted = acceptedOf(verdicts, best)
				rounds.push({
					width: read,
					best,
					proposed: candidates,
					given: verdicts.length,
					counted: Option.match(accepted, {
						onNone: () => verdicts.length,
						onSome: ({ at }) => at + 1
					}),
					accepted: Option.isSome(accepted)
				})
				best = Option.match(accepted, { onNone: () => best, onSome: ({ tape }) => tape })
				return verdicts
			})
		return Effect.map(shrinkInOrder(failing, judge, widthNow, budget), (shrunk) => ({
			shrunk,
			rounds,
			seen: {
				values: valuesOf(best),
				candidates: Arr.reduce(rounds, 0, (counted, round) => counted + round.counted)
			}
		}))
	})

/** What a shrink says it reached. */
export const reachedOf = <X, U>({ shrunk }: Watched<X, U>): Reached => ({
	values: valuesOf(shrunk.best.tape),
	candidates: shrunk.candidates
})

/** What a shrink says it reached, and why it ended. */
export const outcomeOf = <X, U>(watched: Watched<X, U>) => ({
	...reachedOf(watched),
	ended: watched.shrunk.ended
})

/**
 * The situations of judging many candidates at once, each a way shrinkInOrder reads a round's verdicts: candidates
 * judged after the one it accepted are let go; a judge gave back fewer verdicts than candidates, stopping at a
 * failure; a round proposed fewer candidates than its width, its pass ending first.
 */
export const JUDGING_FEATURES = [
	"candidates let go after an acceptance",
	"verdicts held back after a failure",
	"a round shorter than its width"
] as const

/** A situation of judging many candidates at once. */
type JudgingFeature = (typeof JUDGING_FEATURES)[number]

/** Whether a round reached each situation of judging many candidates at once. */
const REACHED_BY: Readonly<Record<JudgingFeature, (round: Round) => boolean>> = {
	"candidates let go after an acceptance": (round) => round.accepted && round.counted < round.given,
	"verdicts held back after a failure": (round) => round.given < round.proposed.length,
	"a round shorter than its width": (round) => round.proposed.length < round.width
}

/**
 * A shrink problem, how many of its candidates its judge cannot judge (one in `every`, by their values' digest, as a
 * need fails the cases that reach a broken member of a cluster), and its judging.
 */
export const unjudgedProblems: Gen<
	Readonly<{ problem: Problem; every: number; judging: Judging }>
> = (source) => ({
	problem: source.draw(problems),
	every: source.draw(int(2, 6)),
	judging: source.draw(judgings)
})

/** Whether a candidate is one in `every` its judge cannot judge, by its values' digest. */
export const unjudgedAt =
	(every: number) =>
	(values: Float64Array): boolean =>
		digestOf(values, values.length) % every === 0

/** A judge that cannot judge the candidates `unjudged` holds of, their values why, and judges the rest by `run`. */
export const stoppedBy =
	(
		unjudged: (values: Float64Array) => boolean,
		run: (values: Float64Array) => Effect.Effect<Judged<ReadonlyArray<number>, never>>
	) =>
	(values: Float64Array): Effect.Effect<Judged<ReadonlyArray<number>, ReadonlyArray<number>>> =>
		unjudged(values)
			? Effect.succeed({ kind: "unjudged", why: Arr.fromIterable(values) })
			: run(values)

/** A judge that finds the candidates `unjudged` holds of holding, and judges the rest by `run`. */
export const heldBy =
	(
		unjudged: (values: Float64Array) => boolean,
		run: (values: Float64Array) => Effect.Effect<Judged<ReadonlyArray<number>, never>>
	) =>
	(values: Float64Array): Effect.Effect<Judged<ReadonlyArray<number>, never>> =>
		unjudged(values) ? Effect.succeed({ kind: "holds" }) : run(values)

/** Where a shrink ended: why, its best case's values, the candidates it counted, and the candidate that stopped it. */
export type Stop = Readonly<{
	ended: OrderedEnd | "unjudged"
	values: ReadonlyArray<number>
	candidates: number
	why: Option.Option<ReadonlyArray<number>>
}>

/** Where a shrink whose judge gave unjudged candidates' values as why ended. */
export const stopOf = ({
	shrunk
}: Watched<ReadonlyArray<number>, ReadonlyArray<number>>): Stop => ({
	ended: shrunk.ended,
	values: valuesOf(shrunk.best.tape),
	candidates: shrunk.candidates,
	why: shrunk.ended === "unjudged" ? Option.some(shrunk.why) : Option.none()
})

/**
 * Where a shrink that stops at its first candidate `unjudged` holds of ends, as the sequential shrink that found those
 * candidates holding (`held`, one candidate a round) shows it: at the first round that proposed one, with that round's
 * best, the candidates counted before it and its values; where `held` ended, when it proposed none.
 */
export const stoppedAt = (
	held: Watched<ReadonlyArray<number>, never>,
	unjudged: (values: Float64Array) => boolean
): Stop =>
	Option.match(
		Arr.findFirstIndex(held.rounds, (round) => unjudged(Arr.headNonEmpty(round.proposed))),
		{
			onNone: (): Stop => ({
				ended: held.shrunk.ended,
				values: valuesOf(held.shrunk.best.tape),
				candidates: held.shrunk.candidates,
				why: Option.none()
			}),
			onSome: (at): Stop => {
				const round = Arr.getUnsafe(held.rounds, at)
				return {
					ended: "unjudged",
					values: valuesOf(round.best),
					candidates: Arr.reduce(
						Arr.take(held.rounds, at),
						0,
						(counted, before) => counted + before.counted
					),
					why: Option.some(Arr.fromIterable(Arr.headNonEmpty(round.proposed)))
				}
			}
		}
	)

/** The situations of judging many candidates at once that some round of a shrink reached. */
export const judgingFeaturesOf = (rounds: ReadonlyArray<Round>): ReadonlyArray<JudgingFeature> =>
	Arr.filter(JUDGING_FEATURES, (feature) => Arr.some(rounds, REACHED_BY[feature]))

/** Whether some round read a width wider than the candidates its budget had left. */
export const widthPastRoom = (rounds: ReadonlyArray<Round>, budget: number): boolean =>
	Arr.some(
		rounds,
		(round, at) =>
			round.width >
			budget - Arr.reduce(Arr.take(rounds, at), 0, (counted, before) => counted + before.counted)
	)

/** Candidates of a plain generator, each generated from its values on one recorder and judged by `fails`. */
export const judgedBy = (
	generator: Gen<ReadonlyArray<number>>,
	fails: (items: ReadonlyArray<number>) => boolean
): ((values: Float64Array) => Effect.Effect<Judged<ReadonlyArray<number>, never>>) => {
	const recorded = recorder()
	return (values) =>
		Effect.sync(() => {
			const candidate = generate(recorded, generator, forcedChooser(values, values.length))
			return fails(candidate.value)
				? { kind: "fails", tape: candidate.tape, failure: candidate.value }
				: { kind: "holds" }
		})
}

/**
 * A generator's form, drawn at random so the shrinker meets tapes of every shape: a leaf draws a whole number up to its
 * top; a list draws between its least and most items of its item's form, a size that may admit one length; a choice
 * draws one of its arms; a run draws its parts in turn, in a span of its own.
 */
type Form =
	| Readonly<{ kind: "leaf"; top: number }>
	| Readonly<{ kind: "list"; item: Form; min: number; max: number }>
	| Readonly<{ kind: "choice"; arms: Arr.NonEmptyReadonlyArray<Form> }>
	| Readonly<{ kind: "run"; parts: ReadonlyArray<Form> }>

/** The kinds of form, the leaf first, so a form shrinks toward a leaf. */
const FORM_KINDS = ["leaf", "list", "choice", "run"] as const

/** A form at most `depth` levels deep, a leaf at the last level. */
const formOf =
	(depth: number): Gen<Form> =>
	(source) => {
		switch (depth === 0 ? "leaf" : source.draw(element(FORM_KINDS))) {
			case "leaf":
				return { kind: "leaf", top: source.draw(int(0, 9)) }
			case "list": {
				const min = source.draw(int(0, 3))
				return {
					kind: "list",
					item: source.draw(formOf(depth - 1)),
					min,
					max: source.draw(int(min, 4))
				}
			}
			case "choice":
				return {
					kind: "choice",
					arms: [
						source.draw(formOf(depth - 1)),
						...source.draw(array(formOf(depth - 1), { min: 0, max: 2 }))
					]
				}
			case "run":
				return { kind: "run", parts: source.draw(array(formOf(depth - 1), { min: 0, max: 3 })) }
		}
	}

/**
 * The generator a form describes, built of the library's own combinators, its leaves drawn onto `leaves` in order.
 * After each leaf `stops` is asserted not to hold of them, so a case it holds of fails right there, inside every draw
 * open at that leaf, as a property that fails inside a draw does.
 */
const generatorOf = (
	form: Form,
	leaves: Array<number>,
	stops: (leaves: ReadonlyArray<number>) => boolean
): Gen<unknown> => {
	switch (form.kind) {
		case "leaf":
			return map(int(0, form.top), (leaf) => {
				leaves.push(leaf)
				assert.ok(!stops(leaves), "the case fails inside its draw")
			})
		case "list":
			return array(generatorOf(form.item, leaves, stops), { min: form.min, max: form.max })
		case "choice":
			return oneOf(Arr.map(form.arms, (arm) => generatorOf(arm, leaves, stops)))
		case "run": {
			const parts = Arr.map(form.parts, (part) => generatorOf(part, leaves, stops))
			return span("run", (source) => Arr.map(parts, (part) => source.draw(part)))
		}
	}
}

/** Where a case's failure is found: once it has drawn everything, or at the first leaf it fails by. */
export const FOUND = ["at its end", "inside a draw"] as const

/** Where a case's failure is found. */
export type Found = (typeof FOUND)[number]

/**
 * Draws a case of a form on `recorded` against `chooser`, its leaves onto `leaves`, as a search's case runner draws a
 * case on a recorder its pool reuses.
 */
const drawOn = (
	recorded: Recorder,
	form: Form,
	leaves: Array<number>,
	stops: (leaves: ReadonlyArray<number>) => boolean,
	chooser: Chooser
): void => {
	recorded.reset(chooser)
	generatorOf(form, leaves, stops)(recorded.source)
}

/** A case of a form as a shrink candidate runs: it fails by its leaves, with the tape it drew, or it holds. */
export type Ran =
	| Readonly<{ kind: "fails"; tape: Tape; failure: ReadonlyArray<number> }>
	| Readonly<{ kind: "holds"; tape: Tape }>

/**
 * A shrink candidate of a form on `recorded`: its values drawn as a case's, and judged by `fails`. A draw that fails
 * ends the case there, and its tape is copied out with every span open at that leaf still open, as a search copies out
 * the tape of a property that failed inside a draw.
 */
export const ranOn =
	(
		recorded: Recorder,
		form: Form,
		fails: (leaves: ReadonlyArray<number>) => boolean,
		stops: (leaves: ReadonlyArray<number>) => boolean
	) =>
	(values: Float64Array): Effect.Effect<Ran> => {
		const leaves: Array<number> = []
		return Effect.map(
			Effect.exit(
				Effect.sync(() =>
					drawOn(recorded, form, leaves, stops, forcedChooser(values, values.length))
				)
			),
			(): Ran => {
				const tape = recorded.tape()
				return fails(leaves) ? { kind: "fails", tape, failure: leaves } : { kind: "holds", tape }
			}
		)
	}

/** A candidate's run as the shrink reads its verdict: still failing with its tape, or holding. */
export const judgedOf = (ran: Ran): Judged<ReadonlyArray<number>, never> => {
	switch (ran.kind) {
		case "fails":
			return ran
		case "holds":
			return { kind: "holds" }
	}
}

/** The decisions of another case's source, so a case drawn on them replays and shrinks with that case. */
const through = (source: Source): Chooser => ({
	exhausted: () => false,
	draw: (lo, hi, _at, spread) => {
		switch (spread.kind) {
			case "leaning":
				return source.choose(lo, hi)
			case "uniform":
				return source.pick(lo, hi)
			case "weighted":
				return lo + source.weigh(spread)
			case "recalled":
				return source.recall(hi)
		}
	}
})

/** A whole case of a form, drawn on `recorded` through the case's own source, so it replays and shrinks with it. */
export const wholeOn =
	(recorded: Recorder, form: Form): Gen<Readonly<{ tape: Tape; leaves: ReadonlyArray<number> }>> =>
	(source) => {
		const leaves: Array<number> = []
		drawOn(recorded, form, leaves, () => false, through(source))
		return { tape: recorded.tape(), leaves }
	}

/** The largest threshold leaves fail by under a predicate that has one: their largest, their sum, or their count. */
export const thresholdOf = (predicate: Predicate, leaves: ReadonlyArray<number>): number => {
	switch (predicate) {
		case "an item at least k":
			return Arr.reduce(leaves, 0, (most, leaf) => Math.max(most, leaf))
		case "a sum at least k":
			return Arr.reduce(leaves, 0, (sum, leaf) => sum + leaf)
		case "at least k items":
			return leaves.length
		case "a descent":
			return 1
	}
}

/** A run of a tape's decisions, `[start, end)`. */
type Run = Readonly<{ start: number; end: number }>

/** The runs a tape's spans label. */
const spanRunsOf = (tape: Tape): ReadonlyArray<Run> =>
	Arr.map(Arr.fromIterable(tape.spanLabel.keys()), (at) => ({
		start: tape.spanStart[at] ?? 0,
		end: tape.spanEnd[at] ?? 0
	}))

/** Whether every span of a tape lies within its decisions. */
export const spansWithin = (tape: Tape): boolean =>
	Arr.every(spanRunsOf(tape), ({ start, end }) => start >= 0 && start <= end && end <= tape.length)

/**
 * The collections of a tape as `array` draws them: each `array` span, the decisions from its start to its first item
 * that count it, and its items, the `element` spans directly inside it.
 */
const arraysOf = (tape: Tape): ReadonlyArray<Readonly<{ count: Run; items: ReadonlyArray<Run> }>> =>
	Arr.flatMap(Arr.fromIterable(tape.spanLabel.entries()), ([held, label]) => {
		if (label !== "array") {
			return []
		}
		const depth = tape.spanDepth[held] ?? 0
		const inside = Arr.takeWhile(
			Arr.drop(Arr.fromIterable(tape.spanLabel.keys()), held + 1),
			(at) => (tape.spanDepth[at] ?? 0) > depth
		)
		const items = Arr.map(
			Arr.filter(
				inside,
				(at) => tape.spanLabel[at] === "element" && tape.spanDepth[at] === depth + 1
			),
			(at) => ({ start: tape.spanStart[at] ?? 0, end: tape.spanEnd[at] ?? 0 })
		)
		const count = {
			start: tape.spanStart[held] ?? 0,
			end: Option.match(Arr.head(items), {
				onNone: () => tape.spanEnd[held] ?? 0,
				onSome: (first) => first.start
			})
		}
		return [{ count, items }]
	})

/** Values with the run removed. */
const cut = (values: ReadonlyArray<number>, run: Run): ReadonlyArray<number> => [
	...values.slice(0, run.start),
	...values.slice(run.end)
]

/**
 * Every candidate the shrinker's passes may build from a tape, as its documentation states them, by a second
 * implementation over the tape's spans: a span deleted or set to its simplest, an item of a collection deleted with each
 * decision that counts the collection one lower, and two items of a collection exchanged. Lowering one decision is
 * judged by `lowered`.
 */
const movesOf = (tape: Tape): ReadonlyArray<ReadonlyArray<number>> => {
	const values = valuesOf(tape)
	const lows = Arr.fromIterable(tape.lo)
	const spans = Arr.flatMap(spanRunsOf(tape), (run) => [
		cut(values, run),
		[...values.slice(0, run.start), ...lows.slice(run.start, run.end), ...values.slice(run.end)]
	])
	const items = Arr.flatMap(arraysOf(tape), ({ count, items: runs }) =>
		Arr.flatMap(runs, (item, at) => [
			Arr.map(cut(values, item), (value, position) =>
				position >= count.start && position < count.end ? value - 1 : value
			),
			...Arr.map(Arr.drop(runs, at + 1), (later) => [
				...values.slice(0, item.start),
				...values.slice(later.start, later.end),
				...values.slice(item.end, later.start),
				...values.slice(item.start, item.end),
				...values.slice(later.end)
			])
		])
	)
	return [...spans, ...items]
}

/** Whether a candidate is a tape with one decision lowered toward its simplest. */
const lowered = (tape: Tape, candidate: ReadonlyArray<number>): boolean => {
	const differing = Arr.filter(
		Arr.fromIterable(tape.values.keys()),
		(at) => candidate[at] !== tape.values[at]
	)
	return (
		candidate.length === tape.length &&
		differing.length === 1 &&
		Arr.every(
			differing,
			(at) =>
				(candidate[at] ?? 0) >= (tape.lo[at] ?? 0) && (candidate[at] ?? 0) < (tape.values[at] ?? 0)
		)
	)
}

/** Whether two runs of values are the same values. */
const sameValues = (left: ReadonlyArray<number>, right: ReadonlyArray<number>): boolean =>
	left.length === right.length && Arr.every(left, (value, at) => value === right[at])

/**
 * The candidates of a shrink's rounds that are none of the shrinker's documented moves of the best case they were
 * proposed from: neither a move of movesOf nor one decision lowered.
 */
export const straysOf = (rounds: ReadonlyArray<Round>): ReadonlyArray<ReadonlyArray<number>> =>
	Arr.flatMap(rounds, (round) => {
		const moves = movesOf(round.best)
		return Arr.filter(
			Arr.map(round.proposed, (values) => Arr.fromIterable(values)),
			(candidate) =>
				!lowered(round.best, candidate) && !Arr.some(moves, (move) => sameValues(move, candidate))
		)
	})

/**
 * Each decision of a tape lowered alone, as the lowering pass ends with it once nothing it tries is accepted: to its
 * simplest, and to one below its value, the last value its bisection tries.
 */
const loweringsOf = (tape: Tape): ReadonlyArray<ReadonlyArray<number>> => {
	const values = valuesOf(tape)
	const at = (position: number, value: number) => [
		...values.slice(0, position),
		value,
		...values.slice(position + 1)
	]
	return Arr.flatMap(Arr.fromIterable(tape.lo), (lo, position) => {
		const value = values[position] ?? lo
		return value > lo ? [at(position, lo), at(position, value - 1)] : []
	})
}

/**
 * The documented moves of a shrink's best case that the acceptance rule would accept: each move smaller than the case
 * (a span deleted or set simplest, an item deleted with its count lowered, two items exchanged, a decision at its
 * simplest or one below its value) whose run fails with a tape smaller than the case's. A shrink that ended minimal
 * judged every one of them in its last round and accepted none, so none is left: its best case is a local least of its
 * moves.
 */
export const acceptedMovesOf = <X, U>(
	best: Tape,
	run: (values: Float64Array) => Effect.Effect<Judged<X, U>>
): Effect.Effect<ReadonlyArray<ReadonlyArray<number>>> =>
	Effect.filter(
		Arr.filter([...movesOf(best), ...loweringsOf(best)], (move) => {
			const values = Float64Array.from(move)
			return shortlex(values, values.length, best.values, best.length) === -1
		}),
		(move) =>
			Effect.map(
				run(Float64Array.from(move)),
				(verdict) =>
					verdict.kind === "fails" &&
					shortlex(verdict.tape.values, verdict.tape.length, best.values, best.length) === -1
			)
	)

/** A shrink of a drawn form: its form, the predicate its case fails by, where the failure is found, and its judging. */
export type Formed = Readonly<{ form: Form; predicate: Predicate; found: Found; judging: Judging }>

/** A form up to three levels deep, a predicate, where its failure is found, and its judging. */
export const formedProblems: Gen<Formed> = (source) => ({
	form: source.draw(formOf(3)),
	predicate: source.draw(element(PREDICATES)),
	found: source.draw(element(FOUND)),
	judging: source.draw(judgings)
})
