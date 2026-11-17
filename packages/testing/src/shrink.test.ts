/**
 * Shrinking in candidate order (shrink.ts shrinkInOrder), held to what it promises over tapes of every shape: a failing
 * case shrinks to one that still fails, no larger, the same on a repeat and the same at every width and however its
 * judge gives verdicts back, to a local least of its moves, and to its space's least wherever its moves reach it; it
 * never throws, and proposes only its documented moves of the smallest failing case so far, accepting the first smaller
 * failure in candidate order and counting exactly the verdicts it read, returning one its own decisions replay; and it
 * spends at most its budget of candidates, saying so when the budget stopped it; and it stops at the first candidate in
 * candidate order its judge could not judge, judging none after it. Each shrink is driven directly: a
 * drawn generator and failure, and a judge that replays each candidate's values through the generator. Oracles are
 * stated per property.
 */
import { Array as Arr, Effect } from "effect"
import { assertTrue, deepStrictEqual, fail, strictEqual } from "#assert.ts"
import { int } from "#gen.ts"
import { property } from "#property.ts"
import {
	acceptedMovesOf,
	budgetedProblems,
	FOUND,
	failingOf,
	failsBy,
	formedProblems,
	generatorOfShape,
	heldBy,
	JUDGING_FEATURES,
	judgedBy,
	judgedOf,
	judgedProblems,
	judgingFeaturesOf,
	leastOf,
	outcomeOf,
	PREDICATES,
	ranOn,
	reachedOf,
	reachesLeast,
	SHAPE_NAMES,
	sequential,
	shrunkUnder,
	spansWithin,
	stopOf,
	stoppedAt,
	stoppedBy,
	straysOf,
	thresholdOf,
	unjudgedAt,
	unjudgedProblems,
	wholeOn,
	widthPastRoom
} from "#shrink.fixtures.ts"
import { boundedShrink, completeShrink } from "#shrink.ts"
import { recorder } from "#source.ts"
import { shortlex, valuesOf } from "#tape.ts"

/**
 * A failing case shrinks to one that still fails, no larger, the same on a repeat and the same at every width and
 * either way of giving verdicts back: a local least of its moves, none of which it would accept, and its space's least
 * wherever its moves reach it.
 */
export const shrinksToTheLeast = property.explore(judgedProblems, {
	needs: {},
	situations: [...SHAPE_NAMES, ...PREDICATES, ...JUDGING_FEATURES],
	check:
		(_resources, c) =>
		({ problem, judging }) =>
			Effect.gen(function* () {
				const { fails, failing } = failingOf(problem)
				c.note(problem.shape)
				c.note(problem.predicate)
				const begun = Arr.getUnsafe(failing, c.draw(int(0, failing.length - 1)))
				const start = { tape: begun.tape, failure: begun.value }
				const run = judgedBy(generatorOfShape(problem.shape), fails)
				const alone = yield* shrunkUnder(sequential, start, run, completeShrink)
				const again = yield* shrunkUnder(sequential, start, run, completeShrink)
				const judged = yield* shrunkUnder(judging, start, run, completeShrink)
				c.noteAll(judgingFeaturesOf(judged.rounds))
				const accepted = yield* acceptedMovesOf(alone.shrunk.best.tape, run)
				deepStrictEqual(
					{
						fails: fails(alone.shrunk.best.failure),
						noLarger:
							shortlex(
								alone.shrunk.best.tape.values,
								alone.shrunk.best.tape.length,
								begun.tape.values,
								begun.tape.length
							) <= 0,
						ended: alone.shrunk.ended,
						localLeast: Arr.take(accepted, 1),
						repeat: outcomeOf(again),
						judged: outcomeOf(judged),
						seen: judged.seen
					},
					{
						fails: true,
						noLarger: true,
						ended: "minimal",
						localLeast: [],
						repeat: outcomeOf(alone),
						judged: outcomeOf(alone),
						seen: reachedOf(judged)
					}
				)
				if (reachesLeast(problem.shape, problem.predicate)) {
					deepStrictEqual(valuesOf(alone.shrunk.best.tape), valuesOf(leastOf(failing).tape))
				}
			}),
	oracle: {
		kind: "second-implementation",
		name: "the space enumerated whole, its least failing case in shortlex order; the shrunk case's documented moves judged again; the sequential shrink, one candidate a round"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/shrink.ts",
			original: "\t\t\t\t\tif (search.low + 1 >= search.high) {",
			replacement: "\t\t\t\t\tif (search.low + 2 >= search.high) {",
			why: "Lowering a decision stops its bisection one step short, so a shrink can end above its space's least; the least-case property fails."
		}
	]
})

/**
 * Shrinking never throws and proposes only its documented moves of the smallest failing case so far, over tapes of
 * every shape failing at their end or inside a draw on a reused recorder, judged at any width; it accepts the first
 * smaller failure in candidate order and counts exactly the verdicts it read; and it returns a failing case no larger
 * than where it began, a local least of its moves, which its own decisions replay, the same as the sequential
 * shrink's.
 */
export const shrinksByItsMoves = property.explore(formedProblems, {
	needs: {},
	situations: [...FOUND, ...PREDICATES, ...JUDGING_FEATURES],
	check:
		(_resources, c) =>
		({ form, predicate, found, judging }) =>
			Effect.gen(function* () {
				const recorded = recorder()
				const whole = c.draw(wholeOn(recorded, form))
				const fails = failsBy(
					predicate,
					c.draw(int(1, Math.max(1, thresholdOf(predicate, whole.leaves))))
				)
				const attempt = ranOn(
					recorded,
					form,
					fails,
					found === "inside a draw" ? fails : () => false
				)
				const begun = yield* attempt(whole.tape.values)
				if (begun.kind === "holds") {
					return
				}
				c.note(found)
				c.note(predicate)
				const run = (values: Float64Array) => Effect.map(attempt(values), judgedOf)
				const judged = yield* shrunkUnder(judging, begun, run, completeShrink)
				const alone = yield* shrunkUnder(sequential, begun, run, completeShrink)
				c.noteAll(judgingFeaturesOf(judged.rounds))
				const replayed = yield* attempt(judged.shrunk.best.tape.values)
				const accepted = yield* acceptedMovesOf(judged.shrunk.best.tape, run)
				deepStrictEqual(
					{
						fails: fails(judged.shrunk.best.failure),
						noLarger:
							shortlex(
								judged.shrunk.best.tape.values,
								judged.shrunk.best.tape.length,
								begun.tape.values,
								begun.tape.length
							) <= 0,
						replayed: { kind: replayed.kind, values: valuesOf(replayed.tape) },
						ended: judged.shrunk.ended,
						localLeast: Arr.take(accepted, 1),
						spansWithin: [spansWithin(begun.tape), spansWithin(judged.shrunk.best.tape)],
						strays: Arr.take(straysOf(judged.rounds), 1),
						seen: judged.seen,
						alone: outcomeOf(alone)
					},
					{
						fails: true,
						noLarger: true,
						replayed: { kind: "fails", values: valuesOf(judged.shrunk.best.tape) },
						ended: "minimal",
						localLeast: [],
						spansWithin: [true, true],
						strays: [],
						seen: reachedOf(judged),
						alone: outcomeOf(judged)
					}
				)
			}),
	oracle: {
		kind: "second-implementation",
		name: "the shrinker's documented moves built again from each tape's spans: a span deleted or simplest, an array's item deleted with its count lowered, two of its items exchanged, one decision lowered; its acceptance rule restated over each round's verdicts"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/shrink.ts",
			original: "\t\t\t\t\t\tvalues: replaced(best.tape.values, at, lo),",
			replacement: "\t\t\t\t\t\tvalues: replaced(best.tape.values, at, lo - 1),",
			why: "Lowering a decision first proposes a value below the decision's simplest, a move the shrinker does not document; the moves property fails."
		}
	]
})

/**
 * A bounded shrink spends at most its budget of candidates at any width, says so when the budget stopped it, and
 * otherwise reaches what a complete shrink reaches.
 */
export const shrinkSpendsItsBudget = property.explore(budgetedProblems, {
	needs: {},
	situations: [
		"stopped by its budget",
		"minimal within its budget",
		"a width past its remaining budget"
	],
	check:
		(_resources, c) =>
		({ problem, budget, judging }) =>
			Effect.gen(function* () {
				const { fails, failing } = failingOf(problem)
				const begun = Arr.getUnsafe(failing, c.draw(int(0, failing.length - 1)))
				const start = { tape: begun.tape, failure: begun.value }
				const run = judgedBy(generatorOfShape(problem.shape), fails)
				const bounded = yield* shrunkUnder(judging, start, run, boundedShrink(budget))
				const alone = yield* shrunkUnder(sequential, start, run, boundedShrink(budget))
				const complete = yield* shrunkUnder(sequential, start, run, completeShrink)
				if (widthPastRoom(bounded.rounds, budget)) {
					c.note("a width past its remaining budget")
				}
				assertTrue(
					bounded.shrunk.candidates <= budget,
					`${bounded.shrunk.candidates} candidates within ${budget}`
				)
				deepStrictEqual(
					{ judged: outcomeOf(bounded), seen: bounded.seen },
					{ judged: outcomeOf(alone), seen: reachedOf(bounded) }
				)
				switch (bounded.shrunk.ended) {
					case "budget":
						c.note("stopped by its budget")
						strictEqual(bounded.shrunk.candidates, budget)
						break
					case "minimal":
						c.note("minimal within its budget")
						deepStrictEqual(valuesOf(bounded.shrunk.best.tape), valuesOf(complete.shrunk.best.tape))
						break
					case "unjudged":
						fail("a shrink whose judge judged every candidate stopped at one it could not judge")
				}
			}),
	oracle: {
		kind: "specification",
		name: "a bounded shrink spends at most its candidates and says when it stopped short; the sequential shrink under the same budget"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/shrink.ts",
			original:
				'budget.kind === "bounded" ? budget.candidates - candidates : Number.POSITIVE_INFINITY',
			replacement:
				'budget.kind === "bounded" ? budget.candidates + 1 - candidates : Number.POSITIVE_INFINITY',
			why: "A bounded shrink runs one candidate past its budget; the budget property fails."
		}
	]
})

/**
 * A shrink stops at the first candidate in candidate order its judge could not judge (what judging it needed could not
 * be had, as when a need of its property fails it), uncounted and with nothing judged after it, keeping the smallest
 * failure so far: where the sequential shrink that finds those candidates holding stands at its first round that
 * proposes one, at every width and either way of giving verdicts back.
 */
export const shrinkStopsUnjudged = property.explore(unjudgedProblems, {
	needs: {},
	situations: ["stopped at an unjudged candidate", "ended before any unjudged candidate"],
	check:
		(_resources, c) =>
		({ problem, every, judging }) =>
			Effect.gen(function* () {
				const { fails, failing } = failingOf(problem)
				const begun = Arr.getUnsafe(failing, c.draw(int(0, failing.length - 1)))
				const start = { tape: begun.tape, failure: begun.value }
				const run = judgedBy(generatorOfShape(problem.shape), fails)
				const unjudged = unjudgedAt(every)
				const stopped = yield* shrunkUnder(judging, start, stoppedBy(unjudged, run), completeShrink)
				const held = yield* shrunkUnder(sequential, start, heldBy(unjudged, run), completeShrink)
				const expected = stoppedAt(held, unjudged)
				c.note(
					expected.ended === "unjudged"
						? "stopped at an unjudged candidate"
						: "ended before any unjudged candidate"
				)
				deepStrictEqual(stopOf(stopped), expected)
			}),
	oracle: {
		kind: "second-implementation",
		name: "the sequential shrink that finds the unjudged candidates holding, read up to its first round that proposes one"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/shrink.ts",
			original: '\t\t\t\tif (judged.kind === "unjudged") {',
			replacement: "\t\t\t\tif (false) {",
			why: "A candidate the judge could not judge is read as one that holds, so the shrink goes on past it, judging every later candidate by the same broken means (CALLERROR's write oracle: 749 candidates, each a clone of a missing template); the stopping property fails."
		}
	]
})
