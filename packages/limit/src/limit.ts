/**
 * Limits: every number a codebase bounds something by, as a value that carries its evidence (the limits skill,
 * packages/devtools/skills/limits, which keeps the indefensible-numbers policy's terms). A limit is one of four kinds,
 * and nothing else:
 *
 * - published: a number a source states, PostgreSQL's, V8's, a protocol's, a provider's or a file system's, with the
 *   exact source, a quote of it, what kind of constraint it is, and the day it was opened and checked;
 * - measured: an operating value a measurement supports, with the record of that measurement, what it observed and
 *   under which environment and workload, how the value follows from it, and what invalidates it;
 * - derived: a value computed from other limits by the arithmetic its `compute` states, never a second spelling of
 *   their numbers;
 * - provisional: a protective cap no evidence defends yet, with what breaks without it, how it will be measured or
 *   sourced, and where its number came from. It is a debt, never an authority: it keeps work bounded until it is
 *   minted as one of the other three.
 *
 * A limit is minted only in its codebase's limits package (packages/limits, named `<scope>/limits`), by `published`,
 * `measured`, `derived` and `provisional`, and code reads its `.value`. The dev tools' oxlint rules hold that by syntax:
 * limits-sole-mint refuses a mint anywhere else, and no-bare-limit refuses a bare number where a limit belongs. A
 * library chooses no number on its caller's behalf: what is a choice is the caller's input, required and with no
 * default, and what is not is one of these.
 */
declare const limitBrand: unique symbol

/** A list with at least one element, its first element typed present. */
export type NonEmptyReadonlyArray<A> = readonly [A, ...Array<A>]

/** The day a source was opened and its number checked, or a debt recorded, as YYYY-MM-DD. */
export type VerifiedDate = `${number}-${number}-${number}`

/**
 * What a published number really is. A vendor default is not a maximum, and an example or an advisory in a vendor's
 * guide is an advisory threshold, not a quota. A compile-time constant is a define of the build
 * (`MaxHeapAttributeNumber`, `String::kMaxLength`).
 */
export type Constraint =
	| "hard quota"
	| "protocol constant"
	| "compile-time constant"
	| "configurable default"
	| "advisory threshold"

/** What every limit states: its number, who sets it, its unit, and exactly what it bounds. */
interface Stated<N extends number | bigint> {
	readonly value: N
	readonly owner: string
	readonly unit: string
	readonly scope: string
}

/** A published limit's evidence: the exact source stating the number, quoted, and when it was verified. */
export interface PublishedEvidence {
	readonly kind: "published"
	readonly constraint: Constraint
	readonly source: `https://${string}`
	readonly quote: string
	readonly verified: VerifiedDate
}

/**
 * A measured limit's evidence: a resolvable record of the measurement (its run output or the suite that re-verifies
 * it), the interval observed, the environment and the workload, the result, how the value follows from it, and what
 * invalidates it.
 */
export interface MeasuredEvidence {
	readonly kind: "measured"
	readonly evidence: string
	readonly observed: string
	readonly environment: string
	readonly workload: string
	readonly result: string
	readonly decision: string
	readonly revalidate: string
}

/** A derived limit's evidence: the limits it is computed from, and why the arithmetic bounds what it bounds. */
export interface DerivedEvidence {
	readonly kind: "derived"
	readonly from: NonEmptyReadonlyArray<AnyLimit>
	readonly derivation: string
}

/**
 * A provisional limit's debt: a cap that protects something though no evidence defends its number yet. `breaks` says
 * what goes wrong without it (the unbounded work, wait or growth it stops), `measure` how its number will be defended
 * (the measurement to run, or the source to find, and what will decide the value), `origin` where the number came from
 * as it stands (an old record whose revalidation fired, the commit that wrote it), and `recorded` the day the debt was
 * written down.
 */
export interface ProvisionalEvidence {
	readonly kind: "provisional"
	readonly breaks: string
	readonly measure: string
	readonly origin: string
	readonly recorded: VerifiedDate
}

/** Any kind's evidence. */
type Evidence = PublishedEvidence | MeasuredEvidence | DerivedEvidence | ProvisionalEvidence

/** A limit with its evidence: published, measured, derived or provisional. */
export type Limit<N extends number | bigint = number> = Stated<N> &
	Evidence & { readonly [limitBrand]: N }

/** A limit of either carrier, as a derived limit's inputs are. */
export type AnyLimit = Limit | Limit<bigint>

/** The one mint of a Limit: a limit with its evidence, frozen by the constructor that built it, branded. */
/* @__NO_SIDE_EFFECTS__ */
const mint = <N extends number | bigint>(limit: Readonly<Stated<N> & Evidence>): Limit<N> => {
	/** The claim behind the mint, unchecked: a frozen record of a number and its evidence is a Limit of its kind. */
	const claim: (record: Readonly<Stated<N> & Evidence>) => asserts record is Limit<N> = () =>
		undefined
	claim(limit)
	return limit
}

/** A limit a source states. */
/* @__NO_SIDE_EFFECTS__ */
export const published = <N extends number | bigint>(
	limit: Stated<N> & Omit<PublishedEvidence, "kind">
): Limit<N> => mint(Object.freeze({ ...limit, kind: "published" }))

/** An operating limit a measurement supports. */
/* @__NO_SIDE_EFFECTS__ */
export const measured = <N extends number | bigint>(
	limit: Stated<N> & Omit<MeasuredEvidence, "kind">
): Limit<N> => mint(Object.freeze({ ...limit, kind: "measured" }))

/**
 * A limit computed from other limits: `compute` reads their values, so the derived number is never a second spelling
 * of theirs, and `derivation` says why the arithmetic bounds the resource. A data length the computation reads (the
 * width of a format the code prints, a list's length) needs no limit of its own.
 */
/* @__NO_SIDE_EFFECTS__ */
export const derived = <
	const From extends NonEmptyReadonlyArray<AnyLimit>,
	N extends number | bigint
>(limit: {
	readonly owner: string
	readonly unit: string
	readonly scope: string
	readonly from: From
	readonly derivation: string
	readonly compute: (from: From) => N
}): Limit<N> =>
	mint(
		Object.freeze({
			value: limit.compute(limit.from),
			owner: limit.owner,
			unit: limit.unit,
			scope: limit.scope,
			kind: "derived",
			from: limit.from,
			derivation: limit.derivation
		})
	)

/**
 * A protective cap no evidence defends yet, kept so the work it bounds stays bounded: a debt to measure or source,
 * which review reads as such and never as an authority. Mint it this way only where deleting the cap would unleash
 * unbounded work and nothing published, measured or derived states its number; never to rename a guess into one.
 */
/* @__NO_SIDE_EFFECTS__ */
export const provisional = <N extends number | bigint>(
	limit: Stated<N> & Omit<ProvisionalEvidence, "kind">
): Limit<N> => mint(Object.freeze({ ...limit, kind: "provisional" }))
