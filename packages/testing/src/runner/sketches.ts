import { Array as Arr, Effect, Option } from "effect"
import { type Branch, enumerated, nextBranch } from "#enumerate.ts"
import type { Gen } from "#gen.ts"
import {
	type CaseOrder,
	type CaseResult,
	type ChooserSpec,
	type Printed,
	type SketchesOrder,
	type SketchesRan,
	stops
} from "#runner/protocol.ts"
import { recorder } from "#source.ts"

/**
 * An exhaustion's window run on the process its run of sketches was sent to (protocol.ts SketchesOrder): the process
 * enumerates the run's sketches over the property's space from the branch it was given, runs their cases in rounds as
 * the parent's window did, and gives back one summary in enumeration order, so the exhaustion's cases cross no process
 * boundary one by one and the first failing case in enumeration order is the same whoever ran which run.
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
 * The order of a run's case at `branch`: unsteered, its tape kept (the sketch's next case is read from it), its notes
 * perceived, under the run's deadline and open bound.
 */
const orderAt = (run: SketchesOrder, branch: Branch): CaseOrder => ({
	property: run.property,
	chooser: branchChooser(branch),
	drawn: { kind: "unsteered" },
	keep: "tape",
	sense: { kind: "notes" },
	deadline: run.deadline,
	open: run.open,
	print: "failing"
})

/** A run's sketches: `count` of them from its start, in enumeration order over `space`, fewer when the space ends. */
const sketchesOf = (space: Gen<unknown>, run: SketchesOrder): ReadonlyArray<Sketch> => {
	const recorded = recorder()
	const sketches: Array<Sketch> = []
	let next: Option.Option<Branch> = Option.some({ values: run.start, length: run.length })
	while (Option.isSome(next) && sketches.length < run.count) {
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

/**
 * Runs a run of sketches here: in rounds, each the next case of every sketch still going, its case's tape giving the
 * sketch's next case (the next branch its property's draws enumerate); a sketch ends at its last case or its first that
 * does not pass, and once a sketch has stopped no later sketch runs further, since its cases come after in enumeration
 * order. A passing case its property used after it ended (`lateOf`, by its order) is misused, which stops its sketch.
 * The summary reads the sketches in order through the first that stopped.
 */
export const sketchesRun = <R>(
	space: Gen<unknown>,
	evaluate: (
		batch: Arr.NonEmptyReadonlyArray<CaseOrder>
	) => Effect.Effect<ReadonlyArray<CaseResult>, never, R>,
	lateOf: (order: CaseOrder) => Option.Option<Printed>,
	run: SketchesOrder
): Effect.Effect<SketchesRan, never, R> =>
	Effect.gen(function* () {
		const sketches = sketchesOf(space, run)
		const passed: Array<Array<CaseResult>> = Arr.map(sketches, () => [])
		const stopped: Array<Option.Option<CaseResult>> = Arr.map(sketches, () => Option.none())
		let evaluated = 0
		let millis = 0
		let cpu = 0
		let frontier: ReadonlyArray<readonly [number, Branch]> = Arr.map(
			sketches,
			(sketch, at) => [at, sketch.start] as const
		)
		while (Arr.isReadonlyArrayNonEmpty(frontier)) {
			const orders = Arr.map(frontier, ([, branch]) => orderAt(run, branch))
			const evaluatedRound = yield* roundOf(orders, run.group, evaluate)
			const results = Arr.map(evaluatedRound, (result, at): CaseResult =>
				Option.match(Option.flatMap(Arr.get(orders, at), lateOf), {
					onNone: () => result,
					onSome: (printed) =>
						result.outcome.kind === "passed"
							? { ...result, outcome: { kind: "misused", printed } }
							: result
				})
			)
			const next: Array<readonly [number, Branch]> = []
			for (const [[at], result] of Arr.zip(frontier, results)) {
				evaluated += 1
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
		const notes = new Set<string>()
		const measures = new Map<string, number>()
		let passing = 0
		let first: SketchesRan["stopped"] = { kind: "none" }
		for (const [at, cases] of passed.entries()) {
			for (const result of cases) {
				passing += 1
				for (const note of result.notes) {
					notes.add(note)
				}
				for (const [name, amount] of result.measures) {
					measures.set(name, (measures.get(name) ?? 0) + amount)
				}
			}
			const stop = stopped[at] ?? Option.none()
			if (Option.isSome(stop)) {
				first = { kind: "stopped", result: stop.value }
				break
			}
		}
		return {
			ran: evaluated,
			passed: passing,
			notes: Arr.fromIterable(notes),
			measures: Arr.fromIterable(measures.entries()),
			millis,
			cpu,
			stopped: first
		}
	})
