import { Array as Arr, Effect, Option } from "effect"
import { assert } from "#assert.ts"
import { aimed, array, type Gen, int } from "#gen.ts"
import { type Case, type Property, property } from "#property.ts"
import type { Limits } from "#runner/limits.ts"
import { runnerLimits } from "#runner/limits.ts"

/**
 * What the meta-tests of the steered phase (runner/search.ts) share: a lock that opens on magic values, which a
 * steered search climbs one new note at a time; and inner searches whose aims show whose turn each case was.
 */

/** The oracle of an inner search: a lock planted so that only a steered search opens it. */
const lock = {
	kind: "specification",
	name: "a lock planted so that only a steered search opens it"
} as const

/** How many magic values a case begins with, as it notes it. */
type Matched = `${0 | 1 | 2 | 3 | 4 | 5} matched`

const MATCHED: ReadonlyArray<Matched> = [
	"0 matched",
	"1 matched",
	"2 matched",
	"3 matched",
	"4 matched",
	"5 matched"
]

/** Five magic values of 0..31: random search begins with all five once in 33 million cases. */
export const magics: Gen<ReadonlyArray<number>> = array(int(0, 31), { min: 5, max: 5 })

/** How many of `magic` the drawn values begin with. */
const matchedOf = (magic: ReadonlyArray<number>, drawnValues: ReadonlyArray<number>): number => {
	let matched = 0
	while (matched < magic.length && drawnValues[matched] === magic[matched]) {
		matched += 1
	}
	return matched
}

/**
 * The lock of `magic`: six values of 0..31, which notes how many of the magic values each case begins with, and
 * requires all five.
 */
export const lockOf = (magic: ReadonlyArray<number>): Property =>
	property.explore(array(int(0, 31), { min: 6, max: 6 }), {
		needs: {},
		situations: ["5 matched"],
		check: (_resources, c: Case<Matched>) => (drawnValues) =>
			Effect.sync(() => c.note(Arr.getUnsafe(MATCHED, matchedOf(magic, drawnValues)))),
		oracle: lock,
		kept: [],
		kills: []
	})

/** The runner's limits with a steered budget of `steered`: none, or unbounded, what a lock's climb is held to. */
export const steeredBy = (steered: number): Limits => ({ ...runnerLimits, steered })

/** A requirement of the turns oracle, by its place. */
type Requirement = `r${number}`

/** The most requirements a turns search requires. */
const MOST_REQUIRED = 12

/** The requirement at `place`. */
const requirementAt = (place: number): Requirement => `r${place}`

/**
 * A drawn turns search: it requires the first `pending` requirements, steers every `window` cases, runs a floor of
 * `floor` cases and a steered budget of `budget`, and its cases reach the requirement they aim at sometimes or never.
 */
export type TurnShape = Readonly<{
	pending: number
	window: number
	floor: number
	budget: number
	reaching: boolean
}>

export const turnShapes: Gen<TurnShape> = (source) => ({
	pending: source.draw(int(1, MOST_REQUIRED)),
	window: source.draw(int(1, 8)),
	floor: source.draw(int(1, 8)),
	budget: source.draw(int(0, 40)),
	reaching: source.draw(int(0, 1)) === 1
})

/** A case of a turns search: a value of 0..3, and the requirement whose aim drew it, if one did. */
type Turned = Readonly<{ value: number; aim: Option.Option<number> }>

/** What a turns search's case was aimed at, and whether it reached (noted) that requirement. */
export type Seen = Readonly<{ aim: Option.Option<number>; noted: boolean }>

const turnedBy =
	(aim: Option.Option<number>): Gen<Turned> =>
	(source) => ({ value: source.draw(int(0, 3)), aim })

/**
 * A turns search of `shape`, and what each case it checked was aimed at, in the order checked: each requirement's aim
 * draws its case, which notes that requirement when it reaches (a value of 0), so a case's turn is what it was drawn
 * for. Every other case is drawn unaimed.
 */
export const turnsOf = (
	shape: TurnShape
): Readonly<{ seen: ReadonlyArray<Seen>; property: Property }> => {
	const seen: Array<Seen> = []
	const places = Array.from({ length: shape.pending }, (_, place) => place)
	return {
		seen,
		property: property.explore(
			aimed(
				turnedBy(Option.none()),
				Arr.map(places, (place) => [requirementAt(place), turnedBy(Option.some(place))] as const)
			),
			{
				needs: {},
				situations: Arr.map(places, requirementAt),
				check: (_resources, c: Case<Requirement>) => (drawnCase) =>
					Effect.sync(() => {
						const noted = shape.reaching && drawnCase.value === 0 && Option.isSome(drawnCase.aim)
						seen.push({ aim: drawnCase.aim, noted })
						if (noted) {
							c.noteAll(Arr.map(Option.toArray(drawnCase.aim), requirementAt))
						}
					}),
				oracle: { kind: "specification", name: "what each case was aimed at" },
				kept: [],
				kills: []
			}
		)
	}
}

/** The limits of a turns search: no rotating case, its floor, steered budget and window. */
export const turnLimits = (shape: TurnShape): Limits => ({
	runs: 0,
	floor: shape.floor,
	steered: shape.budget,
	window: shape.window,
	deadline: runnerLimits.deadline,
	open: runnerLimits.open
})

/** What the turns oracle notes of a stream's windows. */
export type TurnFeature =
	| "more pending than a window holds"
	| "a window holding more cases than are pending"
	| "a requirement reached between windows"
	| "a steered phase of several windows"

/** One window of a stream: what was pending as it began, and each of its cases' aim. */
type Window = Readonly<{
	pending: ReadonlyArray<number>
	aims: ReadonlyArray<Option.Option<number>>
}>

/**
 * A stream's windows, from its cases in order and the requirements reached before it: each window's pending snapshot is
 * what no earlier case reached, and a case reaches the requirement its aim drew it for when it notes it.
 */
export const windowsOf = (
	cases: ReadonlyArray<Seen>,
	width: number,
	pending: number,
	reachedBefore: ReadonlySet<number>
): Readonly<{ windows: ReadonlyArray<Window>; reached: ReadonlySet<number> }> => {
	const reached = new Set(reachedBefore)
	const windows: Array<Window> = []
	for (const chunk of Arr.chunksOf(cases, width)) {
		windows.push({
			pending: Arr.filter(
				Array.from({ length: pending }, (_, place) => place),
				(place) => !reached.has(place)
			),
			aims: Arr.map(chunk, (turned) => turned.aim)
		})
		for (const turned of chunk) {
			if (turned.noted) {
				Option.map(turned.aim, (place) => reached.add(place))
			}
		}
	}
	return { windows, reached }
}

/**
 * Checks one stream's windows of `width` cases against what the runner promises, and returns the features they reached:
 * each case aims at one pending requirement while any is pending and at none after, a window's aims are distinct while
 * it holds no more cases than are pending, and every requirement still pending is aimed at within ⌈pending / width⌉ full
 * windows.
 */
export const turnsKept = (
	windows: ReadonlyArray<Window>,
	width: number
): ReadonlyArray<TurnFeature> =>
	Arr.flatMap(windows, (window, at): ReadonlyArray<TurnFeature> => {
		const { pending } = window
		const aimedAt = Arr.flatMap(window.aims, Option.toArray)
		assert.equal(aimedAt.length, Arr.isReadonlyArrayNonEmpty(pending) ? window.aims.length : 0)
		assert.ok(
			Arr.every(aimedAt, (aim) => Arr.contains(pending, aim)),
			`window ${at} aims at ${Arr.join(Arr.map(aimedAt, String), ",")}, which is not all pending (${Arr.join(Arr.map(pending, String), ",")})`
		)
		assert.deepEqual(Arr.dedupe(aimedAt).length, Math.min(pending.length, window.aims.length))
		const span = Math.ceil(pending.length / width)
		const sweep = windows.slice(at, at + span)
		const swept =
			pending.length > 0 &&
			sweep.length === span &&
			Arr.every(sweep, (later) => later.aims.length === width)
		if (swept) {
			for (const place of pending) {
				const stillPending = Arr.every(sweep, (later) => Arr.contains(later.pending, place))
				assert.ok(
					!stillPending ||
						Arr.some(sweep, (later) => Arr.some(later.aims, (aim) => Option.contains(aim, place))),
					`requirement ${place} pending through ${sweep.length} windows of ${width} and never aimed at`
				)
			}
		}
		const next = windows[at + 1]
		return [
			...(swept && pending.length > width ? ["more pending than a window holds" as const] : []),
			...(pending.length > 0 && window.aims.length > pending.length
				? ["a window holding more cases than are pending" as const]
				: []),
			...(next !== undefined && next.pending.length > 0 && next.pending.length < pending.length
				? ["a requirement reached between windows" as const]
				: [])
		]
	})
