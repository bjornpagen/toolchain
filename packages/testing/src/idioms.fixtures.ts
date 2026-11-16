/**
 * What idioms.test.ts's properties draw and judge with: their spaces, the models their second implementations build
 * by naive recursion, the documented rates their random reach is held to, and the grammar the patterns they generate
 * from are written in.
 */
import { regex } from "arkregex"
import { Array as Arr, Option, Order, pipe, Result, Schema, String as Str } from "effect"
import { type Fraction, fraction } from "#chance.fixtures.ts"
import { type Dictionary, dictionary, word } from "#dictionary.ts"
import {
	aimed,
	alphabet,
	array,
	type Aimed,
	boolean,
	characterOf,
	codePoint,
	constant,
	element,
	type Gen,
	increasing,
	int,
	map,
	oneOf,
	recursive,
	type Size,
	string,
	uniqueArray,
	uniqueKeys,
	type Weight,
	weighted
} from "#gen.ts"
import {
	type Corruption,
	type Drawn,
	type DrawnFeature,
	lsw,
	WILD_KINDS,
	type WildKind,
	wild
} from "#lsw.ts"
import type { Kill } from "#property.ts"
import { wordsOf } from "#random.ts"
import {
	type Chooser,
	generate,
	type Generated,
	prefixChooser,
	randomChooser,
	recorder
} from "#source.ts"
import type { Presence, SwarmWeight } from "#swarm.ts"
import { bigint, double, doubleOrSpecial, type UuidVersion } from "#values.ts"

/**
 * A chooser that takes every decision's greatest value: a draw at the far end of its range, which a double drawn whole
 * starts its shrink from where its seed's draw does not fail, and which a wide whole number draws at its high word's
 * top, where only the low word's bound keeps it within its range.
 */
export const greatestChooser: Chooser = { exhausted: () => false, draw: (_lo, hi) => hi }

/** The decision that takes a floating-point draw's first arm, its whole numbers, when its range holds any. */
export const WHOLE_ARM = Float64Array.of(0)

/**
 * A floating-point generator's draws at the far end of each arm: every decision at its greatest, which takes the arm by
 * place to its range's end farthest from zero, and the whole numbers' arm with every later decision at its greatest,
 * which takes it to its whole number farthest from zero.
 */
export const farDraws = (
	generator: Gen<number>
): Readonly<{ farthest: number; farthestWhole: number }> => ({
	farthest: generate(recorder(), generator, greatestChooser).value,
	farthestWhole: generate(
		recorder(),
		generator,
		prefixChooser(WHOLE_ARM, WHOLE_ARM.length, greatestChooser)
	).value
})

/** A case drawn fresh from one seed. */
export const fresh = <A>(generator: Gen<A>, seed: number): Generated<A> =>
	generate(recorder(), generator, randomChooser(wordsOf(seed)))

/** A list known to be non-empty, as its type says; a generator of at least one value draws it. */
export const nonEmpty = <A>(values: ReadonlyArray<A>): Arr.NonEmptyReadonlyArray<A> =>
	Option.getOrThrow(Option.liftPredicate(values, Arr.isReadonlyArrayNonEmpty))

/** A search over the seed a fresh case is drawn from: any seed of the word source. */
export const seeds: Gen<number> = int(0, 0xffff_ffff)

/** The values of `wanted` a random search never drew, compared as `Object.is` compares, so -0 is not 0. */
export const neverDrawn = <A>(
	values: ReadonlyArray<A>,
	wanted: ReadonlyArray<A>
): ReadonlyArray<A> =>
	Arr.filter(wanted, (value) => !Arr.some(values, (seen) => Object.is(seen, value)))

/** Two draws of `generator` as a range: the lesser first. */
export const boundsOf =
	<A extends number | bigint>(generator: Gen<A>): Gen<readonly [lo: A, hi: A]> =>
	(source) => {
		const first = source.draw(generator)
		const second = source.draw(generator)
		return first <= second ? [first, second] : [second, first]
	}

/** Every whole number from -5 to 5 as a range's low end, with every high end from there to 5. */
export const smallBounds: Gen<readonly [lo: number, hi: number]> = (source) => {
	const lo = source.draw(int(-5, 5))
	return [lo, source.draw(int(lo, 5))]
}

/** int's order: by distance from zero, the positive side first. */
export const byDistanceFromZero = Order.mapInput(
	Order.Number,
	(value: number) => Math.abs(value) * 2 + (value < 0 ? 1 : 0)
)

/** The whole numbers from `lo` to `hi`, in ascending order. */
export const wholeNumbers = (lo: number, hi: number): ReadonlyArray<number> =>
	Array.from({ length: hi - lo + 1 }, (_, i) => lo + i)

/** The greatest finite 32-bit float. */
export const FLOAT_MAX = 3.402_823_466_385_288_6e38

/** A UUID in RFC 9562's canonical form: lowercase hexadecimal, a version of 1 to 8 and the variant 10. */
export const CANONICAL_UUID = regex(
	"^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)

/** RFC 9562's UUID versions, the vocabulary `uuid` takes. */
const UUID_VERSIONS: Dictionary<UuidVersion> = dictionary<UuidVersion>([1, 2, 3, 4, 5, 6, 7, 8])

/** One UUID version. */
export const uuidVersion: Gen<UuidVersion> = word(UUID_VERSIONS)

/**
 * A generator whose values a random search must reach, the values code branches on: a range's ends, zero, -0 and the
 * special doubles, with the least chance per draw its documented rates give each of them.
 */
type Reaching = Readonly<{
	generator: Gen<unknown>
	values: ReadonlyArray<unknown>
	chance: number
}>

/** The kinds of generator the reach search draws. */
export const REACHING_KINDS = ["int", "bigint", "double", "double or special"] as const

export type ReachingKind = (typeof REACHING_KINDS)[number]

/**
 * The least chance a random search draws one of a wide decision's ends, or the value one step in from its high end: a
 * draw leans to an end one time in eight, to either end equally, at a distance whose bit width is uniform over the
 * range's own, so distance 0 has at least half of that width's chances and distance 1 a quarter.
 */
const leanedEnd = (span: number): number => 1 / (16 * (Math.floor(Math.log2(span + 1)) + 1))

/** What a reach case draws besides its kind: a range's width and side, a bigint's bit width, a double's bound. */
type ReachParameters = Readonly<{ width: number; side: number; bits: number; exponent: number }>

const reachParameters: Gen<ReachParameters> = (source) => ({
	width: source.draw(int(257, 2 ** 31 - 1)),
	side: source.draw(int(0, 2)),
	bits: source.draw(int(33, 70)),
	exponent: source.draw(int(0, 20))
})

/** A reach case: the kind of generator, the seed its sample is drawn from, and the generator's parameters. */
export const reachCase: Gen<
	Readonly<{ kind: ReachingKind; seed: number; parameters: ReachParameters }>
> = (source) => ({
	kind: source.draw(element(REACHING_KINDS)),
	seed: source.draw(seeds),
	parameters: source.draw(reachParameters)
})

/**
 * A wide generator of each kind, and what it reaches, by the drawn parameters; a double or special within 1..2, which
 * holds no -0, so only its special arm reaches -0.
 */
export const reaching = (
	kind: ReachingKind,
	{ width, side, bits, exponent }: ReachParameters
): Reaching => {
	switch (kind) {
		case "int": {
			const [lo, hi] = side === 0 ? [0, width] : side === 1 ? [-width, 0] : [-width, width]
			return {
				generator: int(lo, hi),
				values: Arr.dedupe([0, lo, hi]),
				chance: leanedEnd(hi - lo)
			}
		}
		case "bigint": {
			const lo = -(2n ** BigInt(bits))
			const hi = 2n ** BigInt(bits) - 1n
			return { generator: bigint(lo, hi), values: [lo, 0n, hi], chance: 1 / (8 * 2 * 33) }
		}
		case "double": {
			const bound = 2 ** exponent
			return {
				generator: double(-bound, bound),
				values: [-bound, -0, 0, bound],
				chance: Math.min(
					2 * bound + 1 <= 256 ? 1 / (4 * (2 * bound + 1)) : leanedEnd(2 * bound) / 4,
					(3 / 4) * (1 / 8) * (1 / 33) * (1 / 4)
				)
			}
		}
		case "double or special":
			return {
				generator: doubleOrSpecial(1, 2),
				values: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0],
				chance: 1 / (10 * 4)
			}
	}
}

/** How many draws make a miss of any one value less likely than e^-30, about 10^-13. */
export const drawsFor = (chance: number): number => Math.ceil(30 / chance)

/** A box of shuffles: how many values, 0 to 4, and every size within that count. */
export const shuffleBox: Gen<Readonly<{ count: number; size: Size }>> = (source) => {
	const count = source.draw(int(0, 4))
	const max = source.draw(int(0, count))
	return { count, size: { min: source.draw(int(0, max)), max } }
}

/** Every arrangement of `values`, each value at most once, of a length within `size`. */
export const arrangementsModel = <A>(
	values: ReadonlyArray<A>,
	size: Size
): ReadonlyArray<ReadonlyArray<A>> => {
	const grown: Array<ReadonlyArray<A>> = []
	const grow = (prefix: ReadonlyArray<A>, rest: ReadonlyArray<A>): void => {
		if (prefix.length >= size.min) {
			grown.push(prefix)
		}
		if (prefix.length < size.max) {
			for (const [at, value] of rest.entries()) {
				grow([...prefix, value], Arr.remove(rest, at))
			}
		}
	}
	grow([], values)
	return grown
}

/** A unique array's case: how many keys its key generator holds, whether each item carries a tail, its size, its seed. */
export type UniqueCase = Readonly<{ keys: number; projected: boolean; size: Size; seed: number }>

export const uniqueCase: Gen<UniqueCase> = (source) => {
	const keys = source.draw(int(1, 6))
	const min = source.draw(int(0, 7))
	return {
		keys,
		projected: source.draw(boolean),
		size: { min, max: source.draw(int(min, 7)) },
		seed: source.draw(seeds)
	}
}

/**
 * A unique array's item generator was run a second time for one key: the array built an item it then dropped, as a
 * repair that walks items, not keys, does.
 */
class ItemRebuilt extends Schema.TaggedError<ItemRebuilt, { readonly brand: unique symbol }>()(
	"ItemRebuilt",
	{ key: Schema.Int, message: Schema.String }
) {}

/**
 * A unique array's keys, the keys `0..keys - 1`: projected, each item a key and a tail of 2^32 values that the array
 * then drops, otherwise the keys alone; and the keys the item generator was run for, in order. The item generator
 * refuses to run twice for one key (ItemRebuilt), so a repair that builds an item fails the case at once, before it
 * could walk a tail of 2^32 values.
 */
export const uniqueOf = ({
	keys,
	projected,
	size
}: UniqueCase): Readonly<{
	generator: Gen<ReadonlyArray<number>>
	built: () => ReadonlyArray<number>
}> => {
	const builtFor: Array<number> = []
	const itemOf =
		(key: number): Gen<readonly [key: number, tail: number]> =>
		(source) => {
			if (Arr.contains(builtFor, key)) {
				throw ItemRebuilt.make({ key, message: `the item of key ${key} was built twice` })
			}
			builtFor.push(key)
			return [key, source.draw(int(0, 2 ** 32 - 1))]
		}
	const generator = projected
		? map(uniqueArray(int(0, keys - 1), itemOf, size), (pairs) => Arr.map(pairs, ([key]) => key))
		: uniqueKeys(int(0, keys - 1), size)
	return { generator, built: () => builtFor }
}

/** The first 1 to 4 letters of the alphabet: a, then up to three of b, c and d. */
export const firstLetters: Gen<Arr.NonEmptyReadonlyArray<string>> = map(int(0, 3), (more) =>
	Arr.prepend(
		Array.from({ length: more }, (_, at) => String.fromCodePoint(0x62 + at)),
		"a"
	)
)

/** Every subset of `values`, each in their order. */
const subsetsOf = <A>(values: ReadonlyArray<A>): ReadonlyArray<ReadonlyArray<A>> => {
	const none: ReadonlyArray<ReadonlyArray<A>> = [[]]
	return Arr.reduce(values, none, (subsets, value) =>
		Arr.flatMap(subsets, (subset) => [subset, Arr.append(subset, value)])
	)
}

/** Every alphabet of `letters`: each letter kept first, then each subset of the others in their order. */
export const alphabetsModel = (
	letters: Arr.NonEmptyReadonlyArray<string>
): ReadonlyArray<ReadonlyArray<string>> =>
	Arr.flatMap(letters, (kept, at) =>
		Arr.map(subsetsOf(Arr.remove(letters, at)), (others) => [kept, ...others])
	)

/** A clone case: how many twins, and the seed they are drawn from. */
export const cloneCase: Gen<Readonly<{ count: number; seed: number }>> = (source) => ({
	count: source.draw(int(1, 4)),
	seed: source.draw(seeds)
})

/** The small values production draws beside its constant: a non-empty alphabet of 1 to 8. */
export const smallValues: Gen<Arr.NonEmptyReadonlyArray<number>> = alphabet([
	1, 2, 3, 4, 5, 6, 7, 8
])

export type Letter = "a" | "b" | "c"

/** Every alphabet of a, b and c. */
export const letterAlphabets: Gen<Arr.NonEmptyReadonlyArray<Letter>> = alphabet<Letter>([
	"a",
	"b",
	"c"
])

/** A feature's weight in a swarm: off, or present at one to three thirds. */
const swarmWeightGen: Gen<SwarmWeight> = element([0, 1, 2, 3] as const)

/** A swarm's weight for each of a, b and c, against a choice among an alphabet of them. */
export const swarmWeightsBox: Gen<
	Readonly<{
		weights: Readonly<Record<Letter, SwarmWeight>>
		options: Arr.NonEmptyReadonlyArray<Letter>
	}>
> = (source) => ({
	weights: {
		a: source.draw(swarmWeightGen),
		b: source.draw(swarmWeightGen),
		c: source.draw(swarmWeightGen)
	},
	options: source.draw(letterAlphabets)
})

/** Whether a swarm weight is a presence: on at one to three thirds. */
export const isPresence = (weight: SwarmWeight): weight is Presence => weight > 0

/**
 * The chance a swarm turns off a feature other than its forced one, from the omissions' definition: five-sixths,
 * half and one-sixth, each drawn a third of the time, so 1/2.
 */
export const OFF_RATE: Fraction = fraction(5n + 3n + 1n, 3n * 6n)

/** A literal a mixed list may hold: a small whole number or a short string. */
const mixedLiteral: Gen<number | string> = oneOf<number | string>([
	int(0, 999),
	string(characterOf(["a", "b", "z"]), { min: 0, max: 2 })
])

/** A list of mixed literals: its first and the rest, up to five more. */
export const mixedList: Gen<
	Readonly<{ first: number | string; rest: ReadonlyArray<number | string> }>
> = (source) => ({
	first: source.draw(mixedLiteral),
	rest: source.draw(array(mixedLiteral, { min: 0, max: 5 }))
})

/** The surrogate code points, which no scalar is, and the last scalar's index: the places unicodeScalar branches at. */
export const SURROGATE_FIRST = 0xd8_00

export const SURROGATE_COUNT = 0x8_00

const LAST_SCALAR_INDEX = 0x10_ff_ff - SURROGATE_COUNT

/** The indexes unicodeScalar's mapping turns at: the ends of the scalars below the surrogates and above them. */
const SCALAR_TURNS = dictionary([0, SURROGATE_FIRST - 1, SURROGATE_FIRST, LAST_SCALAR_INDEX])

/** An index of unicodeScalar's decision: any, or one where its mapping turns. */
export const scalarIndex: Gen<number> = oneOf([int(0, LAST_SCALAR_INDEX), word(SCALAR_TURNS)])

/** Up to four computed weights: none, a few, or up to 300. */
export const computedWeights: Gen<ReadonlyArray<number>> = array(
	oneOf([constant(0), int(1, 9), int(1, 300)]),
	{ min: 1, max: 4 }
)

/** Every strictly increasing or nondecreasing sequence of whole numbers of `lo..hi` of a length within `size`. */
export const ascendingModel = (
	lo: number,
	hi: number,
	size: Size,
	step: 0 | 1
): ReadonlyArray<ReadonlyArray<number>> => {
	const grown: Array<ReadonlyArray<number>> = []
	const grow = (prefix: ReadonlyArray<number>, from: number): void => {
		if (prefix.length >= size.min) {
			grown.push(prefix)
		}
		if (prefix.length < size.max) {
			for (let value = from; value <= hi; value += 1) {
				grow([...prefix, value], value + step)
			}
		}
	}
	grow([], lo)
	return grown
}

/** Every array whose entry `i` is a number from 0 to `i`: the parent of node `i + 1` among the nodes before it. */
export const treesModel = (nodes: number): ReadonlyArray<ReadonlyArray<number>> =>
	Arr.reduce(
		Array.from({ length: nodes - 1 }, (_, i) => i + 1),
		[[]],
		(trees: ReadonlyArray<ReadonlyArray<number>>, node) =>
			Arr.flatMap(trees, (tree) =>
				Arr.map(
					Array.from({ length: node }, (_, i) => i),
					(parent) => Arr.append(tree, parent)
				)
			)
	)

/** Every way `total` items fall into `parts` places, each a count of none or more. */
export const compositionsModel = (
	total: number,
	parts: number
): ReadonlyArray<ReadonlyArray<number>> =>
	parts === 0
		? total === 0
			? [[]]
			: []
		: parts === 1
			? [[total]]
			: Arr.flatMap(
					Array.from({ length: total + 1 }, (_, i) => i),
					(first) =>
						Arr.map(compositionsModel(total - first, parts - 1), (rest) => [first, ...rest])
				)

/** Whether a parent array is a tree: every node reaches the root by its parents in fewer steps than there are nodes. */
export const isTree = (parent: ReadonlyArray<number>): boolean =>
	Arr.every(parent, (first, index) => {
		let node = first
		for (let step = 0; step <= parent.length && node !== 0; step += 1) {
			if (node > index) {
				return false
			}
			node = Arr.getUnsafe(parent, node - 1)
		}
		return node === 0
	})

/** A box of ranges and sizes: a low end of -2 to 1, a width of up to 4, and every size within it. */
export const rangeBox: Gen<Readonly<{ lo: number; hi: number; size: Size }>> = (source) => {
	const lo = source.draw(int(-2, 1))
	const width = source.draw(int(0, 4))
	const max = source.draw(int(0, width))
	return { lo, hi: lo + width - 1, size: { min: source.draw(int(0, max)), max } }
}

/** A box of compositions: a total of 0 to 4 into 1 to 3 places. */
export const compositionBox: Gen<Readonly<{ total: number; parts: number }>> = (source) => ({
	total: source.draw(int(0, 4)),
	parts: source.draw(int(1, 3))
})

/** A boundary value's feature: live, stale from a closed scope, or wild of a kind. */
export type BoundaryFeature = DrawnFeature<"closed scope">

/** A boundary value: live, stale from a closed scope, or wild. */
type Boundary = Drawn<number, "closed scope">

/** Every feature a boundary value names. */
export const DRAWN_FEATURES: Arr.NonEmptyReadonlyArray<BoundaryFeature> = [
	"live",
	"stale closed scope",
	...Arr.map(WILD_KINDS, (kind): BoundaryFeature => `wild ${kind}`)
]

export const boundaryValue: Gen<Boundary> = lsw({
	live: int(0, 9),
	stale: Option.some(map(int(0, 9), (value) => ({ value, from: "closed scope" as const }))),
	wild: WILD_KINDS
})

/** A boundary value aimed at every wild kind it names: for each, a wild value of that kind alone. */
export const boundaryAimed: Aimed<Boundary, BoundaryFeature> = aimed(
	boundaryValue,
	Arr.map(WILD_KINDS, (kind: WildKind): readonly [BoundaryFeature, Gen<Boundary>] => [
		`wild ${kind}`,
		map(wild([kind]), (drawn): Boundary => ({ kind: "wild", wild: drawn }))
	])
)

/** Up to two boundary values in a list, which a shrink deletes one of only by deleting its item. */
export const boundaryList: Gen<ReadonlyArray<Boundary>> = array(boundaryValue, { min: 0, max: 2 })

/**
 * The decisions that start a list as two values, a live 9 and then a wild value, its kind and what it holds drawn
 * after them: the wild value a list fails for, after a live value only deleting its item takes out.
 */
export const LIVE_THEN_WILD = Float64Array.of(2, 0, 9, 2)

/**
 * The bug the live, stale and wild properties must catch: wild and wildOf hand out a wild value's hostile form in place
 * of its data.
 */
export const hostileWildKill: Kill = {
	file: "packages/testing/src/lsw.ts",
	original:
		"export const wildOf = (kind: WildKind): Wild => simplest[kind]\n\n/** One wild value of the given kinds, shrinking toward the first kind and its simplest value: list the simplest first. */\nexport const wild =\n\t(kinds: Arr.NonEmptyReadonlyArray<WildKind>): Gen<Wild> =>\n\t(source) =>\n\t\tsource.draw(wilds[source.draw(element(kinds))])",
	replacement:
		"export const wildOf = (kind: WildKind): Wild => hostile(simplest[kind]) as Wild\n\n/** One wild value of the given kinds, shrinking toward the first kind and its simplest value: list the simplest first. */\nexport const wild =\n\t(kinds: Arr.NonEmptyReadonlyArray<WildKind>): Gen<Wild> =>\n\t(source) =>\n\t\thostile(source.draw(wilds[source.draw(element(kinds))])) as Wild",
	why: "wild and wildOf hand out a wild value's hostile form in place of its data, so printing or reading a drawn proxy runs its traps; the lsw kinds and wild data properties fail."
}

/** Every wild kind, the vocabulary a boundary's wild values are drawn from. */
export const wildKind: Gen<WildKind> = word(dictionary(WILD_KINDS))

/**
 * Whether a value is data, judged without running any of its code: a primitive, or an object whose own properties are
 * all data properties holding data, read through their descriptors. A proxy that refuses every operation refuses this
 * reading too, and is no data.
 */
export const isData = (value: unknown): boolean => {
	if (typeof value !== "object" || value === null) {
		return true
	}
	const descriptors = Result.try(() =>
		Arr.map(Reflect.ownKeys(value), (key) => Reflect.getOwnPropertyDescriptor(value, key))
	)
	return (
		Result.isSuccess(descriptors) &&
		Arr.every(
			descriptors.success,
			(descriptor) => descriptor !== undefined && "value" in descriptor && isData(descriptor.value)
		)
	)
}

export type Rule = "negative" | "unsorted" | "out of range"

/** `list` with the item at `at` made `item`. */
const withItem = (list: ReadonlyArray<number>, at: number, item: number) =>
	Arr.map(list, (current, index) => (index === at ? item : current))

/**
 * Ways to break an ascending list of naturals, at the drawn weights: negate one item, swap two neighbours, or a rule no
 * list can break, which has no site in any list.
 */
export const corruptionsOf = (
	weights: Readonly<Record<Rule, Weight>>
): Arr.NonEmptyReadonlyArray<Corruption<ReadonlyArray<number>, Rule, Rule>> => [
	{
		rule: "negative",
		from: "wild",
		weight: weights.negative,
		sites: (live) =>
			Arr.map(live, (item, at) => ({
				value: withItem(live, at, -item - 1),
				refusal: "negative",
				at: `item ${at}`
			}))
	},
	{
		rule: "unsorted",
		from: "stale",
		weight: weights.unsorted,
		sites: (live) =>
			Arr.map(Arr.drop(live, 1), (item, at) => ({
				value: withItem(withItem(live, at, item), at + 1, Arr.getUnsafe(live, at)),
				refusal: "unsorted",
				at: `item ${at + 1}`
			}))
	},
	{ rule: "out of range", from: "wild", weight: weights["out of range"], sites: () => [] }
]

/** How many sites each rule has in a list of `length` items: one per item, one per neighbouring pair, and none. */
export const sitesIn = (rule: Rule, length: number): number => {
	switch (rule) {
		case "negative":
			return length
		case "unsorted":
			return Math.max(0, length - 1)
		case "out of range":
			return 0
	}
}

export const RULES = ["negative", "unsorted", "out of range"] as const satisfies ReadonlyArray<Rule>

/** The weights a corruption is drawn at: one, a few and many times another's. */
const RULE_WEIGHTS = [1, 2, 3, 5, 9] as const satisfies ReadonlyArray<Weight>

const ruleWeight: Gen<Weight> = element(RULE_WEIGHTS)

/** A live ascending list of up to four naturals below 10, and a weight for each rule that breaks it. */
export const corruptionCase: Gen<
	Readonly<{ live: ReadonlyArray<number>; weights: Readonly<Record<Rule, Weight>> }>
> = (source) => ({
	live: source.draw(increasing(0, 9, { min: 0, max: 4 })),
	weights: {
		negative: source.draw(ruleWeight),
		unsorted: source.draw(ruleWeight),
		"out of range": source.draw(ruleWeight)
	}
})

/** A class as written: whether it is negated, and its items, each a character or a range from its low end to its high,
 * drawn from one window of letters or one of astral characters, so no item writes `]`, `\`, `^` or `-`. */
export type WrittenClass = Readonly<{
	negated: boolean
	items: ReadonlyArray<readonly [low: number, high: number]>
}>

const classItem: Gen<readonly [low: number, high: number]> = (source) => {
	const [lo, hi] = source.draw(
		element([
			[0x61, 0x66],
			[0x1f600, 0x1f605]
		] as const)
	)
	const first = source.draw(int(lo, hi))
	const second = source.draw(int(lo, hi))
	return first <= second ? [first, second] : [second, first]
}

export const writtenClass: Gen<WrittenClass> = (source) => ({
	negated: source.draw(boolean),
	items: source.draw(array(classItem, { min: 1, max: 4 }))
})

/** A class as its pattern writes it, brackets and all. */
const classBody = (written: WrittenClass): string =>
	`[${written.negated ? "^" : ""}${Arr.join(
		Arr.map(written.items, ([low, high]) =>
			low === high
				? String.fromCodePoint(low)
				: `${String.fromCodePoint(low)}-${String.fromCodePoint(high)}`
		),
		""
	)}]`

/** The source of a class's one-character pattern. */
export const classSource = (written: WrittenClass): string => `^${classBody(written)}$`

/** The class written out: each member at the place it is first written, or, negated, the printable characters it
 * leaves, in order. */
export const writtenOut = (written: WrittenClass): ReadonlyArray<string> => {
	const members = Arr.dedupe(
		Arr.flatMap(written.items, ([low, high]) =>
			Array.from({ length: high - low + 1 }, (_, i) => low + i)
		)
	)
	const points = written.negated
		? Arr.filter(Arr.range(0x20, 0x7e), (point) => !Arr.contains(members, point))
		: members
	return Arr.map(points, (point) => String.fromCodePoint(point))
}

/**
 * The constructs generation cannot honour, each one `matching` refuses rather than guess at: a repetition without a
 * bound, a backreference, a word boundary and a Unicode property.
 */
const UNHONOURED = ["a+", "a*", "a{2,}", "(a)\\1", "\\bx", "\\p{L}"] as const

/** One piece of a drawn pattern: a class repeated within bounds, a letter, an optional letter, or a construct refused. */
export type PatternPiece =
	| Readonly<{ kind: "class"; written: WrittenClass; min: number; max: number }>
	| Readonly<{ kind: "literal"; letter: string }>
	| Readonly<{ kind: "option"; letter: string }>
	| Readonly<{ kind: "unhonoured"; construct: (typeof UNHONOURED)[number] }>

const patternPiece: Gen<PatternPiece> = weighted<PatternPiece>([
	[
		3,
		(source) => {
			const min = source.draw(int(0, 2))
			return {
				kind: "class",
				written: source.draw(writtenClass),
				min,
				max: source.draw(int(min, 3))
			}
		}
	],
	[2, map(characterOf(["q", "r"]), (letter) => ({ kind: "literal", letter }))],
	[1, map(characterOf(["x", "y"]), (letter) => ({ kind: "option", letter }))],
	[1, map(element(UNHONOURED), (construct) => ({ kind: "unhonoured", construct }))]
])

/** One to three pattern pieces. */
export const patternPieces: Gen<ReadonlyArray<PatternPiece>> = array(patternPiece, {
	min: 1,
	max: 3
})

/** A piece as the pattern writes it. */
export const pieceSource = (piece: PatternPiece): string => {
	switch (piece.kind) {
		case "class":
			return `${classBody(piece.written)}{${piece.min},${piece.max}}`
		case "literal":
			return piece.letter
		case "option":
			return `${piece.letter}?`
		case "unhonoured":
			return piece.construct
	}
}

/** The shortest string a piece matches, by the grammar: a class's first member at its least repetition, and no option. */
export const shortestOf = (piece: PatternPiece): string => {
	switch (piece.kind) {
		case "class":
			return Str.repeat(piece.min)(Arr.getUnsafe(writtenOut(piece.written), 0))
		case "literal":
			return piece.letter
		case "option":
		case "unhonoured":
			return ""
	}
}

/** `point` in hexadecimal, at least `digits` digits. */
const hexOf = (point: number, digits: number): string =>
	pipe(point.toString(16), Str.padStart(digits, "0"))

/**
 * A character a pattern writes as itself, which the grammar never reads as syntax: a letter, a digit, a Latin-1 letter
 * or an astral emoji.
 */
const plainCharacter: Gen<string> = oneOf([
	codePoint(0x61, 0x7a),
	codePoint(0x30, 0x39),
	codePoint(0xc0, 0xff),
	codePoint(0x1_f6_00, 0x1_f6_4f)
])

/** The characters a pattern's grammar reads as syntax, each written literally behind a backslash. */
const SYNTAX_CHARACTERS = [
	"^",
	"$",
	"\\",
	".",
	"*",
	"+",
	"?",
	"(",
	")",
	"[",
	"]",
	"{",
	"}",
	"|",
	"/"
] as const

/**
 * One character written by an escape: a syntax character behind a backslash, a code point as `\xHH`, `\uHHHH` or
 * `\u{H…}`, a control character, or a shorthand class (`\d`, `\w`, `\s` and their complements).
 */
const escapedAtom: Gen<string> = oneOf([
	map(characterOf(SYNTAX_CHARACTERS), (character) => `\\${character}`),
	map(int(0x20, 0x7e), (point) => `\\x${hexOf(point, 2)}`),
	map(int(0x20, 0xd7_ff), (point) => `\\u${hexOf(point, 4)}`),
	map(int(0x1_00_00, 0x10_ff_ff), (point) => `\\u{${hexOf(point, 1)}}`),
	map(characterOf(["n", "t", "r", "f", "v"]), (letter) => `\\${letter}`),
	map(characterOf(["d", "w", "s", "D", "W", "S"]), (letter) => `\\${letter}`)
])

/** An atom with no group in it: a plain character, an escape, any printable character (`.`) or a class. */
const flatAtom: Gen<string> = oneOf([
	plainCharacter,
	escapedAtom,
	constant("."),
	map(writtenClass, classBody)
])

/**
 * How often an atom repeats, every bound stated: once, optionally, exactly a count, or between two counts, eagerly or
 * lazily.
 */
const quantifier: Gen<string> = weighted<string>([
	[3, constant("")],
	[1, constant("?")],
	[1, map(int(0, 3), (count) => `{${count}}`)],
	[
		2,
		(source) => {
			const min = source.draw(int(0, 3))
			const max = source.draw(int(min, min + 3))
			return `{${min},${max}}${source.draw(boolean) ? "?" : ""}`
		}
	]
])

/** Up to three atoms of `atom`, each with its quantifier, in sequence. */
const sequenceOf = (atom: Gen<string>, max: number): Gen<string> =>
	map(
		array((source) => `${source.draw(atom)}${source.draw(quantifier)}`, { min: 0, max }),
		Arr.join("")
	)

/** A group, capturing or not, of one or two alternatives of atoms of `atom`. */
const groupOf =
	(atom: Gen<string>): Gen<string> =>
	(source) =>
		`(${source.draw(boolean) ? "" : "?:"}${Arr.join(source.draw(array(sequenceOf(atom, 3), { min: 1, max: 2 })), "|")})`

/**
 * The source of a pattern `matching` honours, generated from its grammar: one or two alternatives, each anchored at
 * both ends, of atoms (plain characters, escapes, `.`, classes and groups nested two deep), each repeated within a
 * stated bound.
 */
export const honouredPattern: Gen<string> = map(
	array(sequenceOf(recursive(flatAtom, groupOf, 2), 4), { min: 1, max: 2 }),
	(branches) =>
		Arr.join(
			Arr.map(branches, (branch) => `^${branch}$`),
			"|"
		)
)
