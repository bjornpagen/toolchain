import { Array as Arr, Effect, Option, Order, type Scope } from "effect"
import { aimed, array, constant, element, finite, type Gen, int, map } from "#gen.ts"
import {
	type Case,
	type Kept,
	type NeedContext,
	type Property,
	property,
	ReplayToken
} from "#property.ts"
import { floorSeed } from "#random.ts"
import { type Drawn, type ReplayCase, replayOf, replayTokenOf } from "#replay.ts"
import { inlineEvaluator, searchInline } from "#runner/inline.ts"
import { type Limits, runnerLimits } from "#runner/limits.ts"
import type {
	Batch,
	CasePhase,
	CaseResult,
	Evaluator,
	Finding,
	Printed,
	Reach,
	Verdict
} from "#runner/protocol.ts"
import type { ModuleClosure, WorkerIndex } from "#runner/services.ts"
import { sample } from "#source.ts"

/**
 * What the meta-tests of the runner's searches share: an inner search run as a meta-test states it (its identity, run
 * seed, reach, limits and width), on an evaluator in this process that judges as many batches at once as the width it
 * is given, as a pool of that many workers would; and the readings of a verdict the properties compare.
 */

/** An inner search's run: its property's identity, the run's seed, which cases it runs, its limits and its width. */
export type InnerRun = Readonly<{
	id: string
	seed: number
	reach: Reach
	limits: Limits
	width: number
}>

/** The results of judged batches, in batch order, through the first batch holding a result `stop` holds of. */
const throughStop = (
	judged: ReadonlyArray<ReadonlyArray<CaseResult>>,
	stop: (result: CaseResult) => boolean
): ReadonlyArray<ReadonlyArray<CaseResult>> =>
	Option.match(
		Arr.findFirstIndex(judged, (batch) => Arr.some(batch, stop)),
		{ onNone: () => judged, onSome: (at) => Arr.take(judged, at + 1) }
	)

/**
 * What a search run in this process needs from its caller: every need's context but the worker index, which is 0, and
 * the module closures, which the inline evaluator hashes for the package it runs in.
 */
type InProcess = Exclude<NeedContext, WorkerIndex | ModuleClosure> | Scope.Scope

/**
 * An evaluator of one property in this process that judges `width` batches at once and gives back their results in
 * batch order through the first that stops its search, starting no batch after a group whose results stopped it: the
 * pool's contract, at a width the meta-test draws, so a property can hold a search to finding the same at every width.
 * Each of its `width` lanes is the library's inline evaluator (runner/inline.ts), with its own needs, as a worker has.
 */
const widthEvaluator = (
	inner: Property,
	width: number
): Effect.Effect<Evaluator, never, InProcess> =>
	Effect.gen(function* () {
		const lanes = yield* Effect.forEach(
			Array.from({ length: width }, (_, lane) => lane),
			() => inlineEvaluator(inner)
		)
		const one = (batch: Batch, lane: number) =>
			Option.match(Arr.get(lanes, lane), {
				onNone: () => Effect.die(`no lane ${lane} of ${width}`),
				onSome: (evaluator) =>
					Effect.map(
						evaluator.evaluate([batch], () => false),
						(results) => Arr.flatten(results)
					)
			})
		const evaluator: Evaluator = {
			evaluate: (batches, stop) =>
				Effect.gen(function* () {
					const judged: Array<ReadonlyArray<CaseResult>> = []
					for (const group of Arr.chunksOf(batches, width)) {
						const results = yield* Effect.forEach(group, one, { concurrency: "unbounded" })
						for (const batch of results) {
							judged.push(batch)
						}
						if (Arr.some(results, (batch) => Arr.some(batch, stop))) {
							return throughStop(judged, stop)
						}
					}
					return judged
				}),
			width: Effect.succeed(width)
		}
		return evaluator
	})

/** An inner search's verdict: the property's search, run as `run` states, on an evaluator of its width. */
export const searchedAt = (
	inner: Property,
	run: InnerRun
): Effect.Effect<Verdict, never, InProcess> =>
	Effect.flatMap(widthEvaluator(inner, run.width), (evaluator) =>
		inner.search({
			id: run.id,
			seed: run.seed,
			reach: run.reach,
			limits: run.limits,
			evaluator
		})
	)

/** A token's case replayed alone, as `toolchain-test replay` replays it, on an evaluator of the run's width. */
export const replayedAt = (
	inner: Property,
	run: InnerRun,
	token: string
): Effect.Effect<Verdict, never, InProcess> =>
	Effect.flatMap(widthEvaluator(inner, run.width), (evaluator) =>
		inner.replay(
			{ id: run.id, seed: run.seed, reach: run.reach, limits: run.limits, evaluator },
			token
		)
	)

/** A full run of an inner search at the runner's own limits, one batch at a time. */
export const fullRun = (id: string, seed: number): InnerRun => ({
	id,
	seed,
	reach: "full",
	limits: runnerLimits,
	width: 1
})

/** Every 32-bit run seed. */
export const seeds: Gen<number> = int(0, 2 ** 32 - 1)

/** A width a pool may have: one worker to a few dozen. */
export const widths: Gen<number> = int(1, 24)

/** A search's finding, when its verdict is a failure. */
export const findingOf = (verdict: Verdict): Option.Option<Finding> =>
	verdict.kind === "failed" ? Option.some(verdict.finding) : Option.none()

/** The values a token replays, when it reads. */
export const tokenValues = (token: string): Effect.Effect<Option.Option<ReadonlyArray<number>>> =>
	Effect.map(
		Effect.option(replayOf(token)),
		Option.map((replay) => replay.replayed.values)
	)

/** The kind of a verdict, a failure named by its finding's kind. */
export const verdictKind = (verdict: Verdict): string =>
	verdict.kind === "failed" ? verdict.finding.kind : verdict.kind

/** Values of 0..9 tagged with whether an aim drew them: the plain space, and the aim's. */
const tagged = (aimedAt: boolean): Gen<Readonly<{ value: number; aimed: boolean }>> =>
	map(int(0, 9), (value) => ({ value, aimed: aimedAt }))

/** The oracle of an inner search: a property planted to exercise the search itself. */
const planted = {
	kind: "specification",
	name: "a property planted to exercise the search itself"
} as const

/** An inner search over 0..9 whose every case passes. */
export const passing: Property = property.explore(int(0, 9), {
	needs: {},
	situations: [],
	check: () => () => Effect.void,
	oracle: planted,
	kept: [],
	kills: []
})

/** An inner search over 0..9 whose property fails, whatever the value, when its own draw of 0..1000 is `threshold`
 * or more. */
export const drawsFrom = (threshold: number): Property =>
	property.explore(int(0, 9), {
		needs: {},
		situations: [],
		check: (_resources, c) => () =>
			c.draw(int(0, 1000)) >= threshold ? Effect.die("drew too much") : Effect.void,
		oracle: planted,
		kept: [],
		kills: []
	})

/** An inner search over 0..9 that requires "rare" and whose property draws once more from 0..9. */
export const drawsOnce: Property = property.explore(int(0, 9), {
	needs: {},
	situations: ["rare"],
	check: (_resources, c) => () =>
		Effect.sync(() => {
			c.note("rare")
			c.draw(int(0, 9))
		}),
	oracle: planted,
	kept: [],
	kills: []
})

/** How a replayed token no longer runs as it says. */
export const STALE_KINDS = [
	"a requirement it does not declare",
	"draws left over",
	"draws run out"
] as const

export type StaleKind = (typeof STALE_KINDS)[number]

/**
 * A stale token's case for `drawsOnce`, whose cases take two values: steered by an undeclared requirement, one value
 * too many, or one too few.
 */
export const staleCases: Gen<readonly [StaleKind, ReplayCase]> = (source) => {
	const kind = source.draw(element(STALE_KINDS))
	switch (kind) {
		case "a requirement it does not declare":
			return [
				kind,
				{
					drawn: { kind: "steered", pending: [source.draw(int(1, 8))] },
					values: [source.draw(int(0, 9)), source.draw(int(0, 9))]
				}
			]
		case "draws left over":
			return [
				kind,
				{
					drawn: { kind: "unsteered" },
					values: [source.draw(int(0, 9)), source.draw(int(0, 9)), source.draw(int(0, 9))]
				}
			]
		case "draws run out":
			return [kind, { drawn: { kind: "unsteered" }, values: [source.draw(int(0, 9))] }]
	}
}

/**
 * An inner search over 0..9 requiring "rare", which its property notes only when its own draw of 0..2^30 is `magic`,
 * and which keeps the case `kept` names. A magic value in the middle of the range is one neither the random chooser's
 * lean toward the ends nor its floor's few dozen cases reach, so only the kept case reaches "rare".
 */
export const rareByDraw = (magic: number, kept: ReadonlyArray<Kept>): Property =>
	property.explore(int(0, 9), {
		needs: {},
		situations: ["rare"],
		check: (_resources, c) => () =>
			Effect.sync(() => {
				if (c.draw(int(0, 2 ** 30)) === magic) {
					c.note("rare")
				}
			}),
		oracle: planted,
		kept,
		kills: []
	})

/** A kept regression of `id`'s case `replayed`, kept today. */
export const keptOf = (id: string, replayed: ReplayCase): Kept => ({
	token: ReplayToken(replayTokenOf(id, replayed)),
	reason: "a case the meta-test keeps",
	since: "2026-11-16"
})

/** An inner search over 0..9, printed as the number, whose property fails when its own draw of 0..1000 is 990 or more. */
export const rareDraw = (kept: ReadonlyArray<Kept>): Property =>
	property.explore(int(0, 9), {
		needs: {},
		situations: [],
		check: (_resources, c) => () =>
			c.draw(int(0, 1000)) >= 990 ? Effect.die("a rare draw") : Effect.void,
		oracle: planted,
		kept,
		kills: [],
		show: String
	})

/** An inner search over 0..9 whose property records two decisions of the system under test, and keeps `kept`. */
export const observing = (
	decided: readonly [string, string],
	kept: ReadonlyArray<Kept>
): Property =>
	property.explore(int(0, 9), {
		needs: {},
		situations: [],
		check: (_resources, c) => () =>
			Effect.sync(() => {
				c.observe(decided[0])
				c.observe(decided[1])
			}),
		oracle: planted,
		kept,
		kills: []
	})

/**
 * An inner search requiring "x", which only a case an aim drew notes: whether each case it checked was drawn by the
 * aim, in the order checked, and the search. Its kept case is drawn by nothing.
 */
export const aimRecorder = (
	kept: ReadonlyArray<Kept>
): Readonly<{ aims: ReadonlyArray<boolean>; property: Property }> => {
	const aims: Array<boolean> = []
	return {
		aims,
		property: property.explore(aimed(tagged(false), [["x", tagged(true)]]), {
			needs: {},
			situations: ["x"],
			check: (_resources, c) => (drawnCase) =>
				Effect.sync(() => {
					aims.push(drawnCase.aimed)
					if (drawnCase.aimed) {
						c.note("x")
					}
				}),
			oracle: planted,
			kept: kept,
			kills: []
		})
	}
}

/**
 * An inner search requiring "x", which only a case an aim drew notes, whose property fails on the case it checks after
 * `floor` cases: with a floor of `floor` cases and none kept, the rotating stream's first.
 */
export const failsAfter = (floor: number): Property => {
	let checked = 0
	return property.explore(aimed(tagged(false), [["x", tagged(true)]]), {
		needs: {},
		situations: ["x"],
		check: (_resources, c) => (drawnCase) =>
			Effect.suspend(() => {
				checked += 1
				if (drawnCase.aimed) {
					c.note("x")
				}
				return checked > floor ? Effect.die("past the floor") : Effect.void
			}),
		oracle: planted,
		kept: [],
		kills: []
	})
}

/** The steering a token's case was drawn under, when the token reads. */
export const tokenDrawn = (token: string): Effect.Effect<Option.Option<Drawn>> =>
	Effect.map(
		Effect.option(replayOf(token)),
		Option.map((replay) => replay.replayed.drawn)
	)

/** `count` copies of `value`. */
export const copiesOf = <A>(value: A, count: number): ReadonlyArray<A> =>
	Array.from({ length: count }, () => value)

/** A drawn exhaustion: a × b values, a property drawing one of c more, its width, and the deadline its count races. */
export type SpaceShape = Readonly<{
	a: number
	b: number
	c: number
	width: number
	deadline: number
}>

/** An inner exhaustion of the pairs below `a` and `b` whose property draws one of `c` more, and what it ran. */
export const pairsOf = (
	shape: SpaceShape
): Readonly<{ ran: () => number; seen: ReadonlySet<string>; property: Property }> => {
	let ran = 0
	const seen = new Set<string>()
	return {
		ran: () => ran,
		seen,
		property: property.exhaust(
			finite(
				(source) => [source.draw(int(0, shape.a - 1)), source.draw(int(0, shape.b - 1))] as const
			),
			{
				box: "every pair of the drawn ranges, with the draw its property makes",
				needs: {},
				situations: [],
				check:
					(_resources, c) =>
					([x, y]) =>
						Effect.gen(function* () {
							yield* Effect.yieldNow
							ran += 1
							seen.add(`${x} ${y} ${c.draw(int(0, shape.c - 1))}`)
						}),
				oracle: planted,
				kept: [],
				kills: []
			}
		)
	}
}

/** An inner exhaustion of every whole number below 2^53, too many to count, and how many cases it ran. */
export const endless = (): Readonly<{ ran: () => number; property: Property }> => {
	let ran = 0
	return {
		ran: () => ran,
		property: property.exhaust(finite(int(0, 2 ** 53 - 1)), {
			box: "every whole number below 2^53",
			needs: {},
			situations: [],
			check: () => () =>
				Effect.sync(() => {
					ran += 1
				}),
			oracle: planted,
			kept: [],
			kills: []
		})
	}
}

/**
 * What the width oracle draws: a space of `values` values, each case drawing one of `draws` more; "rare" noted by the
 * value `rareAt`; failing on the values `failing` at a draw of at least `from`; and the width it runs at beside one.
 */
export type WidthSketch = Readonly<{
	values: number
	draws: number
	rareAt: number
	failing: ReadonlyArray<number>
	from: number
	width: number
}>

export const widthSketches: Gen<WidthSketch> = (source) => {
	const values = source.draw(int(2, 12))
	const draws = source.draw(int(1, 3))
	return {
		values,
		draws,
		rareAt: source.draw(int(0, values - 1)),
		failing: Arr.dedupe(source.draw(array(int(0, values - 1), { min: 0, max: 3 }))),
		from: source.draw(int(0, draws)),
		width: source.draw(int(2, 24))
	}
}

/** The width oracle's inner exhaustion of a sketch. */
export const sketchExhaustion = (sketch: WidthSketch): Property =>
	property.exhaust(finite(int(0, sketch.values - 1)), {
		box: "every value of the sketch's space, with the draw its property makes",
		needs: {},
		situations: ["rare"],
		check: (_resources, c) => (value) =>
			Effect.gen(function* () {
				yield* Effect.yieldNow
				const drew = c.draw(int(0, sketch.draws - 1))
				if (value === sketch.rareAt) {
					c.note("rare")
				}
				if (Arr.contains(sketch.failing, value) && drew >= sketch.from) {
					return yield* Effect.die("falsified")
				}
			}),
		oracle: planted,
		kept: [],
		kills: []
	})

/** Inner identities: each fixes its own floor and steered streams, so a property covers several of each. */
const LABELS = [
	"inner a",
	"inner b",
	"inner c",
	"inner d",
	"inner e",
	"inner f",
	"inner g",
	"inner h"
] as const

const labels: Gen<string> = (source) => source.draw(element(LABELS))

/** How the coverage oracle's inner property reaches "rare": never, in one value of fifty, of five, or always. */
const RARE_REACHES = ["never", "one in fifty", "one in five", "always"] as const

export type RareReach = (typeof RARE_REACHES)[number]

const reachesRare = (rare: RareReach, value: number): boolean => {
	switch (rare) {
		case "never":
			return false
		case "one in fifty":
			return value % 50 === 1
		case "one in five":
			return value % 5 === 1
		case "always":
			return true
	}
}

/** One run of an inner search: its seed and its width. */
export type SeedAndWidth = Readonly<{ seed: number; width: number }>

const seedsAndWidths: Gen<SeedAndWidth> = (source) => ({
	seed: source.draw(seeds),
	width: source.draw(widths)
})

/** What the coverage oracle draws: an inner property's identity, how it reaches "rare", its steered budget, two runs. */
export type VerdictSketch = Readonly<{
	label: string
	rare: RareReach
	budget: number
	runs: readonly [first: SeedAndWidth, second: SeedAndWidth]
}>

export const verdictSketches: Gen<VerdictSketch> = (source) => ({
	label: source.draw(labels),
	rare: source.draw(element(RARE_REACHES)),
	budget: source.draw(int(0, 64)),
	runs: [source.draw(seedsAndWidths), source.draw(seedsAndWidths)]
})

/** The values an inner exploration of the coverage oracle draws. */
const innerValues: Gen<number> = int(0, 999)

/** The coverage oracle's inner exploration, and every value its witnesses checked. */
const witnessed = (
	rare: RareReach
): Readonly<{ values: ReadonlyArray<number>; property: Property }> => {
	const values: Array<number> = []
	return {
		values,
		property: property.explore(innerValues, {
			needs: {},
			situations: ["common", "rare"],
			check: (_resources, c) => (value) =>
				Effect.sync(() => {
					values.push(value)
					c.note("common")
					if (reachesRare(rare, value)) {
						c.note("rare")
					}
				}),
			oracle: planted,
			kept: [],
			kills: []
		})
	}
}

/** The limits of an inner run of the coverage oracle: the runner's, with the sketch's steered budget. */
export const witnessLimits = (budget: number): Limits => ({ ...runnerLimits, steered: budget })

/** The witness verdict of a coverage sketch's inner search at one seed and width, and its witnesses' values in order. */
export const witnessRun = (sketch: VerdictSketch, at: SeedAndWidth) =>
	Effect.suspend(() => {
		const inner = witnessed(sketch.rare)
		return Effect.map(
			searchedAt(inner.property, {
				id: sketch.label,
				seed: at.seed,
				reach: "witnesses",
				limits: witnessLimits(sketch.budget),
				width: at.width
			}),
			(verdict) => ({ verdict, witnesses: Arr.sort(inner.values, Order.Number) })
		)
	})

/** What the floor stream alone decides of a coverage verdict: met, unreachable, or left to the steered phase. */
export type FloorDecides = "met" | "unreachable" | "steered"

/** What a sketch's floor stream decides, from the floor's own cases, drawn as the search draws them. */
export const floorDecides = (sketch: VerdictSketch): FloorDecides => {
	if (sketch.rare === "never") {
		return "unreachable"
	}
	const floor = sample(innerValues, floorSeed(sketch.label), runnerLimits.floor)
	return Arr.some(floor, (value) => reachesRare(sketch.rare, value)) ? "met" : "steered"
}

/**
 * What the aimed-case oracle draws: an inner search's identity, the value a case aimed at its pending "rare" draws,
 * which no plain draw of 0..9 reaches, and the width it runs at.
 */
export type AimedSketch = Readonly<{ label: string; aimedAt: number; width: number }>

export const aimedSketches: Gen<AimedSketch> = (source) => ({
	label: source.draw(labels),
	aimedAt: source.draw(int(10, 99)),
	width: source.draw(widths)
})

/**
 * The aimed-case oracle's inner search: values of 0..9, a case aimed at "rare" drawing `aimedAt` instead, the one value
 * that reaches "rare" and fails, printed as the number.
 */
export const aimedSearch = (sketch: AimedSketch, kept: ReadonlyArray<Kept>): Property =>
	property.explore(aimed(int(0, 9), [["rare", constant(sketch.aimedAt)]]), {
		needs: {},
		situations: ["rare"],
		check: (_resources, c) => (value) =>
			Effect.gen(function* () {
				if (value === sketch.aimedAt) {
					c.note("rare")
					return yield* Effect.die("falsified")
				}
			}),
		oracle: planted,
		kept,
		kills: [],
		show: String
	})

/** How the replay oracle's inner property fails: on a seventh of its values; on a high draw of a case aimed at "rare";
 * or on a high draw from a case that reached "rare". */
const FAILINGS = ["often", "aimed", "rarely"] as const

export type Failing = (typeof FAILINGS)[number]

/** What the replay oracle draws: an inner search of either kind, its identity, how it fails, its steered budget, and
 * two runs: the first's seed runs at both widths, and a witness's failure is also sought on the second's seed. */
export type FidelitySketch = Readonly<{
	search: "explore" | "exhaust"
	label: string
	failing: Failing
	budget: number
	runs: readonly [first: SeedAndWidth, second: SeedAndWidth]
}>

export const fidelitySketches: Gen<FidelitySketch> = (source) => ({
	search: source.draw(element(["explore", "exhaust"] as const)),
	label: source.draw(labels),
	failing: source.draw(element(FAILINGS)),
	budget: source.draw(int(0, 64)),
	runs: [source.draw(seedsAndWidths), source.draw(seedsAndWidths)]
})

/** A case of the replay oracle's inner search: its value, and whether an aim at a pending "rare" drew it. */
type FidelityCase = Readonly<{ value: number; aimed: boolean }>

const fidelityOf =
	(aimedAt: boolean): Gen<FidelityCase> =>
	(source) => ({ value: source.draw(innerValues), aimed: aimedAt })

/** Whether a case fails, as its sketch says, given its own draw. */
const failsOn = (failing: Failing, seen: FidelityCase, drew: number): boolean => {
	switch (failing) {
		case "often":
			return seen.value % 7 === 0
		case "aimed":
			return seen.aimed && drew >= 90
		case "rarely":
			return seen.value % 50 === 1 && drew >= 5
	}
}

/** The replay oracle's inner property: it draws wider where its case was aimed at "rare", and fails as its sketch
 * says. It yields first, so the cases judged at once interleave. */
const failingCheck =
	(failing: Failing) =>
	(_resources: Readonly<Record<string, never>>, c: Case<"rare">) =>
	(drawnCase: FidelityCase): Effect.Effect<void> =>
		Effect.gen(function* () {
			yield* Effect.yieldNow
			const drew = c.draw(int(0, drawnCase.aimed ? 99 : 9))
			if (drawnCase.value % 50 === 1) {
				c.note("rare")
			}
			if (failsOn(failing, drawnCase, drew)) {
				return yield* Effect.die("falsified")
			}
		})

/** The inner search a fidelity sketch names, keeping `kept`: an exploration aimed at "rare", or an exhaustion of
 * 0..59, which nothing steers. */
export const fidelitySearch = (sketch: FidelitySketch, kept: ReadonlyArray<Kept>): Property =>
	sketch.search === "explore"
		? property.explore(aimed(fidelityOf(false), [["rare", fidelityOf(true)]]), {
				needs: {},
				situations: ["rare"],
				check: failingCheck(sketch.failing),
				oracle: planted,
				kept,
				kills: []
			})
		: property.exhaust(
				finite(map(int(0, 59), (value): FidelityCase => ({ value, aimed: false }))),
				{
					box: "every value of 0..59, with the draw its property makes",
					needs: {},
					situations: ["rare"],
					check: failingCheck(sketch.failing),
					oracle: planted,
					kept,
					kills: []
				}
			)

/** A fidelity run of a sketch's inner search at one seed and width. */
export const fidelityRun = (sketch: FidelitySketch, at: SeedAndWidth): InnerRun => ({
	id: sketch.label,
	seed: at.seed,
	reach: "full",
	limits: witnessLimits(sketch.budget),
	width: at.width
})

/** A failure as fidelity compares it: where it was drawn and the token of its case. */
export const caseOf = (
	verdict: Verdict
): Option.Option<readonly [phase: CasePhase, token: string]> =>
	Option.flatMap(findingOf(verdict), (finding) =>
		finding.kind === "falsified"
			? Option.some([finding.phase, finding.token] as const)
			: Option.none()
	)

/** A falsifying finding, as properties compare one: where its case was drawn, how it printed, and its token. */
export type Falsified = Readonly<{ phase: CasePhase; printed: Printed; token: string }>

/** A verdict's falsifying finding, when it failed on a case. */
export const falsifiedOf = (verdict: Verdict): Option.Option<Falsified> =>
	Option.flatMap(findingOf(verdict), (finding) =>
		finding.kind === "falsified"
			? Option.some({ phase: finding.phase, printed: finding.printed, token: finding.token })
			: Option.none()
	)

/** Where a falsified case was drawn and how it printed, without its token. */
export const shownOf = (
	verdict: Verdict
): Option.Option<Readonly<{ phase: CasePhase; printed: Printed }>> =>
	Option.map(falsifiedOf(verdict), (falsified) => ({
		phase: falsified.phase,
		printed: falsified.printed
	}))

/** The situations a verdict found unreached, when it found some. */
export const unreachedOf = (verdict: Verdict): Option.Option<ReadonlyArray<string>> =>
	Option.flatMap(findingOf(verdict), (finding) =>
		finding.kind === "unreached" ? Option.some(finding.missing) : Option.none()
	)

/** Where a stale token's case came from, when a verdict found one stale. */
export const staleOf = (verdict: Verdict): Option.Option<CasePhase> =>
	Option.flatMap(findingOf(verdict), (finding) =>
		finding.kind === "stale" ? Option.some(finding.phase) : Option.none()
	)

/** A drawn case printed as its number, with no draws of its property's. */
export const printedNumber = (value: number): Printed => ({
	kind: "drawn",
	value: String(value),
	draws: []
})

/**
 * An inner search's verdict on the library's inline evaluator itself (runner/inline.ts), which judges a window's
 * batches together, so a late use of a case by a later case of its window is seen before the window is judged.
 */
export const searchedInline = (
	inner: Property,
	run: InnerRun
): Effect.Effect<Verdict, never, InProcess> =>
	searchInline(inner, { id: run.id, seed: run.seed, reach: run.reach, limits: run.limits })
