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
import type { Digest } from "effect/crypto"
import {
	applied,
	type Equivalent,
	type Family,
	type Mutant,
	type MutationSourceRefused,
	mutantsOf
} from "#mutants.ts"
import type { Loading } from "#mutate/checkout.ts"
import { type CoverageMap, coverageMapOf, type DumpUnread, type Ran } from "#mutate/coverage.ts"
import type { Images } from "#mutate/image.ts"
import { type Judged, killsOf, redText } from "#mutate/kills.ts"
import { type MutatedFile, probeOf, type RealPath, realPathOf } from "#mutate/mutated.ts"
import { type Covered, coveragePass, trialOf } from "#mutate/operators.ts"
import type { MutantPool } from "#mutate/pool.ts"
import { type Subject, type TrialVerdict, trialsOn, type WitnessRun } from "#mutate/schedule.ts"
import type { TreeFailed } from "#mutate/tree.ts"
import { typecheckerOf } from "#mutate/typecheck.ts"
import type { Kill, PropertyId } from "#property.ts"
import { fnv1a32, mix } from "#random.ts"
import { type EditVerdicts, type KillVerdicts, withKills } from "#runner/affected.ts"
import { editOf, type VerdictCacheUnusable } from "#runner/cache.ts"
import type { RunLease } from "#runner/services.ts"
import type { Product } from "#scope.ts"

/**
 * The census: which properties have caught a bug (Bjorn, 2026-11-16: "all tests that have never caught a bug need to be
 * hard deleted. no conditions."). A property has caught one when an edit of product source turns its witnesses red:
 * one of its kills (judged here, or a verdict the cache holds at its closure), or an operator mutant at a place of
 * product source its witnesses ran. Product source is a file the repository itself holds outside test scope (scope.ts):
 * a kill or a mutant of support, a harness or an oracle shows nothing, and neither does a file another repository holds
 * (a submodule's). A kept case shows nothing on its own: the defect it pins counts as the kill that writes it back.
 * Every other property never caught a bug, but one the census cannot judge: red with no mutant, its coverage lost, a
 * product file it ran whose mutants its workers never load (the file's probe survives it), or a file whose mutants the
 * package cannot type.
 */

/** What showed that a property caught a bug: a kill of product source, or an operator mutant of it. */
export type Catch =
	| Readonly<{ kind: "kill"; kill: Kill }>
	| Readonly<{ kind: "mutant"; mutant: Mutant<string> }>

/** Where a property stands: it caught a bug, and what showed it; it never caught one; or the census cannot say, and why. */
export type Standing =
	| Readonly<{ kind: "catches"; by: Catch }>
	| Readonly<{ kind: "never-caught" }>
	| Readonly<{ kind: "unjudged"; why: string }>

/**
 * One property counted: its standing; its kills of product source and how many of them turned it red; its kills of
 * anything else, which show nothing; its kept cases; and how many operator mutants it ran against.
 */
export type Counted = Readonly<{
	id: PropertyId
	standing: Standing
	productKills: number
	killedKills: number
	otherKills: number
	kept: number
	tried: number
}>

/**
 * What a census weighs: `subjects` on the witnesses' run, product source as `product` says, the files of it the mutator
 * may mutate (`sources`, paths from the checkout, typed by the package at `pkg`), the operators of `families` beside the
 * library's, the mutants judged `equivalent`, and the verdicts the cache holds and keeps, of kills and of edits.
 * `settled` hears of each property as its standing is settled.
 */
export type CensusRun<O extends string> = Readonly<{
	witnesses: WitnessRun
	checkout: RealPath
	pkg: RealPath
	subjects: ReadonlyArray<Subject>
	product: Product
	sources: ReadonlyArray<string>
	families: ReadonlyArray<Family<O>>
	equivalent: ReadonlyArray<Equivalent>
	kills: KillVerdicts
	edits: EditVerdicts
	reading: Reading
	settled: (counted: Counted) => Effect.Effect<void>
}>

/**
 * How the census reads which places of product source a subject ran: by the V8 coverage of its witnesses (`places`),
 * whose offsets are the file's own where Node runs it as written (types stripped in place), or by the files it imports
 * (`files`, from importClosure: each a path from the checkout), every place of each, for a foreign command's module,
 * which another runner transforms as it loads (so no offset is the file's) in workers whose coverage it never writes.
 */
export type Reading =
	| Readonly<{ kind: "places" }>
	| Readonly<{ kind: "files"; importClosure: (id: PropertyId) => ReadonlyArray<string> }>

/** A product file the census may mutate: its path from the checkout, its canonical path, and its text. */
type Source = Readonly<{ file: string; target: RealPath; text: string }>

/** One mutant a property faces: the mutant, its file's text with it applied, and its file. */
type Faced = Readonly<{ mutant: Mutant<string>; mutated: MutatedFile }>

/**
 * A property the census pursues with operator mutants: the mutants of product source at places its witnesses ran, in
 * its own order, the next to try, how many it ran against, how many of its trials are in flight, the first that turned
 * it red, and why a file's mutants could not be typed.
 */
type Pursuit = {
	readonly subject: Subject
	readonly queue: ReadonlyArray<Faced>
	next: number
	tried: number
	flying: number
	found: Option.Option<Mutant<string>>
	untyped: Option.Option<string>
}

/** A file's probe against a property no mutant turned red, which must turn it red. */
type Probe = Readonly<{ pursuit: Pursuit; source: Source }>

/** A mutant's place among the judgments: its file and its id. */
const judgedKey = (file: string, mutant: string): string => `${file}\u0000${mutant}`

/** A property's mutants in its own order: drawn by its identity, so two properties meet the same mutants differently. */
const orderFor = (id: PropertyId) =>
	Order.mapInput(Order.Number, (faced: Faced) => mix(fnv1a32(id) ^ fnv1a32(faced.mutant.id)))

/**
 * The next mutant to try and the pursuit it is for: of the pursuits still looking, the one with the fewest trials in
 * flight, so every property still looking shares the pool's width evenly.
 */
const nextOf = (pursuits: ReadonlyArray<Pursuit>): Option.Option<readonly [Pursuit, Faced]> => {
	const looking = Arr.filter(
		pursuits,
		(pursuit) => Option.isNone(pursuit.found) && pursuit.next < pursuit.queue.length
	)
	return Option.flatMap(
		Arr.head(
			Arr.sort(
				looking,
				Order.mapInput(Order.Number, (pursuit: Pursuit) => pursuit.flying)
			)
		),
		(pursuit) =>
			Option.map(Option.fromUndefinedOr(pursuit.queue[pursuit.next]), (faced) => {
				pursuit.next += 1
				pursuit.flying += 1
				return [pursuit, faced] as const
			})
	)
}

/**
 * The census of `run.subjects`, in their order: first each property's kills of product source, those the cache answers
 * left alone and the rest judged (mutate/kills.ts killsOf), each verdict recorded; then, for each property no kill of
 * product source turned red, a coverage pass of its witnesses over the product files (which a property red with no
 * mutant fails, unjudged, as it fails its kills' baseline), and the operator mutants at the
 * places it ran, each tried against it alone on a worker of its own until one turns it red that the package types (one
 * with a type error is no mutant anyone could commit, so a red one shows nothing; only a red mutant is typed, since a
 * survivor shows nothing either way, which keeps the one typing session off the trials' path), every property still looking sharing the pool's width,
 * each verdict recorded and a verdict the cache holds tried no more; last, for each property no mutant turned red, the
 * probe of every product file it faced a mutant of, which must turn it red, or its mutants never reached it. A file it
 * ran with no mutant at a place it ran (a module it imports and never calls) is no file it could catch a bug in.
 */
export const censusOf = <E, O extends string>(
	pool: MutantPool<E>,
	images: Images,
	run: CensusRun<O>
): Effect.Effect<
	ReadonlyArray<Counted>,
	| E
	| TreeFailed
	| DumpUnread
	| MutationSourceRefused
	| VerdictCacheUnusable
	| PlatformError.PlatformError,
	FileSystem.FileSystem | Path.Path | Scope.Scope | RunLease | Digest.Digest
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const productKills = (subject: Subject) =>
			Arr.filter(subject.property.kills, (kill) => run.product(kill.file))
		const { fresh, cached } = yield* run.kills.split(
			Arr.map(run.subjects, (subject) => ({
				...subject,
				property: withKills(subject.property, productKills(subject))
			}))
		)
		const judged = yield* killsOf(pool, run.witnesses, run.checkout, images, fresh)
		yield* run.kills.record(judged)
		const killedBy = (id: PropertyId): ReadonlyArray<Kill> => [
			...Arr.flatMap(cached, (one) => (one.property === id ? [one.kill] : [])),
			...Arr.flatMap(judged, (one: Judged) =>
				one.property === id && one.verdict.kind === "killed" ? [one.kill] : []
			)
		]
		const countedOf = (subject: Subject, standing: Standing, tried: number): Counted => {
			const product = productKills(subject)
			return {
				id: subject.id,
				standing,
				productKills: product.length,
				killedKills: killedBy(subject.id).length,
				otherKills: subject.property.kills.length - product.length,
				kept: subject.property.kept.length,
				tried
			}
		}
		const byKill = new Map<PropertyId, Counted>()
		const pursued: Array<Subject> = []
		for (const subject of run.subjects) {
			const killed = Arr.head(killedBy(subject.id))
			if (Option.isSome(killed)) {
				const counted = countedOf(
					subject,
					{ kind: "catches", by: { kind: "kill", kill: killed.value } },
					0
				)
				byKill.set(subject.id, counted)
				yield* run.settled(counted)
			} else {
				pursued.push(subject)
			}
		}
		const sources = yield* Effect.forEach(run.sources, (file) =>
			Effect.gen(function* () {
				const target = yield* realPathOf(path.join(run.checkout, file))
				const text = yield* fs.readFileString(target)
				const source: Source = { file, target, text }
				return source
			})
		)
		const covered = yield* coveragePass(
			pool,
			run.witnesses,
			images,
			pursued,
			Arr.map(sources, (source) => source.target)
		)
		const byCoverage = new Map<PropertyId, Counted>()
		const reading = run.reading
		const readOf = (ran: Ran<Subject>): Ran<Subject> => {
			switch (reading.kind) {
				case "places":
					return ran
				case "files": {
					const imported = new Set(reading.importClosure(ran.property.id))
					return {
						property: ran.property,
						files: new Map(
							Arr.flatMap(sources, (source) =>
								imported.has(source.file)
									? [[source.target, [{ start: 0, end: source.text.length }]] as const]
									: []
							)
						)
					}
				}
			}
		}
		const ran = Arr.flatMap(covered, (one: Covered) => {
			switch (one.kind) {
				case "ran":
					return [readOf(one.ran)]
				case "red":
					byCoverage.set(
						one.subject.id,
						countedOf(
							one.subject,
							{ kind: "unjudged", why: `red with no mutant: ${redText(one.red)}` },
							0
						)
					)
					return []
				case "lost":
					byCoverage.set(
						one.subject.id,
						countedOf(
							one.subject,
							{
								kind: "unjudged",
								why: `its coverage pass lost what its workers ${Arr.join(one.processes, ", ")} ran`
							},
							0
						)
					)
					return []
			}
		})
		yield* Effect.forEach(byCoverage.values(), run.settled, { discard: true })
		const touched = new Set(
			Arr.flatMap(ran, (one) =>
				Arr.flatMap(Arr.fromIterable(one.files), ([file, spans]) =>
					Arr.isReadonlyArrayNonEmpty(spans) ? [file] : []
				)
			)
		)
		const equivalent = new Set(
			Arr.map(run.equivalent, (entry) => judgedKey(entry.file, entry.mutant))
		)
		const mutated = new Map<RealPath, ReadonlyArray<Faced>>()
		for (const source of sources) {
			if (touched.has(source.target)) {
				const mutants = yield* mutantsOf([{ file: source.file, text: source.text }], run.families)
				mutated.set(
					source.target,
					Arr.map(
						Arr.filter(mutants, (mutant) => !equivalent.has(judgedKey(source.file, mutant.id))),
						(mutant): Faced => ({
							mutant,
							mutated: { target: source.target, text: applied(mutant) }
						})
					)
				)
			}
		}
		const pursuits = Arr.map(ran, (one): Pursuit => {
			const map: CoverageMap<Subject> = coverageMapOf([one])
			const files = Arr.flatMap(Arr.fromIterable(one.files), ([file, spans]) =>
				Arr.isReadonlyArrayNonEmpty(spans) ? [file] : []
			)
			return {
				subject: one.property,
				queue: Arr.sort(
					Arr.flatMap(files, (file) =>
						Arr.filter(mutated.get(file) ?? [], (faced) =>
							Arr.isReadonlyArrayNonEmpty(map.covering(file, faced.mutant.start))
						)
					),
					orderFor(one.property.id)
				),
				next: 0,
				tried: 0,
				flying: 0,
				found: Option.none(),
				untyped: Option.none()
			}
		})
		const mistyped = yield* typecheckerOf(run.pkg)
		const settledFound = (pursuit: Pursuit) =>
			Option.isSome(pursuit.found) && pursuit.flying === 0
				? run.settled(
						countedOf(
							pursuit.subject,
							{ kind: "catches", by: { kind: "mutant", mutant: pursuit.found.value } },
							pursuit.tried
						)
					)
				: Effect.void
		const tryOne = (pursuit: Pursuit, faced: Faced) =>
			Effect.gen(function* () {
				const edit = yield* editOf(faced.mutant.file, faced.mutant.source, faced.mutated.text)
				const known = yield* run.edits.red(pursuit.subject.id, edit)
				if (known) {
					pursuit.found = Option.orElse(pursuit.found, () => Option.some(faced.mutant))
					return
				}
				if (Option.isSome(pursuit.found)) {
					return
				}
				const [verdict] = yield* trialsOn<E | TreeFailed, Loading>(
					pool,
					run.witnesses,
					[trialOf(images, [pursuit.subject], faced.mutated)],
					"one each"
				)
				pursuit.tried += 1
				if (verdict?.kind !== "red") {
					return
				}
				const typed = yield* Effect.result(mistyped(faced.mutated))
				if (Result.isFailure(typed)) {
					pursuit.untyped = Option.some(
						`the mutants of ${faced.mutant.file} could not be typed: ${typed.failure.message}`
					)
					return
				}
				if (!typed.success) {
					yield* run.edits.record(pursuit.subject.id, edit, true)
					pursuit.found = Option.orElse(pursuit.found, () => Option.some(faced.mutant))
				}
			}).pipe(
				Effect.ensuring(
					Effect.suspend(() => {
						pursuit.flying -= 1
						return settledFound(pursuit)
					})
				)
			)
		const hunter: Effect.Effect<
			void,
			E | TreeFailed | VerdictCacheUnusable,
			RunLease | Digest.Digest
		> = Effect.suspend(() =>
			Option.match(nextOf(pursuits), {
				onNone: () => Effect.void,
				onSome: ([pursuit, faced]) => Effect.andThen(tryOne(pursuit, faced), hunter)
			})
		)
		yield* Effect.all(
			Array.from({ length: pool.width }, () => hunter),
			{ concurrency: "unbounded", discard: true }
		)
		const unfound = Arr.filter(pursuits, (pursuit) => Option.isNone(pursuit.found))
		const probes = Arr.flatMap(unfound, (pursuit): ReadonlyArray<Probe> =>
			Arr.flatMap(Arr.dedupe(Arr.map(pursuit.queue, (faced) => faced.mutated.target)), (target) =>
				Option.toArray(
					Option.map(
						Arr.findFirst(sources, (source) => source.target === target),
						(source) => ({ pursuit, source })
					)
				)
			)
		)
		const probed = yield* trialsOn<E | TreeFailed, Loading>(
			pool,
			run.witnesses,
			Arr.map(probes, ({ pursuit, source }) =>
				trialOf(images, [pursuit.subject], probeOf(source.target, source.text))
			),
			"one each"
		)
		const unreached: ReadonlyArray<Probe> = Arr.flatMap(
			Arr.zip(probes, probed),
			([probe, verdict]: readonly [Probe, TrialVerdict<Loading>]) =>
				verdict.kind === "green" ? [probe] : []
		)
		const byPursuit = new Map<PropertyId, Counted>()
		for (const pursuit of pursuits) {
			const missed = Arr.findFirst(unreached, (probe) => probe.pursuit === pursuit)
			const standing: Standing = Option.match(pursuit.found, {
				onSome: (mutant) => ({ kind: "catches", by: { kind: "mutant", mutant } }),
				onNone: () =>
					Option.isSome(missed)
						? {
								kind: "unjudged",
								why: `the probe of ${missed.value.source.file}, a mutant that throws as soon as the module loads, survived it: it runs the file where its workers' module hook does not reach, in a child process, so it must need Checkout.dir`
							}
						: Option.match(pursuit.untyped, {
								onSome: (why) => ({ kind: "unjudged", why }),
								onNone: () => ({ kind: "never-caught" })
							})
			})
			const counted = countedOf(pursuit.subject, standing, pursuit.tried)
			byPursuit.set(pursuit.subject.id, counted)
			if (Option.isNone(pursuit.found)) {
				yield* run.settled(counted)
			}
		}
		return Arr.flatMap(run.subjects, (subject) =>
			Option.toArray(
				Option.orElse(Option.fromUndefinedOr(byKill.get(subject.id)), () =>
					Option.orElse(Option.fromUndefinedOr(byCoverage.get(subject.id)), () =>
						Option.fromUndefinedOr(byPursuit.get(subject.id))
					)
				)
			)
		)
	})
