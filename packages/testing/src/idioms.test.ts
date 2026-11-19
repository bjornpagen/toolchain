/**
 * The library's generators (gen.ts, values.ts, swarm.ts, lsw.ts, pattern.ts), each held to what its JSDoc promises,
 * every search stating its oracle: exact enumeration orders and spaces (an int's or a bigint's distance from zero,
 * every arrangement, alphabet, subset, sorted list, tree and composition of a small box, each exactly once); ranges
 * kept however wide, a wide int's every decision at its greatest included; doubles and floats within range, a whole
 * failure shrinking to the least whole number, every special double reached, -0 from a range that holds none; UUIDs
 * canonical, of their version and variant; a unique array distinct by construction, its repair building no item;
 * twins, element order and the scalar code points; exact shares by exact enumeration (production's five in six,
 * proportional weights, a swarm's omissions and presences, a swarm choice); live, stale and wild boundary values drawn,
 * printed untouched, handed as data where data, and shrunk to the simplest live value, or, in a list failing for its
 * wild value, to that value alone; a corrupted value's live share and its rules' weights; and a pattern's strings
 * matching it, every pattern generated from the grammar it honours.
 */
import { regex } from "arkregex"
import {
	Array as Arr,
	Cause,
	Effect,
	Formatter,
	Option,
	Record as Rec,
	Result,
	Schema,
	String as Str
} from "effect"
import { assert } from "#assert.ts"
import { everyCase, everyValue, type Fraction, fraction, shareOf } from "#chance.fixtures.ts"
import { failureText } from "#failure.ts"
import {
	alphabet,
	array,
	clone,
	composition,
	constant,
	element,
	finite,
	increasing,
	int,
	map,
	nondecreasing,
	parents,
	production,
	proportional,
	shuffled,
	subset,
	unicodeScalar,
	UniqueKeysExhausted
} from "#gen.ts"
import {
	alphabetsModel,
	arrangementsModel,
	ascendingModel,
	boundaryAimed,
	boundaryList,
	boundaryValue,
	boundsOf,
	byDistanceFromZero,
	CANONICAL_UUID,
	classSource,
	cloneCase,
	compositionBox,
	compositionsModel,
	computedWeights,
	corruptionCase,
	corruptionsOf,
	DRAWN_FEATURES,
	drawsFor,
	farDraws,
	firstLetters,
	FLOAT_MAX,
	fresh,
	greatestChooser,
	honouredPattern,
	hostileWildKill,
	isData,
	isPresence,
	isTree,
	type Letter,
	letterAlphabets,
	LIVE_THEN_WILD,
	mixedList,
	neverDrawn,
	nonEmpty,
	OFF_RATE,
	patternPieces,
	pieceSource,
	rangeBox,
	REACHING_KINDS,
	reachCase,
	reaching,
	type Rule,
	RULES,
	scalarIndex,
	seeds,
	shortestOf,
	shuffleBox,
	sitesIn,
	smallBounds,
	smallValues,
	SURROGATE_COUNT,
	SURROGATE_FIRST,
	swarmWeightsBox,
	treesModel,
	uniqueCase,
	uniqueOf,
	uuidVersion,
	WHOLE_ARM,
	wholeNumbers,
	wildKind,
	writtenClass,
	writtenOut
} from "#idioms.fixtures.ts"
import { corrupted, drawnFeature, passed, WILD_IS_DATA, WildTouched, wildOf } from "#lsw.ts"
import { agree, exact, set, structuralHash } from "#oracle.ts"
import { matching, PatternRefused } from "#pattern.ts"
import { property } from "#property.ts"
import { floorSeed, rotatingSeed, wordsOf } from "#random.ts"
import { completeShrink, shrink } from "#shrink.ts"
import {
	forcedChooser,
	generate,
	prefixChooser,
	randomChooser,
	recorder,
	sample,
	simplestChooser
} from "#source.ts"
import { keep, type Swarm, swarm, swarmChoice, weightOf } from "#swarm.ts"
import { bigint, double, float, uuid } from "#values.ts"

/** Whole numbers enumerate every range by distance from zero, the positive side first. */
export const intOrder = property.exhaust(finite(smallBounds), {
	box: "every range of whole numbers within -5..5",
	needs: {},
	situations: [],
	check:
		() =>
		([lo, hi]) =>
			Effect.sync(() =>
				assert.deepEqual(
					everyValue(int(lo, hi)),
					Arr.sort(wholeNumbers(lo, hi), byDistanceFromZero)
				)
			),
	oracle: {
		kind: "specification",
		name: "int's order: by distance from zero, the positive side first"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/gen.ts",
			original: "\t\treturn offset % 2 === 1 ? distance : -distance",
			replacement: "\t\treturn offset % 2 === 1 ? -distance : distance",
			why: "int's order puts the negative side first at each distance from zero; the int order enumeration fails."
		}
	]
})

/** Bigints enumerate every range by distance from zero, the positive side first. */
export const bigintOrder = property.exhaust(finite(smallBounds), {
	box: "every range of bigints within -5..5",
	needs: {},
	situations: [],
	check:
		() =>
		([lo, hi]) =>
			Effect.sync(() =>
				assert.deepEqual(
					everyValue(bigint(BigInt(lo), BigInt(hi))),
					Arr.map(Arr.sort(wholeNumbers(lo, hi), byDistanceFromZero), BigInt)
				)
			),
	oracle: {
		kind: "specification",
		name: "bigint's order, int's: by distance from zero, the positive side first"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/values.ts",
			original: "\t\treturn offset % 2n === 1n ? distance : -distance",
			replacement: "\t\treturn offset % 2n === 1n ? -distance : distance",
			why: "bigint's order puts the negative side first at each distance from zero; the bigint order enumeration fails."
		}
	]
})

/** Bigints stay within their range, however wide. */
export const bigintBounds = property.explore(boundsOf(bigint(-(2n ** 100n), 2n ** 100n)), {
	needs: {},
	situations: [],
	check:
		(_resources, c) =>
		([lo, hi]) =>
			Effect.sync(() => {
				const value = c.draw(bigint(lo, hi))
				assert.ok(lo <= value && value <= hi, `${value} lies within ${lo}..${hi}`)
			}),
	oracle: { kind: "specification", name: "lo ≤ value ≤ hi, as bigint states" },
	kept: [],
	kills: []
})

/**
 * Floating-point numbers are finite doubles within their range: a random draw, and each arm's draw at its far end, by
 * place and whole.
 */
export const doubleBounds = property.explore(
	boundsOf(double(-Number.MAX_VALUE, Number.MAX_VALUE)),
	{
		needs: {},
		situations: [],
		check:
			(_resources, c) =>
			([min, max]) =>
				Effect.sync(() => {
					const generator = double(min, max)
					assert.deepEqual(
						Rec.filter(
							{ drawn: c.draw(generator), ...farDraws(generator) },
							(value) => !(Number.isFinite(value) && min <= value && value <= max)
						),
						{}
					)
				}),
		oracle: {
			kind: "specification",
			name: "a finite double within its range, as double states, for a random draw and for each arm's draw at its far end"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/values.ts",
				original: "\t\tmax,\n\t\t2 ** 31 - 1,",
				replacement: "\t\tMath.ceil(max),\n\t\t2 ** 31 - 1,",
				why: "double's whole arm runs to max rounded up, past a max that is no whole number; the double bounds property fails."
			}
		]
	}
)

/**
 * Floating-point numbers are 32-bit floats within their range: a random draw, and each arm's draw at its far end, by
 * place and whole.
 */
export const floatBounds = property.explore(boundsOf(float(-FLOAT_MAX, FLOAT_MAX)), {
	needs: {},
	situations: [],
	check:
		(_resources, c) =>
		([min, max]) =>
			Effect.sync(() => {
				const generator = float(min, max)
				assert.deepEqual(
					Rec.filter(
						{ drawn: c.draw(generator), ...farDraws(generator) },
						(value) => !(Math.fround(value) === value && min <= value && value <= max)
					),
					{}
				)
			}),
	oracle: {
		kind: "specification",
		name: "a 32-bit float within its range, as float states, for a random draw and for each arm's draw at its far end"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/values.ts",
			original: "\t\tmax,\n\t\t2 ** 24,",
			replacement: "\t\tMath.ceil(max),\n\t\t2 ** 24,",
			why: "float's whole arm runs to max rounded up, past a max that is no whole number; the float bounds property fails."
		}
	]
})

/** A failing double drawn whole shrinks to the least whole number that still fails. */
export const doubleShrink = property.explore(seeds, {
	needs: {},
	situations: [],
	check: () => (seed) =>
		Effect.gen(function* () {
			const generator = double(-1e9, 1e9)
			const fails = (value: number) => Math.abs(value) > 10.25
			const drawnStart = generate(
				recorder(),
				generator,
				prefixChooser(WHOLE_ARM, WHOLE_ARM.length, randomChooser(wordsOf(seed)))
			)
			const failing = fails(drawnStart.value)
				? drawnStart
				: generate(
						recorder(),
						generator,
						prefixChooser(WHOLE_ARM, WHOLE_ARM.length, greatestChooser)
					)
			const shrunk = yield* shrink(
				generator,
				failing,
				(value) => Effect.succeed(fails(value)),
				completeShrink
			)
			assert.equal(shrunk.best.failure, 11)
		}),
	oracle: {
		kind: "specification",
		name: "the least whole number that still fails, as wholeOr states"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/values.ts",
			original: "\t\t\t\t[1, int(low, high)],\n\t\t\t\t[3, anywhere]",
			replacement: "\t\t\t\t[3, anywhere],\n\t\t\t\t[1, int(low, high)]",
			why: "wholeOr puts its whole arm after the arm by place, so a failing double shrinks by place, never to the least whole number that still fails; the double shrink property fails."
		}
	]
})

/** A random search reaches the ends of a wide range, zero, -0 and every special double, from any seed. */
export const randomReach = property.explore(reachCase, {
	needs: {},
	situations: REACHING_KINDS,
	check:
		(_resources, c) =>
		({ kind, seed, parameters }) =>
			Effect.sync(() => {
				c.note(kind)
				const { generator, values, chance } = reaching(kind, parameters)
				assert.deepEqual(
					neverDrawn(
						sample(generator, rotatingSeed(seed, floorSeed("random reach")), drawsFor(chance)),
						values
					),
					[]
				)
			}),
	oracle: {
		kind: "specification",
		name: "each generator's documented rates: a value they give a chance of p per draw is missed by 30/p draws with probability below 10^-13"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/values.ts",
			original: "\t-0",
			replacement: "\t0",
			why: "The special doubles hold 0 where -0 belongs, so a double or special from a range without -0 never draws it; the random reach property fails."
		}
	]
})

/** UUIDs are canonical, of their version, with RFC 9562's variant. */
export const uuidForm = property.explore(uuidVersion, {
	needs: {},
	situations: [],
	check: (_resources, c) => (version) =>
		Effect.sync(() => {
			const value = c.draw(uuid(version))
			assert.ok(CANONICAL_UUID.test(value), `${value} is a canonical UUID`)
			assert.deepEqual(
				{
					version: Str.slice(14, 15)(value),
					simplest: generate(recorder(), uuid(version), simplestChooser).value
				},
				{
					version: `${version}`,
					simplest: `00000000-0000-${version}000-8000-000000000000`
				}
			)
		}),
	oracle: { kind: "specification", name: "RFC 9562's canonical form, version and variant" },
	kept: [],
	kills: [
		{
			file: "packages/testing/src/values.ts",
			original: "\t\tconst randomB = hex(0x8000 | source.choose(0, 0x3fff), 4)",
			replacement: "\t\tconst randomB = hex(0xc000 | source.choose(0, 0x3fff), 4)",
			why: "A UUID's variant bits are 11 where RFC 9562 has 10; the uuid form property fails."
		}
	]
})

/** Collections shuffle without repeating, every arrangement once. */
export const shuffledArrangements = property.exhaust(finite(shuffleBox), {
	box: "every count of values up to 4 and every size within it",
	needs: {},
	situations: [],
	check:
		() =>
		({ count, size }) => {
			const values = wholeNumbers(0, count - 1)
			return agree(
				[
					["shuffled", everyValue(shuffled(values, size))],
					["model", arrangementsModel(values, size)]
				],
				set(structuralHash, exact)
			)
		},
	oracle: {
		kind: "second-implementation",
		name: "every arrangement of each size, each value at most once, built by naive recursion"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/gen.ts",
			original: "\t\t\trest = Arr.remove(rest, at)\n",
			replacement: "",
			why: "shuffled never takes a picked value out of the rest, so a value repeats; the shuffled exhaustion fails."
		}
	]
})

/**
 * Collections construct a unique array: no key repeated, no case given up, its length drawn unless the keys run out
 * first, a length past the keys refused, and a repair that walks keys alone however large each item's tail, building
 * no item.
 */
export const uniqueArrays = property.explore(uniqueCase, {
	needs: {},
	situations: [
		"a key repeated and moved",
		"every key used",
		"a key moved beside a huge tail",
		"a length past the keys refused"
	],
	check: (_resources, c) => (drawnCase) =>
		Effect.sync(() => {
			const { keys, projected, size, seed } = drawnCase
			const unique = uniqueOf(drawnCase)
			const drawn = Result.try(() => fresh(unique.generator, seed))
			if (size.min > keys) {
				c.note("a length past the keys refused")
				assert.deepEqual(
					Result.match(drawn, {
						onSuccess: () => Option.none(),
						onFailure: (thrown) =>
							Schema.is(UniqueKeysExhausted)(thrown)
								? Option.some({ held: thrown.held, needed: thrown.needed })
								: Option.none()
					}),
					Option.some({ held: keys, needed: size.min })
				)
				return
			}
			const { value: items, tape } = Result.getOrThrow(drawn)
			const lengthAt = size.min < size.max ? 1 : 0
			const length = size.min < size.max ? (tape.values[0] ?? 0) : size.min
			const perItem = projected ? 2 : 1
			const candidates =
				keys > 1
					? Array.from(
							{ length: Math.min(length, items.length) },
							(_, at) => tape.values[lengthAt + perItem * at] ?? 0
						)
					: []
			if (Arr.dedupe(candidates).length < candidates.length) {
				c.note(projected ? "a key moved beside a huge tail" : "a key repeated and moved")
			}
			if (items.length === keys) {
				c.note("every key used")
			}
			assert.deepEqual(
				{
					status: tape.status,
					distinct: Arr.dedupe(items).length === items.length,
					length: items.length,
					built: projected ? unique.built() : items
				},
				{
					status: "complete",
					distinct: true,
					length: Math.min(length, keys),
					built: items
				}
			)
		}),
	oracle: {
		kind: "specification",
		name: "distinct keys by construction: the drawn length, or every key where fewer remain, never a discard, the repair over the key space alone, each item built once, for its own key"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/gen.ts",
			original:
				"\t\t\tconst drawn = drawnWithDecisions(key, source)\n\t\t\tconst unique = seen.has(drawn.value)\n\t\t\t\t? nearestNew(key, drawn.decisions, seen)",
			replacement:
				"\t\t\tconst keyAndItem: Gen<K> = (inner) => {\n\t\t\t\tconst drawnKey = key(inner)\n\t\t\t\titemOf(drawnKey)(inner)\n\t\t\t\treturn drawnKey\n\t\t\t}\n\t\t\tconst drawn = drawnWithDecisions(keyAndItem, source)\n\t\t\tconst unique = seen.has(drawn.value)\n\t\t\t\t? nearestNew(keyAndItem, drawn.decisions, seen)",
			why: "The repair of a repeated key walks each item, tail and all, building items it drops, and where the keys run out it enumerates every tail, a hang; the unique array property fails at the first item built twice, before any walk."
		}
	]
})

/** Collections draw a non-empty alphabet of every subset with each kept letter, the kept letter first. */
export const alphabets = property.exhaust(finite(firstLetters), {
	box: "every alphabet of the first 1 to 4 letters",
	needs: {},
	situations: [],
	check: () => (letters) =>
		agree(
			[
				["alphabet", everyValue(alphabet(letters))],
				["model", alphabetsModel(letters)]
			],
			set(structuralHash, exact)
		),
	oracle: {
		kind: "second-implementation",
		name: "every non-empty subset, each kept letter first and the others in their order, built by naive recursion"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/gen.ts",
			original: "\t\treturn [Arr.getUnsafe(letters, kept), ...others]",
			replacement: "\t\treturn [...others, Arr.getUnsafe(letters, kept)]",
			why: "alphabet puts its kept letter last, after the others, so the letters after the first leave their order; the alphabet exhaustion fails."
		}
	]
})

/** Collections make twins equal by structure that share no object. */
export const cloneTwins = property.explore(cloneCase, {
	needs: {},
	situations: ["one twin", "several twins"],
	check:
		(_resources, c) =>
		({ count, seed }) =>
			Effect.sync(() => {
				c.note(count === 1 ? "one twin" : "several twins")
				const twins = fresh(
					clone(
						array(
							map(array(int(0, 9), { min: 0, max: 3 }), (values) => ({ values })),
							{ min: 0, max: 4 }
						),
						count
					),
					seed
				).value
				const objectsOf = (twin: ReadonlyArray<Readonly<{ values: ReadonlyArray<number> }>>) => [
					twin,
					...Arr.flatMap(twin, (item) => [item, item.values])
				]
				const owned = Arr.map(twins, (twin) => new Set<object>(objectsOf(twin)))
				const copies: typeof twins = Array.from({ length: count }, () => Arr.getUnsafe(twins, 0))
				assert.deepEqual(
					{
						twins,
						shared: Arr.some(owned, (objects, at) =>
							Arr.some(Arr.drop(owned, at + 1), (later) =>
								Arr.some(Arr.fromIterable(objects), (object) => later.has(object))
							)
						)
					},
					{ twins: copies, shared: false }
				)
			}),
	oracle: {
		kind: "specification",
		name: "every twin equal to the first by structure, and no object of one reachable from another"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/gen.ts",
			original: "\t\t\ttwins.push(generator(replayed))",
			replacement: "\t\t\tgenerator(replayed)\n\t\t\ttwins.push(Arr.headNonEmpty(twins))",
			why: "clone hands out the first twin again for every other, so the twins share their objects; the clone property fails."
		}
	]
})

/** Collections draw production's constant five times in six exactly, and each small value an equal share of the rest. */
export const productionShare = property.explore(smallValues, {
	needs: {},
	situations: [],
	check: () => (small) =>
		Effect.sync(() => {
			const cases = everyCase(production(64, small))
			assert.deepEqual(
				[
					shareOf(cases, (value) => value === 64),
					...Arr.map(small, (value) => shareOf(cases, (drawnValue) => drawnValue === value))
				],
				[fraction(5n, 6n), ...Arr.map(small, () => fraction(1n, 6n * BigInt(small.length)))]
			)
		}),
	oracle: {
		kind: "specification",
		name: "production's constant five times in six, by exact enumeration"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/gen.ts",
			original: "\t\t[5, constant(inForce)],",
			replacement: "\t\t[4, constant(inForce)],",
			why: "production draws its constant four times in five; the production share property fails."
		}
	]
})

/** An element is one of its list's own literals, every place in order when enumerated. */
export const elementOrder = property.explore(mixedList, {
	needs: {},
	situations: ["one literal", "numbers and strings mixed", "a literal repeated"],
	check:
		(_resources, c) =>
		({ first, rest }) =>
			Effect.sync(() => {
				const list = Arr.prepend(rest, first)
				if (list.length === 1) {
					c.note("one literal")
				}
				if (
					Arr.some(list, (item) => typeof item === "number") &&
					Arr.some(list, (item) => typeof item === "string")
				) {
					c.note("numbers and strings mixed")
				}
				if (Arr.dedupe(list).length < list.length) {
					c.note("a literal repeated")
				}
				assert.deepEqual(everyValue(element(list)), list)
			}),
	oracle: { kind: "specification", name: "the list itself, each place once, in order" },
	kept: [],
	kills: [
		{
			file: "packages/testing/src/gen.ts",
			original: "(source: Source): A => Arr.getUnsafe(values, source.pick(0, values.length - 1))",
			replacement:
				"(source: Source): A => Arr.getUnsafe(values, values.length - 1 - source.pick(0, values.length - 1))",
			why: "element picks from its list's end, so it shrinks toward the last literal and enumerates the list reversed; the element order property fails."
		}
	]
})

/** Unicode scalars map every index of their decision onto a scalar, in order, skipping the surrogates and reaching the last plane. */
export const unicodeScalars = property.explore(scalarIndex, {
	needs: {},
	situations: ["below the surrogates", "past the surrogates", "beyond the basic plane"],
	check: (_resources, c) => (index) =>
		Effect.sync(() => {
			const scalar = index < SURROGATE_FIRST ? index : index + SURROGATE_COUNT
			c.note(
				scalar < SURROGATE_FIRST
					? "below the surrogates"
					: scalar <= 0xff_ff
						? "past the surrogates"
						: "beyond the basic plane"
			)
			assert.deepEqual(
				generate(recorder(), unicodeScalar, forcedChooser(Float64Array.of(index), 1)).value,
				String.fromCodePoint(scalar)
			)
		}),
	oracle: {
		kind: "second-implementation",
		name: "index i is the scalar i below the surrogates and i + 0x800 above them"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/gen.ts",
			original:
				"\tString.fromCodePoint(index < SURROGATES.first ? index : index + SURROGATES.count)",
			replacement: "\tString.fromCodePoint(index)",
			why: "unicodeScalar takes its index for the code point, so it draws lone surrogates and never the last plane's top; the unicode scalars property fails."
		}
	]
})

/**
 * Computed weights draw each option exactly in proportion to its weight, however large the total, never one of weight
 * zero, and the floor when none has weight.
 */
export const proportionalShares = property.explore(computedWeights, {
	needs: {},
	situations: ["a weight of zero", "a total past 256", "no weight at all", "one weight alone"],
	check: (_resources, c) => (weights) =>
		Effect.sync(() => {
			const total = Arr.reduce(weights, 0, (sum, weight) => sum + weight)
			if (Arr.some(weights, (weight) => weight === 0)) {
				c.note("a weight of zero")
			}
			if (total > 256) {
				c.note("a total past 256")
			}
			if (total === 0) {
				c.note("no weight at all")
			}
			const weighed = Arr.filter(weights, (weight) => weight > 0).length
			if (weighed === 1) {
				c.note("one weight alone")
			}
			const cases = everyCase(
				proportional(nonEmpty(Arr.map(weights, (weight, at) => [weight, constant(at)] as const)))
			)
			assert.deepEqual(
				{
					shares: Arr.map(weights, (_weight, at) => shareOf(cases, (drawnAt) => drawnAt === at)),
					decides: Arr.map(cases, (drawnCase) => drawnCase.tape.length > 0)
				},
				{
					shares: Arr.map(weights, (weight, at): Fraction =>
						total === 0 ? fraction(at === 0 ? 1n : 0n, 1n) : fraction(BigInt(weight), BigInt(total))
					),
					decides: Arr.map(cases, () => weighed > 1)
				}
			)
		}),
	oracle: {
		kind: "specification",
		name: "each option's weight over the total, by exact enumeration"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/gen.ts",
			original: "\t\tconst live = Arr.filter(options, ([weight]) => Math.floor(weight) > 0)",
			replacement: "\t\tconst live = Arr.filter(options, ([weight]) => Math.floor(weight) >= 0)",
			why: "proportional counts an option of weight zero among those with weight, so it draws the last option, not the floor, when none has weight, and decides where one alone has it; the proportional shares property fails."
		}
	]
})

/**
 * Swarms never turn every feature off, and turn each other one off at its omission's rate exactly, every presence
 * equally often, in boxes of up to 3 features.
 */
export const swarmDistribution = property.exhaust(finite(letterAlphabets), {
	box: "every swarm of every alphabet of a, b and c",
	needs: {},
	situations: [],
	check: () => (features) =>
		Effect.sync(() => {
			const cases = everyCase(swarm(features))
			const k = BigInt(features.length)
			const offAt = (feature: Letter) =>
				shareOf(cases, (drawnSwarm) => weightOf(drawnSwarm, feature) === 0)
			const presenceAt = (feature: Letter, presence: 1 | 2 | 3) =>
				shareOf(cases, (drawnSwarm) => weightOf(drawnSwarm, feature) === presence)
			assert.deepEqual(
				{
					allOff: shareOf(cases, (drawnSwarm) =>
						Arr.every(features, (feature) => weightOf(drawnSwarm, feature) === 0)
					),
					off: Arr.map(features, offAt),
					presences: Arr.map(features, (feature) =>
						Arr.map([1, 2, 3] as const, (presence) => presenceAt(feature, presence))
					)
				},
				{
					allOff: fraction(0n, 1n),
					off: Arr.map(features, () => fraction((k - 1n) * OFF_RATE[0], k * OFF_RATE[1])),
					presences: Arr.map(features, () =>
						Arr.map([1, 2, 3] as const, () =>
							fraction(k * OFF_RATE[1] - (k - 1n) * OFF_RATE[0], 3n * k * OFF_RATE[1])
						)
					)
				}
			)
		}),
	oracle: {
		kind: "specification",
		name: "the omissions' rates and the forced feature, by exact enumeration"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/swarm.ts",
			original:
				'const OFF: Readonly<Record<Omission, number>> = { "five-sixths": 15, half: 9, "one-sixth": 3 }',
			replacement:
				'const OFF: Readonly<Record<Omission, number>> = { "five-sixths": 15, half: 6, "one-sixth": 3 }',
			why: "The half omission turns a feature off a third of the time; the swarm distribution exhaustion fails."
		}
	]
})

/**
 * Swarms keep a feature at the third of its places its weight says, and choose among those on by weight, the floor
 * when none is.
 */
export const swarmWeights = property.exhaust(finite(swarmWeightsBox), {
	box: "every weight of 0 to 3 for each of a, b and c, against every choice among an alphabet of them",
	needs: {},
	situations: [],
	check:
		() =>
		({ weights, options }) =>
			Effect.sync(() => {
				const drawnSwarm: Swarm<Letter> = Rec.filter(weights, isPresence)
				const on = Arr.filter(options, (option) => weights[option] > 0)
				const total = Arr.reduce(on, 0, (sum, option) => sum + weights[option])
				const choices = everyCase(swarmChoice(drawnSwarm, options))
				assert.deepEqual(
					{
						kept: Arr.map(options, (feature) =>
							shareOf(everyCase(keep(drawnSwarm, feature)), (kept) => kept)
						),
						chosen: Arr.map(options, (option) => shareOf(choices, (chosen) => chosen === option)),
						decides: Arr.map(choices, (choice) => choice.tape.length > 0)
					},
					{
						kept: Arr.map(options, (feature) => fraction(BigInt(weights[feature]), 3n)),
						chosen: Arr.map(options, (option, at) =>
							total === 0
								? fraction(at === 0 ? 1n : 0n, 1n)
								: fraction(BigInt(weights[option] > 0 ? weights[option] : 0), BigInt(total))
						),
						decides: Arr.map(choices, () => on.length > 1)
					}
				)
			}),
	oracle: {
		kind: "specification",
		name: "keep's share weight/3 and a choice's share weight/total among those on, by exact enumeration"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/swarm.ts",
			original: "\t\treturn weight === 3 || (weight > 0 && source.pick(0, 2) >= 3 - weight)",
			replacement:
				"\t\treturn weight === 3 || weight === 1 || (weight > 0 && source.pick(0, 2) >= 3 - weight)",
			why: "keep keeps a feature of weight 1 at every place; the swarm weights exhaustion fails."
		}
	]
})

/**
 * Constructive collections draw every sorted list, sorted set and subset in a box of ranges up to 4 wide exactly once,
 * and nothing else.
 */
export const sortedCollections = property.exhaust(finite(rangeBox), {
	box: "every range of width up to 4 from -2..1, and every size within it",
	needs: {},
	situations: [],
	check:
		() =>
		({ lo, hi, size }) =>
			Effect.gen(function* () {
				const width = hi - lo + 1
				const strict = { min: Math.min(size.min, width), max: Math.min(size.max, width) }
				yield* agree(
					[
						["increasing", everyValue(increasing(lo, hi, strict))],
						["model", ascendingModel(lo, hi, strict, 1)]
					],
					set(structuralHash, exact)
				)
				yield* agree(
					[
						["nondecreasing", everyValue(nondecreasing(lo, hi, size))],
						["model", width === 0 ? (size.min === 0 ? [[]] : []) : ascendingModel(lo, hi, size, 0)]
					],
					set(structuralHash, exact)
				)
				const values = Array.from({ length: width }, (_, i) => `v${lo + i}`)
				yield* agree(
					[
						["subset", everyValue(subset(values, strict))],
						[
							"model",
							Arr.map(ascendingModel(0, width - 1, strict, 1), (at) =>
								Arr.map(at, (index) => Arr.getUnsafe(values, index))
							)
						]
					],
					set(structuralHash, exact)
				)
			}),
	oracle: { kind: "second-implementation", name: "each space built by naive recursion" },
	kept: [],
	kills: [
		{
			file: "packages/testing/src/gen.ts",
			original: "\t\t\tat += (index === 0 ? 0 : step) + gap",
			replacement: "\t\t\tat += gap",
			why: "ascending drops its step, so increasing repeats values; the sorted collections exhaustion fails."
		}
	]
})

/** Constructive collections draw every rooted tree of up to 5 nodes exactly once, each one acyclic. */
export const trees = property.exhaust(finite(int(1, 5)), {
	box: "every tree of 1 to 5 nodes",
	needs: {},
	situations: [],
	check: () => (nodes) =>
		Effect.gen(function* () {
			const drawnTrees = everyValue(parents({ min: nodes, max: nodes }))
			assert.ok(Arr.every(drawnTrees, isTree), "every drawn parent array is a tree")
			yield* agree(
				[
					["parents", drawnTrees],
					["model", treesModel(nodes)]
				],
				set(structuralHash, exact)
			)
		}),
	oracle: { kind: "second-implementation", name: "every parent array built by naive recursion" },
	kept: [],
	kills: [
		{
			file: "packages/testing/src/gen.ts",
			original: "\t\t\tparent.push(source.pick(0, node - 1))",
			replacement: "\t\t\tparent.push(source.pick(0, node))",
			why: "parents lets a node be its own parent; the trees exhaustion fails."
		}
	]
})

/**
 * Constructive collections draw every way up to 4 items fall into up to 3 places exactly once, each summing to its
 * total.
 */
export const compositions = property.exhaust(finite(compositionBox), {
	box: "every total of 0 to 4 into 1 to 3 places",
	needs: {},
	situations: [],
	check:
		() =>
		({ total, parts }) =>
			agree(
				[
					["composition", everyValue(composition(total, parts))],
					["model", compositionsModel(total, parts)]
				],
				set(structuralHash, exact)
			),
	oracle: { kind: "second-implementation", name: "every composition built by naive recursion" },
	kept: [],
	kills: [
		{
			file: "packages/testing/src/gen.ts",
			original: "\t\t\tconst count = source.choose(0, rest)",
			replacement: "\t\t\tconst count = source.choose(0, total)",
			why: "composition draws each count from the whole total, not what the counts before it left, so the counts run past it and the last goes negative; the compositions exhaustion fails."
		}
	]
})

/** Live, stale and wild values: every kind drawn, and printed without touching a hostile value. */
export const lswKinds = property.explore(boundaryAimed, {
	needs: {},
	situations: DRAWN_FEATURES,
	check: (_resources, c) => (value) =>
		Effect.sync(() => {
			Formatter.format(value)
			c.note(drawnFeature(value))
		}),
	oracle: {
		kind: "specification",
		name: "every kind of live, stale and wild value drawn, none touched in printing"
	},
	kept: [],
	kills: [hostileWildKill]
})

/**
 * Live, stale and wild values shrink any case toward the simplest live value, and a list failing for its wild value
 * toward that value alone, of the simplest wild kind.
 */
export const lswShrink = property.explore(seeds, {
	needs: {},
	situations: [],
	check: () => (seed) =>
		Effect.gen(function* () {
			const shrunk = yield* shrink(
				boundaryValue,
				fresh(boundaryValue, seed),
				() => Effect.succeed(true),
				completeShrink
			)
			const shrunkList = yield* shrink(
				boundaryList,
				generate(
					recorder(),
					boundaryList,
					prefixChooser(LIVE_THEN_WILD, LIVE_THEN_WILD.length, randomChooser(wordsOf(seed)))
				),
				(values) => Effect.succeed(Arr.some(values, (value) => value.kind === "wild")),
				completeShrink
			)
			assert.deepEqual(
				{ value: shrunk.best.failure, list: shrunkList.best.failure },
				{
					value: { kind: "live", value: 0 },
					list: [{ kind: "wild", wild: wildOf("null") }]
				}
			)
		}),
	oracle: {
		kind: "specification",
		name: "the simplest live value, as lsw orders its arms, and the simplest wild kind alone once the live value before it is deleted"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/shrink.ts",
			original: "\t\t\tconst deleted = yield* deleteItems()",
			replacement: "\t\t\tconst deleted = false",
			why: "The shrinker never deletes an item, so a list failing for its wild value keeps the live value before it; the lsw shrink property fails."
		}
	]
})

/**
 * Live, stale and wild values hand the boundary data of every kind but two, which refuse to have their properties
 * read, each by its own kind.
 */
export const wildData = property.exhaust(finite(map(wildKind, wildOf)), {
	box: "the simplest wild value of every kind",
	needs: {},
	situations: [],
	check: () => (wildValue) =>
		Effect.sync(() => {
			const handed = passed({ kind: "wild", wild: wildValue })
			const asData = Result.try(() => {
				const target = new Object(handed)
				return Arr.map(Reflect.ownKeys(target), (key): unknown => Reflect.get(target, key))
			})
			const thrown = Option.flatMap(Result.getFailure(asData), (failure) =>
				Schema.is(WildTouched)(failure) ? Option.some(failure) : Option.none()
			)
			const touched = Option.map(thrown, (failure) => failure.touch.kind)
			assert.deepEqual<{ data: boolean; touched: Option.Option<string> }>(
				{ data: WILD_IS_DATA[wildValue.kind], touched },
				{
					data: isData(handed),
					touched: isData(handed) ? Option.none() : Option.some(wildValue.kind)
				}
			)
			assert.deepEqual(
				Option.map(thrown, (failure) => {
					const report = failureText(Cause.die(failure))
					return {
						said: failure.message !== "",
						data: Str.includes(Formatter.format(failure.touch))(report),
						message: Str.includes(failure.message)(report)
					}
				}),
				Option.map(thrown, () => ({ said: true, data: true, message: true }))
			)
		}),
	oracle: {
		kind: "second-implementation",
		name: "a walk of the value's own property descriptors, which runs none of its code"
	},
	kept: [],
	kills: [hostileWildKill]
})

/**
 * Corrupted artifacts draw the live artifact one time in six, each rule with a site by its weight among those, each of
 * its sites equally, and an artifact no rule has a site in live without a decision.
 */
export const corruptedShares = property.explore(corruptionCase, {
	needs: {},
	situations: ["no rule has a site", "one rule has a site", "two rules have sites"],
	check:
		(_resources, c) =>
		({ live, weights }) =>
			Effect.sync(() => {
				const applicable = Arr.filter(RULES, (rule) => sitesIn(rule, live.length) > 0)
				c.note(
					applicable.length === 0
						? "no rule has a site"
						: applicable.length === 1
							? "one rule has a site"
							: "two rules have sites"
				)
				const total = Arr.reduce(applicable, 0, (sum, rule) => sum + weights[rule])
				const cases = everyCase(corrupted(live, corruptionsOf(weights)))
				const siteShare = (rule: Rule, at: number): Fraction =>
					Arr.contains(applicable, rule) && at < sitesIn(rule, live.length)
						? fraction(
								5n * BigInt(weights[rule]),
								6n * BigInt(total) * BigInt(sitesIn(rule, live.length))
							)
						: fraction(0n, 1n)
				const siteOf = (rule: Rule, at: number) => `item ${rule === "unsorted" ? at + 1 : at}`
				assert.deepEqual(
					{
						live: shareOf(cases, (drawnCase) => drawnCase.kind === "live"),
						sites: Arr.map(RULES, (rule) =>
							Arr.map(Arr.range(0, 4), (at) =>
								shareOf(
									cases,
									(drawnCase) =>
										drawnCase.kind !== "live" &&
										drawnCase.rule === rule &&
										drawnCase.at === siteOf(rule, at)
								)
							)
						),
						decides: Arr.some(cases, (drawnCase) => drawnCase.tape.length > 0)
					},
					{
						live: applicable.length === 0 ? fraction(1n, 1n) : fraction(1n, 6n),
						sites: Arr.map(RULES, (rule) => Arr.map(Arr.range(0, 4), (at) => siteShare(rule, at))),
						decides: applicable.length > 0
					}
				)
			}),
	oracle: {
		kind: "specification",
		name: "corrupted's rates: 1/6 live, then each applicable rule by weight, each site equally, by exact enumeration"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/lsw.ts",
			original:
				"\treturn weighted<Corrupted<T, R, Rule>>([\n\t\t[1, constant(unbroken)],\n\t\t[5, rules]\n\t])",
			replacement: "\treturn weighted<Corrupted<T, R, Rule>>([[5, rules]])",
			why: "corrupted drops its live arm, so an artifact a rule has a site in is never drawn live; the corrupted shares property fails."
		}
	]
})

/** A pattern generates only strings it matches. */
export const matchingPatterns = property.explore(honouredPattern, {
	needs: {},
	situations: [],
	check: (_resources, c) => (source) =>
		Effect.sync(() => {
			const pattern = regex.as(source, "u")
			const text = c.draw(matching(pattern))
			assert.ok(pattern.test(text), `${text} matches ${pattern.source}`)
		}),
	oracle: { kind: "universal", name: "the pattern's own RegExp accepts every string it generates" },
	kept: [],
	kills: [
		{
			file: "packages/testing/src/pattern.ts",
			original:
				'\t\t\treturn map(array(generatorOf(node.node), { min: node.min, max: node.max }), Arr.join(""))',
			replacement:
				'\t\t\treturn map(array(generatorOf(node.node), { min: node.min, max: node.max + 1 }), Arr.join(""))',
			why: "A repetition draws up to one item past its max; the matching property fails."
		}
	]
})

/** A pattern draws each member of a class by its index, where the class written out holds it. */
export const patternClasses = property.explore(writtenClass, {
	needs: {},
	situations: [],
	check: () => (written) =>
		Effect.sync(() => {
			const pattern = regex.as(classSource(written), "u")
			const expected = writtenOut(written)
			const recorded = recorder()
			const byIndex = Arr.map(
				Array.from({ length: expected.length }, (_, i) => i),
				(index) =>
					generate(recorded, matching(pattern), forcedChooser(Float64Array.of(index), 1)).value
			)
			assert.deepEqual<ReadonlyArray<string>>(byIndex, expected)
			assert.ok(
				Arr.every(byIndex, (text) => pattern.test(text)),
				classSource(written)
			)
		}),
	oracle: {
		kind: "second-implementation",
		name: "the class written out, each member at the place it is first written"
	},
	kept: [],
	kills: []
})

/**
 * A pattern generates from what it can honour, shortest first, each class at its first member, and refuses every
 * pattern holding what it cannot.
 */
export const patternGrammar = property.explore(patternPieces, {
	needs: {},
	situations: ["refused", "generated", "a negated class", "an option"],
	check: (_resources, c) => (pieces) =>
		Effect.sync(() => {
			const source = `^${Arr.join(Arr.map(pieces, pieceSource), "")}$`
			const unhonoured = Arr.some(pieces, (piece) => piece.kind === "unhonoured")
			c.note(unhonoured ? "refused" : "generated")
			if (Arr.some(pieces, (piece) => piece.kind === "class" && piece.written.negated)) {
				c.note("a negated class")
			}
			if (Arr.some(pieces, (piece) => piece.kind === "option")) {
				c.note("an option")
			}
			const pattern = regex.as(source, "u")
			const generated = Result.try(
				() => generate(recorder(), matching(pattern), simplestChooser).value
			)
			assert.deepEqual(
				{
					refused: Result.isFailure(generated) && Schema.is(PatternRefused)(generated.failure),
					shortest: Result.getSuccess(generated)
				},
				{
					refused: unhonoured,
					shortest: unhonoured
						? Option.none()
						: Option.some(Arr.join(Arr.map(pieces, shortestOf), ""))
				}
			)
		}),
	oracle: {
		kind: "specification",
		name: "matching's grammar: bounded classes, literals and options shrink to their minimum, each class at the member it writes first; an unbounded repetition, a backreference, a boundary or a property is refused"
	},
	kept: [],
	kills: []
})

/** A wide whole number stays within a range wider than 2^32, every decision at its greatest included. */
export const wideInts = property.explore(boundsOf(int(-(2 ** 50), 2 ** 50)), {
	needs: {},
	situations: [],
	check:
		(_resources, c) =>
		([lo, hi]) =>
			Effect.sync(() => {
				const value = c.draw(int(lo, hi))
				const farthest = generate(recorder(), int(lo, hi), greatestChooser).value
				assert.ok(
					lo <= value && value <= hi && Number.isInteger(value),
					`${value} lies within ${lo}..${hi}`
				)
				assert.ok(
					lo <= farthest && farthest <= hi,
					`${farthest}, every decision at its greatest, lies within ${lo}..${hi}`
				)
			}),
	oracle: {
		kind: "specification",
		name: "lo ≤ value ≤ hi, as int states, for a random draw and for every decision at its greatest"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/gen.ts",
			original: "\t\tconst low = source.choose(0, high === highest ? lowestAtTop : WORD_SPAN - 1)",
			replacement: "\t\tconst low = source.choose(0, WORD_SPAN - 1)",
			why: "A wide int's low word goes unbounded at its high word's top, so the whole passes hi; the wide ints property fails at every decision's greatest."
		}
	]
})
