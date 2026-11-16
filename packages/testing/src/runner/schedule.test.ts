/**
 * The pool's scheduling (runner/schedule.ts), held to what it promises over drawn workloads run on a simulated pool in
 * virtual time (schedule.fixtures.ts), the pool's own loop over the scheduler:
 *
 * - Every case of every window runs exactly once, and every search ends, at any width: a worker that holds a module,
 *   waits, takes or steals never loses, repeats or starves a unit.
 * - A module whose whole work is no more than readying it takes is readied by one worker, at any width: a further
 *   worker would spend more readying it than it could take off the holder.
 * - A module whose queued work outgrows its holder (cases at least as long as readying it, four or more a worker) is
 *   readied by more than one worker: the spread is measured, never refused.
 * - The pool is as wide as its work: a run of one module whose work is no more than its readying forks one worker, at
 *   any width, where a pool forked whole up front starts every worker it may have.
 *
 * Oracles are stated per property.
 */
import { Array as Arr, Effect, Order } from "effect"
import { deepStrictEqual, strictEqual } from "#assert.ts"
import { element } from "#gen.ts"
import { property } from "#property.ts"
import { cheap, FORKINGS, outgrowing, simulate, workloads } from "#runner/schedule.fixtures.ts"

export const everyCaseOnce = property.explore(
	(source) => ({ workload: source.draw(workloads), forking: source.draw(element(FORKINGS)) }),
	{
		needs: {},
		situations: [
			"one worker",
			"more workers than modules",
			"more modules than workers",
			"lazily",
			"whole"
		],
		check:
			(_resources, c) =>
			({ workload, forking }) =>
				Effect.sync(() => {
					c.note(forking)
					if (workload.workers === 1) {
						c.note("one worker")
					}
					if (workload.workers > workload.modules.length) {
						c.note("more workers than modules")
					}
					if (workload.modules.length > workload.workers) {
						c.note("more modules than workers")
					}
					const ran = simulate(workload, forking)
					deepStrictEqual(
						{
							finished: ran.finished,
							runs: Arr.sort(Arr.dedupe(Arr.fromIterable(ran.runs.values())), Order.Number),
							units: ran.runs.size
						},
						{ finished: true, runs: ran.units > 0 ? [1] : [], units: ran.units }
					)
				}),
		oracle: {
			kind: "universal",
			name: "a scheduled pool runs every case of every window exactly once and ends"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/runner/schedule.ts",
				original:
					"\t\t\treturn Arr.isReadonlyArrayNonEmpty(taken) ? Option.some(taken) : Option.none()",
				replacement:
					"\t\t\treturn Arr.isReadonlyArrayNonEmpty(taken) ? Option.some(Arr.of(Arr.headNonEmpty(taken))) : Option.none()",
				why: "A take gives the worker only the first unit of the message it took out of the queue, so the rest are neither queued nor run and their window never completes; the run stalls and this property fails."
			}
		]
	}
)

export const cheapReadiedOnce = property.explore(cheap, {
	needs: {},
	situations: ["one worker", "several workers"],
	check: (_resources, c) => (workload) =>
		Effect.sync(() => {
			c.note(workload.workers === 1 ? "one worker" : "several workers")
			strictEqual(simulate(workload, "whole").readiedBy.get("m0")?.size ?? 0, 1)
		}),
	oracle: {
		kind: "specification",
		name: "a module whose work is no more than its readying is readied by one worker at any width"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/schedule.ts",
			original:
				"\t\t\t\t\t() => oldestOf((candidate) => (holders.get(candidate)?.size ?? 0) === 0)",
			replacement: "\t\t\t\t\t() => oldestOf(() => true)",
			why: "An idle worker takes the oldest queued unit whoever holds its module, as the pool did before it kept to its modules: every idle worker imports and readies a module whose work it cannot pay for (GZ-UNIT-A's runner at about twice Vitest's CPU); a cheap module is readied by more than one worker, and this property fails."
		},
		{
			file: "packages/testing/src/runner/schedule.ts",
			original: "\t\tif (holds[thief]?.has(first.module) ?? false) {",
			replacement: "\t\tif (true) {",
			why: "A steal halves a busy worker's unstarted units whatever module they are of, so an idle worker readies a module only to take a tail shorter than readying it; a cheap module is stolen into a second worker, and this property fails."
		}
	]
})

export const outgrowingSpreads = property.explore(outgrowing, {
	needs: {},
	situations: [],
	check: () => (workload) =>
		Effect.sync(() => {
			const ran = simulate(workload, "whole")
			strictEqual((ran.readiedBy.get("m0")?.size ?? 0) > 1, true)
		}),
	oracle: {
		kind: "specification",
		name: "a module whose queued work outgrows its holder within its readying is readied by a further worker"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/schedule.ts",
			original: "\t\t\treadyings.set(module, Math.min(readyings.get(module) ?? millis, millis))",
			replacement: "\t\t\treadyings.delete(module)",
			why: "A module's readying is never measured, so no further worker is ever judged to find work left once ready, and a module stays on the one worker that first took it however much work it queues; this property fails."
		}
	]
})

export const sizedToWork = property.explore(cheap, {
	needs: {},
	situations: ["one worker", "several workers"],
	check: (_resources, c) => (workload) =>
		Effect.sync(() => {
			c.note(workload.workers === 1 ? "one worker" : "several workers")
			strictEqual(simulate(workload, "lazily").forked, 1)
		}),
	oracle: {
		kind: "specification",
		name: "a pool forks the workers its queue wants: one for a module that cannot pay for a second"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/schedule.ts",
			original: "\t\t\tscheduler.wanted(view, pool.started) - pool.idling - pool.starting",
			replacement: "\t\t\tpool.most",
			why: "The pool forks every worker it may have as soon as it can, whatever its queue wants, so a run of one small module starts one worker a core (PERF: a one-kill run spent 139 of its 180 CPU-s booting workers); this property fails."
		}
	]
})
