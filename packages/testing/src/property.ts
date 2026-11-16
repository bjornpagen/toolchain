import type { NodeServices } from "@effect/platform-node/NodeServices"
import { Array as Arr, Brand, Effect, Formatter, Option, type Scope } from "effect"
import type { NoCommands, StatefulMachine, StatefulSpec } from "#commands.ts"
import { statefulExplore } from "#commands.ts"
import type { Oracle } from "#explore.ts"
import { keyOf, type Pending, pendingAt, type Reached } from "#features.ts"
import type { Aimed, FiniteSpace, Gen, Space } from "#gen.ts"
import type { Interleaved, InterleaveSpec } from "#interleave.ts"
import { interleaveExplore } from "#interleave.ts"
import type { ReplayCase } from "#replay.ts"
import {
	type BatchCheck,
	batchesReadied,
	type Case,
	casesReadied,
	type Drawing,
	type Readying
} from "#runner/case.ts"
import { keptOf } from "#runner/keep.ts"
import type { SearchRun, Sense, Verdict } from "#runner/protocol.ts"
import { exhaustSearch, exploreSearch, replay, type Searched } from "#runner/search.ts"
import type { ModuleClosure, NeedFailed, WorkerIndex } from "#runner/services.ts"

export type { Aimed, Case, FiniteSpace, Oracle, Space }
export { ModuleClosure, NeedFailed, WorkerIndex } from "#runner/services.ts"
export type { Dictionary } from "#dictionary.ts"
export type { CaseList } from "#gen.ts"

/**
 * A test is a value, not a callback. A test module exports properties and nothing else
 * (`export const x = property.explore({ ... })`), and the runner, which owns every search's state machine, evaluates
 * their cases on a pool of workers, one per core: the unit of parallelism is the case. Nothing in a property can ask
 * for serial execution (no concurrency, sequence, retry, hook or timeout field), its resources exist only through
 * `needs` and are per case, its space comes only from generators, its regressions are replay tokens and its bugs are
 * kept mutants it must kill.
 *
 * Identity is the module (its path from the package root), the export, and a family's key: a replay token names it.
 */

/** A property's identity: `<module path from the package root>#<export>`, then `/<key>` for a family's member. */
export type PropertyId = string & Brand.Brand<"PropertyId">

export const PropertyId = Brand.nominal<PropertyId>()

/**
 * A replay token: a property's identity and one case's tape and steering. Replay is by token only; a kept case is a
 * token.
 */
export type ReplayToken = string & Brand.Brand<"ReplayToken">

export const ReplayToken = Brand.nominal<ReplayToken>()

/**
 * The services every need may require, by name: the platform, and the services a repository's runner config provides
 * through its `layer` (a database cluster, a repository root), which the repository declares with a module augmentation
 * of this interface, one property per service:
 * `declare module "@bjornpagen/testing/property" { interface RunnerServices { cluster: Cluster } }`.
 */
export interface RunnerServices {
	readonly platform: NodeServices
	readonly worker: WorkerIndex
	readonly closures: ModuleClosure
}

/** What a need may require: the worker's scope and the runner's services. */
export type NeedContext = Scope.Scope | RunnerServices[keyof RunnerServices]

/**
 * A per-case resource. `open` runs once per worker, in the worker's scope, when the worker readies the first property
 * that needs it (needs with the same `key` share it): before that property's first case there and outside every case's
 * deadline, within the runner's open bound (needOpenMillis), so a need that fails to open or outruns it fails the
 * property once, never a case. It keeps warm what the need keeps warm (a pool of pre-cloned databases); the effect it
 * returns gives one case its resource in the case's scope, released when the case ends. A shared mutable
 * resource is unrepresentable: what is shared is immutable (a Template) and what a case gets is its own.
 */
export type Need<A> = Readonly<{
	key: string
	open: Effect.Effect<Effect.Effect<A, NeedFailed, Scope.Scope>, NeedFailed, NeedContext>
}>

/** A property's needs, by the name its check reads each resource under. */
export type Needs = Readonly<Record<string, Need<unknown>>>

/**
 * The resources a case receives for its needs, by the name its check reads each under: each an effect that takes the
 * need's resource in the case's scope the first time the check yields it (`const db = yield* resources.db`), and gives
 * the same resource every later time, so a check takes only what it uses.
 */
export type Resources<N extends Needs> = {
	readonly [K in keyof N]: Effect.Effect<NeedValue<N[K]>, NeedFailed, Scope.Scope>
}

/** The resource a need gives. */
export type NeedValue<X> = X extends Need<infer A> ? A : never

/** What a check may require beyond its resources: the case's scope and the platform. */
export type CheckContext = Scope.Scope | NodeServices

/**
 * One case's check: given the case's resources and its handle (notes, mid-case draws, observations), it checks the
 * property on one value of the space. Any failure falsifies the case.
 */
export type Check<S, F extends string, N extends Needs, E> = (
	resources: Resources<N>,
	c: Case<F>
) => (value: S) => Effect.Effect<void, E, CheckContext>

/** The day a kept case was kept, as YYYY-MM-DD. */
export type Since = `${number}-${number}-${number}`

/** A regression kept by its replay token, with why it is kept and since when. It replays before any stream. */
export type Kept = Readonly<{ token: ReplayToken; reason: string; since: Since }>

/**
 * A bug the property must catch, kept by value: `original` stands once in `file` (a path from the repository root) and
 * is replaced by `replacement`. With it applied, the property's witness cases (the floor, the steered phase, an
 * exhaustion's every case) must fail. Kills are gated; operator mutation is a measurement.
 */
export type Kill = Readonly<{ file: string; original: string; replacement: string; why: string }>

/** What every kind of property states. */
type Stated<S, F extends string, N extends Needs, E> = Readonly<{
	/** The required situations: each must be reached by a witness case. Empty for none. */
	situations: ReadonlyArray<Reached<F>>
	needs: N
	check: Check<S, F, N, E>
	oracle: Oracle
	kept: ReadonlyArray<Kept>
	kills: ReadonlyArray<Kill>
	/** How a case prints, when its structural form (derived from the value) is not the clearest. */
	show?: (value: S) => string
	/**
	 * How long one of its cases may run, in milliseconds, when the runner's case deadline (caseDeadlineMillis) is too
	 * short for its honest work: a Limit, with the evidence that its cases take that long. Without one, the runner's.
	 */
	caseDeadline?: number
	/**
	 * How many steered cases its search may run while a required situation is unreached, when the runner's
	 * (steeredCases) is too few for its situations (a property that requires more situations than the runner's witnesses
	 * can reach one each): a Limit, with the evidence that its situations need that many. Without one, the runner's.
	 */
	steeredCases?: number
}>

/**
 * What a sampled search's steered phase perceives beyond its notes: V8's block coverage of the files whose path ends
 * with one of `blocks` (the code under test), so a case that runs a block or a count class no earlier case did is kept
 * as a seed. A guide only steers; it never decides a verdict.
 */
export type Guide = Readonly<{ blocks: Arr.NonEmptyReadonlyArray<string> }>

/**
 * What a sampled search states beside its space: `property.explore(space, spec)`. `guide` steers its steered phase by
 * block coverage too; without one it steers by notes alone. The space is the constructor's first argument, so the
 * value type a check takes is inferred from it before the check is read.
 */
export type ExploreStated<S, F extends string, N extends Needs, E> = Stated<S, F, N, E> &
	Readonly<{ guide?: Guide }>

/** A sampled search with its space, as a harness that builds one states it (interleave.ts, commands.ts). */
export type ExploreSpec<S, F extends string, N extends Needs, E> = ExploreStated<S, F, N, E> &
	Readonly<{ space: Space<S> | Aimed<S, F> }>

/** What an exhaustion states beside its finite space: the box it proves the property inside, in words. */
export type ExhaustSpec<S, F extends string, N extends Needs, E> = Stated<S, F, N, E> &
	Readonly<{ box: string }>

/**
 * What a batched property states beside its space: cases checked a batch at a time in one evaluation (a type-tier
 * batch checked in one compiler run), still drawn, shrunk alone and parallel across batches. `size` is how many cases
 * one batch holds; each case's own effect, from `checkAll`, is its verdict.
 */
export type BatchedSpec<S, F extends string, N extends Needs, E> = Omit<
	Stated<S, F, N, E>,
	"check"
> &
	Readonly<{
		size: number
		checkAll: (
			resources: Resources<N>
		) => (
			cases: Arr.NonEmptyReadonlyArray<readonly [S, Case<F>]>
		) => Effect.Effect<ReadonlyArray<Effect.Effect<void, E>>, E, CheckContext>
	}>

/**
 * The case a kept value is, as a replay token holds it: the steering it is drawn under and its tape's values (keep.ts
 * keptOf, under each steering the space aims by), or why none was found.
 */
export type Keeping =
	| Readonly<{ kind: "found"; replayed: ReplayCase }>
	| Readonly<{ kind: "unfound"; why: string }>

/**
 * The case a space draws `target` from: unsteered first, then under each of `aims` (an aimed space's situations, by
 * place, each pending and aimed at), so a value only an aim draws is found with the steering that draws it.
 */
const keepingOf =
	<S, F extends string>(drawing: Drawing<S, F>, aims: ReadonlyArray<number>) =>
	(target: unknown): Keeping => {
		const unsteered = keptOf(drawing.spaceUnder(Option.none()), target)
		if (unsteered.kind === "found") {
			return {
				kind: "found",
				replayed: { drawn: { kind: "unsteered" }, values: Arr.fromIterable(unsteered.values) }
			}
		}
		for (const place of aims) {
			const kept = keptOf(
				drawing.spaceUnder(Option.some(pendingAt(drawing.situations, [place]))),
				target
			)
			if (kept.kind === "found") {
				return {
					kind: "found",
					replayed: {
						drawn: { kind: "steered", pending: [place] },
						values: Arr.fromIterable(kept.values)
					}
				}
			}
		}
		return { kind: "unfound", why: unsteered.why }
	}

/** The places among `situations` of those an aimed space aims at: none for a plain space. */
const aimPlacesOf = <S, F extends string>(
	space: Space<S> | Aimed<S, F>,
	situations: ReadonlyArray<Reached<F>>
): ReadonlyArray<number> =>
	typeof space === "function"
		? []
		: Arr.flatMap(situations, (situation, place) =>
				Arr.some(space.aims, ([aimed]) => keyOf(aimed) === keyOf(situation)) ? [place] : []
			)

/** What kind of search a property is, as the report names it. */
export type PropertyKind = "explore" | "exhaust" | "batched" | "interleave" | "stateful"

/**
 * The search a property runs and how a process readies it to evaluate its cases (its needs opened first), every type it
 * was stated with erased into closures.
 */
type Made = Readonly<{
	kind: PropertyKind
	needs: Needs
	guide: Sense
	oracle: Oracle
	kills: ReadonlyArray<Kill>
	search: (run: SearchRun) => Effect.Effect<Verdict>
	replay: (run: SearchRun, token: string) => Effect.Effect<Verdict>
	keep: (target: unknown) => Keeping
	ready: Readying
}>

/**
 * What the runner runs: a property, its case type, needs and failures erased at construction into closures (its
 * search, its replay of one token, and how a process readies it: its needs opened, outside any case's deadline, then the
 * evaluation of a batch of its cases), so one runner holds properties of
 * every type with no cast. Its needs stay readable, by key, so the mutator knows a property that needs Checkout.dir. A test module only ever builds one with a constructor of `property` or a harness
 * constructor that returns one or a Family.
 */
export class Property {
	readonly kind: PropertyKind
	readonly needs: Needs
	readonly guide: Sense
	readonly oracle: Oracle
	readonly kills: ReadonlyArray<Kill>
	readonly search: Made["search"]
	readonly replay: Made["replay"]
	readonly keep: Made["keep"]
	readonly ready: Made["ready"]

	constructor(made: Made) {
		this.kind = made.kind
		this.needs = made.needs
		this.guide = made.guide
		this.oracle = made.oracle
		this.kills = made.kills
		this.search = made.search
		this.replay = made.replay
		this.keep = made.keep
		this.ready = made.ready
	}
}

/** A harness's properties under keys: the runner expands a family into its members, each `<export>/<key>`. */
export class Family {
	readonly members: Readonly<Record<string, Property>>

	constructor(members: Readonly<Record<string, Property>>) {
		this.members = members
	}
}

/** The search's view of a property's stated situations and kept tokens. */
const searchedOf = <F extends string>(
	situations: ReadonlyArray<Reached<F>>,
	kept: ReadonlyArray<Kept>,
	guide: Sense
): Searched => ({
	situations: Arr.map(situations, keyOf),
	kept: Arr.map(kept, (token) => ({ token: token.token, reason: token.reason })),
	guide
})

/** What a property's steered phase perceives: its guide's blocks, or its notes alone when it states none. */
const senseOf = (guide: Guide | undefined): Sense =>
	guide === undefined ? { kind: "notes" } : { kind: "blocks", files: guide.blocks }

/** How a case prints: the property's show, or the value's structural form. */
const printOf = <S>(show: Stated<S, string, Needs, unknown>["show"]): ((value: S) => string) =>
	show ?? ((value) => Formatter.format(value))

/** The space a case's steering selects: an aimed space's aim at the pending situation its turn aims at, or the space. */
const spaceUnderOf =
	<S, F extends string>(space: Space<S> | Aimed<S, F>) =>
	(steering: Option.Option<Pending<F>>): Gen<S> => {
		if (typeof space === "function") {
			return space
		}
		return Option.match(
			Option.flatMap(steering, (pending) =>
				Arr.findFirst(space.aims, ([situation]) => pending.aimed(situation))
			),
			{ onNone: () => space.space, onSome: ([, aim]) => aim }
		)
	}

/** An explored property of `kind`: its cases one an evaluation, its search an exploration. */
const exploredAs =
	(kind: "explore" | "interleave" | "stateful") =>
	<S, F extends string, N extends Needs, E>(spec: ExploreSpec<S, F, N, E>): Property => {
		const searched = searchedOf(spec.situations, spec.kept, senseOf(spec.guide))
		const drawing: Drawing<S, F> = {
			situations: spec.situations,
			spaceUnder: spaceUnderOf(spec.space),
			print: printOf(spec.show)
		}
		return new Property({
			kind,
			needs: spec.needs,
			guide: searched.guide,
			oracle: spec.oracle,
			kills: spec.kills,
			...boundedBy(spec, exploreSearch(searched, 1), replay(searched)),
			keep: keepingOf(drawing, aimPlacesOf(spec.space, spec.situations)),
			ready: casesReadied(drawing, spec.needs, spec.check)
		})
	}

/** The runner's limits a property may replace with a Limit it cites, each the runner's where it cites none. */
type Cited = Readonly<{ caseDeadline?: number; steeredCases?: number }>

/** A search run under the limits a property cites in place of the runner's, and the runner's otherwise. */
const citedIn =
	(cited: Cited) =>
	(run: SearchRun): SearchRun => ({
		...run,
		limits: {
			...run.limits,
			deadline: cited.caseDeadline ?? run.limits.deadline,
			steered: cited.steeredCases ?? run.limits.steered
		}
	})

/** A property's search and replay, each run under the limits it cites. */
const boundedBy = (
	cited: Cited,
	search: Made["search"],
	replaying: Made["replay"]
): Pick<Made, "search" | "replay"> => {
	const under = citedIn(cited)
	return {
		search: (run) => search(under(run)),
		replay: (run, token) => replaying(under(run), token)
	}
}

/** The constructors a test module builds its properties with, one per kind of search. */
export const property = {
	/** A sampled search of `space`, steered toward its required situations. */
	explore: <S, const F extends string, N extends Needs, E>(
		space: Space<S> | Aimed<S, F>,
		spec: ExploreStated<S, F, N, E>
	): Property => exploredAs("explore")({ ...spec, space }),
	/** Every case of a finite space: passing is a proof inside the box it names. */
	exhaust: <S, const F extends string, N extends Needs, E>(
		space: FiniteSpace<S>,
		spec: ExhaustSpec<S, F, N, E>
	): Property => {
		const searched = searchedOf(spec.situations, spec.kept, { kind: "notes" })
		const drawing: Drawing<S, F> = {
			situations: spec.situations,
			spaceUnder: () => space,
			print: printOf(spec.show)
		}
		return new Property({
			kind: "exhaust",
			needs: spec.needs,
			guide: searched.guide,
			oracle: spec.oracle,
			kills: spec.kills,
			...boundedBy(spec, exhaustSearch(searched, space, spec.box, 1), replay(searched)),
			keep: keepingOf(drawing, []),
			ready: casesReadied(drawing, spec.needs, spec.check)
		})
	},
	/** Cases checked a batch at a time in one evaluation, still drawn and shrunk one by one. */
	batched: <S, const F extends string, N extends Needs, E>(
		space: Space<S> | Aimed<S, F>,
		spec: BatchedSpec<S, F, N, E>
	): Property => {
		const searched = searchedOf(spec.situations, spec.kept, { kind: "notes" })
		const checkAll: BatchCheck<S, F, N, E> = spec.checkAll
		const drawing: Drawing<S, F> = {
			situations: spec.situations,
			spaceUnder: spaceUnderOf(space),
			print: printOf(spec.show)
		}
		return new Property({
			kind: "batched",
			needs: spec.needs,
			guide: searched.guide,
			oracle: spec.oracle,
			kills: spec.kills,
			...boundedBy(spec, exploreSearch(searched, spec.size), replay(searched)),
			keep: keepingOf(drawing, aimPlacesOf(space, spec.situations)),
			ready: batchesReadied(drawing, spec.needs, checkAll)
		})
	},
	/**
	 * Every case of a finite space, checked a batch at a time in one evaluation (a box of type agreements checked in one
	 * compiler run per batch): passing is a proof inside the box it names, as an exhaustion's; a failing case is shrunk
	 * alone.
	 */
	exhaustBatched: <S, const F extends string, N extends Needs, E>(
		space: FiniteSpace<S>,
		spec: BatchedSpec<S, F, N, E> & Readonly<{ box: string }>
	): Property => {
		const searched = searchedOf(spec.situations, spec.kept, { kind: "notes" })
		const checkAll: BatchCheck<S, F, N, E> = spec.checkAll
		const drawing: Drawing<S, F> = {
			situations: spec.situations,
			spaceUnder: () => space,
			print: printOf(spec.show)
		}
		return new Property({
			kind: "exhaust",
			needs: spec.needs,
			guide: searched.guide,
			oracle: spec.oracle,
			kills: spec.kills,
			...boundedBy(spec, exhaustSearch(searched, space, spec.box, spec.size), replay(searched)),
			keep: keepingOf(drawing, []),
			ready: batchesReadied(drawing, spec.needs, checkAll)
		})
	},
	/** Concurrent sessions run under every order or a drawn schedule (interleave.ts). */
	interleave: <C, S extends string, M, O, Q, A, W, N extends Needs, const F extends string, E, J>(
		space: Space<C> | Aimed<C, F | Interleaved>,
		spec: InterleaveSpec<C, S, M, O, Q, A, W, N, F, E, J>
	): Property => exploredAs("interleave")(interleaveExplore(space, spec)),
	/** Programs of a machine's commands run against the real system and its model (commands.ts). */
	stateful: <
		M,
		N extends Needs,
		const F extends string,
		E,
		PP = NoCommands,
		V extends string = never,
		PR = NoCommands,
		O extends string = never,
		X = never
	>(
		machine: StatefulMachine<M, PP, V, PR, O, X, N, F, E>,
		spec: StatefulSpec<PP, V, PR, O, N, F>
	): Property => statefulExplore(machine, spec, exploredAs("stateful"))
} as const

/** A harness's properties under keys, which the runner runs as `<export>/<key>`. */
export const family = (members: Readonly<Record<string, Property>>): Family => new Family(members)
