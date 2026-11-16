/**
 * The pool's scheduling (runner/schedule.ts), held to what it promises over drawn workloads run on a simulated pool in
 * virtual time (schedule.fixtures.ts), the pool's own loop over the scheduler:
 *
 * - Every case of every window runs exactly once, and every search ends, at any width: a worker that holds a module,
 *   waits, takes or steals never loses, repeats or starves a unit.
 * - A module whose whole work is no more than readying it takes is readied by one worker, at any width: a further
 *   worker would spend more readying it than it could take off the holder.
 * - A further worker pays for itself: a module spreads exactly when the queued work its holder leaves undrained while
 *   that worker gets ready (its start, if forked; the module's import and every queued property's opening, measured
 *   apart) covers that time, and the pool wants as many as that work holds the time whole.
 * - A module whose queued work outgrows its holder (cases at least as long as readying it, four or more a worker) is
 *   readied by more than one worker: the spread is measured, never refused.
 * - A module whose cases cost nothing but whose units each hold their worker for a round trip as long as readying it,
 *   four or more a worker, spreads too: a unit's work is how long it holds its worker, as the pool saw it.
 * - The pool is as wide as its work: a run of one module whose work is no more than its readying forks one worker, at
 *   any width, where a pool forked whole up front starts every worker it may have.
 *
 * Oracles are stated per property.
 */
import { Array as Arr, Effect, Order } from "effect"
import { deepStrictEqual, strictEqual } from "#assert.ts"
import { element, int } from "#gen.ts"
import { property } from "#property.ts"
import {
	cheap,
	FORKINGS,
	outgrowing,
	spreadIn,
	simulate,
	spreadStates,
	type SpreadState,
	tripBound,
	workloads
} from "#runner/schedule.fixtures.ts"

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
			original: "\t\tif (within === 0) {",
			replacement: "\t\tif (true) {",
			why: "A steal halves a busy worker's unstarted units whatever the thief must ready to run them, so an idle worker readies a module only to take a tail shorter than readying it; a cheap module is stolen into a second worker, and this property fails."
		}
	]
})

export const spreadPaysForItself = property.explore(
	(source) => ({ state: source.draw(spreadStates), starting: source.draw(int(0, 60)) }),
	{
		needs: {},
		situations: [
			"several properties queued",
			"one property queued",
			"nothing queued",
			"a further worker pays for itself"
		],
		check:
			(_resources, c) =>
			({ state, starting }) =>
				Effect.sync(() => {
					const queued = Arr.filter(state.properties, (drawn) => drawn.queued > 0)
					c.note(
						queued.length > 1
							? "several properties queued"
							: queued.length === 1
								? "one property queued"
								: "nothing queued"
					)
					const work = (count: (drawn: SpreadState["properties"][number]) => number) =>
						Arr.reduce(state.properties, 0, (sum, drawn) => sum + count(drawn) * drawn.caseMillis)
					const readying = Arr.reduce(queued, state.importing, (sum, drawn) => sum + drawn.opening)
					const shortWithin = (within: number) =>
						work((drawn) => drawn.queued) - Math.max(0, within - work((drawn) => drawn.sent))
					const pays = (within: number) => shortWithin(within) > 0 && shortWithin(within) >= within
					if (pays(readying)) {
						c.note("a further worker pays for itself")
					}
					const forked = readying + starting
					deepStrictEqual(spreadIn(state, starting), {
						outgrows: pays(readying),
						wanted: pays(forked)
							? Math.floor(shortWithin(forked) / Math.max(forked, Number.MIN_VALUE))
							: 0
					})
				}),
		oracle: {
			kind: "specification",
			name: "a module spreads to a further worker exactly when the queued work its holder leaves undrained while that worker gets ready (its start, if forked, its import and every queued property's opening) covers that time, and wants as many as that work holds the time whole"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/runner/schedule.ts",
				original: "\t\t\treadying += opening\n",
				replacement: "\t\t\treturn Option.some(readying + opening)\n",
				why: "A further worker's readying of a module is reckoned as its import and its first queued property's opening alone, as a module's first readying measured it before: a module of several properties costly to open (grizzle's education, a template plan a property and a worker) spreads to workers that each open every property again; this property fails."
			},
			{
				file: "packages/testing/src/runner/schedule.ts",
				original: "\t\tshort > 0 && short >= within",
				replacement: "\t\tshort > 0",
				why: "A module spreads whenever its holders leave any work undrained, however little, as before main's rule: a further worker spends seconds readying for a case or two (education at 959 CPU-s against Vitest's 450); this property fails."
			},
			{
				file: "packages/testing/src/runner/schedule.ts",
				original:
					"\t\t\t\t\t\t\t\t? Math.floor(shortfall.short / Math.max(shortfall.within, Number.MIN_VALUE))",
				replacement:
					"\t\t\t\t\t\t\t\t? Math.ceil(shortfall.short / Math.max(shortfall.within, Number.MIN_VALUE))",
				why: "The pool forks one worker more than the undrained work holds whole, so the last one's share falls short of its start and readying; this property fails."
			}
		]
	}
)

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
			original:
				"\t\t\t\timports.set(module, Math.min(imports.get(module) ?? readying.importing, readying.importing))",
			replacement: "\t\t\t\timports.delete(module)",
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

export const tripsSpread = property.explore(tripBound, {
	needs: {},
	situations: [],
	check: () => (workload) =>
		Effect.sync(() => {
			const ran = simulate(workload, "whole")
			strictEqual((ran.readiedBy.get("m0")?.size ?? 0) > 1, true)
		}),
	oracle: {
		kind: "specification",
		name: "a module whose units hold their workers past their cases (a round trip) spreads by how long they hold them"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/schedule.ts",
			original: "\t\tconst sum = occupancies.get(property)\n\t\treturn sum === undefined",
			replacement: "\t\tconst sum = cases.get(property)\n\t\treturn sum === undefined",
			why: "A unit's work is its cases' own time, so a module whose units are bound by their round trips (grizzle's template forms under load: 33 ms of CPU a case, about a second a unit) never outgrows the worker that holds it, and its cases queue for that one worker; this property fails."
		}
	]
})
