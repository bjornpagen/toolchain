import { Array as Arr, Effect, Option } from "effect"
import { type Branch, enumerated, nextBranch } from "#enumerate.ts"
import type { Gen } from "#gen.ts"
import {
	type CaseOrder,
	type CaseResult,
	type ChooserSpec,
	judgedLate,
	type Noted,
	type Printed,
	type SeriesFrom,
	type SeriesOrder,
	type SeriesRan,
	stops
} from "#runner/protocol.ts"
import { recorder } from "#source.ts"

/**
 * A series run on the process it was sent to (protocol.ts SeriesOrder): the process draws the series' cases itself, an
 * exhaustion's sketches enumerated over the property's space from the branch it was given or an exploration's stream
 * from its case seeds, runs them in rounds as the parent's window did, and gives back one summary in order, so the
 * search's cases cross no process boundary one by one and the first failing case in order is the same whoever ran which
 * series.
 */

/** One sketch of a run: its branch, and how many decisions the space itself made in its first case. */
type Sketch = Readonly<{ start: Branch; decisions: number }>

/** The chooser of an enumeration's branch: its fixed decisions, every later one at its simplest. */
const branchChooser = (branch: Branch): ChooserSpec => ({
	kind: "prefix",
	values: branch.values.slice(0, branch.length),
	rest: { kind: "simplest" }
})

/**
 * The order of a series' case drawn by `chooser`: unsteered, its tape kept as `keep` says, its notes perceived, under the
 * series' deadline and open bound.
 */
const orderOf = (
	series: SeriesOrder,
	chooser: ChooserSpec,
	keep: CaseOrder["keep"]
): CaseOrder => ({
	property: series.property,
	chooser,
	drawn: { kind: "unsteered" },
	keep,
	sense: { kind: "notes" },
	deadline: series.deadline,
	open: series.open,
	print: "failing"
})

/** The sketches a series names: `count` from its start, in enumeration order over `space`, fewer when the space ends. */
const sketchesOf = (
	space: Gen<unknown>,
	from: Extract<SeriesFrom, { kind: "sketches" }>
): ReadonlyArray<Sketch> => {
	const recorded = recorder()
	const sketches: Array<Sketch> = []
	let next: Option.Option<Branch> = Option.some({ values: from.start, length: from.length })
	while (Option.isSome(next) && sketches.length < from.count) {
		const step = enumerated(recorded, space, next.value)
		sketches.push({ start: next.value, decisions: step.generated.tape.length })
		next = step.next
	}
	return sketches
}

/**
 * A round's results: its orders evaluated `group` to an evaluation, in order, and none after the first evaluation that
 * holds a case that did not pass.
 */
const roundOf = <R>(
	orders: ReadonlyArray<CaseOrder>,
	group: number,
	evaluate: (
		batch: Arr.NonEmptyReadonlyArray<CaseOrder>
	) => Effect.Effect<ReadonlyArray<CaseResult>, never, R>
): Effect.Effect<ReadonlyArray<CaseResult>, never, R> =>
	Effect.gen(function* () {
		const results: Array<CaseResult> = []
		for (const batch of Arr.chunksOf(orders, Math.max(1, group))) {
			if (!Arr.isReadonlyArrayNonEmpty(batch)) {
				continue
			}
			const evaluated = yield* evaluate(batch)
			for (const result of evaluated) {
				results.push(result)
			}
			if (Arr.some(evaluated, stops)) {
				break
			}
		}
		return results
	})

/** A case as its series reads it: its result, a passing case its property used after it ended being misused. */
const judgedOf =
	(lateOf: (order: CaseOrder) => Option.Option<Printed>) =>
	(order: CaseOrder, result: CaseResult): CaseResult =>
		judgedLate(result, lateOf(order))

/** What the process spent on a series: how many cases it ran, and their milliseconds and CPU. */
type Spent = Readonly<{ ran: number; millis: number; cpu: number }>

/**
 * A series' summary from its cases in order through the first that stopped: those that passed, each noted situation
 * with how many noted it and the first of them that did, what they measured, and the case that stopped, if one did.
 */
const summaryOf = (
	passed: ReadonlyArray<CaseResult>,
	stopped: Option.Option<CaseResult>,
	spent: Spent
): SeriesRan => {
	const notes = new Map<string, Noted>()
	const measures = new Map<string, number>()
	for (const [place, result] of passed.entries()) {
		for (const key of new Set(result.notes)) {
			const before = notes.get(key)
			notes.set(key, before === undefined ? [key, 1, place] : [key, before[1] + 1, before[2]])
		}
		for (const [name, amount] of result.measures) {
			measures.set(name, (measures.get(name) ?? 0) + amount)
		}
	}
	return {
		ran: spent.ran,
		passed: passed.length,
		notes: Arr.fromIterable(notes.values()),
		measures: Arr.fromIterable(measures.entries()),
		millis: spent.millis,
		cpu: spent.cpu,
		stopped: Option.match(stopped, {
			onNone: () => ({ kind: "none" }) as const,
			onSome: (result) => ({ kind: "stopped", result }) as const
		})
	}
}

/**
 * Runs an exhaustion's sketches here: in rounds, each the next case of every sketch still going, its case's tape giving
 * the sketch's next case (the next branch its property's draws enumerate); a sketch ends at its last case or its first
 * that does not pass, and once a sketch has stopped no later sketch runs further, since its cases come after in
 * enumeration order. The summary reads the sketches in order through the first that stopped.
 */
const sketchesRun = <R>(
	space: Gen<unknown>,
	evaluate: (
		batch: Arr.NonEmptyReadonlyArray<CaseOrder>
	) => Effect.Effect<ReadonlyArray<CaseResult>, never, R>,
	judged: (order: CaseOrder, result: CaseResult) => CaseResult,
	series: SeriesOrder,
	from: Extract<SeriesFrom, { kind: "sketches" }>
): Effect.Effect<SeriesRan, never, R> =>
	Effect.gen(function* () {
		const sketches = sketchesOf(space, from)
		const passed: Array<Array<CaseResult>> = Arr.map(sketches, () => [])
		const stopped: Array<Option.Option<CaseResult>> = Arr.map(sketches, () => Option.none())
		let ran = 0
		let millis = 0
		let cpu = 0
		let frontier: ReadonlyArray<readonly [number, Branch]> = Arr.map(
			sketches,
			(sketch, at) => [at, sketch.start] as const
		)
		while (Arr.isReadonlyArrayNonEmpty(frontier)) {
			const orders = Arr.map(frontier, ([, branch]) =>
				orderOf(series, branchChooser(branch), "tape")
			)
			const evaluatedRound = yield* roundOf(orders, series.group, evaluate)
			const results = Arr.map(evaluatedRound, (result, at): CaseResult =>
				Option.match(Arr.get(orders, at), {
					onNone: () => result,
					onSome: (order) => judged(order, result)
				})
			)
			const next: Array<readonly [number, Branch]> = []
			for (const [[at], result] of Arr.zip(frontier, results)) {
				ran += 1
				millis += result.millis
				cpu += result.cpu
				const outcome = result.outcome
				if (outcome.kind !== "passed") {
					stopped[at] = Option.some(result)
					continue
				}
				passed[at]?.push(result)
				const decisions = Option.map(Arr.get(sketches, at), (sketch) => sketch.decisions)
				const after =
					outcome.kept.kind === "tape"
						? Option.filter(nextBranch(outcome.kept.tape), (branch) =>
								Option.exists(decisions, (drawn) => branch.length > drawn)
							)
						: Option.none()
				if (Option.isSome(after)) {
					next.push([at, after.value])
				}
			}
			const firstStop = Arr.findFirstIndex(stopped, Option.isSome)
			frontier = Option.match(firstStop, {
				onNone: () => next,
				onSome: (stop) => Arr.filter(next, ([at]) => at < stop)
			})
		}
		const ordered: Array<CaseResult> = []
		let first: Option.Option<CaseResult> = Option.none()
		for (const [at, cases] of passed.entries()) {
			for (const result of cases) {
				ordered.push(result)
			}
			const stop = stopped[at] ?? Option.none()
			if (Option.isSome(stop)) {
				first = stop
				break
			}
		}
		return summaryOf(ordered, first, { ran, millis, cpu })
	})

/**
 * Runs a stream's cases here, one a seed in order, each drawn unsteered from its case seed with its tape kept only when
 * it fails: in rounds of `group` to an evaluation, through the first evaluation that holds a case that did not pass.
 */
const streamRun = <R>(
	evaluate: (
		batch: Arr.NonEmptyReadonlyArray<CaseOrder>
	) => Effect.Effect<ReadonlyArray<CaseResult>, never, R>,
	judged: (order: CaseOrder, result: CaseResult) => CaseResult,
	series: SeriesOrder,
	from: Extract<SeriesFrom, { kind: "stream" }>
): Effect.Effect<SeriesRan, never, R> =>
	Effect.gen(function* () {
		const orders = Arr.map(Arr.fromIterable(from.seeds), (seed) =>
			orderOf(series, { kind: "random", seed, skip: 0 }, "nothing")
		)
		const evaluated = yield* roundOf(orders, series.group, evaluate)
		const results = Arr.map(evaluated, (result, at): CaseResult =>
			Option.match(Arr.get(orders, at), {
				onNone: () => result,
				onSome: (order) => judged(order, result)
			})
		)
		const stop = Arr.findFirstIndex(results, (result) => result.outcome.kind !== "passed")
		return summaryOf(
			Option.match(stop, { onNone: () => results, onSome: (at) => Arr.take(results, at) }),
			Option.flatMap(stop, (at) => Arr.get(results, at)),
			{
				ran: results.length,
				millis: Arr.reduce(results, 0, (total, result) => total + result.millis),
				cpu: Arr.reduce(results, 0, (total, result) => total + result.cpu)
			}
		)
	})

/**
 * Runs a series here, as its source says: an exhaustion's sketches over `space`, or a stream's cases. A passing case its
 * property used after it ended (`lateOf`, by its order) is misused, which stops its series.
 */
export const seriesRun = <R>(
	space: Gen<unknown>,
	evaluate: (
		batch: Arr.NonEmptyReadonlyArray<CaseOrder>
	) => Effect.Effect<ReadonlyArray<CaseResult>, never, R>,
	lateOf: (order: CaseOrder) => Option.Option<Printed>,
	series: SeriesOrder
): Effect.Effect<SeriesRan, never, R> => {
	const from = series.from
	switch (from.kind) {
		case "sketches":
			return sketchesRun(space, evaluate, judgedOf(lateOf), series, from)
		case "stream":
			return streamRun(evaluate, judgedOf(lateOf), series, from)
	}
}
