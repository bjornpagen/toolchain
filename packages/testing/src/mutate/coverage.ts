import { fileURLToPath } from "node:url"
import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	Order,
	Path,
	Schema,
	String as Str
} from "effect"
import type { Span } from "#mutants.ts"
import type { RealPath } from "#mutate/mutated.ts"

/**
 * Which properties run a mutant's code, from a coverage pass: each property's witnesses run once, unmutated, on a
 * worker of its own (images.covered), with NODE_V8_COVERAGE naming a directory of the property's, so every process the
 * property ran, its worker and each child a check started, writes its block coverage there as it exits. A property
 * covers a place of a file when the innermost range one of its dumps reports around the place ran: a mutant there is
 * run against it, and a mutant no property covers is uncovered. A worker of its own per property is what makes a
 * module's top level, which runs once per process, count for each property that loads the module.
 */

const Range = Schema.Struct({
	startOffset: Schema.Finite,
	endOffset: Schema.Finite,
	count: Schema.Finite
})

/** A coverage dump as Node writes one under NODE_V8_COVERAGE: every script the process loaded, by its URL. */
const Dump = Schema.fromJsonString(
	Schema.Struct({
		result: Schema.Array(
			Schema.Struct({
				url: Schema.String,
				functions: Schema.Array(Schema.Struct({ ranges: Schema.Array(Range) }))
			})
		)
	})
)

/** A dump that is no coverage dump: the pass's worker wrote it, so the pass fails rather than read less. */
export class DumpUnread extends Schema.TaggedError<DumpUnread, { readonly brand: unique symbol }>()(
	"DumpUnread",
	{ file: Schema.String, message: Schema.String }
) {}

/** A range of a script as V8 reports it: half-open, and its count the times it ran. */
type Ranged = typeof Range.Type

/** Ranges ordered so that each comes before every range it holds: by start, then the longer first. */
const OUTER_FIRST: Order.Order<Ranged> = Order.combine(
	Order.mapInput(Order.Number, (range: Ranged) => range.startOffset),
	Order.mapInput(Order.flip(Order.Number), (range: Ranged) => range.endOffset)
)

/**
 * The spans of a script that ran, from its ranges, which V8 nests (a function's range holds its blocks' and its inner
 * functions'): a place ran when the innermost range around it has a count above zero, and a place no range holds did
 * not run. Disjoint, in order, each span maximal.
 */
export const ranOf = (ranges: ReadonlyArray<Ranged>): ReadonlyArray<Span> => {
	const ran: Array<Span> = []
	const paint = (start: number, end: number, count: number) => {
		const last = ran.at(-1)
		if (start >= end || count <= 0) {
			return
		}
		if (last?.end === start) {
			ran[ran.length - 1] = { start: last.start, end }
			return
		}
		ran.push({ start, end })
	}
	const open: Array<Ranged> = []
	let at = 0
	const closeTo = (until: number) => {
		for (let top = open.at(-1); top !== undefined && top.endOffset <= until; top = open.at(-1)) {
			paint(at, top.endOffset, top.count)
			at = Math.max(at, top.endOffset)
			open.pop()
		}
	}
	for (const range of Arr.sort(ranges, OUTER_FIRST)) {
		closeTo(range.startOffset)
		paint(at, range.startOffset, open.at(-1)?.count ?? 0)
		at = Math.max(at, range.startOffset)
		open.push(range)
	}
	closeTo(Number.POSITIVE_INFINITY)
	return ran
}

/** Two lists of disjoint spans in order, as one: their union, disjoint, in order, each span maximal. */
const union = (left: ReadonlyArray<Span>, right: ReadonlyArray<Span>): ReadonlyArray<Span> =>
	Arr.reduce(
		Arr.sort(
			[...left, ...right],
			Order.mapInput(Order.Number, (span: Span) => span.start)
		),
		Arr.empty<Span>(),
		(merged, span) => {
			const last = Arr.last(merged)
			return Option.isSome(last) && last.value.end >= span.start
				? Arr.append(Arr.dropRight(merged, 1), {
						start: last.value.start,
						end: Math.max(last.value.end, span.end)
					})
				: Arr.append(merged, span)
		}
	)

/** Whether a place lies in one of a list of disjoint spans in order. */
const holds = (spans: ReadonlyArray<Span>, place: number): boolean => {
	let low = 0
	let high = spans.length
	while (low < high) {
		const middle = (low + high) >>> 1
		const span = spans[middle]
		if (span === undefined || span.end <= place) {
			low = middle + 1
		} else {
			high = middle
		}
	}
	const found = spans[low]
	return found !== undefined && found.start <= place
}

/** What one property ran of the files a mutation run mutates: each file's spans that ran in any of its processes. */
export type Ran<P> = Readonly<{ property: P; files: ReadonlyMap<RealPath, ReadonlyArray<Span>> }>

/** The file a coverage dump's script URL names, when it is a file of the run. */
const fileOf = (files: ReadonlyMap<string, RealPath>, url: string): Option.Option<RealPath> =>
	Str.startsWith("file://")(url)
		? Option.fromUndefinedOr(files.get(fileURLToPath(url)))
		: Option.none()

/**
 * What `property` ran of `files`, from the text of each dump its processes wrote: a file's spans are the union of what
 * ran in each process.
 */
const ranFrom = <P>(
	property: P,
	dumps: ReadonlyArray<Readonly<{ name: string; text: string }>>,
	files: ReadonlyArray<RealPath>
): Effect.Effect<Ran<P>, DumpUnread> =>
	Effect.gen(function* () {
		const named: ReadonlyMap<string, RealPath> = new Map(Arr.map(files, (file) => [file, file]))
		const ran = new Map<RealPath, ReadonlyArray<Span>>()
		for (const dump of dumps) {
			const decoded = yield* Schema.decodeEffect(Dump)(dump.text).pipe(
				Effect.mapError((issue) => DumpUnread.make({ file: dump.name, message: String(issue) }))
			)
			for (const script of decoded.result) {
				const file = fileOf(named, script.url)
				if (Option.isSome(file)) {
					const spans = ranOf(Arr.flatMap(script.functions, (fn) => fn.ranges))
					ran.set(file.value, union(ran.get(file.value) ?? [], spans))
				}
			}
		}
		const found: Ran<P> = { property, files: ran }
		return found
	})

/** Whether a name is one Node gives a coverage dump: `coverage-<pid>-<timestamp>-<sequence>.json`. */
const isDump = (name: string) => Str.startsWith("coverage-")(name) && Str.endsWith(".json")(name)

/** What `property` ran of `files`, from the dumps in `directory`, its coverage pass's. */
export const ranIn = Effect.fn("testing.mutate.ranIn")(function* <P>(
	property: P,
	directory: string,
	files: ReadonlyArray<RealPath>
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const names = yield* fs.readDirectory(directory)
	const dumps = yield* Effect.forEach(Arr.filter(names, isDump), (name) =>
		Effect.map(fs.readFileString(path.join(directory, name)), (text) => ({ name, text }))
	)
	return yield* ranFrom(property, dumps, files)
})

/**
 * The coverage map: the properties that ran each place of the mutated files. `covering` names those that ran a
 * place, in the order the pass listed them; `touching` those that ran anything of a file, which a file's probe runs
 * against.
 */
export type CoverageMap<P> = Readonly<{
	covering: (file: RealPath, place: number) => ReadonlyArray<P>
	touching: (file: RealPath) => ReadonlyArray<P>
}>

/** The coverage map of what each property ran. */
export const coverageMapOf = <P>(ran: ReadonlyArray<Ran<P>>): CoverageMap<P> => ({
	covering: (file, place) =>
		Arr.flatMap(ran, ({ property, files }) =>
			holds(files.get(file) ?? [], place) ? [property] : []
		),
	touching: (file) =>
		Arr.flatMap(ran, ({ property, files }) =>
			Arr.isReadonlyArrayNonEmpty(files.get(file) ?? []) ? [property] : []
		)
})
