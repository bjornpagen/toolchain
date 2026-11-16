import type { NodeServices } from "@effect/platform-node/NodeServices"
import { Array as Arr, Brand, Effect, Formatter, Option, Schema, type Scope } from "effect"
import type { StatefulSpec } from "#commands.ts"
import { statefulExplore } from "#commands.ts"
import type { Oracle } from "#explore.ts"
import { keyOf, type Pending, type Reached } from "#features.ts"
import type { Aimed, FiniteSpace, Gen, Space } from "#gen.ts"
import type { InterleaveSpec } from "#interleave.ts"
import { interleaveExplore } from "#interleave.ts"
import {
	type BatchCheck,
	type Case,
	type CaseEnv,
	type Drawing,
	evaluateBatch,
	evaluateCase
} from "#runner/case.ts"
import type { Batch, CaseResult, SearchRun, Verdict } from "#runner/protocol.ts"
import { exhaustSearch, exploreSearch, replay, type Searched } from "#runner/search.ts"

export type { Aimed, Case, FiniteSpace, Oracle, Space }
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

/** A need failed to open or to give a case its resource: the case fails with it, never the run silently. */
export class NeedFailed extends Schema.TaggedError<NeedFailed, { readonly brand: unique symbol }>()(
	"NeedFailed",
	{ need: Schema.String, message: Schema.String }
) {}

/**
 * The services every need may require, by name: the platform, and the services a repository's runner config provides
 * through its `layer` (a database cluster, a repository root), which the repository declares with a module augmentation
 * of this interface, one property per service:
 * `declare module "@bjornpagen/testing/property" { interface RunnerServices { cluster: Cluster } }`.
 */
export interface RunnerServices {
	readonly platform: NodeServices
}

/** What a need may require: the worker's scope and the runner's services. */
export type NeedContext = Scope.Scope | RunnerServices[keyof RunnerServices]

/**
 * A per-case resource. `open` runs once per worker, in the worker's scope, the first time a case on that worker needs
 * it (needs with the same `key` share it), and keeps warm what the need keeps warm (a pool of pre-cloned databases);
 * the effect it returns gives one case its resource in the case's scope, released when the case ends. A shared mutable
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
}>

/** A sampled search, steered toward its required situations: `property.explore(spec)`. */
export type ExploreSpec<S, F extends string, N extends Needs, E> = Stated<S, F, N, E> &
	Readonly<{ space: Space<S> | Aimed<S, F> }>

/** Every case of a finite space; passing is a proof inside the box it names: `property.exhaust(spec)`. */
export type ExhaustSpec<S, F extends string, N extends Needs, E> = Stated<S, F, N, E> &
	Readonly<{ space: FiniteSpace<S>; box: string }>

/**
 * Cases checked a batch at a time in one evaluation (a type-tier batch checked in one compiler run): still drawn,
 * shrunk alone and parallel across batches: `property.batched(spec)`. `size` is how many cases one batch holds; each
 * case's own effect, from `checkAll`, is its verdict.
 */
export type BatchedSpec<S, F extends string, N extends Needs, E> = Omit<
	Stated<S, F, N, E>,
	"check"
> &
	Readonly<{
		space: Space<S>
		size: number
		checkAll: (
			resources: Resources<N>
		) => (
			cases: Arr.NonEmptyReadonlyArray<readonly [S, Case<F>]>
		) => Effect.Effect<ReadonlyArray<Effect.Effect<void, E>>, E, CheckContext>
	}>

/** What kind of search a property is, as the report names it. */
export type PropertyKind = "explore" | "exhaust" | "batched" | "interleave" | "stateful"

/** The search a property runs and the cases it evaluates, every type it was stated with erased into closures. */
type Made = Readonly<{
	kind: PropertyKind
	oracle: Oracle
	kills: ReadonlyArray<Kill>
	search: (run: SearchRun) => Effect.Effect<Verdict>
	replay: (run: SearchRun, token: string) => Effect.Effect<Verdict>
	evaluate: (batch: Batch) => Effect.Effect<ReadonlyArray<CaseResult>, never, CaseEnv>
}>

/**
 * What the runner runs: a property, its case type, needs and failures erased at construction into closures (its
 * search, its replay of one token, and the evaluation of a batch of its cases), so one runner holds properties of
 * every type with no cast. A test module only ever builds one with a constructor of `property` or a harness
 * constructor that returns one or a Family.
 */
export class Property {
	readonly kind: PropertyKind
	readonly oracle: Oracle
	readonly kills: ReadonlyArray<Kill>
	readonly search: Made["search"]
	readonly replay: Made["replay"]
	readonly evaluate: Made["evaluate"]

	constructor(made: Made) {
		this.kind = made.kind
		this.oracle = made.oracle
		this.kills = made.kills
		this.search = made.search
		this.replay = made.replay
		this.evaluate = made.evaluate
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
	kept: ReadonlyArray<Kept>
): Searched => ({
	situations: Arr.map(situations, keyOf),
	kept: Arr.map(kept, (token) => ({ token: token.token, reason: token.reason }))
})

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
		const searched = searchedOf(spec.situations, spec.kept)
		const drawing: Drawing<S, F> = {
			situations: spec.situations,
			spaceUnder: spaceUnderOf(spec.space),
			print: printOf(spec.show)
		}
		const evaluate = evaluateCase(drawing, spec.needs, spec.check)
		return new Property({
			kind,
			oracle: spec.oracle,
			kills: spec.kills,
			search: exploreSearch(searched, 1),
			replay: replay(searched),
			evaluate: (batch) => Effect.forEach(batch, evaluate)
		})
	}

/** The constructors a test module builds its properties with, one per kind of search. */
export const property = {
	/** A sampled search, steered toward its required situations. */
	explore: <S, const F extends string, N extends Needs, E>(
		spec: ExploreSpec<S, F, N, E>
	): Property => exploredAs("explore")(spec),
	/** Every case of a finite space: passing is a proof inside the box it names. */
	exhaust: <S, const F extends string, N extends Needs, E>(
		spec: ExhaustSpec<S, F, N, E>
	): Property => {
		const searched = searchedOf(spec.situations, spec.kept)
		const evaluate = evaluateCase(
			{ situations: spec.situations, spaceUnder: () => spec.space, print: printOf(spec.show) },
			spec.needs,
			spec.check
		)
		return new Property({
			kind: "exhaust",
			oracle: spec.oracle,
			kills: spec.kills,
			search: exhaustSearch(searched, spec.space, spec.box),
			replay: replay(searched),
			evaluate: (batch) => Effect.forEach(batch, evaluate)
		})
	},
	/** Cases checked a batch at a time in one evaluation, still drawn and shrunk one by one. */
	batched: <S, const F extends string, N extends Needs, E>(
		spec: BatchedSpec<S, F, N, E>
	): Property => {
		const searched = searchedOf(spec.situations, spec.kept)
		const checkAll: BatchCheck<S, F, N, E> = spec.checkAll
		return new Property({
			kind: "batched",
			oracle: spec.oracle,
			kills: spec.kills,
			search: exploreSearch(searched, spec.size),
			replay: replay(searched),
			evaluate: evaluateBatch(
				{ situations: spec.situations, spaceUnder: () => spec.space, print: printOf(spec.show) },
				spec.needs,
				checkAll
			)
		})
	},
	/** Concurrent sessions run under every order or a drawn schedule (interleave.ts). */
	interleave: <C, S extends string, M, O, Q, A, W, N extends Needs, const F extends string, E, J>(
		spec: InterleaveSpec<C, S, M, O, Q, A, W, N, F, E, J>
	): Property => exploredAs("interleave")(interleaveExplore(spec)),
	/** Programs of a machine's commands run against the real system and its model (commands.ts). */
	stateful: <M, P, V extends string, N extends Needs, const F extends string, E>(
		spec: StatefulSpec<M, P, V, N, F, E>
	): Property => exploredAs("stateful")(statefulExplore(spec))
} as const

/** A harness's properties under keys, which the runner runs as `<export>/<key>`. */
export const family = (members: Readonly<Record<string, Property>>): Family => new Family(members)
