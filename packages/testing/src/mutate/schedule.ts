import { Array as Arr, Effect, type Scope } from "effect"
import type { Loading } from "#mutate/checkout.ts"
import type { MutantPool, WorkerImage } from "#mutate/pool.ts"
import type { Property, PropertyId } from "#property.ts"
import type { Limits } from "#runner/limits.ts"
import type { Evaluator, Finding } from "#runner/protocol.ts"

/**
 * A property as the mutator runs it: its identity, the property, and how its workers load the repository's code
 * (`loadingOf` its needs, read once where the runner discovers it).
 */
export type Subject = Readonly<{ id: PropertyId; property: Property; loading: Loading }>

/**
 * What a witness search runs with besides its evaluator: the run's seed, which no witness reads (the floor and the
 * steered phase are fixed by the property's identity), and the runner's limits.
 */
export type WitnessRun = Readonly<{ seed: number; limits: Limits }>

/**
 * One stage of a trial: the image its workers start from, for the stage's scope (a mutant's text written, a tree lent),
 * the properties they run, in order, and what the stage is to its trial (`label`), which a red verdict names.
 */
export type Stage<E, L> = Readonly<{
	image: Effect.Effect<WorkerImage, E, Scope.Scope>
	properties: Arr.NonEmptyReadonlyArray<Subject>
	label: L
}>

/**
 * A trial: one mutant (or probe, or coverage pass) against properties, in stages run in order on fresh workers of each
 * stage's image until a property goes red: a mutant's stages are the ways its properties load the repository's code
 * (checkout.ts Loading), and a kill's are its mutant and then its file's probe.
 */
export type Trial<E, L> = Arr.NonEmptyReadonlyArray<Stage<E, L>>

/**
 * What a trial found: the first property that went red, in which stage, and its witnesses' finding (a witness case that
 * failed, hung, misused its case or was lost, a required situation no witness reached, a kept token that no longer runs
 * as it says, or an exhaustion past counting), or none.
 */
export type TrialVerdict<L> =
	| Readonly<{ kind: "red"; stage: L; property: PropertyId; red: Finding }>
	| Readonly<{ kind: "green" }>

/**
 * The first of `subjects` to go red under its witnesses on `evaluator`'s workers, run in order; green when each
 * passes.
 */
const firstRed = <L>(
	run: WitnessRun,
	evaluator: Evaluator,
	stage: L,
	subjects: ReadonlyArray<Subject>
): Effect.Effect<TrialVerdict<L>> => {
	const [subject, ...rest] = subjects
	return subject === undefined
		? Effect.succeed({ kind: "green" })
		: Effect.flatMap(
				subject.property.search({ ...run, id: subject.id, evaluator, reach: "witnesses" }),
				(verdict): Effect.Effect<TrialVerdict<L>> =>
					verdict.kind === "failed"
						? Effect.succeed({ kind: "red", stage, property: subject.id, red: verdict.finding })
						: firstRed(run, evaluator, stage, rest)
			)
}

/** A trial's stages run in order, each on `workers` fresh workers of its image, until one goes red. */
const trialOn = <E, L>(
	pool: MutantPool<E>,
	run: WitnessRun,
	workers: number,
	stages: ReadonlyArray<Stage<E, L>>
): Effect.Effect<TrialVerdict<L>, E> => {
	const [stage, ...rest] = stages
	return stage === undefined
		? Effect.succeed({ kind: "green" })
		: Effect.scoped(
				Effect.flatMap(
					Effect.flatMap(stage.image, (image) => pool.lease(image, workers)),
					(evaluator) => firstRed(run, evaluator, stage.label, stage.properties)
				)
			).pipe(
				Effect.filterOrElse(
					(verdict) => verdict.kind === "red",
					() => trialOn(pool, run, workers, rest)
				)
			)
}

/**
 * How many workers each trial of a run of `trials` trials leases from a pool `width` wide: the width split evenly among
 * the trials, at least one. With as many trials as workers or more, each runs on one worker and `width` run at once;
 * with fewer, each spreads its cases over its share and all run at once, so the workers leased never pass the width.
 */
export const shareOf = (width: number, trials: number): number =>
	Math.max(1, Math.floor(width / Math.max(1, trials)))

/**
 * The verdicts of `trials` on `pool`, in the trials' order: each property of each stage searched under its witnesses
 * alone (reach "witnesses": kept tokens, the floor stream and the steered phase, or an exhaustion's every case, never
 * the rotating stream, so a verdict is the same on every run seed), on workers of the trial's own, started fresh from
 * the stage's image, which no other trial's case ever runs on; never more workers leased at once than the pool's width
 * (shareOf). A worker never outlives its stage.
 */
export const trialsOn = <E, L>(
	pool: MutantPool<E>,
	run: WitnessRun,
	trials: ReadonlyArray<Trial<E, L>>
): Effect.Effect<ReadonlyArray<TrialVerdict<L>>, E> => {
	const workers = shareOf(pool.width, trials.length)
	return Effect.forEach(trials, (stages) => trialOn(pool, run, workers, stages), {
		concurrency: pool.width
	})
}
