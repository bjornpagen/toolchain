import { Array as Arr, Effect, Option, Ref } from "effect"
import { array, boolean, element, type Gen, int, shuffled } from "#gen.ts"
import type { MutantPool, WorkerImage } from "#mutate/pool.ts"
import { lost, oneCase, passed } from "#mutate/processes.fixtures.ts"
import { SHARINGS, type Sharing, type TrialVerdict } from "#mutate/schedule.ts"
import { Property, PropertyId } from "#property.ts"
import type { Batch, Reach, Sense } from "#runner/protocol.ts"

/** The properties a stage's draw names. */
const NAMES = ["p0", "p1", "p2", "p3"] as const

/**
 * A stage as drawn: its properties, distinct and in order, whether each goes red on the stage's image, and whether each
 * guides its search by blocks.
 */
export type DrawnStage = Readonly<{
	properties: Arr.NonEmptyReadonlyArray<Readonly<{ name: string; red: boolean; guided: boolean }>>
}>

/** A case: the pool's width, the trials, each its stages, and how they share the pool. */
export type Schedule = Readonly<{
	width: number
	trials: ReadonlyArray<Arr.NonEmptyReadonlyArray<DrawnStage>>
	sharing: Sharing
}>

/** What the fake pool saw over a run: among it, each lease's stage (by its image's STAGE) and the guide it asked. */
export type Seen = Readonly<{
	live: number
	most: number
	open: number
	leased: ReadonlyArray<number>
	guides: ReadonlyArray<readonly [stage: string, guide: "notes" | "blocks"]>
	strays: ReadonlyArray<string>
	reaches: ReadonlyArray<Reach>
}>

export const unseen: Seen = {
	live: 0,
	most: 0,
	open: 0,
	leased: [],
	guides: [],
	strays: [],
	reaches: []
}

/**
 * A property whose search orders one case under its identity and reads its verdict from the result: red when the case
 * did not pass. It records the reach every search ran with.
 */
export const fakeProperty = (seen: Ref.Ref<Seen>, guide: Sense): Property =>
	new Property({
		kind: "explore",
		oracle: { kind: "unstated" },
		kills: [],
		needs: {},
		guide,
		keep: () => ({ kind: "unfound", why: "a fixture keeps nothing" }),
		search: (run) =>
			Effect.gen(function* () {
				yield* Ref.update(seen, (s) => ({ ...s, reaches: [...s.reaches, run.reach] }))
				const results = yield* run.evaluator.evaluate(
					[oneCase(run.id, run.limits.deadline)],
					() => true
				)
				return Arr.some(Arr.flatten(results), (result) => result.outcome.kind !== "passed")
					? {
							kind: "failed",
							finding: { kind: "lost", phase: "floor", where: run.id, report: "red on this image" }
						}
					: { kind: "exhausted", cases: 1, box: "one fake case", measures: [] }
			}),
		replay: () =>
			Effect.succeed({ kind: "exhausted", cases: 1, box: "one fake case", measures: [] }),
		ready: () =>
			Effect.succeed({
				cases: () => Effect.succeed([]),
				series: () =>
					Effect.succeed({
						ran: 0,
						passed: 0,
						notes: [],
						measures: [],
						millis: 0,
						cpu: 0,
						stopped: { kind: "none" }
					} as const),
				count: () => Effect.succeed({ kind: "uncountable" } as const)
			})
	})

/** The image key of stage `stage` of trial `trial`, which its leases are known by. */
export const keyOf = (trial: number, stage: number) => `${String(trial)}/${String(stage)}`

/**
 * The fake pool: a lease's evaluator fails the case of a property red on its image's stage, and passes every other,
 * yielding once per case so leases overlap; a case of a property the stage does not run is a stray. Live workers are
 * counted as leases open and close.
 */
export const fakePool = (
	width: number,
	stages: ReadonlyMap<string, DrawnStage>,
	seen: Ref.Ref<Seen>
): MutantPool<never> => ({
	width,
	lease: (image: WorkerImage, workers: number, guide: "notes" | "blocks") =>
		Effect.acquireRelease(
			Effect.as(
				Ref.update(seen, (s) => ({
					...s,
					live: s.live + workers,
					most: Math.max(s.most, s.live + workers),
					leased: [...s.leased, workers],
					guides: [...s.guides, [image.env["STAGE"] ?? "", guide] as const]
				})),
				{
					series: () => Effect.succeed([]),
					count: () => Effect.succeed({ kind: "uncountable" } as const),
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
											Ref.update(seen, (s) => ({ ...s, strays: [...s.strays, order.property] })),
											passed
										),
									onSome: (p) =>
										Effect.as(Effect.yieldNow, p.red ? lost("red on this image") : passed)
								})
							})
						),
					width: Effect.succeed(workers),
					workers
				}
			),
			() => Ref.update(seen, (s) => ({ ...s, live: s.live - workers }))
		)
})

/** The verdict a trial must get: its stages and properties run one at a time, the first red one. */
export const expectedOf = (stages: ReadonlyArray<DrawnStage>): TrialVerdict<number> => {
	for (const [index, stage] of stages.entries()) {
		for (const p of stage.properties) {
			if (p.red) {
				return {
					kind: "red",
					stage: index,
					property: PropertyId(p.name),
					red: {
						kind: "found",
						finding: { kind: "lost", phase: "floor", where: p.name, report: "red on this image" }
					}
				}
			}
		}
	}
	return { kind: "green" }
}

/** A stage: one to three of the properties, distinct, each red or not, each guided by blocks or not. */
const stageGen: Gen<DrawnStage> = (source) => {
	const first = source.draw(element(NAMES))
	const rest = source.draw(
		shuffled(
			Arr.filter(NAMES, (name) => name !== first),
			{ min: 0, max: 2 }
		)
	)
	return {
		properties: Arr.map(Arr.prepend(rest, first), (name) => ({
			name,
			red: source.draw(boolean),
			guided: source.draw(boolean)
		}))
	}
}

/** A trial: one or two stages. */
const trialGen: Gen<Arr.NonEmptyReadonlyArray<DrawnStage>> = (source) =>
	Arr.prepend(source.draw(array(stageGen, { min: 0, max: 1 })), source.draw(stageGen))

/** A case: a pool one to eight wide, up to twelve trials, and either way of sharing the pool. */
export const scheduleGen: Gen<Schedule> = (source) => ({
	width: source.draw(int(1, 8)),
	trials: source.draw(array(trialGen, { min: 0, max: 12 })),
	sharing: source.draw(element(SHARINGS))
})
