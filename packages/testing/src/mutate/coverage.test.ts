/**
 * The coverage map (mutate/coverage.ts): the spans that ran of a script are exactly the places whose innermost
 * enclosing range, as V8 nests a script's ranges, has a count above zero, disjoint, in order and maximal, and the map
 * names a property at exactly those places; and on a real
 * process under NODE_V8_COVERAGE, a TypeScript module's places map to the properties that ran them: the body of each
 * function the process called, and the module's top level, and never the body of one it did not call. Oracles: a
 * second implementation (each place's innermost range found by hand), and the specification of what ran.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { layer } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import {
	Array as Arr,
	Duration,
	Effect,
	FileSystem,
	Formatter,
	Option,
	Path,
	Stream,
	String as Str
} from "effect"
import { ChildProcess } from "effect/process"
import { drawn, exhaust, explore } from "#explore.ts"
import { noCoverage, required } from "#features.ts"
import { array, boolean, type Gen, int } from "#gen.ts"
import type { Span } from "#mutants.ts"
import { coverageMapOf, ranIn, ranOf } from "#mutate/coverage.ts"
import { realPathOf } from "#mutate/mutated.ts"
import { notesOnly } from "#sense.ts"
import { boundedShrink } from "#shrink.ts"
import { searched } from "#vitest/searched.ts"

/** A range as V8 reports one: half-open, with the times it ran. */
type Ranged = Readonly<{ startOffset: number; endOffset: number; count: number }>

/** A range and the ranges it holds, laid out by gaps and lengths, as a function holds its blocks. */
type Node = Readonly<{
	lead: number
	length: number
	count: number
	same: boolean
	children: ReadonlyArray<Node>
}>

const nodeGen =
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
const laidOut = (
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
const ranByHand = (ranges: ReadonlyArray<Ranged>, place: number): boolean => {
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

const inSpans = (spans: ReadonlyArray<Span>, place: number) =>
	Arr.some(spans, (span) => span.start <= place && place < span.end)

/** Whether spans are disjoint, in order, and maximal: each ends before the next begins, with a gap between. */
const wellFormed = (spans: ReadonlyArray<Span>) =>
	Arr.every(spans, (span, index) => {
		const next = spans[index + 1]
		return span.start < span.end && (next === undefined || span.end < next.start)
	})

/** The functions of the real module, each returning a number of its own. */
const FUNCTIONS = 4

/** A TypeScript module of FUNCTIONS typed functions after a top-level marker, and a main that calls `called` of them. */
const moduleText = Arr.join(
	[
		"export const marker: number = 7",
		...Arr.makeBy(
			FUNCTIONS,
			(i) =>
				`export const f${String(i)} = (x: number): number => {\n\treturn x * ${String(i + 2)}\n}`
		)
	],
	"\n"
)

const mainText = (called: ReadonlyArray<boolean>) =>
	`import * as m from "./target.ts"\nconsole.log(m.marker${Arr.join(
		Arr.flatMap(called, (call, i) => (call ? [` + m.f${String(i)}(1)`] : [])),
		""
	)})\n`

layer(NodeServices.layer, { excludeTestServices: true })("the coverage map", (it) => {
	it.effect(
		"finds a place ran exactly when the innermost range V8 reports around it ran, as disjoint spans in order",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "coverage spans",
						oracle: {
							kind: "second-implementation",
							name: "each place's innermost range found by hand among every range of the script"
						},
						draw: drawn((source) => source.draw(array(nodeGen(2), { min: 0, max: 3 }))),
						literal: Formatter.format,
						coverage: required<
							"nested ranges" | "a range over its parent's span" | "a run inside one that did not"
						>(
							["nested ranges", "a range over its parent's span", "a run inside one that did not"],
							{ cases: 200, sense: notesOnly }
						),
						kept: [],
						runs: 200,
						shrink: boundedShrink(200),
						steerEvery: 16,
						caseHang: Duration.seconds(30)
					},
					(roots, c) =>
						Effect.gen(function* () {
							const file = yield* realPathOf(".")
							const [end, ranges] = Arr.mapAccum(roots, 0, (at, root) => {
								const placed = laidOut(root, at + root.lead)
								return [placed.end, placed.ranges] as const
							})
							const all = Arr.flatten(ranges)
							if (Arr.some(roots, (root) => root.children.length > 0)) {
								c.note("nested ranges")
							}
							if (Arr.some(roots, (root) => root.same)) {
								c.note("a range over its parent's span")
							}
							if (
								Arr.some(all, (outer) =>
									Arr.some(
										all,
										(inner) =>
											outer.count === 0 &&
											inner.count > 0 &&
											outer.startOffset < inner.startOffset &&
											inner.endOffset < outer.endOffset
									)
								)
							) {
								c.note("a run inside one that did not")
							}
							const spans = ranOf(all)
							const map = coverageMapOf([
								{ property: "the script", files: new Map([[file, spans]]) }
							])
							const places = Array.from({ length: end + 2 }, (_, place) => place)
							const byHand = Arr.filter(places, (place) => ranByHand(all, place))
							deepStrictEqual(
								{
									ran: Arr.filter(places, (place) => inSpans(spans, place)),
									covered: Arr.filter(places, (place) => map.covering(file, place).length > 0),
									wellFormed: wellFormed(spans)
								},
								{ ran: byHand, covered: byHand, wellFormed: true }
							)
						})
				)
			)
	)

	it.effect(
		"maps a TypeScript module's places to the property whose process ran them, from Node's own coverage dumps",
		(ctx) =>
			searched(
				ctx,
				exhaust(
					{
						suite: "coverage of a real process",
						oracle: {
							kind: "specification",
							name: "the top level and each called function's body ran, no uncalled function's body did"
						},
						box: "every subset of four functions called",
						generator: (source) => source.draw(array(boolean, { min: FUNCTIONS, max: FUNCTIONS })),
						literal: Formatter.format,
						coverage: noCoverage,
						caseHang: Duration.minutes(1)
					},
					(called) =>
						Effect.scoped(
							Effect.gen(function* () {
								const fs = yield* FileSystem.FileSystem
								const path = yield* Path.Path
								const made = yield* fs.makeTempDirectoryScoped({
									prefix: "toolchain-coverage-test-"
								})
								const directory = yield* realPathOf(made)
								yield* fs.writeFileString(path.join(directory, "package.json"), `{"type":"module"}`)
								yield* fs.writeFileString(path.join(directory, "target.ts"), moduleText)
								yield* fs.writeFileString(path.join(directory, "main.ts"), mainText(called))
								const dumps = path.join(directory, "dumps")
								const handle = yield* ChildProcess.make(process.execPath, ["main.ts"], {
									cwd: directory,
									env: { NODE_V8_COVERAGE: dumps },
									extendEnv: true,
									stdin: "ignore"
								})
								yield* Stream.runDrain(handle.stdout)
								yield* handle.exitCode
								const target = yield* realPathOf(path.join(directory, "target.ts"))
								const ran = yield* ranIn("the process", dumps, [target])
								const map = coverageMapOf([ran])
								const ranAt = (text: string) =>
									Option.map(Str.indexOf(text)(moduleText), (place) =>
										Arr.copy(map.covering(target, place))
									)
								deepStrictEqual(
									{
										touching: Arr.copy(map.touching(target)),
										topLevel: ranAt("marker"),
										bodies: Array.from({ length: FUNCTIONS }, (_, i) =>
											Option.map(ranAt(`return x * ${String(i + 2)}`), Arr.isArrayNonEmpty)
										)
									},
									{
										touching: ["the process"],
										topLevel: Option.some(["the process"]),
										bodies: Arr.map(called, Option.some)
									}
								)
							})
						)
				)
			)
	)
})
