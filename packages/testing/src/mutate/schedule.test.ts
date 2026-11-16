import * as NodeServices from "@effect/platform-node/NodeServices"
import { layer } from "@effect/vitest"
/**
 * The mutator's scheduling over the pool (mutate/schedule.ts): every trial's verdict is the first property, stage by
 * stage, whose witnesses go red on the workers of that stage's image, as a one-at-a-time reference finds it; each stage
 * runs on fresh workers of its own image, which no other stage's case reaches; every property runs its witnesses
 * alone; and the trials fill the pool's width and never pass it: as many run at once as the width allows, each lease
 * the most workers an even split of the width gives them, every lease and image released at the end. Oracle: a second implementation, the trials run one at a time by hand.
 */
import { deepStrictEqual } from "@effect/vitest/utils"
import { Array as Arr, Duration, Effect, Formatter, Option, Ref } from "effect"
import { drawn, explore } from "#explore.ts"
import { required } from "#features.ts"
import { array, boolean, element, type Gen, int, shuffled } from "#gen.ts"
import { realPathOf } from "#mutate/mutated.ts"
import type { MutantPool, WorkerImage } from "#mutate/pool.ts"
import { shareOf, type Stage, type Subject, type TrialVerdict, trialsOn } from "#mutate/schedule.ts"
import { Property, PropertyId } from "#property.ts"
import { runnerLimits } from "#runner/limits.ts"
import type { Batch, CaseResult, Reach } from "#runner/protocol.ts"
import { notesOnly } from "#sense.ts"
import { boundedShrink } from "#shrink.ts"
import { searched } from "#vitest/searched.ts"

/** The properties a case's stages draw from. */
const NAMES = ["p0", "p1", "p2", "p3"] as const

/** A stage as drawn: its properties, distinct and in order, and whether each goes red on the stage's image. */
type DrawnStage = Readonly<{
	properties: Arr.NonEmptyReadonlyArray<Readonly<{ name: string; red: boolean }>>
}>

/** A case: the pool's width and the trials, each its stages. */
type Schedule = Readonly<{
	width: number
	trials: ReadonlyArray<Arr.NonEmptyReadonlyArray<DrawnStage>>
}>

/** What the fake pool saw over a run. */
type Seen = Readonly<{
	live: number
	most: number
	open: number
	leased: ReadonlyArray<number>
	strays: ReadonlyArray<string>
	reaches: ReadonlyArray<Reach>
}>

const passed: CaseResult = {
	decisions: 0,
	sketchDecisions: 0,
	overrun: false,
	notes: [],
	measures: [],
	trace: [],
	outcome: { kind: "passed", kept: { kind: "nothing" }, shown: { kind: "unshown" } },
	millis: 0
}

const failed: CaseResult = { ...passed, outcome: { kind: "lost", report: "red on this image" } }

/**
 * A property whose search orders one case under its identity and reads its verdict from the result: red when the case
 * failed. It records the reach every search ran with.
 */
const fakeProperty = (seen: Ref.Ref<Seen>): Property =>
	new Property({
		kind: "explore",
		guide: { kind: "notes" },
		oracle: { kind: "unstated" },
		kills: [],
		search: (run) =>
			Effect.gen(function* () {
				yield* Ref.update(seen, (s) => ({ ...s, reaches: [...s.reaches, run.reach] }))
				const results = yield* run.evaluator.evaluate(
					[
						[
							{
								property: run.id,
								chooser: { kind: "simplest" },
								drawn: { kind: "unsteered" },
								keep: "nothing",
								sense: { kind: "notes" },
								deadline: run.limits.deadline,
								print: "failing"
							}
						]
					],
					() => true
				)
				const red = Arr.some(Arr.flatten(results), (result) => result.outcome.kind !== "passed")
				return red
					? {
							kind: "failed",
							finding: {
								kind: "falsified",
								phase: "floor",
								where: run.id,
								printed: { kind: "undrawn", why: "a fake case" },
								failure: "red on this image",
								shrinking: { kind: "unshrunk" },
								token: run.id
							}
						}
					: { kind: "exhausted", cases: 1, box: "one fake case", measures: [] }
			}),
		replay: () =>
			Effect.succeed({ kind: "exhausted", cases: 1, box: "one fake case", measures: [] }),
		evaluate: () => Effect.succeed([])
	})

/** The image of stage `stage` of trial `trial`: the key its leases are known by. */
const keyOf = (trial: number, stage: number) => `${String(trial)}/${String(stage)}`

/**
 * The fake pool: a lease's evaluator fails the case of a property red on its image's stage, and passes every other; a
 * case of a property the stage does not run is a stray. Live workers are counted as leases open and close.
 */
const fakePool = (
	width: number,
	stages: ReadonlyMap<string, DrawnStage>,
	seen: Ref.Ref<Seen>
): MutantPool<never> => ({
	width,
	lease: (image: WorkerImage, workers: number) =>
		Effect.acquireRelease(
			Effect.as(
				Ref.update(seen, (s) => ({
					...s,
					live: s.live + workers,
					most: Math.max(s.most, s.live + workers),
					leased: [...s.leased, workers]
				})),
				{
					evaluate: (batches: ReadonlyArray<Batch>) =>
						Effect.forEach(batches, (batch) =>
							Effect.forEach(batch, (order) => {
								const red = Option.flatMap(
									Option.fromUndefinedOr(stages.get(image.env["STAGE"] ?? "")),
									(stage) => Arr.findFirst(stage.properties, (p) => p.name === order.property)
								)
								return Option.match(red, {
									onNone: () =>
										Effect.as(
											Ref.update(seen, (s) => ({
												...s,
												strays: [...s.strays, order.property]
											})),
											passed
										),
									onSome: (p) => Effect.as(Effect.yieldNow, p.red ? failed : passed)
								})
							})
						),
					width: Effect.succeed(workers)
				}
			),
			() => Ref.update(seen, (s) => ({ ...s, live: s.live - workers }))
		)
})

/** The verdict a trial must get: its stages and properties run one at a time, the first red one. */
const expectedOf = (stages: ReadonlyArray<DrawnStage>): TrialVerdict<number> => {
	for (const [index, stage] of stages.entries()) {
		for (const p of stage.properties) {
			if (p.red) {
				return {
					kind: "red",
					stage: index,
					property: PropertyId(p.name),
					red: {
						kind: "falsified",
						phase: "floor",
						where: p.name,
						printed: { kind: "undrawn", why: "a fake case" },
						failure: "red on this image",
						shrinking: { kind: "unshrunk" },
						token: p.name
					}
				}
			}
		}
	}
	return { kind: "green" }
}

/** A stage: one to three of the properties, distinct, each red or not. */
const stageGen: Gen<DrawnStage> = (source) => {
	const first = source.draw(element(NAMES))
	const rest = source.draw(
		shuffled(
			Arr.filter(NAMES, (name) => name !== first),
			{ min: 0, max: 2 }
		)
	)
	return {
		properties: Arr.map(Arr.prepend(rest, first), (name) => ({ name, red: source.draw(boolean) }))
	}
}

/** A trial: one or two stages. */
const trialGen: Gen<Arr.NonEmptyReadonlyArray<DrawnStage>> = (source) =>
	Arr.prepend(source.draw(array(stageGen, { min: 0, max: 1 })), source.draw(stageGen))

layer(NodeServices.layer, { excludeTestServices: true })("the mutator's schedule", (it) => {
	it.effect(
		"finds each trial's first red property on fresh workers of its stage's image, never leasing past the width",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "mutant schedule",
						oracle: {
							kind: "second-implementation",
							name: "the trials run one at a time by hand, each stage's properties in order"
						},
						draw: drawn((source): Schedule => ({
							width: source.draw(int(1, 8)),
							trials: source.draw(array(trialGen, { min: 0, max: 12 }))
						})),
						literal: Formatter.format,
						coverage: required<
							| "more trials than workers"
							| "fewer trials than workers"
							| "red in a later stage"
							| "a trial all green"
							| "no trial"
						>(
							[
								"more trials than workers",
								"fewer trials than workers",
								"red in a later stage",
								"a trial all green",
								"no trial"
							],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 100,
						shrink: boundedShrink(100),
						steerEvery: 16,
						caseHang: Duration.seconds(30)
					},
					(schedule, c) =>
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
							const seen = yield* Ref.make<Seen>({
								live: 0,
								most: 0,
								open: 0,
								leased: [],
								strays: [],
								reaches: []
							})
							const property = fakeProperty(seen)
							const root = yield* realPathOf(".")
							const trials = Arr.map(schedule.trials, (stages, t) =>
								Arr.map(stages, (stage, s): Stage<never, number> => ({
									image: Effect.acquireRelease(
										Effect.as(
											Ref.update(seen, (x) => ({ ...x, open: x.open + 1 })),
											{ root, execArgv: [], env: { STAGE: keyOf(t, s) } }
										),
										() => Ref.update(seen, (x) => ({ ...x, open: x.open - 1 }))
									),
									properties: Arr.map(stage.properties, (p): Subject => ({
										id: PropertyId(p.name),
										property,
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
											w === share &&
											w * atOnce <= schedule.width &&
											(w + 1) * atOnce > schedule.width
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
						})
				)
			)
	)
})
