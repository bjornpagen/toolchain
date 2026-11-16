import { Array as Arr } from "effect"
import { array, boolean, type Gen, int } from "#gen.ts"
import type { Span } from "#mutants.ts"

/** A range as V8 reports one: half-open, with the times it ran. */
export type Ranged = Readonly<{ startOffset: number; endOffset: number; count: number }>

/** A range and the ranges it holds, laid out by gaps and lengths, as a function holds its blocks. */
export type Node = Readonly<{
	lead: number
	length: number
	count: number
	same: boolean
	children: ReadonlyArray<Node>
}>

/** A range tree of at most `depth` levels below its root. */
export const nodeGen =
	(depth: number): Gen<Node> =>
	(source) => ({
		lead: source.draw(int(0, 3)),
		length: source.draw(int(1, 4)),
		count: source.draw(int(0, 2)),
		same: source.draw(boolean),
		children: depth === 0 ? [] : source.draw(array(nodeGen(depth - 1), { min: 0, max: 3 }))
	})

/**
 * The ranges a node lays out from `start`, outer first as V8 lists a function's: each child after its lead gap, the
 * node's own length after the last, and, when `same`, one more range over exactly the node's span after its children.
 */
export const laidOut = (
	node: Node,
	start: number
): Readonly<{ ranges: ReadonlyArray<Ranged>; end: number }> => {
	const inner: Array<Ranged> = []
	let at = start
	for (const child of node.children) {
		const placed = laidOut(child, at + child.lead)
		for (const range of placed.ranges) {
			inner.push(range)
		}
		at = placed.end
	}
	const end = at + node.length
	const own = { startOffset: start, endOffset: end, count: node.count }
	const twin = node.same
		? [{ startOffset: start, endOffset: end, count: (node.count + 1) % 2 }]
		: []
	return { ranges: [own, ...inner, ...twin], end }
}

/** Whether a place ran, by hand: the shortest range around it, the last listed among equals, has a count above zero. */
export const ranByHand = (ranges: ReadonlyArray<Ranged>, place: number): boolean => {
	let best: Ranged | undefined
	for (const range of ranges) {
		if (range.startOffset <= place && place < range.endOffset) {
			if (
				best === undefined ||
				range.endOffset - range.startOffset <= best.endOffset - best.startOffset
			) {
				best = range
			}
		}
	}
	return best !== undefined && best.count > 0
}

/** Whether a place lies in one of the spans. */
export const inSpans = (spans: ReadonlyArray<Span>, place: number) =>
	Arr.some(spans, (span) => span.start <= place && place < span.end)

/** Whether spans are disjoint, in order, and maximal: each ends before the next begins, with a gap between. */
export const wellFormed = (spans: ReadonlyArray<Span>) =>
	Arr.every(spans, (span, index) => {
		const next = spans[index + 1]
		return span.start < span.end && (next === undefined || span.end < next.start)
	})

/** The functions of the real module, each returning a number of its own. */
export const FUNCTIONS = 4

/** A TypeScript module of FUNCTIONS typed functions after a top-level marker. */
export const moduleText = Arr.join(
	[
		"export const marker: number = 7",
		...Array.from(
			{ length: FUNCTIONS },
			(_, i) =>
				`export const f${String(i)} = (x: number): number => {\n\treturn x * ${String(i + 2)}\n}`
		)
	],
	"\n"
)

/** A main that imports the module and calls `called` of its functions. */
export const mainText = (called: ReadonlyArray<boolean>) =>
	`import * as m from "./target.ts"\nconsole.log(m.marker${Arr.join(
		Arr.flatMap(called, (call, i) => (call ? [` + m.f${String(i)}(1)`] : [])),
		""
	)})\n`
