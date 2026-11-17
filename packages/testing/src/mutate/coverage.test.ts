/**
 * The coverage map (mutate/coverage.ts): the spans that ran of a script are exactly the places whose innermost
 * enclosing range, as V8 nests a script's ranges, has a count above zero, disjoint, in order and maximal, and the map
 * names a property at exactly those places; and on a real process under NODE_V8_COVERAGE, a TypeScript module's places
 * map to the properties that ran them: the body of each function the process called, and the module's top level, and
 * never the body of one it did not call; and a process a coverage pass started that ended before it wrote its dump is
 * coverage lost, never less coverage, while a process a check starts and ends is no loss.
 */
import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	Path,
	Schema,
	Stream,
	String as Str
} from "effect"
import { ChildProcess } from "effect/process"
import { deepStrictEqual } from "#assert.ts"
import { array, boolean, finite } from "#gen.ts"
import {
	childText,
	FUNCTIONS,
	inSpans,
	laidOut,
	lostGen,
	lostMainText,
	mainText,
	moduleText,
	nodeGen,
	ranByHand,
	wellFormed
} from "#mutate/coverage.fixtures.ts"
import { CoverageLost, coverageMapOf, ranIn, ranOf } from "#mutate/coverage.ts"
import { startedMark } from "#mutate/image.ts"
import { realPathOf } from "#mutate/mutated.ts"
import { property } from "#property.ts"

export const ranSpans = property.explore(
	(source) => source.draw(array(nodeGen(2), { min: 0, max: 3 })),
	{
		needs: {},
		situations: [
			"nested ranges",
			"a range over its parent's span",
			"a run inside one that did not"
		],
		check: (_resources, c) => (roots) =>
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
				const map = coverageMapOf([{ property: "the script", files: new Map([[file, spans]]) }])
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
			}),
		oracle: {
			kind: "second-implementation",
			name: "each place's innermost range found by hand among every range of the script"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/mutate/coverage.ts",
				original: "span === undefined || span.end <= place",
				replacement: "span === undefined || span.end < place",
				why: "The map's binary search stops on a span ending at the place, so a place just past a span that ran is covered."
			},
			{
				file: "packages/testing/src/mutate/coverage.ts",
				original: "Order.mapInput(Order.flip(Order.Number), (range: Ranged) => range.endOffset)",
				replacement: "Order.mapInput(Order.Number, (range: Ranged) => range.endOffset)",
				why: "Ranges sharing a start are taken shortest first, so an outer range paints over the inner one it holds."
			},
			{
				file: "packages/testing/src/mutate/coverage.ts",
				original: "\t\tif (last?.end === start) {",
				replacement: "\t\tif (last?.end === start && false) {",
				why: "Adjacent spans that ran are never merged, so the spans are not maximal."
			}
		]
	}
)

export const realProcessCoverage = property.exhaust(
	finite((source) => source.draw(array(boolean, { min: FUNCTIONS, max: FUNCTIONS }))),
	{
		box: "every subset of four functions called",
		needs: {},
		situations: [],
		check: () => (called) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const made = yield* fs.makeTempDirectoryScoped({ prefix: "toolchain-coverage-test-" })
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
			}),
		oracle: {
			kind: "specification",
			name: "the top level and each called function's body ran, no uncalled function's body did"
		},
		kept: [],
		kills: []
	}
)

export const lostCoverage = property.exhaust(finite(lostGen), {
	box: "every way the pass's process and a child of it end",
	needs: {},
	situations: [],
	check: () => (lost) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const made = yield* fs.makeTempDirectoryScoped({ prefix: "toolchain-coverage-test-" })
			const directory = yield* realPathOf(made)
			yield* fs.writeFileString(path.join(directory, "package.json"), `{"type":"module"}`)
			yield* fs.writeFileString(path.join(directory, "main.ts"), lostMainText(lost))
			yield* fs.writeFileString(path.join(directory, "child.ts"), childText)
			const dumps = path.join(directory, "dumps")
			const handle = yield* ChildProcess.make(
				process.execPath,
				[...startedMark(process.pid), "main.ts"],
				{ cwd: directory, env: { NODE_V8_COVERAGE: dumps }, extendEnv: true, stdin: "ignore" }
			)
			yield* handle.stdout.pipe(
				Stream.decodeText(),
				Stream.takeUntil((text) => Str.includes("ready")(text)),
				Stream.runDrain
			)
			if (lost.main === "killed") {
				yield* handle.kill({ killSignal: "SIGKILL" })
			}
			yield* Effect.exit(handle.exitCode)
			const read = yield* Effect.result(ranIn("the process", dumps, []))
			deepStrictEqual(
				read._tag === "Failure" && Schema.is(CoverageLost)(read.failure)
					? Option.some(Arr.copy(read.failure.processes))
					: Option.none(),
				lost.main === "killed" ? Option.some([String(handle.pid)]) : Option.none()
			)
		}),
	oracle: {
		kind: "specification",
		name: "lost exactly when the pass's own process was killed, naming it; a child's ending never counts"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/mutate/coverage.ts",
			original: "\tif (Arr.isReadonlyArrayNonEmpty(lost)) {",
			replacement: "\tif (Arr.isReadonlyArrayNonEmpty([])) {",
			why: "A process that started and wrote no dump is read as having run nothing, so a worker killed before it exits leaves its property covering less, silently."
		},
		{
			file: "packages/testing/src/mutate/image.ts",
			original: "if (process.ppid === ",
			replacement: "if (true || process.ppid === ",
			why: "Every process under the pass's coverage marks itself, a check's child among them, so a child the check kills refuses the run."
		}
	]
})
