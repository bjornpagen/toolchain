import { Array as Arr, Option, Order, String as Str } from "effect"
import {
	array,
	boolean,
	characterOf,
	constant,
	element,
	type Gen,
	int,
	oneOf,
	string,
	subarray,
	type Weight,
	weighted
} from "#gen.ts"
import { wordsOf } from "#random.ts"
import type { Drawn, ReplayCase } from "#replay.ts"
import { type Generated, generate, randomChooser, recorder, type Source } from "#source.ts"

/** The seeds a word stream starts from, every one of them a valid seed. */
export const seeds: Gen<number> = int(0, 0xffff_ffff)

/** Weights a weighted choice draws from: from the least to the most a weight can be, so totals pass 256. */
const WEIGHTS: Arr.NonEmptyReadonlyArray<Weight> = [1, 2, 3, 50, 99]

/** One weight of a weighted choice. */
const weight = element(WEIGHTS)

/** The weights of a weighted choice: one to five options, the first always there, each of any weight. */
export const weightLists: Gen<Arr.NonEmptyReadonlyArray<Weight>> = (source) => [
	source.draw(weight),
	...source.draw(array(weight, { min: 0, max: 4 }))
]

/** A case drawn fresh from one seed. */
export const fresh = <A>(generator: Gen<A>, seed: number): Generated<A> =>
	generate(recorder(), generator, randomChooser(wordsOf(seed)))

/** A generator with every structure the engine records: a dependent bound, a collection and weighted branches. */
export const composite = (source: Source) => {
	const bound = source.draw(int(0, 4))
	return {
		bound,
		items: source.draw(
			array(
				weighted([
					[1, int(0, bound)],
					[3, int(10, 20)]
				]),
				{ min: 0, max: bound }
			)
		),
		flag: source.draw(boolean)
	}
}

/** A seed, and how many of the decisions its composite case made a replay keeps: none, some, or all of them. */
export const cutTapes: Gen<Readonly<{ seed: number; kept: number }>> = (source) => {
	const seed = source.draw(seeds)
	return { seed, kept: source.draw(int(0, fresh(composite, seed).tape.length)) }
}

/** A seed and a range of whole numbers, of either sign and up to a hundred thousand wide. */
export const seededRanges: Gen<Readonly<{ seed: number; lo: number; hi: number }>> = (source) => {
	const seed = source.draw(seeds)
	const lo = source.draw(int(-1000, 1000))
	return { seed, lo, hi: lo + source.draw(int(0, 100_000)) }
}

/** A seed and how many cases of its stream a sample takes. */
export const seededLengths: Gen<Readonly<{ seed: number; length: number }>> = (source) => ({
	seed: source.draw(seeds),
	length: source.draw(int(0, 20))
})

/** What a tape's length is, as the token property notes it. */
export type TapeLength = "an empty tape" | "one value" | "several values"

/** The length a tape of `values` has, as the token property notes it. */
export const tapeLengthOf = (values: ReadonlyArray<number>): TapeLength =>
	values.length === 0 ? "an empty tape" : values.length === 1 ? "one value" : "several values"

/**
 * Pending requirements in turn order: some of twenty, ascending from the drawn one aimed at and wrapping, or none.
 */
const turnOrders: Gen<ReadonlyArray<number>> = (source) => {
	const pending = source.draw(oneOf([constant([]), subarray(Arr.range(0, 19))]))
	const first = source.draw(int(0, Math.max(0, pending.length - 1)))
	return Arr.map(pending, (_, i) => Arr.getUnsafe(pending, (first + i) % pending.length))
}

/**
 * A suite label, colons and all, and a case to replay in it: unsteered, or steered with nothing pending or with some
 * of twenty requirements pending in turn order, and values of either sign.
 */
export const replayTokens: Gen<readonly [string, ReplayCase]> = (source) => {
	const suite = source.draw(string(characterOf(["a", ":", " ", "/", "-", "."]), { min: 1, max: 6 }))
	const drawnUnder: Drawn = source.draw(boolean)
		? { kind: "steered", pending: source.draw(turnOrders) }
		: { kind: "unsteered" }
	const values = source.draw(array(oneOf([int(-1000, -1), int(0, 2 ** 52)]), { min: 0, max: 6 }))
	return [suite, { drawn: drawnUnder, values }]
}

/** What a replay token's suite, steering and values hold that its reading must survive. */
export type TokenFeature =
	| "unsteered"
	| "steered, nothing pending"
	| "steered, past the first digit"
	| "steered, aimed past its lowest pending"
	| "a colon in the suite"
	| "a negative value"
	| "an empty tape"

/** The steering a replayed case was drawn under, as the token property notes it. */
const steeringFeaturesOf = (drawn: Drawn): ReadonlyArray<TokenFeature> => {
	switch (drawn.kind) {
		case "unsteered":
			return ["unsteered"]
		case "steered": {
			const { pending } = drawn
			return [
				...(Arr.isReadonlyArrayNonEmpty(pending) ? [] : ["steered, nothing pending" as const]),
				...(Arr.some(pending, (place) => place >= 4)
					? ["steered, past the first digit" as const]
					: []),
				...(Option.exists(Arr.head(pending), (aim) => Arr.some(pending, (place) => place < aim))
					? ["steered, aimed past its lowest pending" as const]
					: [])
			]
		}
	}
}

/** Everything a replay token of `suite` and `replayed` holds that its reading must survive. */
export const tokenFeaturesOf = (
	suite: string,
	replayed: ReplayCase
): ReadonlyArray<TokenFeature> => [
	...steeringFeaturesOf(replayed.drawn),
	...(Str.includes(":")(suite) ? ["a colon in the suite" as const] : []),
	...(Arr.some(replayed.values, (value) => value < 0) ? ["a negative value" as const] : []),
	...(Arr.isReadonlyArrayNonEmpty(replayed.values) ? [] : ["an empty tape" as const])
]

/** A generator's shape, small enough to enumerate by hand: a range of whole numbers, a collection of a shape, or a pair. */
export type Shape =
	| Readonly<{ kind: "int"; lo: number; hi: number }>
	| Readonly<{ kind: "array"; item: Shape; min: number; max: number }>
	| Readonly<{ kind: "pair"; first: Shape; second: Shape }>

/** A value of a shape. */
export type Shaped = number | ReadonlyArray<Shaped>

/** A range of whole numbers within -3..3. */
const rangeShape: Gen<Readonly<{ kind: "int"; lo: number; hi: number }>> = (source) => {
	const lo = source.draw(int(-3, 3))
	return { kind: "int", lo, hi: source.draw(int(lo, 3)) }
}

/** A shape at most `depth` levels deep: at each level a range, a collection of up to two items, or a pair. */
export const shapeOf = (depth: number): Gen<Shape> =>
	depth === 0
		? rangeShape
		: oneOf<Shape>([
				rangeShape,
				(source) => {
					const min = source.draw(int(0, 2))
					return {
						kind: "array",
						item: source.draw(shapeOf(depth - 1)),
						min,
						max: source.draw(int(min, 2))
					}
				},
				(source) => ({
					kind: "pair",
					first: source.draw(shapeOf(depth - 1)),
					second: source.draw(shapeOf(depth - 1))
				})
			])

/** The generator a shape describes. */
export const generatorOf = (shape: Shape): Gen<Shaped> => {
	switch (shape.kind) {
		case "int":
			return int(shape.lo, shape.hi)
		case "array":
			return array(generatorOf(shape.item), { min: shape.min, max: shape.max })
		case "pair": {
			const first = generatorOf(shape.first)
			const second = generatorOf(shape.second)
			return (source) => [source.draw(first), source.draw(second)]
		}
	}
}

/** By distance from zero, the positive side first: int's order, as its specification states it. */
const byDistanceFromZero = Order.mapInput(
	Order.Number,
	(value: number) => Math.abs(value) * 2 + (value < 0 ? 1 : 0)
)

/** Every sequence of `length` values of `items`, the first position outermost. */
const sequences = (
	items: ReadonlyArray<Shaped>,
	length: number
): ReadonlyArray<ReadonlyArray<Shaped>> =>
	length === 0
		? [[]]
		: Arr.flatMap(items, (first) =>
				Arr.map(sequences(items, length - 1), (rest) => [first, ...rest])
			)

/**
 * Every value of a shape, in the order the library's specification gives: a range by distance from zero, the positive
 * side first; a collection by its length, shortest first, then its items, the first outermost; a pair with its first
 * value outermost.
 */
export const enumerationOf = (shape: Shape): ReadonlyArray<Shaped> => {
	switch (shape.kind) {
		case "int":
			return Arr.sort(
				Array.from({ length: shape.hi - shape.lo + 1 }, (_, i) => shape.lo + i),
				byDistanceFromZero
			)
		case "array": {
			const items = enumerationOf(shape.item)
			return Arr.flatMap(
				Array.from({ length: shape.max - shape.min + 1 }, (_, i) => shape.min + i),
				(length) => sequences(items, length)
			)
		}
		case "pair": {
			const seconds = enumerationOf(shape.second)
			return Arr.flatMap(enumerationOf(shape.first), (first) =>
				Arr.map(seconds, (second) => [first, second])
			)
		}
	}
}

/** What a shape holds that its enumeration must order right. */
export type EnumerationFeature =
	| "a range across zero"
	| "a range below zero"
	| "a collection that may be empty"
	| "a collection of collections"
	| "a pair"

/** Everything a shape holds that its enumeration must order right, `nested` when it is a collection's item. */
export const shapeFeaturesOf = (
	shape: Shape,
	nested: boolean
): ReadonlyArray<EnumerationFeature> => {
	switch (shape.kind) {
		case "int":
			return [
				...(shape.lo < 0 && shape.hi > 0 ? ["a range across zero" as const] : []),
				...(shape.hi < 0 ? ["a range below zero" as const] : [])
			]
		case "array":
			return [
				...(shape.min === 0 ? ["a collection that may be empty" as const] : []),
				...(nested ? ["a collection of collections" as const] : []),
				...shapeFeaturesOf(shape.item, true)
			]
		case "pair":
			return [
				"a pair",
				...shapeFeaturesOf(shape.first, false),
				...shapeFeaturesOf(shape.second, false)
			]
	}
}
