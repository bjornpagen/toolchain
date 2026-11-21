import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	Order,
	Path,
	type PlatformError,
	Result,
	type Scope
} from "effect"
import { killApplied, killMissing, type KillStale } from "#mutants.ts"
import type { Images } from "#mutate/image.ts"
import { type MutatedFile, probeOf, type RealPath, realPathOf } from "#mutate/mutated.ts"
import type { MutantPool } from "#mutate/pool.ts"
import {
	type Red,
	type Subject,
	type Trial,
	type TrialVerdict,
	trialsOn,
	type WitnessRun
} from "#mutate/schedule.ts"
import type { TreeFailed } from "#mutate/tree.ts"
import type { Kill, PropertyId } from "#property.ts"
import { findingLines, headlineOf } from "#runner/report.ts"

/**
 * What a kill's trial decided. Killed: the property's witnesses went red with the kill applied, and the gate passes it.
 * Survived: every witness passed, which fails the gate; `loaded` says whether the property's workers loaded the
 * mutated text at all (the file's probe, a mutant that throws as the module loads, went red), so a property that runs
 * the file only in a child process without needing Checkout.dir is told apart from one that runs it and misses the bug.
 * Stale: the kill's original no longer stands once in its file, which fails the gate. Unjudged: the property goes red
 * with no mutant at all, on the same image and workers (`red`, its baseline's), so its witnesses going red with the kill
 * applied says nothing about the kill (a need the run's width cannot serve, workers that cannot start), which fails
 * the gate.
 */
export type KillVerdict =
	| Readonly<{ kind: "killed"; red: Red }>
	| Readonly<{ kind: "survived"; loaded: boolean }>
	| Readonly<{ kind: "stale"; stale: KillStale }>
	| Readonly<{ kind: "unjudged"; red: Red }>

/** One kill of one property, judged. */
export type Judged = Readonly<{ property: PropertyId; kill: Kill; verdict: KillVerdict }>

/** The stages of a kill's trial: the kill applied, then, only when it survives, its file's probe. */
type KillStage = "kill" | "probe"

/** The mutant a kill makes of its file in the checkout, with the file's own text; a file not there is stale. */
const appliedIn = (checkout: RealPath, kill: Kill) =>
	Effect.map(
		Effect.option(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const target = yield* realPathOf(path.join(checkout, kill.file))
				const own = yield* fs.readFileString(target)
				return { target, own }
			})
		),
		(read): Result.Result<Readonly<{ mutated: MutatedFile; probe: MutatedFile }>, KillStale> =>
			Option.match(read, {
				onNone: () => Result.fail(killMissing(kill)),
				onSome: ({ target, own }) =>
					Result.map(killApplied(kill, own), (text) => ({
						mutated: { target, text },
						probe: probeOf(target, own)
					}))
			})
	)

/** A kill's verdict from its trial's. */
const verdictOf = (trial: TrialVerdict<KillStage>): KillVerdict => {
	if (trial.kind === "green") {
		return { kind: "survived", loaded: false }
	}
	switch (trial.stage) {
		case "kill":
			return { kind: "killed", red: trial.red }
		case "probe":
			return { kind: "survived", loaded: true }
	}
}

/**
 * What turned a property red, on one line: the runner's own report of its witnesses' finding (runner/report.ts), its
 * headline and each line below it, so an unopened need names the need and why it failed and a hung case its token.
 */
export const redText = (red: Red): string =>
	red.kind === "unstarted"
		? `its workers would not start: ${red.message}`
		: Arr.join([headlineOf(red.finding), ...findingLines(red.finding)], "; ")

/**
 * The kill gate: every kill of every subject applied to its file in the checkout (killApplied), and the subject's
 * witnesses run with it on workers that serve that mutant alone, every kill at once across the pool (trialsOn). A kill
 * passes when the witnesses go red; a surviving or stale kill fails. A survivor's trial goes on to its file's probe on
 * fresh workers, to say whether the property's workers loaded the mutant at all. First, each subject's baseline runs
 * its witnesses on its image with no mutant: a subject red there has every kill unjudged, and none of its kills is
 * tried. The verdicts are in the subjects' and their kills' order, and the same on every run seed: only witnesses run.
 */
export const killsOf = <E>(
	pool: MutantPool<E>,
	run: WitnessRun,
	checkout: RealPath,
	images: Images,
	subjects: ReadonlyArray<Subject>
): Effect.Effect<
	ReadonlyArray<Judged>,
	E | TreeFailed | PlatformError.PlatformError,
	FileSystem.FileSystem | Path.Path | Scope.Scope
> =>
	Effect.gen(function* () {
		const kills = Arr.flatMap(subjects, (subject) =>
			Arr.map(subject.property.kills, (kill) => ({ subject, kill }))
		)
		const applied = yield* Effect.forEach(
			kills,
			({ subject, kill }, at) =>
				Effect.map(appliedIn(checkout, kill), (mutant) => ({ at, subject, kill, mutant })),
			{ concurrency: "unbounded" }
		)
		const live = Arr.flatMap(applied, ({ at, subject, kill, mutant }) =>
			Result.isSuccess(mutant) ? [{ at, subject, kill, ...mutant.success }] : []
		)
		const judging: ReadonlyArray<Subject> = [
			...new Map(Arr.map(live, ({ subject }) => [subject.id, subject] as const)).values()
		]
		const baselines = yield* trialsOn<E | TreeFailed, "baseline">(
			pool,
			run,
			Arr.map(judging, (subject): Trial<TreeFailed, "baseline"> => [
				{
					image: images.open(subject.loading, Option.none()),
					properties: [subject],
					label: "baseline"
				}
			]),
			"spread"
		)
		const baselineRed: ReadonlyMap<PropertyId, Red> = new Map(
			Arr.flatMap(baselines, (baseline) =>
				baseline.kind === "red" ? [[baseline.property, baseline.red] as const] : []
			)
		)
		const [tryable, unjudged] = Arr.partition(live, (one) => {
			const red = baselineRed.get(one.subject.id)
			return red === undefined ? Result.succeed(one) : Result.fail({ ...one, red })
		})
		const trials = yield* trialsOn<E | TreeFailed, KillStage>(
			pool,
			run,
			Arr.map(tryable, ({ subject, mutated, probe }): Trial<TreeFailed, KillStage> => [
				{
					image: images.open(subject.loading, Option.some(mutated)),
					properties: [subject],
					label: "kill"
				},
				{
					image: images.open(subject.loading, Option.some(probe)),
					properties: [subject],
					label: "probe"
				}
			]),
			"spread"
		)
		const tried = [
			...Arr.map(
				Arr.zip(tryable, trials),
				([{ at, subject, kill }, trial]) =>
					[at, { property: subject.id, kill, verdict: verdictOf(trial) }] as const
			),
			...Arr.map(
				unjudged,
				({ at, subject, kill, red }) =>
					[at, { property: subject.id, kill, verdict: { kind: "unjudged", red } }] as const
			)
		]
		const stale = Arr.flatMap(applied, ({ at, subject, kill, mutant }) =>
			Result.isFailure(mutant)
				? [
						[
							at,
							{ property: subject.id, kill, verdict: { kind: "stale", stale: mutant.failure } }
						] as const
					]
				: []
		)
		return Arr.map(
			Arr.sort(
				[...tried, ...stale],
				Order.mapInput(Order.Number, ([at]: readonly [number, Judged]) => at)
			),
			([, judged]) => judged
		)
	})
