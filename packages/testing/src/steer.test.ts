/**
 * The steered phase (explore.ts), against what it promises, over locks planted to open on five magic values that
 * random search meets once in 33 million cases:
 *
 * - It climbs, one new note at a time, to a situation an unsteered search never reaches: with no steered budget the
 *   requirement goes unreached, with one it is met.
 * - Its witnesses, floor and steered, are the suite label's alone: the same under every concurrency and every run
 *   seed. Oracle: universal, a metamorphic relation.
 *
 * The climb through V8's block coverage is steer-by-coverage.test.ts, a process of its own. Each lock is a planted
 * capability problem, its verdict the specification's: a steered search reaches what it requires within its budget.
 *
 * Plants (~/.cache/grizzle-release/BR07/plants): steer-fresh-only.patch (every steered case a fresh draw) turns the
 * first property red; coverage-verdict-run-seeded.patch (the steered stream drawn from the run's seed) the second.
 */
import { describe, it } from "@effect/vitest"
import { deepStrictEqual, strictEqual } from "@effect/vitest/utils"
import { Array as Arr, Duration, Effect, Formatter, Option, Order } from "effect"
import type { TestContext } from "vitest"
import { type Case, drawn, type Exploration, explore, Run } from "#explore.ts"
import { type Coverage, required } from "#features.ts"
import { array, type Gen, int } from "#gen.ts"
import { floorSeed, rotatingSeed } from "#random.ts"
import { notesOnly } from "#sense.ts"
import { completeShrink } from "#shrink.ts"
import { runOfTest } from "#vitest/run.ts"

const MAGIC = [13, 27, 4, 30, 9] as const

type Matched = `${0 | 1 | 2 | 3 | 4 | 5} matched`

const MATCHED: ReadonlyArray<Matched> = [
	"0 matched",
	"1 matched",
	"2 matched",
	"3 matched",
	"4 matched",
	"5 matched"
]

/** Six values of 0..31: drawn at random, they begin with all five magic values once in 33 million cases. */
const values: Gen<ReadonlyArray<number>> = array(int(0, 31), { min: 6, max: 6 })

/** How many magic values a case begins with. */
const matchedOf = (drawnValues: ReadonlyArray<number>): number => {
	let matched = 0
	while (matched < MAGIC.length && drawnValues[matched] === MAGIC[matched]) {
		matched += 1
	}
	return matched
}

/** The run of the test `ctx` runs, never replaying or fuzzing: the steered and unsteered searches draw from its seed. */
const runIn = (ctx: TestContext) =>
	Effect.map(runOfTest(ctx), (testRun) =>
		Run.of({ ...testRun, replay: Option.none(), fuzz: Option.none() })
	)

/** A search that must reach what its coverage requires, from six values of 0..31. */
const magicSearch = <F extends string>(
	suite: string,
	coverage: Coverage<F>,
	concurrency: number
): Exploration<ReadonlyArray<number>, ReadonlyArray<number>, F> => ({
	suite,
	oracle: { kind: "specification", name: "a lock planted so that only a steered search opens it" },
	draw: drawn(values),
	literal: Formatter.format,
	coverage,
	kept: [],
	runs: 100,
	shrink: completeShrink,
	concurrency,
	steerEvery: 16,
	caseHang: Duration.minutes(1)
})

/** Notes how many magic values the case begins with: each new count is a step a steered search climbs from. */
const noteMatched = (drawnValues: ReadonlyArray<number>, c: Case<Matched>) =>
	Effect.sync(() => c.note(Arr.getUnsafe(MATCHED, matchedOf(drawnValues))))

/** Five magic values matched, the situation only a steered search reaches, with a steered budget of `cases`. */
const fiveMatched = (cases: number) => required<Matched>(["5 matched"], { cases, sense: notesOnly })

/** Orders witnesses' values lexicographically, so two runs' witnesses compare whatever order each run found them in. */
const byValues = Arr.makeOrder(Order.Number)

describe("a steered search", () => {
	it.effect("climbs to a situation random search never reaches, one new note at a time", (ctx) =>
		Effect.gen(function* () {
			const unsteered = yield* Effect.flip(
				explore(magicSearch("unsteered", fiveMatched(0), 4), noteMatched)
			)
			strictEqual(unsteered._tag, "FeaturesUnreached")
			yield* explore(magicSearch("steered", fiveMatched(50_000), 4), noteMatched)
		}).pipe(Effect.provideServiceEffect(Run, runIn(ctx)))
	)

	it.effect(
		"finds the same witnesses, floor and steered, however many run at once and whatever the run's seed",
		(ctx) =>
			Effect.gen(function* () {
				const processRun = yield* runIn(ctx)
				const seeds = [processRun.seed, rotatingSeed(processRun.seed, floorSeed("another run"))]
				const searches = yield* Effect.forEach(
					Arr.flatMap(seeds, (seed) =>
						Arr.map([1, 4, 16], (concurrency) => [seed, concurrency] as const)
					),
					([seed, concurrency]) =>
						Effect.suspend(() => {
							const witnesses: Array<ReadonlyArray<number>> = []
							return explore(
								magicSearch("steered at any concurrency", fiveMatched(50_000), concurrency),
								(drawnValues, c) =>
									Effect.andThen(
										Effect.sync(() => {
											if (Option.isSome(c.steering)) {
												witnesses.push(drawnValues)
											}
										}),
										noteMatched(drawnValues, c)
									)
							).pipe(
								Effect.map(
									(explored) => [explored.steered, Arr.sort(witnesses, byValues)] as const
								),
								Effect.provideService(Run, Run.of({ ...processRun, seed }))
							)
						})
				)
				const [first, ...rest] = searches
				for (const search of rest) {
					deepStrictEqual(search, first)
				}
			}).pipe(Effect.provideServiceEffect(Run, runIn(ctx)))
	)
})
