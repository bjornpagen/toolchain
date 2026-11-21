/**
 * The engine under every search (random.ts, source.ts, tape.ts, replay.ts, enumerate.ts, gen.ts weighted), each held
 * to its specification: a range drawn whole and nothing outside it, from any seed; one stream from one seed; a case
 * replayed exactly from its values and through its replay token, the empty tape's included; a token's suite, steering
 * and values read back exactly, colons in the suite included; a replay that runs out finishing on simplest values and
 * saying so exactly then; weighted options in exact proportion however large the total; a uniform option and a
 * leaning magnitude from the same words; every case of a generator once, in its order, all of them counted; a stream's
 * cases from its seed alone.
 */
import { Array as Arr, Effect, Option, Order } from "effect"
import { assert } from "#assert.ts"
import { everyCase, everyValue, fraction, shareOf } from "#chance.fixtures.ts"
import {
	busyCounts,
	busyFor,
	COUNT_BUDGET_MILLIS,
	composite,
	cutTapes,
	enumerationOf,
	fresh,
	generatorOf,
	replayTokens,
	seededLengths,
	seededRanges,
	seeds,
	shapeFeaturesOf,
	shapeOf,
	tapeLengthOf,
	tokenFeaturesOf,
	weightLists
} from "#core.fixtures.ts"
import { countWithin, sizeOf } from "#enumerate.ts"
import { array, constant, int, type Weighted, weighted } from "#gen.ts"
import { property } from "#property.ts"
import { between, biased, caseSeed, floorSeed, rotatingSeed, wordsOf } from "#random.ts"
import { replayOf, replayTokenOf } from "#replay.ts"
import {
	forcedChooser,
	generate,
	optionAt,
	prefixChooser,
	randomChooser,
	recorder,
	sample,
	simplestChooser,
	weightsOf
} from "#source.ts"
import { tokenOf, valuesFromToken } from "#tape.ts"

/** The word source draws every value of a range, and nothing outside it, from any seed. */
export const betweenDrawsItsRange = property.explore(seeds, {
	needs: {},
	situations: [],
	check: () => (seed) =>
		Effect.sync(() => {
			const words = wordsOf(seed)
			const draws = Arr.makeBy(2000, () => between(words, 3, 7))
			assert.deepEqual(Arr.dedupe(Arr.sort(draws, Order.Number)), [3, 4, 5, 6, 7])
		}),
	oracle: { kind: "specification", name: "between draws exactly the values of its range" },
	kept: [],
	kills: [
		{
			file: "packages/testing/src/random.ts",
			original: "\treturn lo + (word % range)",
			replacement: "\treturn lo + (word % (range - 1))",
			why: "between never draws its range's highest value; the range property fails."
		}
	]
})

/** The word source draws the same stream from the same seed. */
export const oneStreamPerSeed = property.explore(seeds, {
	needs: {},
	situations: [],
	check: () => (seed) =>
		Effect.sync(() => {
			const first = wordsOf(seed)
			const second = wordsOf(seed)
			assert.deepEqual(
				Arr.makeBy(64, () => first.next()),
				Arr.makeBy(64, () => second.next())
			)
		}),
	oracle: { kind: "universal", name: "determinism: one seed, one stream" },
	kept: [],
	kills: [
		{
			file: "packages/testing/src/random.ts",
			original: "export const wordsOf = (seed: number): Words => {\n\tlet split = seed >>> 0",
			replacement:
				"let split = 0\n\nexport const wordsOf = (seed: number): Words => {\n\tsplit = (split + seed) >>> 0",
			why: "wordsOf keeps splitmix's state from one call to the next, so a second word source from one seed draws another stream; the one-stream property fails."
		}
	]
})

/** A tape replays its case exactly from its values. */
export const tapeReplaysItsCase = property.explore(seeds, {
	needs: {},
	situations: [],
	check: () => (seed) =>
		Effect.sync(() => {
			const original = fresh(composite, seed)
			const replay = generate(
				recorder(),
				composite,
				forcedChooser(original.tape.values, original.tape.length)
			)
			assert.deepEqual(replay, original)
		}),
	oracle: { kind: "universal", name: "round trip: a tape's values replay its case exactly" },
	kept: [],
	kills: [
		{
			file: "packages/testing/src/source.ts",
			original: "\texhausted: (at) => at >= length,\n\tdraw: (_lo, _hi, at) => values[at] ?? 0",
			replacement:
				"\texhausted: (at) => at >= length - 1,\n\tdraw: (_lo, _hi, at) => values[at] ?? 0",
			why: "A forced replay counts its last value as past its end, so a case's last decision replays at its simplest; the tape replay property fails."
		}
	]
})

/** A tape carries its values through a replay token, the empty tape's included. */
export const tokenCarriesItsValues = property.explore(array(int(0, 2 ** 52), { min: 0, max: 8 }), {
	needs: {},
	situations: ["an empty tape", "one value", "several values"],
	check: (_resources, c) => (values) =>
		Effect.sync(() => {
			c.note(tapeLengthOf(values))
			const tape = Float64Array.from(values)
			assert.deepEqual<ReadonlyArray<number>>(
				Arr.fromIterable(valuesFromToken(tokenOf(tape, tape.length))),
				values
			)
		}),
	oracle: { kind: "universal", name: "valuesFromToken ∘ tokenOf = id" },
	kept: [],
	kills: [
		{
			file: "packages/testing/src/tape.ts",
			original:
				"\t\tArr.map(Arr.fromIterable(values.subarray(0, length)), (value) => value.toString(36)),",
			replacement:
				"\t\tArr.map(Arr.fromIterable(values.subarray(0, length - 1)), (value) => value.toString(36)),",
			why: "A tape's token drops its last value; the token property fails."
		}
	]
})

/** A replay token names a case's suite, steering and values, and reads them back exactly. */
export const replayTokenReadsBack = property.explore(replayTokens, {
	needs: {},
	situations: [
		"unsteered",
		"steered, nothing pending",
		"steered, past the first digit",
		"steered, aimed past its lowest pending",
		"a colon in the suite",
		"a negative value",
		"an empty tape"
	],
	check:
		(_resources, c) =>
		([suite, replayed]) =>
			Effect.gen(function* () {
				c.noteAll(tokenFeaturesOf(suite, replayed))
				const replay = yield* replayOf(replayTokenOf(suite, replayed))
				assert.deepEqual(replay, { suite, replayed })
			}),
	oracle: { kind: "universal", name: "replayOf ∘ replayTokenOf = id" },
	kept: [],
	kills: [
		{
			file: "packages/testing/src/replay.ts",
			original:
				'\tconst steeringAt = Option.flatMap(tapeAt, (at) => Str.lastIndexOf(":")(Str.slice(0, at)(token)))',
			replacement: '\tconst steeringAt = Option.flatMap(tapeAt, () => Str.indexOf(":")(token))',
			why: "A replay token's steering is read from its first colon, so a token whose suite holds a colon is unreadable; the replay token property fails."
		}
	]
})

/** A replay that runs out finishes on simplest values, and says so exactly when it ran out. */
export const replayRunsOutOnSimplest = property.explore(cutTapes, {
	needs: {},
	situations: ["an empty prefix", "a cut tape", "the whole tape"],
	check:
		(_resources, c) =>
		({ seed, kept }) =>
			Effect.sync(() => {
				const original = fresh(composite, seed)
				const whole = kept === original.tape.length
				c.note(kept === 0 ? "an empty prefix" : whole ? "the whole tape" : "a cut tape")
				const replay = generate(recorder(), composite, forcedChooser(original.tape.values, kept))
				const continued = generate(
					recorder(),
					composite,
					prefixChooser(original.tape.values, kept, simplestChooser)
				)
				assert.deepEqual(
					{ value: replay.value, status: replay.tape.status },
					{ value: continued.value, status: whole ? "complete" : "overrun" }
				)
			}),
	oracle: {
		kind: "second-implementation",
		name: "the same prefix continued by the simplest chooser, as an enumeration continues it"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/source.ts",
			original: '\t\tif (!fits && status === "complete") {\n\t\t\tstatus = "overrun"\n\t\t}\n',
			replacement: "",
			why: "A replay that runs out finishes on simplest values without marking its tape overrun; the run-out property fails."
		}
	]
})

/**
 * A weighted choice draws each option exactly in proportion to its weight, however large the total, and an enumeration
 * meets each option once: the random chooser reads a unit of the total as the option that owns it (optionAt), each
 * option owning its weight of the units, and the space's every case is one option, in order, so an exhaustive search
 * runs each option's cases once, where it ran them once a unit of the option's weight (option's some six times).
 */
export const weightedShares = property.explore(weightLists, {
	needs: {},
	situations: ["a total past 256"],
	check: (_resources, c) => (weights) =>
		Effect.sync(() => {
			const total = Arr.reduce(weights, 0, (sum, weight) => sum + weight)
			if (total > 256) {
				c.note("a total past 256")
			}
			const space = weighted(
				Arr.map(weights, (weight, at): Weighted<number> => [weight, constant(at)])
			)
			const cases = everyCase(space)
			const owned = Array.from({ length: total }, (_, unit) => optionAt(weightsOf(weights), unit))
			assert.deepEqual(
				{
					shares: Arr.map(weights, (_weight, at) => shareOf(cases, (drawnAt) => drawnAt === at)),
					units: Arr.map(
						weights,
						(_weight, at) => Arr.filter(owned, (option) => option === at).length
					),
					support: everyValue(space)
				},
				{
					shares: Arr.map(weights, (weight) => fraction(BigInt(weight), BigInt(total))),
					units: Arr.map(weights, (weight) => weight),
					support: Arr.map(weights, (_weight, at) => at)
				}
			)
		}),
	oracle: {
		kind: "specification",
		name: "each option's weight over the total, by exact enumeration, and each option once in the space"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/source.ts",
			original: "\t\tif (rest < weight) {",
			replacement: "\t\tif (rest <= weight) {",
			why: "Each option of a weighted choice but the last owns one unit more than its weight; the weighted shares property fails."
		},
		{
			file: "packages/testing/src/source.ts",
			original: "\t\tweigh: (weights) => decide(0, weights.weights.length - 1, weights),\n",
			replacement:
				"\t\tweigh: (weights) => optionAt(weights, decide(0, weights.total - 1, UNIFORM)),\n",
			why: "A weighted choice is a pick over the units of its total, as it was: an enumeration meets an option once a unit of its weight, so an exhaustive search runs option's some branch six times and a weight of 99 ninety-nine times; the property fails on the support."
		}
	]
})

/**
 * The random chooser draws an option uniformly, a magnitude leaning toward the ends, and a weighted option as the unit
 * of its total it draws uniformly owns it, from the same words.
 */
export const chooserSpreads = property.explore(seededRanges, {
	needs: {},
	situations: [],
	check:
		() =>
		({ seed, lo, hi }) =>
			Effect.sync(() => {
				const weights = weightsOf(
					Arr.prepend(
						Array.from({ length: hi - lo }, (_, at) => at + 2),
						1
					)
				)
				assert.deepEqual(
					[
						randomChooser(wordsOf(seed)).draw(lo, hi, 0, { kind: "uniform" }),
						randomChooser(wordsOf(seed)).draw(lo, hi, 0, { kind: "leaning" }),
						randomChooser(wordsOf(seed)).draw(lo, hi, 0, weights)
					],
					[
						between(wordsOf(seed), lo, hi),
						biased(wordsOf(seed), lo, hi),
						lo + optionAt(weights, between(wordsOf(seed), 0, weights.total - 1))
					]
				)
			}),
	oracle: { kind: "second-implementation", name: "the word source's own between and biased" },
	kept: [],
	kills: [
		{
			file: "packages/testing/src/source.ts",
			original: "\t\t\t\treturn biased(words, lo, hi)",
			replacement: "\t\t\t\treturn between(words, lo, hi)",
			why: "The random chooser draws a leaning magnitude uniformly, as between does, never as biased does; the chooser property fails."
		},
		{
			file: "packages/testing/src/source.ts",
			original: "\t\t\t\treturn lo + optionAt(spread, between(words, 0, spread.total - 1))\n",
			replacement: "\t\t\t\treturn between(words, lo, hi)\n",
			why: "The random chooser draws a weighted option uniformly, whatever its weight, so option draws none one case in two; the chooser property fails."
		}
	]
})

/** Enumeration yields every case of a generator once, in its specified order, and counts them all. */
export const enumerationOrder = property.explore(shapeOf(2), {
	needs: {},
	situations: [
		"a range across zero",
		"a range below zero",
		"a collection that may be empty",
		"a collection of collections",
		"a pair"
	],
	check: (_resources, c) => (shape) =>
		Effect.gen(function* () {
			c.noteAll(shapeFeaturesOf(shape, false))
			const expected = enumerationOf(shape)
			const size = yield* sizeOf(generatorOf(shape))
			assert.deepEqual(
				{ values: everyValue(generatorOf(shape)), size },
				{ values: expected, size: expected.length }
			)
		}),
	oracle: {
		kind: "second-implementation",
		name: "each shape's values listed from its specification: int's order, collections by length, the first decision outermost"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/enumerate.ts",
			original: "\t\tvalues[at] = value + 1",
			replacement: "\t\tvalues[at] = Math.min(value + 2, tape.hi[at] ?? 0)",
			why: "Enumeration counts each decision up by two, skipping every other value below its highest; the enumeration property fails."
		}
	]
})

/**
 * An exhaustion's count is bounded by the CPU it spends itself, never by what other fibers of its process spend while it
 * yields: beside a fiber that spends more than the count's whole budget at once, a space of 2,049 to 20,000 cases, which
 * takes a few milliseconds to count, is counted, all of it (grizzle's GZ-UNIT-A: under load, every exhaustion of
 * test/unit/allen and a dozen more were refused as uncountable within a case deadline that the parent's other searches
 * and the machine's load ran out, not the count).
 */
export const countedBesideBusyFibers = property.explore(busyCounts, {
	needs: {},
	situations: [],
	check: () => (busy) =>
		Effect.gen(function* () {
			const [counted] = yield* Effect.all(
				[
					countWithin(int(0, busy.cases - 1), COUNT_BUDGET_MILLIS, busy.cases),
					busyFor(busy.busyMillis)
				],
				{ concurrency: "unbounded" }
			)
			assert.deepEqual(
				Option.map(counted, (count) => count.cases),
				Option.some(busy.cases)
			)
		}),
	oracle: {
		kind: "specification",
		name: "a space whose count spends little CPU is counted whole, whatever its process's other fibers spend meanwhile"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/enumerate.ts",
			original:
				"\t\t\tspent += cpuMillisOf(process.threadCpuUsage(began))\n\t\t\tif (spent > cpuMillis) {\n\t\t\t\treturn Option.none()\n\t\t\t}\n\t\t\tyield* Effect.yieldNow",
			replacement:
				"\t\t\tyield* Effect.yieldNow\n\t\t\tspent += cpuMillisOf(process.threadCpuUsage(began))\n\t\t\tif (spent > cpuMillis) {\n\t\t\t\treturn Option.none()\n\t\t\t}",
			why: "The count is charged with what ran while it yielded, as a deadline on the time that passes charges it: a busy fiber beside it makes a small space uncountable; this property fails."
		}
	]
})

/** Sampling draws a stream's cases from its seed alone. */
export const samplingFromSeed = property.explore(seededLengths, {
	needs: {},
	situations: [],
	check:
		() =>
		({ seed, length }) =>
			Effect.sync(() => {
				const stream = rotatingSeed(seed, floorSeed("sampling"))
				assert.deepEqual(
					sample(composite, stream, length),
					Array.from({ length }, (_, index) => fresh(composite, caseSeed(stream, index)).value)
				)
			}),
	oracle: { kind: "specification", name: "a stream's cases, each regenerated from its own seed" },
	kept: [],
	kills: [
		{
			file: "packages/testing/src/source.ts",
			original:
				"\t\tcases.push(generate(recorded, generator, randomChooser(wordsOf(caseSeed(stream, index)))).value)",
			replacement:
				"\t\tcases.push(generate(recorded, generator, randomChooser(wordsOf(stream + index))).value)",
			why: "sample seeds each case with its stream plus its index, unmixed, not with caseSeed; the sampling property fails."
		}
	]
})
