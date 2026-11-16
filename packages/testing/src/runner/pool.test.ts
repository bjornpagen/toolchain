/**
 * The pool's teardown (runner/pool.ts), over a pool of its own running a planted property (pool.fixtures.ts) from the
 * checkout (Checkout.dir, so a mutant of pool.ts reaches it): a worker leaves none of the children it started running,
 * for the pool ends the worker's process group with it, at once when the worker ends with no finalizer of its own run
 * (SIGKILL, as its watchdog ends it), while the pool is still open, and once the worker has exited when the pool
 * closes. A unit whose worker never finishes loading its module (its top level loops forever), whatever its property
 * needs, is reported lost while readying, within the open bound and the silence grace, never left waiting for a word
 * from a worker that cannot send one; and a unit sent to a worker that can no longer say anything (its main thread held
 * between units) is reported lost too, watched from the moment it was sent. Oracle: stated per property.
 */
import { Array as Arr, Effect, FileSystem, Option, String as Str } from "effect"
import { deepStrictEqual } from "#assert.ts"
import { boolean, finite } from "#gen.ts"
import { WATCHDOG_GRACE_MILLIS } from "#live.ts"
import { Checkout } from "#mutate/checkout.ts"
import { property } from "#property.ts"
import { Scratch } from "#resources/scratch.ts"
import { runnerLimits } from "#runner/limits.ts"
import {
	CHILD_FILE,
	ended,
	goneWithin,
	leavings,
	loopingProperty,
	plantedCase,
	shortCase,
	silencing
} from "#runner/pool.fixtures.ts"
import { poolOf } from "#runner/pool.ts"
import { WORKER_ENTRY } from "#runner/run.ts"

export const workersLeaveNoChild = property.exhaust(finite(leavings), {
	box: "one to three children, their worker ended or left running",
	needs: { checkout: Checkout.dir, directory: Scratch.dir },
	situations: [],
	check:
		({ checkout, directory }) =>
		(leaving) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const root = yield* checkout
				const file = `${yield* directory}/children`
				const open = yield* Effect.scoped(
					Effect.gen(function* () {
						const pool = yield* poolOf({
							entry: WORKER_ENTRY,
							root,
							cwd: root,
							env: { [CHILD_FILE]: file },
							workers: 1,
							execArgv: process.execArgv,
							guide: "notes"
						})
						const results = yield* pool.evaluator.evaluate(
							[plantedCase(leaving, runnerLimits.deadline, runnerLimits.open)],
							() => true
						)
						const written = yield* fs.readFileString(file)
						const pids = Arr.map(Str.split("\n")(written), Number)
						const gone = leaving.endsItsWorker
							? yield* Effect.forEach(pids, (pid) => goneWithin(pid, WATCHDOG_GRACE_MILLIS))
							: []
						return { results, pids, gone }
					})
				)
				yield* Effect.ensuring(
					Effect.gen(function* () {
						const closed = yield* Effect.forEach(open.pids, (pid) =>
							goneWithin(pid, WATCHDOG_GRACE_MILLIS)
						)
						deepStrictEqual(
							{
								outcomes: Arr.map(Arr.flatten(open.results), (result) => result.outcome.kind),
								children: open.pids.length,
								goneWhileOpen: Arr.map(open.gone, Option.isSome),
								goneOnceClosed: Arr.map(closed, Option.isSome)
							},
							{
								outcomes: [leaving.endsItsWorker ? "lost" : "passed"],
								children: leaving.children,
								goneWhileOpen: leaving.endsItsWorker ? Arr.map(open.pids, () => true) : [],
								goneOnceClosed: Arr.map(open.pids, () => true)
							}
						)
					}),
					Effect.forEach(open.pids, ended, { discard: true })
				)
			}),
	oracle: {
		kind: "specification",
		name: "a worker leaves none of its children running, ended at once or at the pool's close"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/pool.ts",
			original:
				"\t\t\t\t\t\tyield* endGroup(worker.child)\n\t\t\t\t\t\tconst wasReady = worker.ready",
			replacement: "\t\t\t\t\t\tconst wasReady = worker.ready",
			why: "A worker's exit leaves its process group as it is, as the pool did before: the children of a worker its watchdog ended run on, parented to init, until the pool closes, a run's or a lease's end (a mutant's runaway programs at a core each for hours, MIGRATE-TC); this property fails."
		},
		{
			file: "packages/testing/src/runner/pool.ts",
			original: "\t\t\t\t\t\t\tendGroup(worker.child)\n\t\t\t\t\t\t),",
			replacement: "\t\t\t\t\t\t\tEffect.void\n\t\t\t\t\t\t),",
			why: "A closing pool waits for each worker to exit and leaves its process group as it is: what a worker started outside its own scopes runs on past the run; this property fails."
		},
		{
			file: "packages/testing/src/runner/pool.ts",
			original: '\t\t\t\t\tstdio: ["ignore", "pipe", "pipe", "ipc"],\n\t\t\t\t\tdetached: true',
			replacement: '\t\t\t\t\tstdio: ["ignore", "pipe", "pipe", "ipc"]',
			why: "A worker is forked into the run's own process group, so it leads none, and ending its group ends nothing of it: its children run on; this property fails."
		}
	]
})

export const loadsNever = property.exhaust(finite(boolean), {
	box: "a property with needs and one without",
	needs: { checkout: Checkout.dir },
	situations: ["a property with needs", "a property without needs"],
	check:
		({ checkout }, c) =>
		(needs) =>
			Effect.gen(function* () {
				c.note(needs ? "a property with needs" : "a property without needs")
				const root = yield* checkout
				const results = yield* Effect.scoped(
					Effect.flatMap(
						poolOf({
							entry: WORKER_ENTRY,
							root,
							cwd: root,
							env: {},
							workers: 1,
							execArgv: process.execArgv,
							guide: "notes"
						}),
						(pool) =>
							pool.evaluator.evaluate([shortCase(loopingProperty(needs), 100, 1000)], () => true)
					)
				)
				deepStrictEqual(
					Arr.map(Arr.flatten(results), (result) =>
						result.outcome.kind === "lost"
							? Str.includes("the worker readying its property")(result.outcome.report)
							: false
					),
					[true]
				)
			}),
	oracle: {
		kind: "specification",
		name: "a unit whose worker never finishes loading its module is reported lost, readying, within the open bound and the silence grace"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/pool.ts",
			original: "\t\t\treturn workOf(unit.work).open\n",
			replacement: "\t\t\treturn Number.POSITIVE_INFINITY\n",
			why: "A unit's readying has no bound, so a worker whose module's load never ends is never ended and its search never returns; this property's case hangs past its deadline."
		}
	]
})

export const silentBeforeReadying = property.exhaust(finite(boolean), {
	box: "a next unit with a need and one without",
	needs: { checkout: Checkout.dir },
	situations: [],
	check:
		({ checkout }) =>
		(nextNeeds) =>
			Effect.gen(function* () {
				const root = yield* checkout
				const planted = silencing(nextNeeds)
				const outcomes = yield* Effect.scoped(
					Effect.gen(function* () {
						const pool = yield* poolOf({
							entry: WORKER_ENTRY,
							root,
							cwd: root,
							env: {},
							workers: 1,
							execArgv: process.execArgv,
							guide: "notes"
						})
						const silenced = yield* pool.evaluator.evaluate(
							[shortCase(planted.silences, runnerLimits.deadline, 1000)],
							() => true
						)
						yield* pool.retire(planted.silences)
						const next = yield* pool.evaluator.evaluate(
							[shortCase(planted.next, runnerLimits.deadline, 1000)],
							() => true
						)
						return Arr.map(Arr.flatten([...silenced, ...next]), (result) => result.outcome.kind)
					})
				)
				deepStrictEqual(outcomes, ["passed", "lost"])
			}),
	oracle: {
		kind: "specification",
		name: "a unit sent to a worker that can no longer say anything is reported lost within the open bound and the silence grace"
	},
	budget: { runs: 2, steered: 0 },
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/pool.ts",
			original:
				'\t\t\t\tQueue.offerUnsafe(events, { kind: "sent", worker, unit: Arr.headNonEmpty(sent).unit })\n',
			replacement: "",
			why: "A unit is watched only once its worker says it is readying it, as before: a worker that cannot get that word out (its main thread held, a load that never ends, a full channel) is never ended, so its unit is never reported and its search never returns (CATCH: a mutant's lease silent past an hour); this property's case hangs past its deadline."
		}
	]
})
