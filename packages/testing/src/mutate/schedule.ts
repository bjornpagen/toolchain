import { Array as Arr, Effect, Schema, type Scope } from "effect"
import type { Loading } from "#mutate/checkout.ts"
import { type MutantPool, Unstarted, type WorkerImage } from "#mutate/pool.ts"
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
 * How a property went red: its witnesses' finding (a witness case that failed, hung, misused its case or was lost, a
 * required situation no witness reached, a kept token that no longer runs as it says, or an exhaustion past counting),
 * or its workers would not start from the stage's image at all.
 */
export type Red =
	| Readonly<{ kind: "found"; finding: Finding }>
	| Readonly<{ kind: "unstarted"; message: string }>

/** What a trial found: the first property that went red, in which stage, and how, or none. */
export type TrialVerdict<L> =
	| Readonly<{ kind: "red"; stage: L; property: PropertyId; red: Red }>
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
						? Effect.succeed({
								kind: "red",
								stage,
								property: subject.id,
								red: { kind: "found", finding: verdict.finding }
							})
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
				Effect.flatMap(stage.image, (image) =>
					pool.lease(image, workers).pipe(
						Effect.flatMap((evaluator) => firstRed(run, evaluator, stage.label, stage.properties)),
						Effect.catchIf(Schema.is(Unstarted), (unstarted): Effect.Effect<TrialVerdict<L>> =>
							Effect.succeed({
								kind: "red",
								stage: stage.label,
								property: Arr.headNonEmpty(stage.properties).id,
								red: { kind: "unstarted", message: unstarted.message }
							})
						)
					)
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
 * How a run's trials share the pool: spread, each leasing an even split of the width (shareOf), so that a few trials
 * still fill it; or one each, a worker a trial, for a coverage pass, whose workers start dearly (no compile cache,
 * V8's coverage on, a dump to write) for witnesses that gain little from being spread. Either way as many trials run
 * at once as the width allows, and the workers leased at once never pass it.
 */
export const SHARINGS = ["spread", "one each"] as const

export type Sharing = (typeof SHARINGS)[number]

/** How many workers each trial of `trials` leases from a pool `width` wide, as `sharing` shares it. */
const LEASED: Readonly<Record<Sharing, (width: number, trials: number) => number>> = {
	spread: shareOf,
	"one each": () => 1
}

/**
 * The verdicts of `trials` on `pool`, in the trials' order: each property of each stage searched under its witnesses
 * alone (reach "witnesses": kept tokens, the floor stream and the steered phase, or an exhaustion's every case, never
 * the rotating stream, so a verdict is the same on every run seed), on workers of the trial's own, as many as
 * `sharing` gives it, started fresh from the stage's image, which no other trial's case ever runs on; never more
 * workers leased at once than the pool's width. A worker never outlives its stage.
 */
export const trialsOn = <E, L>(
	pool: MutantPool<E>,
	run: WitnessRun,
	trials: ReadonlyArray<Trial<E, L>>,
	sharing: Sharing
): Effect.Effect<ReadonlyArray<TrialVerdict<L>>, E> => {
	const workers = LEASED[sharing](pool.width, trials.length)
	return Effect.forEach(trials, (stages) => trialOn(pool, run, workers, stages), {
		concurrency: pool.width
	})
}
