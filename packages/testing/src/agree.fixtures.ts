import { Array as Arr, Option } from "effect"
import { array, element, type Gen, int } from "#gen.ts"
import { by, equivalence, exact, ordered, set, structuralHash } from "#oracle.ts"

/**
 * What agree's property (oracle.ts agree) shares: the comparisons an oracle's sides are judged by, each as the library
 * spells it and as its definition says.
 */

/** The comparisons an oracle's sides are judged by: in order, as sets, through a projection, or within a tolerance. */
export const COMPARISONS = ["ordered", "set", "by first item", "within one"] as const

export type Comparison = (typeof COMPARISONS)[number]

/** A side's answer: a few small whole numbers. */
export type Answer = ReadonlyArray<number>

const answers: Gen<Answer> = array(int(0, 3), { min: 0, max: 3 })

/** A comparison, the first side's answer, and up to three more sides'. */
export const agreements: Gen<
	Readonly<{ comparison: Comparison; first: Answer; rest: ReadonlyArray<Answer> }>
> = (source) => ({
	comparison: source.draw(element(COMPARISONS)),
	first: source.draw(answers),
	rest: source.draw(array(answers, { min: 0, max: 3 }))
})

/** Each comparison as the library spells it. */
export const equivalenceOf = (comparison: Comparison) => {
	switch (comparison) {
		case "ordered":
			return ordered<number>(exact)
		case "set":
			return set<number>(structuralHash, exact)
		case "by first item":
			return by((answer: Answer) => Option.fromUndefinedOr(answer[0]), exact)
		case "within one":
			return by(
				(answer: Answer) => Arr.reduce(answer, 0, (sum, item) => sum + item),
				equivalence((left: number, right: number) => Math.abs(left - right) <= 1, String)
			)
	}
}

/**
 * Whether two answers agree under a comparison, from its definition: the same items in the same order; the same items
 * in any order, neither side repeating one; the same first item, or none on both; sums at most one apart.
 */
export const agreesOf = (comparison: Comparison, left: Answer, right: Answer): boolean => {
	const distinct = (answer: Answer) => new Set(answer).size === answer.length
	const sum = (answer: Answer) => Arr.reduce(answer, 0, (total, item) => total + item)
	switch (comparison) {
		case "ordered":
			return left.length === right.length && Arr.every(left, (item, at) => item === right[at])
		case "set":
			return (
				distinct(left) &&
				distinct(right) &&
				Arr.every(left, (item) => Arr.contains(right, item)) &&
				Arr.every(right, (item) => Arr.contains(left, item))
			)
		case "by first item":
			return left[0] === right[0]
		case "within one":
			return Math.abs(sum(left) - sum(right)) <= 1
	}
}
