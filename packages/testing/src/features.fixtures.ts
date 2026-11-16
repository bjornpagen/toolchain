import { Array as Arr } from "effect"
import { type Fraction, fraction, times } from "#chance.fixtures.ts"
import { riskBoundOf } from "#features.ts"
import { array, element, type Gen, int } from "#gen.ts"

/**
 * What the residual's properties (features.ts) share: the situations their cases note, and the exact distributions they
 * judge the residual's bound and its Good–Turing identity against.
 */

/** The situations a residual test's cases note. */
const SITUATIONS = ["a", "b", "c", "d", "e"] as const

/** Up to twelve cases, each noting up to three of the situations. */
export const notedCases: Gen<ReadonlyArray<ReadonlyArray<string>>> = array(
	array(element(SITUATIONS), { min: 0, max: 3 }),
	{ min: 0, max: 12 }
)

/** The situations of the Good–Turing identity's space, each noted by a case with the chance its weight gives. */
export const NOTED = ["x", "y", "z"] as const

/** What a residual's risk can be, as the residual test notes it. */
export const RISK_SHAPES = ["no cases", "nothing noted", "saturated", "seen once"] as const

export type RiskShape = (typeof RISK_SHAPES)[number]

/** How many cases the bound's box runs to. */
export const BOUND_RUNS = 10

/** Every distribution of one situation a case over 1 to 4 situations, each weighted 1 to 4. */
export const weightings: Gen<ReadonlyArray<number>> = (source) =>
	Array.from({ length: source.draw(int(1, 4)) }, () => source.draw(int(1, 4)))

/**
 * For each run of 1 to `most` cases, each noting one situation drawn with the chance its weight gives, the chance that
 * the next case reaches a situation none reached with a chance above the residual's bound: the bound's miss. It is
 * computed exactly over the distribution of each run's seen situations, as a bit mask, and its last new case, which
 * are all the bound and the missing mass depend on.
 */
export const missesOf = (weights: ReadonlyArray<number>, most: number): ReadonlyArray<number> => {
	const total = Arr.reduce(weights, 0, (sum, weight) => sum + weight)
	const missingOf = (seen: number) =>
		Arr.reduce(weights, 0, (mass, weight, situation) =>
			(seen & (1 << situation)) === 0 ? mass + weight / total : mass
		)
	let runs = new Map<string, Readonly<{ seen: number; lastNew: number; chance: number }>>([
		["0:0", { seen: 0, lastNew: 0, chance: 1 }]
	])
	const misses: Array<number> = []
	for (let cases = 1; cases <= most; cases += 1) {
		const next = new Map<string, Readonly<{ seen: number; lastNew: number; chance: number }>>()
		for (const run of runs.values()) {
			for (const [situation, weight] of weights.entries()) {
				const bit = 1 << situation
				const seen = run.seen | bit
				const lastNew = (run.seen & bit) === 0 ? cases : run.lastNew
				const key = `${seen}:${lastNew}`
				next.set(key, {
					seen,
					lastNew,
					chance: (next.get(key)?.chance ?? 0) + (run.chance * weight) / total
				})
			}
		}
		runs = next
		misses.push(
			Arr.reduce(Arr.fromIterable(runs.values()), 0, (missed, run) =>
				missingOf(run.seen) > riskBoundOf(cases, cases - run.lastNew) ? missed + run.chance : missed
			)
		)
	}
	return misses
}

/** Every sequence of `length` situations of NOTED, each with its chance under `weights`. */
export const sequencesOf = (
	length: number,
	weights: ReadonlyArray<number>
): ReadonlyArray<readonly [ReadonlyArray<number>, Fraction]> => {
	const total = BigInt(Arr.reduce(weights, 0, (sum, weight) => sum + weight))
	let sequences: ReadonlyArray<readonly [ReadonlyArray<number>, Fraction]> = [
		[[], fraction(1n, 1n)]
	]
	for (let step = 0; step < length; step += 1) {
		sequences = Arr.flatMap(sequences, ([sequence, chance]) =>
			Arr.map(
				weights,
				(weight, situation) =>
					[Arr.append(sequence, situation), times(chance, fraction(BigInt(weight), total))] as const
			)
		)
	}
	return sequences
}
