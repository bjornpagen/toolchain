/**
 * The steered phase (explore.ts) perceiving V8's block coverage, against what it promises, over a lock planted to open
 * on five magic values that random search meets once in 33 million cases:
 *
 * - It climbs through branches it perceives in V8's block coverage with no note on the way, where a blind search
 *   meets none.
 *
 * The lock is a planted capability problem, its verdict the specification's: a steered search reaches what it
 * requires within its budget. It runs one case at a time, in a process of its own: V8's block counters are the
 * process's and reset when read, so a case's trace holds its blocks alone only when no other case runs beside it.
 *
 * @plant plants/testing/sense-v8-blind.patch Block coverage perceiving nothing, every trace empty; the property fails.
 */
import { describe, it } from "@effect/vitest"
import { strictEqual } from "@effect/vitest/utils"
import { Duration, Effect, Formatter, Option, String as Str } from "effect"
import type { TestContext } from "vitest"
import { type Case, drawn, type Exploration, explore, Run } from "#explore.ts"
import { required } from "#features.ts"
import { array, type Gen, int } from "#gen.ts"
import { notesOnly, type Sense, v8Coverage } from "#sense.ts"
import { completeShrink } from "#shrink.ts"
import { runOfTest } from "#vitest/run.ts"

const MAGIC = [13, 27, 4, 30, 9] as const

/** The run of the test `ctx` runs, never replaying or fuzzing: the blind and steered searches draw from its seed. */
const runIn = (ctx: TestContext) =>
	Effect.map(runOfTest(ctx), (testRun) =>
		Run.of({ ...testRun, replay: Option.none(), fuzz: Option.none() })
	)

/**
 * Six values of 0..31 for a lock with five nested branches: drawn at random, they open it once in 33 million cases, so
 * a search that does not perceive the branches never opens it within its budget, whatever the run's seed.
 */
const lockValues: Gen<ReadonlyArray<number>> = array(int(0, 31), { min: 6, max: 6 })

/** Opens only on all five magic values, one nested branch per value, and notes nothing on the way. */
const opens = (drawnValues: ReadonlyArray<number>): boolean => {
	if (drawnValues[0] === MAGIC[0]) {
		if (drawnValues[1] === MAGIC[1]) {
			if (drawnValues[2] === MAGIC[2]) {
				if (drawnValues[3] === MAGIC[3]) {
					if (drawnValues[4] === MAGIC[4]) {
						return true
					}
				}
			}
		}
	}
	return false
}

/** A search for the lock's opening, steered by `sense` for up to `cases` cases, one case at a time. */
const lockSearch = (
	suite: string,
	sense: Sense,
	cases: number
): Exploration<ReadonlyArray<number>, ReadonlyArray<number>, "opened"> => ({
	suite,
	oracle: { kind: "specification", name: "a lock planted so that only a steered search opens it" },
	draw: drawn(lockValues),
	literal: Formatter.format,
	coverage: required<"opened">(["opened"], { cases, sense }),
	kept: [],
	runs: 100,
	shrink: completeShrink,
	steerEvery: 16,
	caseHang: Duration.minutes(1)
})

/** Notes only the opening. */
const noteOpened = (drawnValues: ReadonlyArray<number>, c: Case<"opened">) =>
	Effect.sync(() => {
		if (opens(drawnValues)) {
			c.note("opened")
		}
	})

describe("a search steered by coverage", () => {
	it.effect(
		"climbs through branches it perceives in V8's block coverage, with no note on the way",
		(ctx) =>
			Effect.scoped(
				Effect.gen(function* () {
					const sense = yield* v8Coverage(Str.endsWith("/steer-by-coverage.test.ts"))
					const blind = yield* Effect.flip(
						explore(lockSearch("blind", notesOnly, 1000), noteOpened)
					)
					strictEqual(blind._tag, "FeaturesUnreached")
					yield* explore(lockSearch("coverage", sense, 100_000), noteOpened)
				}).pipe(Effect.provideServiceEffect(Run, runIn(ctx)))
			),
		0
	)
})
