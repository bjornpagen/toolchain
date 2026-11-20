/**
 * A recorded space (gen.ts recorded, source.ts recall), each search held to what it may draw of it: no case a random
 * search draws, mutates, repairs into a unique key or clones reaches a recorded value; an enumeration counts its space
 * alone; a token's recalled decision k draws the k-th recorded value, exactly, and one past the last overruns; a shrink
 * moves a recorded case toward its space and never off it; and keep finds every recorded value's token, and a drawn
 * value's beside them.
 */
import { isDeepStrictEqual } from "node:util"
import { Array as Arr, Effect, Option } from "effect"
import { assert } from "#assert.ts"
import { everyValue } from "#chance.fixtures.ts"
import { array, clone, int, uniqueKeys } from "#gen.ts"
import { mutate } from "#mutate.ts"
import { property } from "#property.ts"
import { wordsOf } from "#random.ts"
import {
	isRecordedList,
	listsOf,
	numbersOf,
	recordedCases,
	recordedNumbers
} from "#recorded.fixtures.ts"
import { keptOf } from "#runner/keep.ts"
import { completeShrink, shrink } from "#shrink.ts"
import { forcedChooser, generate, prefixChooser, randomChooser, recorder } from "#source.ts"
import { valuesOf } from "#tape.ts"

/** No case a random search draws, mutates, repairs into a unique key or clones reaches a recorded value. */
export const nothingDrawnReachesARecordedValue = property.explore(recordedCases, {
	needs: {},
	situations: [],
	check: () => (c) =>
		Effect.sync(() => {
			const words = wordsOf(c.seed)
			const lists = listsOf(c)
			const drawn = generate(recorder(), lists, randomChooser(words))
			const mutant = mutate(drawn.tape, Option.none(), words)
			const mutated = generate(
				recorder(),
				lists,
				prefixChooser(mutant.values, mutant.length, randomChooser(words))
			)
			const keys = generate(
				recorder(),
				uniqueKeys(numbersOf(c), { min: 0, max: c.top + 2 }),
				randomChooser(words)
			).value
			const twins = generate(recorder(), clone(lists, 2), randomChooser(words)).value
			assert.deepEqual(
				{
					drawn: isRecordedList(drawn.value),
					mutated: isRecordedList(mutated.value),
					keys: Arr.some(keys, (key) => key < 0),
					twins: Arr.map(twins, isRecordedList),
					alike: isDeepStrictEqual(twins[0], twins[1])
				},
				{ drawn: false, mutated: false, keys: false, twins: [false, false], alike: true }
			)
		}),
	oracle: {
		kind: "specification",
		name: "a recorded value is reached only through its token: every drawn, mutated, repaired and cloned case is its space's"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/source.ts",
			original: '\t\t\tcase "recalled":\n\t\t\t\treturn lo\n',
			replacement: '\t\t\tcase "recalled":\n\t\t\t\treturn between(words, lo, hi)\n',
			why: "A random search draws a recalled decision over its whole range, so a drawn case is a recorded value as often as its space's."
		},
		{
			file: "packages/testing/src/source.ts",
			original: '\t\treturn append(value, lo, spread.kind === "recalled" ? value : hi)',
			replacement: "\t\treturn append(value, lo, hi)",
			why: "A recalled decision's tape spans every recorded value, so a mutation moves a drawn case's recalled decision off 0 onto a recorded value, and a unique key's repair walks onto one."
		},
		{
			file: "packages/testing/src/gen.ts",
			original:
				"\t\trecall: (count) => {\n\t\t\tconst value = source.recall(count)\n\t\t\ttaken.push(value)\n\t\t\treturn value\n\t\t},\n\t\tobserve: (decided) => {",
			replacement: "\t\tobserve: (decided) => {",
			why: "A unique key's decisions leave out its recalled one, so its repair replays the key's first drawn decision as the recalled one and draws a recorded key."
		},
		{
			file: "packages/testing/src/gen.ts",
			original: "\t\t\t\trecall: () => next(0),\n",
			replacement: "",
			why: "A twin's replay draws its recalled decision afresh and reads the first twin's recalled decision as its space's first, so the twins differ."
		}
	]
})

/** An enumeration of a recorded space is its space's, case for case: no recorded value is counted. */
export const anEnumerationCountsTheSpaceAlone = property.explore(recordedCases, {
	needs: {},
	situations: [],
	check: () => (c) =>
		Effect.sync(() => {
			assert.deepEqual(everyValue(listsOf(c)), everyValue(array(int(0, c.top), { min: 0, max: 3 })))
		}),
	oracle: {
		kind: "specification",
		name: "an enumeration takes a recalled decision at 0 alone, so it is the space's enumeration"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/source.ts",
			original: '\t\treturn append(value, lo, spread.kind === "recalled" ? value : hi)',
			replacement: "\t\treturn append(value, lo, hi)",
			why: "A recalled decision's tape spans every recorded value, so an enumeration branches onto each of them after its space's cases."
		}
	]
})

/**
 * A token's recalled decision k, from 1 to the count, draws the k-th recorded value exactly, its tape the token's and
 * bounded by k; one past the last overruns, onto the space's simplest case.
 */
export const aTokenDrawsItsRecordedValue = property.explore(recordedCases, {
	needs: {},
	situations: [],
	check: () => (c) =>
		Effect.sync(() => {
			const space = listsOf(c)
			const replayed = Array.from({ length: c.count + 1 }, (_, at) => {
				const generated = generate(recorder(), space, forcedChooser(Float64Array.of(at + 1), 1))
				return {
					value: generated.value,
					values: valuesOf(generated.tape),
					hi: Arr.fromIterable(generated.tape.hi),
					status: generated.tape.status
				}
			})
			assert.deepEqual(replayed, [
				...Arr.map(recordedNumbers(c.count), (n, at) => ({
					value: [n],
					values: [at + 1],
					hi: [at + 1],
					status: "complete" as const
				})),
				{
					value: [],
					values: [0, 0],
					hi: [0, 3],
					status: "overrun" as const
				}
			])
		}),
	oracle: {
		kind: "specification",
		name: "a recalled decision k draws the k-th recorded value; one past the count overruns onto the simplest case"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/gen.ts",
			original: "\t\treturn at === 0 ? space(source) : Arr.getUnsafe(values, at - 1)",
			replacement: "\t\treturn at === 0 ? space(source) : Arr.getUnsafe(values, 0)",
			why: "Every token of a recorded value draws the first recorded value."
		},
		{
			file: "packages/testing/src/source.ts",
			original: "\t\trecall: (count) => decide(0, count, RECALLED),",
			replacement: "\t\trecall: (count) => decide(0, count - 1, RECALLED),",
			why: "A recalled decision stops one short of its count, so the last recorded value's token overruns."
		}
	]
})

/**
 * A shrink moves a recalled decision toward 0 alone: a failure every case shares shrinks a recorded case to the first
 * recorded value's token, the shortest tape this space draws, and a drawn case to its space's simplest case, its
 * recalled decision never moved off 0 though every recorded case's tape is shorter.
 */
export const aShrinkMovesARecalledDecisionTowardZero = property.explore(recordedCases, {
	needs: {},
	situations: [],
	check: () => (c) =>
		Effect.gen(function* () {
			const space = listsOf(c)
			const fromRecorded = generate(recorder(), space, forcedChooser(Float64Array.of(c.count), 1))
			const fromDrawn = generate(recorder(), space, randomChooser(wordsOf(c.seed)))
			const shrunk = yield* Effect.forEach([fromRecorded, fromDrawn], (failing) =>
				Effect.map(
					shrink(space, failing, () => Effect.succeed(true), completeShrink),
					({ best }) => ({ value: best.failure, values: valuesOf(best.tape) })
				)
			)
			assert.deepEqual(shrunk, [
				{ value: [-1], values: [1] },
				{ value: [], values: [0, 0] }
			])
		}),
	oracle: {
		kind: "specification",
		name: "a shrink lowers a recalled decision toward 0 and never raises it: the first recorded value, or the space's simplest case"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/source.ts",
			original: '\t\treturn append(value, lo, spread.kind === "recalled" ? value : hi)',
			replacement:
				'\t\treturn append(value, spread.kind === "recalled" ? value : lo, spread.kind === "recalled" ? value : hi)',
			why: "A recalled decision's tape is bounded below by the value it took, so a shrink never lowers it and a recorded case keeps its own value."
		}
	]
})

/** keep finds every recorded value's token, its recalled decision the value's place, and a drawn value's beside them. */
export const keepFindsEveryRecordedValue = property.explore(recordedCases, {
	needs: {},
	situations: [],
	check: () => (c) =>
		Effect.sync(() => {
			const space = listsOf(c)
			const targets = [...Arr.map(recordedNumbers(c.count), (n) => [n]), [c.top, 0]]
			const found = Arr.map(targets, (target) => {
				const kept = keptOf(space, target)
				assert.ok(kept.kind === "found", `keep finds ${String(target)}`)
				return Arr.fromIterable(kept.values)
			})
			assert.deepEqual(
				Arr.map(found, (values) => values[0]),
				[...Arr.map(recordedNumbers(c.count), (_, at) => at + 1), 0]
			)
		}),
	oracle: {
		kind: "specification",
		name: "keep tries every value of a recalled decision: a recorded value's token recalls its place, a drawn value's 0"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/keep.ts",
			original: '\t\tcase "uniform":\n\t\tcase "weighted":\n\t\tcase "recalled":\n',
			replacement:
				'\t\tcase "recalled":\n\t\t\treturn [lo]\n\t\tcase "uniform":\n\t\tcase "weighted":\n',
			why: "keep never tries a recalled decision past 0, so no recorded value's token is found."
		}
	]
})
