import { isDeepStrictEqual } from "node:util"
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

/** Every number the target's structure holds: its numbers, its strings' lengths and character codes, its collections'
 * sizes, and its booleans as 0 and 1. */
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
 * A decision's candidates: every value of a choice among options (a pick, whose range is its options' count), and for a
 * magnitude its bounds, its value so far and the offsets of the target's literals, ascending.
 */
const candidatesOf = (
	lo: number,
	hi: number,
	spread: Spread,
	literals: ReadonlySet<number>
): ReadonlyArray<number> => {
	switch (spread) {
		case "uniform":
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
 * The offsets of a decision that put the target's leaves where its draws on its two simplest offsets differ: a leaf
 * that moves by a fixed step from one offset to the next (an int's lo + offset, or hi - offset) is at the target's
 * value at offset lo + (target - first) / step, when that is a whole offset of the range; so a decision whose mapping
 * no literal of the target names directly (int(1000, 2000)) still reaches it.
 */
const probedOf = (
	first: ReadonlyMap<string, string>,
	second: ReadonlyMap<string, string>,
	target: ReadonlyMap<string, string>,
	lo: number,
	hi: number
): ReadonlyArray<number> =>
	Arr.flatMap(Arr.fromIterable(first), ([path, before]) => {
		const after = Number(second.get(path))
		const at = Number(before)
		const wanted = Number(target.get(path))
		const step = after - at
		const offset = lo + (wanted - at) / step
		return Number.isFinite(step) &&
			step !== 0 &&
			Number.isSafeInteger(offset) &&
			offset >= lo &&
			offset <= hi
			? [offset]
			: []
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

/**
 * The tape `space` draws `target` from: decisions fixed left to right, each to the candidate (candidatesOf, and the
 * offsets probedOf reads off its two simplest draws) whose draw, the rest simplest, deeply equals the target or else is
 * nearest it leaf by leaf (nearness), the smallest candidate on a tie, until a draw
 * deeply equals the target. A draw with no decision left to fix ends the search unfound: the value lies outside what
 * the space draws, or a decision no candidate pins. The found tape is drawn again on exactly its decisions and must
 * give the target again.
 */
export const keptOf = (space: Gen<unknown>, target: unknown): Kept => {
	const targetLeaves = leavesOf(target)
	const literals = literalsOf(target)
	const fixed: Array<number> = []
	for (;;) {
		const drawn = drawOn(space, fixed)
		if (isDeepStrictEqual(drawn.value, target)) {
			const again = generate(recorder(), space, forcedChooser(drawn.values, drawn.values.length))
			return isDeepStrictEqual(again.value, target)
				? { kind: "found", values: drawn.values }
				: { kind: "unfound", why: "the tape found draws another value when replayed" }
		}
		const decision = Arr.get(drawn.decisions, fixed.length)
		if (Option.isNone(decision)) {
			return {
				kind: "unfound",
				why: `with every decision fixed the space draws ${Formatter.format(drawn.value)}: the value lies outside what the space draws, or one of its decisions takes a value none of the target's literals pins`
			}
		}
		const { lo, hi, spread } = decision.value
		const probed =
			hi > lo
				? probedOf(
						leavesOf(drawOn(space, [...fixed, lo]).value),
						leavesOf(drawOn(space, [...fixed, lo + 1]).value),
						targetLeaves,
						lo,
						hi
					)
				: []
		const candidates = Arr.sort(
			Arr.dedupe([...candidatesOf(lo, hi, spread, literals), ...probed]),
			Order.Number
		)
		const scored = Arr.map(candidates, (candidate): Scored => {
			const tried = drawOn(space, [...fixed, candidate])
			return {
				candidate,
				exact: isDeepStrictEqual(tried.value, target),
				near: nearness(leavesOf(tried.value), targetLeaves)
			}
		})
		const best = Arr.reduce(scored, Option.none<Scored>(), (chosen, next) =>
			Option.match(chosen, {
				onNone: () => Option.some(next),
				onSome: (current) => (nearer(next, current) ? Option.some(next) : chosen)
			})
		)
		if (Option.isNone(best)) {
			return { kind: "unfound", why: `decision ${fixed.length} has no candidate` }
		}
		fixed.push(best.value.candidate)
	}
}
