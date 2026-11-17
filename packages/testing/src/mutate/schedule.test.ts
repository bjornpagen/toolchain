/**
 * The mutator's scheduling over the pool (mutate/schedule.ts): every trial's verdict is the first property, stage by
 * stage, whose witnesses go red on the workers of that stage's image, as a one-at-a-time reference finds it; each stage
 * runs on fresh workers of its own image, which no other stage's case reaches; every property runs its witnesses
 * alone; and the trials fill the pool's width and never pass it: as many run at once as the width allows, each lease
 * the most workers an even split of the width gives them, every lease and image released at the end.
 */
import { Array as Arr, Effect, Option, Ref } from "effect"
import { deepStrictEqual } from "#assert.ts"
import { array, int } from "#gen.ts"
import { realPathOf } from "#mutate/mutated.ts"
import {
	expectedOf,
	fakePool,
	fakeProperty,
	keyOf,
	type Schedule,
	type Seen,
	trialGen,
	unseen
} from "#mutate/schedule.fixtures.ts"
import { shareOf, type Stage, type Subject, trialsOn } from "#mutate/schedule.ts"
import { property, PropertyId } from "#property.ts"
import { runnerLimits } from "#runner/limits.ts"

export const scheduledTrials = property.explore(
	(source): Schedule => ({
		width: source.draw(int(1, 8)),
		trials: source.draw(array(trialGen, { min: 0, max: 12 }))
	}),
	{
		needs: {},
		situations: [
			"more trials than workers",
			"fewer trials than workers",
			"red in a later stage",
			"a trial all green",
			"no trial"
		],
		check: (_resources, c) => (schedule) =>
			Effect.gen(function* () {
				const n = schedule.trials.length
				if (n === 0) {
					c.note("no trial")
				}
				if (n > schedule.width) {
					c.note("more trials than workers")
				}
				if (n > 0 && n < schedule.width) {
					c.note("fewer trials than workers")
				}
				const expected = Arr.map(schedule.trials, expectedOf)
				if (Arr.some(expected, (v) => v.kind === "red" && v.stage > 0)) {
					c.note("red in a later stage")
				}
				if (Arr.some(expected, (v) => v.kind === "green")) {
					c.note("a trial all green")
				}
				const seen = yield* Ref.make<Seen>(unseen)
				const fake = fakeProperty(seen)
				const root = yield* realPathOf(".")
				const trials = Arr.map(schedule.trials, (stages, t) =>
					Arr.map(stages, (stage, s): Stage<never, number> => ({
						image: Effect.acquireRelease(
							Effect.as(
								Ref.update(seen, (x) => ({ ...x, open: x.open + 1 })),
								{
									root,
									served: Option.none(),
									env: { STAGE: keyOf(t, s) }
								}
							),
							() => Ref.update(seen, (x) => ({ ...x, open: x.open - 1 }))
						),
						properties: Arr.map(stage.properties, (p): Subject => ({
							id: PropertyId(p.name),
							property: fake,
							loading: "in-process"
						})),
						label: s
					}))
				)
				const stages = new Map(
					Arr.flatMap(schedule.trials, (trial, t) =>
						Arr.map(trial, (stage, s) => [keyOf(t, s), stage] as const)
					)
				)
				const verdicts = yield* trialsOn<never, number>(
					fakePool(schedule.width, stages, seen),
					{ seed: 1, limits: runnerLimits },
					trials
				)
				const after = yield* Ref.get(seen)
				const share = shareOf(schedule.width, n)
				const atOnce = Math.min(n, schedule.width)
				deepStrictEqual(
					{
						verdicts: Arr.copy(verdicts),
						peak: after.most,
						live: after.live,
						open: after.open,
						evenAndFull: Arr.every(
							after.leased,
							(w) =>
								w === share && w * atOnce <= schedule.width && (w + 1) * atOnce > schedule.width
						),
						strays: Arr.copy(after.strays),
						witnessesOnly: Arr.every(after.reaches, (r) => r === "witnesses")
					},
					{
						verdicts: expected,
						peak: n === 0 ? 0 : atOnce * share,
						live: 0,
						open: 0,
						evenAndFull: true,
						strays: Arr.empty<string>(),
						witnessesOnly: true
					}
				)
			}),
		oracle: {
			kind: "second-implementation",
			name: "the trials run one at a time by hand, each stage's properties in order"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/mutate/schedule.ts",
				original: "Math.max(1, Math.floor(width / Math.max(1, trials)))",
				replacement: "Math.max(1, Math.ceil(width / Math.max(1, trials)))",
				why: "Each trial leases the width split evenly rounded up, so the trials at once lease more workers than the width holds."
			},
			{
				file: "packages/testing/src/mutate/schedule.ts",
				original: "concurrency: pool.width",
				replacement: "concurrency: 1",
				why: "Trials run one at a time, so the width is never full."
			}
		]
	}
)
