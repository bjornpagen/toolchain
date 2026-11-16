import { Array as Arr, Hash } from "effect"
import { type Equivalence, exact, set } from "#oracle.ts"

/** The items a set comparison's sides draw from. */
export const ITEMS = ["a", "b", "c", "d"] as const

export type Item = (typeof ITEMS)[number]

/**
 * How the second answer differs from the first, a permutation of it: not at all; one item of either side repeated,
 * the duplicated row a set's answer must never hide; one item dropped; or one item added that the first lacks.
 */
export const CHANGES = ["none", "repeat left", "repeat right", "drop", "add"] as const

export type Change = (typeof CHANGES)[number]

/** The two answers a case compares: the first, and its permutation under `change` at `at`. */
export const answersOf = (
	left: ReadonlyArray<Item>,
	right: ReadonlyArray<Item>,
	change: Change,
	at: number
): readonly [ReadonlyArray<Item>, ReadonlyArray<Item>] => {
	switch (change) {
		case "none":
			return [left, right]
		case "repeat left":
			return [[...left, ...Arr.take(Arr.drop(left, at), 1)], right]
		case "repeat right":
			return [left, [...right, ...Arr.take(Arr.drop(right, at), 1)]]
		case "drop":
			return [left, Arr.remove(right, at)]
		case "add":
			return [
				left,
				[
					...right,
					...Arr.take(
						Arr.filter(ITEMS, (item) => !Arr.contains(left, item)),
						1
					)
				]
			]
	}
}

/** Whether two sorted lists hold the same items, item by item. */
export const sameItems = Arr.makeEquivalence<Item>((x, y) => x === y)

/** Whether a list holds no item twice. */
export const distinct = (values: ReadonlyArray<Item>) => new Set(values).size === values.length

/** Two answers of whole numbers: the first, and its permutation under `change` at `at`, as answersOf changes items. */
const answersOfNumbers = (
	left: ReadonlyArray<number>,
	right: ReadonlyArray<number>,
	change: Change,
	at: number
): readonly [ReadonlyArray<number>, ReadonlyArray<number>] => {
	switch (change) {
		case "none":
			return [left, right]
		case "repeat left":
			return [[...left, ...Arr.take(Arr.drop(left, at), 1)], right]
		case "repeat right":
			return [left, [...right, ...Arr.take(Arr.drop(right, at), 1)]]
		case "drop":
			return [left, Arr.remove(right, at)]
		case "add":
			return [left, [...right, left.length]]
	}
}

/**
 * The item comparisons and key computations a set comparison makes over answers of `size` items, the second the first
 * rotated by `turn` places and changed by `change` at place `place`.
 */
export const spentAt = (size: number, change: Change, place: number, turn: number): number => {
	const items = Array.from({ length: size }, (_, i) => i)
	const turned = [...Arr.drop(items, turn), ...Arr.take(items, turn)]
	const [first, second] = answersOfNumbers(items, turned, change, place)
	let spent = 0
	const counted: Equivalence<number> = (left, right) => {
		spent += 1
		return exact(left, right)
	}
	const keyed = (item: number) => {
		spent += 1
		return Hash.number(item)
	}
	set(keyed, counted)(first, second)
	return spent
}
