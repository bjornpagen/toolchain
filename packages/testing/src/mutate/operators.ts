import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	Order,
	Path,
	type PlatformError,
	Schema,
	type Scope
} from "effect"
import {
	applied,
	type Equivalent,
	type Family,
	type Mutant,
	type MutationSourceRefused,
	mutantsOf,
	type Operator
} from "#mutants.ts"
import type { Loading } from "#mutate/checkout.ts"
import {
	type CoverageMap,
	coverageMapOf,
	type DumpUnread,
	type Ran,
	ranIn
} from "#mutate/coverage.ts"
import type { Images } from "#mutate/image.ts"
import { type MutatedFile, probeOf, type RealPath, realPathOf } from "#mutate/mutated.ts"
import type { MutantPool } from "#mutate/pool.ts"
import { type Red, type Subject, type Trial, trialsOn, type WitnessRun } from "#mutate/schedule.ts"
import type { TreeFailed } from "#mutate/tree.ts"
import { type TypecheckRefused, typecheckerOf } from "#mutate/typecheck.ts"
import type { PropertyId } from "#property.ts"
import { fnv1a32, mix } from "#random.ts"
import { processScratch } from "#resources/scratch.ts"

/**
 * A mutation run refused to measure: an equivalent judgment names a mutant its file no longer has, a property is red
 * with no mutant, or a file's probe survived a property that ran the file, so its workers never load the mutants the
 * run gives them and every mutant would survive it unseen.
 */
export class MutationRefused extends Schema.TaggedError<
	MutationRefused,
	{ readonly brand: unique symbol }
>()("MutationRefused", { message: Schema.String }) {}

/** What one operator mutant's trial decided; operator mutation is a measurement, so no verdict fails anything. */
export type MutantVerdict =
	| Readonly<{ kind: "killed"; property: PropertyId; red: Red }>
	| Readonly<{ kind: "survived"; faced: Arr.NonEmptyReadonlyArray<PropertyId> }>
	| Readonly<{ kind: "invalid" }>
	| Readonly<{ kind: "uncovered" }>
	| Readonly<{ kind: "equivalent"; why: string }>

/** One mutant, judged. */
export type MutantJudged<O extends string> = Readonly<{ mutant: Mutant<O>; verdict: MutantVerdict }>

/**
 * Which of the chosen operators' mutants a run judges: every one, `count` drawn by `seed`, or those whose ids are named
 * (a survivor rechecked).
 */
export type Choice =
	| Readonly<{ kind: "every" }>
	| Readonly<{ kind: "sample"; count: number; seed: number }>
	| Readonly<{ kind: "named"; ids: ReadonlySet<string> }>

/**
 * What a mutation run measures: `files` (paths from the checkout) by the library's operators and `families`, those of
 * `operators`, as `choice` chooses among them, against `subjects`, but for the mutants `equivalent` judges.
 * `pkg` is the package whose tsconfig types a mutant.
 */
export type MutationRun<O extends string> = Readonly<{
	witnesses: WitnessRun
	checkout: RealPath
	pkg: RealPath
	subjects: Arr.NonEmptyReadonlyArray<Subject>
	files: Arr.NonEmptyReadonlyArray<string>
	families: ReadonlyArray<Family<O>>
	equivalent: ReadonlyArray<Equivalent>
	operators: ReadonlySet<Operator | O>
	choice: Choice
}>

/** A file a run mutates: its path from the checkout, its canonical path, and its text. */
type Source = Readonly<{ file: string; target: RealPath; text: string }>

/** The order a mutant's stages run in: the properties it loads in process first, on workers that start fastest. */
const FIRST: Readonly<Record<Loading, number>> = { "in-process": 0, tree: 1 }

/**
 * A trial of `mutated` against `subjects`, in their order within one stage per way they load the repository's code
 * (in process first): each stage's workers start from `mutated` loaded as its properties load the code.
 */
export const trialOf = (
	images: Images,
	subjects: Arr.NonEmptyReadonlyArray<Subject>,
	mutated: MutatedFile
): Trial<TreeFailed, Loading> =>
	Arr.map(
		Arr.groupWith(
			Arr.sort(
				subjects,
				Order.mapInput(Order.Number, (subject: Subject) => FIRST[subject.loading])
			),
			(left, right) => left.loading === right.loading
		),
		(group) => {
			const { loading } = Arr.headNonEmpty(group)
			return {
				image: images.open(loading, Option.some(mutated)),
				properties: group,
				label: loading
			}
		}
	)

/**
 * What a coverage pass found of one subject: what its witnesses ran of the pass's files, or that they went red with no
 * mutant (`red`), or that a worker ended before it wrote its coverage (coverage.ts CoverageLost), so what it ran is
 * unknown.
 */
export type Covered =
	| Readonly<{ kind: "ran"; ran: Ran<Subject> }>
	| Readonly<{ kind: "red"; subject: Subject; red: Red }>
	| Readonly<{ kind: "lost"; subject: Subject; processes: ReadonlyArray<string> }>

/**
 * The coverage pass: each subject's witnesses once, unmutated, on a worker of its own ("one each") whose dumps go to a
 * directory of the subject's, every subject at once, and what each ran of `targets`, in the subjects' order.
 */
export const coveragePass = <E>(
	pool: MutantPool<E>,
	run: WitnessRun,
	images: Images,
	subjects: ReadonlyArray<Subject>,
	targets: ReadonlyArray<RealPath>
): Effect.Effect<
	ReadonlyArray<Covered>,
	E | DumpUnread | PlatformError.PlatformError,
	FileSystem.FileSystem | Path.Path | Scope.Scope
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const root = yield* processScratch({ prefix: "toolchain-coverage-" })
		const passes = Arr.map(subjects, (subject, index) => ({
			subject,
			directory: path.join(root, String(index))
		}))
		const verdicts = yield* trialsOn<E, "coverage">(
			pool,
			run,
			Arr.map(passes, ({ subject, directory }): Trial<E, "coverage"> => [
				{
					image: Effect.succeed(images.covered(directory)),
					properties: [subject],
					label: "coverage"
				}
			]),
			"one each"
		)
		return yield* Effect.forEach(
			Arr.zip(passes, verdicts),
			([{ subject, directory }, verdict]): Effect.Effect<
				Covered,
				DumpUnread | PlatformError.PlatformError,
				FileSystem.FileSystem | Path.Path
			> => {
				if (verdict.kind === "red") {
					return Effect.succeed({ kind: "red", subject, red: verdict.red })
				}
				return Effect.flatMap(fs.exists(directory), (present) =>
					present
						? ranIn(subject, directory, targets).pipe(
								Effect.map((ran): Covered => ({ kind: "ran", ran })),
								Effect.catchTag("CoverageLost", (lost) =>
									Effect.succeed<Covered>({ kind: "lost", subject, processes: lost.processes })
								)
							)
						: Effect.succeed<Covered>({ kind: "ran", ran: { property: subject, files: new Map() } })
				)
			}
		)
	})

/**
 * The coverage map of a mutation run: its coverage pass, refused when a subject is red with no mutant or its coverage
 * was lost, since a mutant can only be measured against properties that pass and whose runs are known.
 */
const coverageOf = <E>(
	pool: MutantPool<E>,
	run: WitnessRun,
	images: Images,
	subjects: Arr.NonEmptyReadonlyArray<Subject>,
	targets: ReadonlyArray<RealPath>
): Effect.Effect<
	CoverageMap<Subject>,
	E | MutationRefused | DumpUnread | PlatformError.PlatformError,
	FileSystem.FileSystem | Path.Path | Scope.Scope
> =>
	Effect.gen(function* () {
		const covered = yield* coveragePass(pool, run, images, subjects, targets)
		const red = Arr.flatMap(covered, (one) => (one.kind === "red" ? [one.subject.id] : []))
		if (Arr.isReadonlyArrayNonEmpty(red)) {
			return yield* MutationRefused.make({
				message: `with no mutant, ${Arr.join(red, ", ")} ${red.length === 1 ? "is" : "are"} red: a mutant can only be measured against properties that pass`
			})
		}
		const lost = Arr.flatMap(covered, (one) => (one.kind === "lost" ? [one] : []))
		if (Arr.isReadonlyArrayNonEmpty(lost)) {
			return yield* MutationRefused.make({
				message: Arr.join(
					Arr.map(
						lost,
						({ subject, processes }) =>
							`the coverage pass of ${subject.id} lost what its workers ${Arr.join(processes, ", ")} ran: each started and ended before it wrote its coverage, as a worker the pool ends past its grace does, so the run refuses rather than read less coverage`
					),
					"\n"
				)
			})
		}
		return coverageMapOf(Arr.flatMap(covered, (one) => (one.kind === "ran" ? [one.ran] : [])))
	})

/** A file's probe against one property that ran it. */
type Probe = Readonly<{ source: Source; subject: Subject }>

/**
 * Each file's probe against every property that ran the file, which must go red: one that passes ran the file where
 * its workers' module hook does not reach (a child process, without needing Checkout.dir), so the run refuses.
 */
const probed = <E>(
	pool: MutantPool<E>,
	run: WitnessRun,
	images: Images,
	map: CoverageMap<Subject>,
	sources: ReadonlyArray<Source>
): Effect.Effect<void, E | TreeFailed | MutationRefused> =>
	Effect.gen(function* () {
		const pairs = Arr.flatMap(sources, (source) =>
			Arr.map(map.touching(source.target), (subject): Probe => ({ source, subject }))
		)
		const verdicts = yield* trialsOn<E | TreeFailed, Loading>(
			pool,
			run,
			Arr.map(pairs, ({ source, subject }) =>
				trialOf(images, [subject], probeOf(source.target, source.text))
			),
			"spread"
		)
		const survived = Arr.map(
			Arr.filter(Arr.zip(pairs, verdicts), ([, verdict]) => verdict.kind === "green"),
			([pair]) => pair
		)
		if (Arr.isReadonlyArrayNonEmpty(survived)) {
			return yield* MutationRefused.make({
				message: Arr.join(
					Arr.map(
						survived,
						({ source, subject }) =>
							`the probe of ${source.file}, a mutant that throws as soon as the module loads, survived ${subject.id}, which ran the file: it runs the file where its workers' module hook does not reach, in a child process, so it must need Checkout.dir`
					),
					"\n"
				)
			})
		}
	})

/** A mutant of a file a run mutates, with that file. */
type Sourced<O extends string> = Readonly<{ source: Source; mutant: Mutant<Operator | O> }>

/** The mutants a run judges: those of its operators, as its choice chooses among them. */
const chosenOf = <O extends string>(
	run: MutationRun<O>,
	every: ReadonlyArray<Sourced<O>>
): ReadonlyArray<Sourced<O>> => {
	const wanted = Arr.filter(every, ({ mutant }) => run.operators.has(mutant.operator))
	const { choice } = run
	switch (choice.kind) {
		case "every":
			return wanted
		case "sample":
			return Arr.take(
				Arr.sort(
					wanted,
					Order.mapInput(Order.Number, ({ mutant }: Sourced<O>) =>
						mix(choice.seed ^ fnv1a32(mutant.id))
					)
				),
				choice.count
			)
		case "named":
			return Arr.filter(wanted, ({ mutant }) => choice.ids.has(mutant.id))
	}
}

/** What a chosen mutant goes on to: a trial against the properties that ran its place, or no trial and why. */
type Plan =
	| Readonly<{ kind: "trial"; mutated: MutatedFile; covering: Arr.NonEmptyReadonlyArray<Subject> }>
	| Readonly<{ kind: "invalid" }>
	| Readonly<{ kind: "uncovered" }>
	| Readonly<{ kind: "equivalent"; why: string }>

/** A mutant's place among the judgments: its file and its id. */
const judgedKey = (file: string, mutant: string): string => `${file}\u0000${mutant}`

/**
 * The judgments a run's files hold no mutant for: each names a file the run mutates and an id none of that file's
 * current mutants has, so its code moved or changed since the judgment. A file the run does not mutate is not read, so
 * its judgments are not checked.
 */
const staleOf = <O extends string>(
	run: MutationRun<O>,
	every: ReadonlyArray<Sourced<O>>
): ReadonlyArray<Equivalent> => {
	const current = new Set(Arr.map(every, ({ source, mutant }) => judgedKey(source.file, mutant.id)))
	return Arr.filter(
		run.equivalent,
		(entry) =>
			Arr.contains(run.files, entry.file) && !current.has(judgedKey(entry.file, entry.mutant))
	)
}

/**
 * Operator mutation, a measurement: every chosen mutant of the run's files, typed by the package's own tsconfig
 * through TypeScript 7's native compiler in one session that ends before any trial starts (a mutant with a type error
 * is invalid and runs nowhere), and each valid one run against the properties whose witnesses ran its place (the
 * coverage map), in order until one goes red, each mutant on workers of its own and every mutant at once across the
 * pool. A mutant no property ran is uncovered; a mutant the run's judgments call equivalent is neither typed nor run.
 * Before any mutant, a judgment of a file the run mutates must name one of its current mutants, the coverage pass
 * refuses a property red with no mutant, and each file's probe must go red against every property that ran the file.
 * The verdicts are in the files' and their mutants' order.
 */
export const mutationOf = <E, O extends string>(
	pool: MutantPool<E>,
	images: Images,
	run: MutationRun<O>
): Effect.Effect<
	ReadonlyArray<MutantJudged<Operator | O>>,
	| E
	| TreeFailed
	| MutationRefused
	| DumpUnread
	| TypecheckRefused
	| MutationSourceRefused
	| PlatformError.PlatformError,
	FileSystem.FileSystem | Path.Path | Scope.Scope
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const sources = yield* Effect.forEach(run.files, (file) =>
			Effect.gen(function* () {
				const target = yield* realPathOf(path.join(run.checkout, file))
				const text = yield* fs.readFileString(target)
				const source: Source = { file, target, text }
				return source
			})
		)
		const every = yield* Effect.forEach(sources, (source) =>
			Effect.map(
				mutantsOf([source], run.families),
				Arr.map((mutant): Sourced<O> => ({ source, mutant }))
			)
		)
		const population = Arr.flatten(every)
		const stale = staleOf(run, population)
		if (Arr.isReadonlyArrayNonEmpty(stale)) {
			return yield* MutationRefused.make({
				message: Arr.join(
					Arr.map(
						stale,
						(entry) =>
							`the equivalent mutant ${entry.mutant} of ${entry.file} is none of the file's current mutants: its code moved or changed, so judge it again or delete it (${entry.why})`
					),
					"\n"
				)
			})
		}
		const equivalentWhy = new Map(
			Arr.map(run.equivalent, (entry) => [judgedKey(entry.file, entry.mutant), entry.why] as const)
		)
		const chosen = chosenOf(run, population)
		const map = yield* coverageOf(
			pool,
			run.witnesses,
			images,
			run.subjects,
			Arr.map(sources, (source) => source.target)
		)
		yield* probed(pool, run.witnesses, images, map, sources)
		const plans = yield* Effect.scoped(
			Effect.flatMap(typecheckerOf(run.pkg), (mistyped) =>
				Effect.forEach(chosen, ({ source, mutant }) => {
					const why = equivalentWhy.get(judgedKey(source.file, mutant.id))
					if (why !== undefined) {
						return Effect.succeed<Plan>({ kind: "equivalent", why })
					}
					const mutated: MutatedFile = { target: source.target, text: applied(mutant) }
					return Effect.map(mistyped(mutated), (invalid): Plan => {
						const covering = map.covering(source.target, mutant.start)
						if (invalid) {
							return { kind: "invalid" }
						}
						return Arr.isReadonlyArrayNonEmpty(covering)
							? { kind: "trial", mutated, covering }
							: { kind: "uncovered" }
					})
				})
			)
		)
		const planned = Arr.map(
			Arr.zip(chosen, plans),
			(
				[{ mutant }, plan],
				at
			): Readonly<{ at: number; mutant: Mutant<Operator | O>; plan: Plan }> => ({
				at,
				mutant,
				plan
			})
		)
		const tried = Arr.flatMap(planned, ({ at, mutant, plan }) =>
			plan.kind === "trial" ? [{ at, mutant, ...plan }] : []
		)
		const verdicts = yield* trialsOn<E | TreeFailed, Loading>(
			pool,
			run.witnesses,
			Arr.map(tried, ({ mutated, covering }) => trialOf(images, covering, mutated)),
			"spread"
		)
		const judged = Arr.map(
			Arr.zip(tried, verdicts),
			([{ at, mutant, covering }, verdict]): readonly [number, MutantJudged<Operator | O>] => [
				at,
				{
					mutant,
					verdict:
						verdict.kind === "red"
							? { kind: "killed", property: verdict.property, red: verdict.red }
							: { kind: "survived", faced: Arr.map(covering, (subject) => subject.id) }
				}
			]
		)
		const untried = Arr.flatMap(
			planned,
			({ at, mutant, plan }): ReadonlyArray<readonly [number, MutantJudged<Operator | O>]> =>
				plan.kind === "trial" ? [] : [[at, { mutant, verdict: plan }]]
		)
		return Arr.map(
			Arr.sort(
				[...judged, ...untried],
				Order.mapInput(Order.Number, ([at]: readonly [number, MutantJudged<Operator | O>]) => at)
			),
			([, one]) => one
		)
	})
