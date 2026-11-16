import type { NodeServices } from "@effect/platform-node/NodeServices"
import { type Array as Arr, Brand, type Effect, type Scope, Schema } from "effect"
import type { Case, Oracle } from "#explore.ts"
import type { Reached } from "#features.ts"
import type { Gen } from "#gen.ts"

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

declare const caseListBrand: unique symbol

declare const finiteBrand: unique symbol

declare const dictionaryBrand: unique symbol

/**
 * A pick from a literal list: a generator, so a generator may draw one inside a case it builds (an alphabet, a tag), but
 * never a Space by itself, since a space that is a list of cases is an example table. `element` over a literal array
 * returns one.
 */
export type CaseList<A> = Gen<A> & Readonly<{ [caseListBrand]: true }>

/** What a property draws its cases from: a generator built from generators, never a CaseList. */
export type Space<A> = Gen<A> & Readonly<{ [caseListBrand]?: never }>

/**
 * A space an exhaustion runs every case of. It is declared (`finite`) and checked: the runner counts it before any case
 * runs, and a count the case deadline cuts fails, naming the space.
 */
export type FiniteSpace<A> = Space<A> & Readonly<{ [finiteBrand]: true }>

/**
 * A closed vocabulary minted only through a dictionary door (a module the import-doors rule lets mint one, such as a
 * language's keywords): `element` over a Dictionary is a Space, since its items are the domain, not chosen cases.
 */
export type Dictionary<A> = Arr.NonEmptyReadonlyArray<A> & Readonly<{ [dictionaryBrand]: true }>

/** A space whose generator draws a case aimed at a pending required situation when its turn aims there. */
export type Aimed<A, F extends string> = Readonly<{
	space: Space<A>
	aims: ReadonlyArray<readonly [Reached<F>, Space<A>]>
}>

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

/** The resources a case receives for its needs. */
export type Resources<N extends Needs> = {
	readonly [K in keyof N]: N[K] extends Need<infer A> ? A : never
}

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

/**
 * What the runner runs: a property with its case type, needs and failures erased into closures at construction (no
 * casts), so one runner holds properties of every type. Its representation is the runner's own (CORE); a test module
 * only ever builds one with a constructor: `property.explore`, `property.exhaust`, `property.batched`,
 * `property.interleave` (interleave.ts) or `property.stateful` (commands.ts), or a harness constructor that returns one
 * or a Family.
 */
export type Property = Readonly<{
	kind: "explore" | "exhaust" | "batched" | "interleave" | "stateful"
}>

/** A harness's properties under keys: the runner expands a family into its members, each `<export>/<key>`. */
export type Family = Readonly<{ kind: "family"; members: Readonly<Record<string, Property>> }>
