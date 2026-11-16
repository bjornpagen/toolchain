/**
 * The residual (features.ts residualOf), the risk a search reports from its rotating stream's independent cases:
 *
 * - It counts each situation once per case that noted it, those seen once and twice, and the cases since the last new
 *   one, and knows no risk when no case ran or nothing was noted. Oracle: an independent recount, in order.
 * - Its 95% bound holds: after every run of 1 to 10 cases, over every distribution in the box, the next case's chance
 *   of a situation none reached exceeds the bound with chance at most 5%. Oracle: the specification, by the exact
 *   distribution of each run's seen situations and its last new case.
 * - Its estimate is Good–Turing's: the expectation of the singletons over the cases equals the missing mass one case
 *   earlier, over every sequence of up to 5 cases. Oracle: the identity, by exact enumeration.
 */
import { Array as Arr, Effect, Option } from "effect"
import { assertTrue, deepStrictEqual, strictEqual } from "#assert.ts"
import { fraction, plus, times } from "#chance.fixtures.ts"
import {
	BOUND_RUNS,
	missesOf,
	NOTED,
	notedCases,
	RISK_SHAPES,
	type RiskShape,
	sequencesOf,
	weightings
} from "#features.fixtures.ts"
import { RISK_BOUND_MISS, type Risk, residualOf, riskBoundOf, tallyOf } from "#features.ts"
import { finite, int } from "#gen.ts"
import { type Case, property } from "#property.ts"

export const residualCounts = property.explore(notedCases, {
	needs: {},
	situations: RISK_SHAPES,
	check: (_resources, c: Case<RiskShape>) => (cases) =>
		Effect.sync(() => {
			const tally = tallyOf("independent")
			for (const notes of cases) {
				tally.add(new Set(notes))
			}
			const counts = Arr.map(
				Arr.dedupe(Arr.flatten(cases)),
				(situation) => Arr.filter(cases, (notes) => Arr.contains(notes, situation)).length
			)
			const singletons = Arr.filter(counts, (count) => count === 1).length
			const lastNew = Arr.reduce(cases, 0, (last, notes, at) =>
				Arr.some(notes, (situation) =>
					Arr.every(Arr.take(cases, at), (earlier) => !Arr.contains(earlier, situation))
				)
					? at + 1
					: last
			)
			const risk: Risk =
				cases.length === 0
					? { kind: "unknown", why: "no-cases" }
					: counts.length === 0
						? { kind: "unknown", why: "nothing-noted" }
						: {
								kind: "estimated",
								estimate: singletons / cases.length,
								bound: riskBoundOf(cases.length, cases.length - lastNew)
							}
			c.note(
				risk.kind === "unknown"
					? risk.why === "no-cases"
						? "no cases"
						: "nothing noted"
					: singletons === 0
						? "saturated"
						: "seen once"
			)
			const residual = residualOf(tally.tally())
			deepStrictEqual(
				{
					cases: residual.cases,
					observed: residual.observed,
					singletons: residual.singletons,
					doubletons: residual.doubletons,
					sinceNew: residual.sinceNew,
					risk: residual.risk,
					estimated: Option.isSome(residual.unseen)
				},
				{
					cases: cases.length,
					observed: counts.length,
					singletons,
					doubletons: Arr.filter(counts, (count) => count === 2).length,
					sinceNew: cases.length - lastNew,
					risk,
					estimated: risk.kind === "estimated"
				}
			)
		}),
	oracle: {
		kind: "second-implementation",
		name: "an independent recount of the cases that noted each situation, in order"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/features.ts",
			original: "\tconst doubletons = Arr.filter(counts, (count) => count === 2).length",
			replacement: "\tconst doubletons = Arr.filter(counts, (count) => count >= 2).length",
			why: "Every situation seen twice or more counts as a doubleton, not only those seen exactly twice; the recount property fails."
		}
	]
})

export const residualBound = property.exhaust(finite(weightings), {
	box: "every distribution of one situation a case over 1 to 4 situations, each weighted 1 to 4, after each of 1 to 10 cases",
	needs: {},
	situations: [],
	check: () => (weights) =>
		Effect.sync(() => {
			for (const [at, missed] of missesOf(weights, BOUND_RUNS).entries()) {
				assertTrue(
					missed <= RISK_BOUND_MISS,
					`after ${at + 1} cases the bound is exceeded with chance ${missed}`
				)
			}
		}),
	oracle: {
		kind: "specification",
		name: "the chance the bound is exceeded, by the exact distribution of each run's seen situations and its last new case"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/features.ts",
			original: "\tsinceNew === 0 ? 1 : 1 - (RISK_BOUND_MISS / cases) ** (1 / sinceNew)",
			replacement: "\tsinceNew === 0 ? 1 : (1 - (RISK_BOUND_MISS / cases) ** (1 / sinceNew)) / 2",
			why: "The risk's 95% bound is half what it is, so it is exceeded more often than one run in twenty; the bound property fails."
		}
	]
})

export const goodTuring = property.exhaust(
	finite((source) => ({
		n: source.draw(int(1, 5)),
		weights: Arr.map(NOTED, () => source.draw(int(1, 3)))
	})),
	{
		box: "every sequence of up to 5 cases over 3 situations, under every weighting by 1 to 3",
		needs: {},
		situations: [],
		check:
			() =>
			({ n, weights }) =>
				Effect.sync(() => {
					const total = BigInt(Arr.reduce(weights, 0, (sum, weight) => sum + weight))
					const expectedRisk = Arr.reduce(
						sequencesOf(n, weights),
						fraction(0n, 1n),
						(sum, [sequence, chance]) => {
							const tally = tallyOf("independent")
							for (const situation of sequence) {
								tally.add(new Set([Arr.getUnsafe(NOTED, situation)]))
							}
							const { risk } = residualOf(tally.tally())
							strictEqual(risk.kind, "estimated", "every case notes a situation")
							const estimate = risk.kind === "estimated" ? risk.estimate : Number.NaN
							return plus(sum, times(chance, fraction(BigInt(Math.round(estimate * n)), BigInt(n))))
						}
					)
					const missingMass = Arr.reduce(
						sequencesOf(n - 1, weights),
						fraction(0n, 1n),
						(sum, [sequence, chance]) =>
							plus(
								sum,
								times(
									chance,
									fraction(
										BigInt(
											Arr.reduce(weights, 0, (mass, weight, situation) =>
												Arr.contains(sequence, situation) ? mass : mass + weight
											)
										),
										total
									)
								)
							)
					)
					deepStrictEqual(expectedRisk, missingMass)
				}),
		oracle: {
			kind: "universal",
			name: "Good–Turing: E[singletons(n)]/n equals E[missing mass(n − 1)], by exact enumeration"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/features.ts",
				original: "\t\t\t\t\t\testimate: singletons / tally.cases,",
				replacement: "\t\t\t\t\t\testimate: singletons / (tally.cases + 1),",
				why: "The risk's estimate divides the singletons by one case more than ran; the Good–Turing property fails."
			}
		]
	}
)
