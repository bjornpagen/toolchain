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
import { killApplied, KillStale } from "#mutants.ts"
import type { Images } from "#mutate/image.ts"
import { type MutatedFile, probeOf, type RealPath, realPathOf } from "#mutate/mutated.ts"
import type { MutantPool } from "#mutate/pool.ts"
import {
	type Subject,
	type Trial,
	type TrialVerdict,
	trialsOn,
	type WitnessRun
} from "#mutate/schedule.ts"
import type { TreeFailed } from "#mutate/tree.ts"
import type { Kill, PropertyId } from "#property.ts"
import type { Finding } from "#runner/protocol.ts"

/**
 * What a kill's trial decided. Killed: the property's witnesses went red with the kill applied, and the gate passes it.
 * Survived: every witness passed, which fails the gate; `loaded` says whether the property's workers loaded the
 * mutated text at all (the file's probe, a mutant that throws as the module loads, went red), so a property that runs
 * the file only in a child process without needing Checkout.dir is told apart from one that runs it and misses the bug.
 * Stale: the kill's original no longer stands once in its file, which fails the gate.
 */
export type KillVerdict =
	| Readonly<{ kind: "killed"; red: Finding }>
	| Readonly<{ kind: "survived"; loaded: boolean }>
	| Readonly<{ kind: "stale"; stale: KillStale }>

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
				onNone: () =>
					Result.fail(
						KillStale.make({
							file: kill.file,
							found: 0,
							message: `the kill "${kill.why}" names ${kill.file}, which is not in the checkout`
						})
					),
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
 * The kill gate: every kill of every subject applied to its file in the checkout (killApplied), and the subject's
 * witnesses run with it on workers that serve that mutant alone, every kill at once across the pool (trialsOn). A kill
 * passes when the witnesses go red; a surviving or stale kill fails. A survivor's trial goes on to its file's probe on
 * fresh workers, to say whether the property's workers loaded the mutant at all. The verdicts are in the subjects' and
 * their kills' order, and the same on every run seed: only witnesses run.
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
		const trials = yield* trialsOn<E | TreeFailed, KillStage>(
			pool,
			run,
			Arr.map(live, ({ subject, mutated, probe }): Trial<TreeFailed, KillStage> => [
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
			])
		)
		const tried = Arr.map(
			Arr.zip(live, trials),
			([{ at, subject, kill }, trial]) =>
				[at, { property: subject.id, kill, verdict: verdictOf(trial) }] as const
		)
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
