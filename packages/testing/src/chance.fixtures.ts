import { Array as Arr, Option } from "effect"
import { type Branch, firstBranch, nextBranch } from "#enumerate.ts"
import type { Gen } from "#gen.ts"
import {
	type Chooser,
	type Generated,
	generate,
	prefixChooser,
	recorder,
	type Spread,
	simplestChooser
} from "#source.ts"
import type { Tape } from "#tape.ts"

/** A case of an enumeration: its value, the tape that determines it, and how a random search spreads each decision. */
export type Charted<A> = Generated<A> & Readonly<{ spreads: ReadonlyArray<Spread> }>

/**
 * Every case of a bounded generator, in enumeration order (enumerate.ts: each branch's case, every decision past it at
 * its simplest), each with the tape that determines it and the spread of each of its decisions, every case on one
 * recorder's buffers. An enumeration's chooser is never exhausted, so it is asked for every decision the tape records,
 * in order.
 */
export const everyCase = <A>(generator: Gen<A>): ReadonlyArray<Charted<A>> => {
	const recorded = recorder()
	const cases: Array<Charted<A>> = []
	let branch: Option.Option<Branch> = Option.some(firstBranch)
	while (Option.isSome(branch)) {
		const spreads: Array<Spread> = []
		const inner = prefixChooser(branch.value.values, branch.value.length, simplestChooser)
		const charting: Chooser = {
			exhausted: inner.exhausted,
			draw: (lo, hi, at, spread) => {
				spreads.push(spread)
				return inner.draw(lo, hi, at, spread)
			}
		}
		const generated = generate(recorded, generator, charting)
		cases.push({ ...generated, spreads })
		branch = nextBranch(generated.tape)
	}
	return cases
}

/** Every value of a bounded generator, in enumeration order. */
export const everyValue = <A>(generator: Gen<A>): ReadonlyArray<A> =>
	Arr.map(everyCase(generator), (generated) => generated.value)

/** A probability held exactly, in lowest terms: its numerator and its denominator. */
export type Fraction = readonly [numerator: bigint, denominator: bigint]

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? (a < 0n ? -a : a) : gcd(b, a % b))

/** `numerator / denominator` in lowest terms. */
export const fraction = (numerator: bigint, denominator: bigint): Fraction => {
	const divisor = gcd(numerator, denominator)
	return divisor === 0n ? [0n, 1n] : [numerator / divisor, denominator / divisor]
}

/** The sum of two fractions. */
export const plus = (left: Fraction, right: Fraction): Fraction =>
	fraction(left[0] * right[1] + right[0] * left[1], left[1] * right[1])

/** The product of two fractions. */
export const times = (left: Fraction, right: Fraction): Fraction =>
	fraction(left[0] * right[0], left[1] * right[1])

/**
 * The chance a random search draws a tape: each decision's chance, multiplied. A weighted decision's is its option's
 * weight over the total, as the random chooser draws it; any other's is one over its range, the random chooser's chance
 * for a decision it draws uniformly, every option a generator picks and every magnitude of at most 256 values, so a
 * test states a distribution exactly by enumeration only of a generator whose decisions are of those kinds.
 */
const chanceOf = (tape: Tape, spreads: ReadonlyArray<Spread>): Fraction => {
	let chance = fraction(1n, 1n)
	for (let at = 0; at < tape.length; at += 1) {
		const spread = spreads[at]
		const value = tape.values[at] ?? 0
		const range = (tape.hi[at] ?? 0) - (tape.lo[at] ?? 0) + 1
		chance = times(
			chance,
			spread?.kind === "weighted"
				? fraction(BigInt(spread.weights[value] ?? 0), BigInt(spread.total))
				: fraction(1n, BigInt(range))
		)
	}
	return chance
}

/** The chance a random search draws a case `holds` accepts. */
export const shareOf = <A>(
	cases: ReadonlyArray<Charted<A>>,
	holds: (value: A) => boolean
): Fraction =>
	Arr.reduce(
		Arr.filter(cases, (charted) => holds(charted.value)),
		fraction(0n, 1n),
		(sum, charted) => plus(sum, chanceOf(charted.tape, charted.spreads))
	)
