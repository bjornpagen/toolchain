import { isDeepStrictEqual } from "node:util"
import { regex } from "arkregex"
import { Array as Arr, Formatter, Option, Order, String as Str } from "effect"
import type { Gen } from "#gen.ts"
import {
	type Chooser,
	forcedChooser,
	generate,
	prefixChooser,
	recorder,
	simplestChooser,
	type Spread
} from "#source.ts"

/**
 * Finding the tape a space draws a given value from, so a regression kept by value (the library's old kept sketches)
 * becomes a replay token. A space is an opaque function of its decisions, so the search is over decisions, left to
 * right, each from a finite set of candidates the target fixes, and its verdict is exact: the drawn value deeply equal
 * to the target. Nothing in it is a budget: every candidate set is finite by construction.
 */

/** A run of decimal digits, with its sign: an integer a string spells. */
const SPELLED_INTEGER = regex("-?[0-9]+", "g")

/**
 * The integers a string spells, each with its sign and without it: a generator that draws an integer and prints it into
 * its text (`${int(1, 9)}e${int(-400, 400)}`) leaves only its digits, which no length or character code pins.
 */
const spelledIntegersOf = (text: string): ReadonlyArray<number> =>
	Arr.flatMap(Arr.fromIterable(Str.matchAll(SPELLED_INTEGER)(text)), ([spelled]) => {
		const value = Number(spelled)
		return Number.isSafeInteger(value) ? [value, Math.abs(value)] : []
	})

/** Every number the target's structure holds: its numbers, its strings' lengths, character codes and the integers they
 * spell, its collections' sizes, and its booleans as 0 and 1. */
const literalsOf = (target: unknown): ReadonlySet<number> => {
	const found = new Set<number>()
	const seen = new Set<object>()
	const visit = (value: unknown): void => {
		if (typeof value === "number") {
			found.add(value)
			return
		}
		if (typeof value === "bigint") {
			found.add(Number(value))
			return
		}
		if (typeof value === "boolean") {
			found.add(value ? 1 : 0)
			return
		}
		if (typeof value === "string") {
			found.add(value.length)
			for (const character of value) {
				Option.map(Str.codePointAt(0)(character), (code) => found.add(code))
			}
			for (const spelled of spelledIntegersOf(value)) {
				found.add(spelled)
			}
			return
		}
		if (typeof value !== "object" || value === null || seen.has(value)) {
			return
		}
		seen.add(value)
		if (Arr.isArray(value)) {
			found.add(value.length)
			for (const item of value) {
				visit(item)
			}
			return
		}
		if (value instanceof Map) {
			found.add(value.size)
			for (const [key, item] of value) {
				visit(key)
				visit(item)
			}
			return
		}
		if (value instanceof Set) {
			found.add(value.size)
			for (const item of value) {
				visit(item)
			}
			return
		}
		const keys = Reflect.ownKeys(value)
		found.add(keys.length)
		for (const key of keys) {
			const field: unknown = Reflect.get(value, key)
			visit(field)
		}
	}
	visit(target)
	return found
}

/**
 * The offsets a decision of `lo..hi` may take to draw a literal `v`, through the mappings the library's generators use:
 * the literal itself (a choice whose offset is its value), one either side of it (a range that starts at one, or a
 * count one short), and its place in the near-zero order of a signed range (2v - 1 for a positive v, -2v for a
 * negative one); each kept when it lies in the decision's range.
 */
const offsetsOf = (literal: number, lo: number, hi: number): ReadonlyArray<number> =>
	Arr.filter(
		[literal, literal - 1, literal + 1, literal > 0 ? 2 * literal - 1 : -2 * literal],
		(offset) => Number.isSafeInteger(offset) && offset >= lo && offset <= hi
	)

/**
 * A decision's candidates: every value of a choice among options (a pick or a weighted choice, whose range is its
 * options' count) and of a recalled decision (every recorded value and the space beside them), and for a magnitude its
 * bounds, its value so far and the offsets of the target's literals, ascending.
 */
const candidatesOf = (
	lo: number,
	hi: number,
	spread: Spread,
	literals: ReadonlySet<number>
): ReadonlyArray<number> => {
	switch (spread.kind) {
		case "uniform":
		case "weighted":
		case "recalled":
			return Array.from({ length: hi - lo + 1 }, (_, offset) => lo + offset)
		case "leaning":
			return Arr.sort(
				Arr.dedupe([
					lo,
					hi,
					...Arr.flatMap(Arr.fromIterable(literals), (literal) => offsetsOf(literal, lo, hi))
				]),
				Order.Number
			)
	}
}

/** A value's leaves: each primitive it holds, by its path from the root, printed. */
const leavesOf = (root: unknown): ReadonlyMap<string, string> => {
	const leaves = new Map<string, string>()
	const seen = new Set<object>()
	const visit = (value: unknown, path: string): void => {
		if (typeof value !== "object" || value === null) {
			leaves.set(path, Formatter.format(value))
			return
		}
		if (seen.has(value)) {
			return
		}
		seen.add(value)
		if (Arr.isArray(value)) {
			leaves.set(`${path}#length`, String(value.length))
			for (const [at, item] of value.entries()) {
				visit(item, `${path}[${at}]`)
			}
			return
		}
		if (value instanceof Map || value instanceof Set) {
			leaves.set(`${path}#size`, String(value.size))
			for (const [at, item] of Arr.fromIterable(value).entries()) {
				visit(item, `${path}{${at}}`)
			}
			return
		}
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key === "string") {
				const field: unknown = Reflect.get(value, key)
				visit(field, `${path}.${key}`)
			}
		}
	}
	visit(root, "")
	return leaves
}

/** How close one printed leaf is to another: the characters they share from the start, less their lengths' gap. */
const closeness = (leaf: string, wanted: string): number => {
	let shared = 0
	while (shared < leaf.length && shared < wanted.length && leaf[shared] === wanted[shared]) {
		shared += 1
	}
	return shared - Math.abs(leaf.length - wanted.length)
}

/**
 * How near a drawn value is to the target, compared leaf by leaf (leavesOf): first how few paths one has that the
 * other lacks (its shape), then how many leaves it shares with the target, then how close its other leaves print to
 * the target's (closeness); larger is nearer.
 */
const nearness = (
	drawn: ReadonlyMap<string, string>,
	target: ReadonlyMap<string, string>
): readonly [number, number, number] => {
	let unshared = 0
	let equal = 0
	let close = 0
	for (const [path, leaf] of drawn) {
		const wanted = target.get(path)
		if (wanted === undefined) {
			unshared += 1
		} else if (wanted === leaf) {
			equal += 1
		} else {
			close += closeness(leaf, wanted)
		}
	}
	for (const path of target.keys()) {
		if (!drawn.has(path)) {
			unshared += 1
		}
	}
	return [-unshared, equal, close]
}

/**
 * The offsets of a decision that put the target's leaves where its draws on its two simplest offsets differ: a leaf, or
 * an integer a leaf spells (spelledIntegersOf, its place among the leaf's), that moves by a fixed step from one offset
 * to the next (an int's lo + offset, or hi - offset) is at the target's value at offset lo + (target - first) / step,
 * when that is a whole offset of the range; so a decision whose mapping no literal of the target names directly
 * (int(1000, 2000), or such an int spelled in a text) still reaches it.
 */
const probedOf = (
	first: ReadonlyMap<string, string>,
	second: ReadonlyMap<string, string>,
	target: ReadonlyMap<string, string>,
	lo: number,
	hi: number
): ReadonlyArray<number> =>
	Arr.flatMap(Arr.fromIterable(first), ([path, before]) => {
		const after = second.get(path) ?? ""
		const wanted = target.get(path) ?? ""
		const atOf = (from: number, to: number, aim: number): ReadonlyArray<number> => {
			const step = to - from
			const offset = lo + (aim - from) / step
			return Number.isFinite(step) &&
				step !== 0 &&
				Number.isSafeInteger(offset) &&
				offset >= lo &&
				offset <= hi
				? [offset]
				: []
		}
		const spelled = (leaf: string) =>
			Arr.map(Arr.fromIterable(Str.matchAll(SPELLED_INTEGER)(leaf)), ([integer]) => Number(integer))
		const [befores, afters, wanteds] = [spelled(before), spelled(after), spelled(wanted)]
		return [
			...atOf(Number(before), Number(after), Number(wanted)),
			...Arr.flatMap(befores, (from, place) =>
				Option.match(Option.all([Arr.get(afters, place), Arr.get(wanteds, place)]), {
					onNone: () => [],
					onSome: ([to, aim]) => atOf(from, to, aim)
				})
			)
		]
	})

/** One decision of a draw: its bounds and how a random search spreads it. */
type Decision = Readonly<{ lo: number; hi: number; spread: Spread }>

/** One draw of the space on fixed decisions, the rest simplest: its value, its decisions' values, and each decision. */
type Drawn = Readonly<{ value: unknown; values: Float64Array; decisions: ReadonlyArray<Decision> }>

/**
 * The space's draw on `fixed`, every later decision at its simplest. The chooser is asked once for each decision the
 * tape records, in order, so the decisions it is asked for are the tape's.
 */
const drawOn = (space: Gen<unknown>, fixed: ReadonlyArray<number>): Drawn => {
	const decisions: Array<Decision> = []
	const inner = prefixChooser(Float64Array.from(fixed), fixed.length, simplestChooser)
	const chooser: Chooser = {
		exhausted: inner.exhausted,
		draw: (lo, hi, at, spread) => {
			decisions.push({ lo, hi, spread })
			return inner.draw(lo, hi, at, spread)
		}
	}
	const generated = generate(recorder(), space, chooser)
	return {
		value: generated.value,
		values: Float64Array.from(generated.tape.values.subarray(0, generated.tape.length)),
		decisions
	}
}

/** What the search found: the tape the space draws the target from, or why it found none. */
export type Kept =
	| Readonly<{ kind: "found"; values: Float64Array }>
	| Readonly<{ kind: "unfound"; why: string }>

/** A candidate's draw, and how near it is to the target. */
type Scored = Readonly<{
	candidate: number
	exact: boolean
	near: readonly [number, number, number]
}>

/** Whether one scored candidate is nearer the target than another: exact first, then by nearness. */
const nearer = (one: Scored, other: Scored): boolean => {
	if (one.exact !== other.exact) {
		return one.exact
	}
	const [shape, equal, close] = one.near
	const [otherShape, otherEqual, otherClose] = other.near
	if (shape !== otherShape) {
		return shape > otherShape
	}
	return equal === otherEqual ? close > otherClose : equal > otherEqual
}

/** What the target is, as every step of the search reads it: the value, its leaves and its literals. */
type Target = Readonly<{
	value: unknown
	leaves: ReadonlyMap<string, string>
	literals: ReadonlySet<number>
}>

/** A draw on fixed decisions, scored against the target. */
type Tried = Readonly<{ drawn: Drawn; exact: boolean; near: readonly [number, number, number] }>

const triedOn = (space: Gen<unknown>, target: Target, fixed: ReadonlyArray<number>): Tried => {
	const drawn = drawOn(space, fixed)
	return {
		drawn,
		exact: isDeepStrictEqual(drawn.value, target.value),
		near: nearness(leavesOf(drawn.value), target.leaves)
	}
}

/**
 * The candidates of the next decision after `fixed` (candidatesOf, and the offsets probedOf reads off its two simplest
 * draws), each with its draw, the rest simplest, ascending; none when the draw on `fixed` takes no further decision.
 */
const candidatesAfter = (
	space: Gen<unknown>,
	target: Target,
	fixed: ReadonlyArray<number>,
	drawn: Drawn
): Option.Option<ReadonlyArray<Scored>> =>
	Option.map(Arr.get(drawn.decisions, fixed.length), ({ lo, hi, spread }) => {
		const probed =
			hi > lo
				? probedOf(
						leavesOf(drawOn(space, [...fixed, lo]).value),
						leavesOf(drawOn(space, [...fixed, lo + 1]).value),
						target.leaves,
						lo,
						hi
					)
				: []
		return Arr.map(
			Arr.sort(
				Arr.dedupe([...candidatesOf(lo, hi, spread, target.literals), ...probed]),
				Order.Number
			),
			(candidate): Scored => {
				const tried = triedOn(space, target, [...fixed, candidate])
				return { candidate, exact: tried.exact, near: tried.near }
			}
		)
	})

/** The nearest of scored candidates (nearer), the smallest on a tie; none of none. */
const nearestOf = (scored: ReadonlyArray<Scored>): Option.Option<Scored> =>
	Arr.reduce(scored, Option.none<Scored>(), (chosen, next) =>
		Option.match(chosen, {
			onNone: () => Option.some(next),
			onSome: (current) => (nearer(next, current) ? Option.some(next) : chosen)
		})
	)

/**
 * The greedy completion of `fixed`: each later decision fixed to its nearest candidate, its draw the rest simplest,
 * until a draw deeply equals the target or takes no further decision; the last draw, scored.
 */
const greedyFrom = (space: Gen<unknown>, target: Target, prefix: ReadonlyArray<number>): Tried => {
	const fixed = [...prefix]
	for (;;) {
		const tried = triedOn(space, target, fixed)
		if (tried.exact) {
			return tried
		}
		const best = Option.flatMap(candidatesAfter(space, target, fixed, tried.drawn), nearestOf)
		if (Option.isNone(best)) {
			return tried
		}
		fixed.push(best.value.candidate)
	}
}

/**
 * A decision's candidates each judged by its greedy completion (greedyFrom), one for each distinct draw the rest
 * simplest gives, since candidates whose simplest draws are alike take the same arm: an arm a choice opens (an option
 * of oneOf, weighted or a swarm) prints nothing of the target until the decisions after it are fixed, so its simplest
 * draw cannot tell it from another, and only its completion can.
 */
const lookedAhead = (
	space: Gen<unknown>,
	target: Target,
	fixed: ReadonlyArray<number>,
	candidates: ReadonlyArray<Scored>
): Option.Option<readonly [Scored, Tried]> => {
	const seen = new Set<string>()
	const distinct = Arr.filter(candidates, (c) => {
		const printed = Formatter.format(drawOn(space, [...fixed, c.candidate]).value)
		const fresh = !seen.has(printed)
		seen.add(printed)
		return fresh
	})
	const completed = Arr.map(distinct, (c) => {
		const tried = greedyFrom(space, target, [...fixed, c.candidate])
		return [{ candidate: c.candidate, exact: tried.exact, near: tried.near }, tried] as const
	})
	return Arr.reduce(completed, Option.none<readonly [Scored, Tried]>(), (chosen, next) =>
		Option.match(chosen, {
			onNone: () => Option.some(next),
			onSome: (current) => (nearer(next[0], current[0]) ? Option.some(next) : chosen)
		})
	)
}

/** A found tape, drawn again on exactly its decisions, which must give the target again. */
const foundOf = (space: Gen<unknown>, target: Target, drawn: Drawn): Kept => {
	const again = generate(recorder(), space, forcedChooser(drawn.values, drawn.values.length))
	return isDeepStrictEqual(again.value, target.value)
		? { kind: "found", values: drawn.values }
		: { kind: "unfound", why: "the tape found draws another value when replayed" }
}

/**
 * The tape `space` draws `target` from: decisions fixed left to right, each to the candidate (candidatesOf, and the
 * offsets probedOf reads off its two simplest draws) whose greedy completion (greedyFrom) deeply equals the target or
 * else is nearest it leaf by leaf (nearness), the smallest candidate on a tie (lookedAhead), until a draw deeply equals
 * the target. The plain greedy completion of no decision is tried first, and found alone when it is exact. A draw with
 * no decision left to fix ends the search unfound: the value lies outside what the space draws, or a decision no
 * candidate pins. The found tape is drawn again on exactly its decisions and must give the target again.
 */
export const keptOf = (space: Gen<unknown>, value: unknown): Kept => {
	const target: Target = { value, leaves: leavesOf(value), literals: literalsOf(value) }
	const greedy = greedyFrom(space, target, [])
	if (greedy.exact) {
		return foundOf(space, target, greedy.drawn)
	}
	const fixed: Array<number> = []
	for (;;) {
		const tried = triedOn(space, target, fixed)
		if (tried.exact) {
			return foundOf(space, target, tried.drawn)
		}
		const candidates = candidatesAfter(space, target, fixed, tried.drawn)
		if (Option.isNone(candidates)) {
			return {
				kind: "unfound",
				why: `with every decision fixed the space draws ${Formatter.format(tried.drawn.value)}: the value lies outside what the space draws, or one of its decisions takes a value none of the target's literals pins`
			}
		}
		const best = lookedAhead(space, target, fixed, candidates.value)
		if (Option.isNone(best)) {
			return { kind: "unfound", why: `decision ${fixed.length} has no candidate` }
		}
		const [chosen, completion] = best.value
		if (completion.exact) {
			return foundOf(space, target, completion.drawn)
		}
		fixed.push(chosen.candidate)
	}
}
