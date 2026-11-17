/**
 * The pool's teardown (runner/pool.ts), over a pool of its own running a planted property (pool.fixtures.ts) from the
 * checkout (Checkout.dir, so a mutant of pool.ts reaches it): a worker leaves none of the children it started running,
 * for the pool ends the worker's process group with it, at once when the worker ends with no finalizer of its own run
 * (SIGKILL, as its watchdog ends it), while the pool is still open, and once the worker has exited when the pool
 * closes. A unit whose worker never finishes loading its module (its top level loops forever), whatever its property
 * needs, is reported lost while readying, within the open bound and the silence grace, never left waiting for a word
 * from a worker that cannot send one; and a unit sent to a worker that can no longer say anything (its main thread held
 * between units) is reported lost too, watched from the moment it was sent; and a worker whose runner config's load never
 * ends is ended within the open bound and the grace, its units lost, not waited for; and a worker whose parent is killed
 * ends with it (its orphan guard), even with its main thread held. Oracle: stated per property.
 */
import { Array as Arr, Effect, FileSystem, Option, String as Str } from "effect"
import { deepStrictEqual } from "#assert.ts"
import { countWithin } from "#enumerate.ts"
import { array, boolean, finite, int } from "#gen.ts"
import { WATCHDOG_GRACE_MILLIS } from "#live.ts"
import { Checkout } from "#mutate/checkout.ts"
import { property } from "#property.ts"
import { Scratch } from "#resources/scratch.ts"
import { placesLeased } from "#runner/lease.ts"
import { runnerLimits } from "#runner/limits.ts"
import { heldProgram, orphansProgram } from "#runner/orphans.fixtures.ts"
import {
	COUNTED,
	countsEvery,
	CHILD_FILE,
	countedValues,
	placedCase,
	RELEASED,
	releasingRoot,
	DIED_OPENING,
	dyingProperty,
	ended,
	goneWithin,
	leavings,
	loopingProperty,
	plantedCase,
	shortCase,
	silencing,
	unreadyRoot
} from "#runner/pool.fixtures.ts"
import { placesOf, poolOf } from "#runner/pool.ts"
import { runPackage, WORKER_ENTRY } from "#runner/run.ts"

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
							places: placesOf(1),
							execArgv: process.execArgv,
							guide: "notes",
							open: runnerLimits.open
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
							places: placesOf(1),
							execArgv: process.execArgv,
							guide: "notes",
							open: runnerLimits.open
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
							places: placesOf(1),
							execArgv: process.execArgv,
							guide: "notes",
							open: runnerLimits.open
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

export const countedOnAWorker = property.exhaust(finite(countsEvery), {
	box: "a count's every from one case to more than the space holds, four of them",
	needs: { checkout: Checkout.dir },
	situations: ["one series for the whole space", "several series"],
	check:
		({ checkout }, c) =>
		(every) =>
			Effect.gen(function* () {
				c.note(every >= 64 ? "one series for the whole space" : "several series")
				const root = yield* checkout
				const answer = yield* Effect.scoped(
					Effect.flatMap(
						poolOf({
							entry: WORKER_ENTRY,
							root,
							cwd: root,
							env: {},
							places: placesOf(1),
							execArgv: process.execArgv,
							guide: "notes",
							open: runnerLimits.open
						}),
						(pool) =>
							pool.evaluator.count({
								property: COUNTED,
								every,
								cpu: runnerLimits.deadline,
								open: runnerLimits.open
							})
					)
				)
				const here = yield* countWithin(countedValues, runnerLimits.deadline, every)
				deepStrictEqual(
					{
						answer:
							answer.kind === "counted"
								? Option.some({
										cases: answer.cases,
										starts: Arr.map(answer.starts, (start) =>
											Array.from(start.values.subarray(0, start.length))
										)
									})
								: Option.none()
					},
					{
						answer: Option.map(here, (counted) => ({
							cases: counted.cases,
							starts: Arr.map(counted.starts, (start) =>
								Array.from(start.values.subarray(0, start.length))
							)
						}))
					}
				)
			}),
	oracle: {
		kind: "second-implementation",
		name: "the space counted in this process (enumerate.ts countWithin), which a worker's count must match"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/case.ts",
			original: "\t\t\tcountWithin(drawing.spaceUnder(Option.none()), order.cpu, order.every),",
			replacement:
				"\t\t\tcountWithin(drawing.spaceUnder(Option.none()), order.cpu, order.every + 1),",
			why: "A worker's count gives the branch of every case but the one its order asks for, so an exhaustion's series start where no window does and its sketches overlap or skip cases; this property fails."
		}
	]
})

export const openDiesUnopened = property.exhaust(finite(boolean), {
	box: "a need's open that throws and one that dies",
	needs: { checkout: Checkout.dir },
	situations: [],
	check:
		({ checkout }) =>
		(thrown) =>
			Effect.gen(function* () {
				const root = yield* checkout
				const outcomes = yield* Effect.scoped(
					Effect.gen(function* () {
						const pool = yield* poolOf({
							entry: WORKER_ENTRY,
							root,
							cwd: root,
							env: {},
							places: placesOf(1),
							execArgv: process.execArgv,
							guide: "notes",
							open: runnerLimits.open
						})
						const dying = yield* pool.evaluator.evaluate(
							[shortCase(dyingProperty(thrown), runnerLimits.deadline, runnerLimits.open)],
							() => false
						)
						const next = yield* pool.evaluator.evaluate(
							[shortCase(silencing(false).next, runnerLimits.deadline, runnerLimits.open)],
							() => false
						)
						return Arr.map(Arr.flatten([...dying, ...next]), (result) =>
							result.outcome.kind === "unopened"
								? `unopened: ${Str.includes(DIED_OPENING)(result.outcome.message) ? "the open's defect" : result.outcome.message}`
								: result.outcome.kind
						)
					})
				)
				deepStrictEqual(outcomes, ["unopened: the open's defect", "passed"])
			}),
	oracle: {
		kind: "specification",
		name: "a need whose open dies refuses its property's cases as unopened, with the defect, and the worker goes on"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/case.ts",
			original: "\t\t\t\t\t\t\t(cause) => !Cause.hasInterruptsOnly(cause),",
			replacement: "\t\t\t\t\t\t\t() => false,",
			why: "A need's open that dies ends its worker, as before: the worker's main effect fails, it says so to the parent and exits 0, and its unit is lost with nothing written (GZ-NETWORK: admission.test.ts's property lost its worker readying, \"ended (exit 0)\"); this property fails."
		}
	]
})

export const closedOnReturn = property.exhaust(finite(boolean), {
	box: "a run of the planted package, twice",
	needs: { directory: Scratch.dir },
	situations: [],
	check:
		({ directory }) =>
		() =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const scratch = yield* directory
				const root = yield* releasingRoot(scratch)
				const released = yield* Effect.scoped(
					Effect.gen(function* () {
						const outcome = yield* runPackage({ root, seed: 1, reach: "full", selected: [] })
						const files = yield* fs.readDirectory(root)
						return {
							failed: Arr.filter(outcome.properties, (ran) => ran.verdict.kind === "failed").length,
							released: Arr.filter(files, (file) => Str.startsWith(RELEASED)(file)).length
						}
					})
				)
				deepStrictEqual(
					{ failed: released.failed, released: released.released > 0 },
					{ failed: 0, released: true }
				)
			}),
	oracle: {
		kind: "specification",
		name: "a run's pool is closed when runPackage returns: every worker has ended and released what its services held, before the caller goes on"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/run.ts",
			original:
				"\tEffect.scoped(\n\t\tEffect.gen(function* () {\n\t\t\tconst began = yield* liveMillis",
			replacement:
				"\t(<A>(effect: A) => effect)(\n\t\tEffect.gen(function* () {\n\t\t\tconst began = yield* liveMillis",
			why: "A run's pool stays open in its caller's scope past its properties, as before: its workers hold what their services drew (a lease's permit) while the caller runs the kills' trials, which wait for it (GZ-NETWORK: 32 network modules hung, 64 idle workers holding their leases and five trials waiting on the lease gate); this property fails."
		}
	]
})

export const workersTakeTheirPlaces = property.exhaust(
	finite((source) => {
		const of = source.draw(int(2, 8))
		return { at: source.draw(int(1, of - 1)), of }
	}),
	{
		box: "a place past the first among two to eight",
		needs: { checkout: Checkout.dir },
		situations: [],
		check:
			({ checkout }) =>
			({ at, of }) =>
				Effect.gen(function* () {
					const root = yield* checkout
					const results = yield* Effect.scoped(
						Effect.flatMap(
							poolOf({
								entry: WORKER_ENTRY,
								root,
								cwd: root,
								env: {},
								places: { at: [at], of },
								execArgv: process.execArgv,
								guide: "notes",
								open: runnerLimits.open
							}),
							(pool) =>
								pool.evaluator.evaluate(
									[placedCase(at, of, runnerLimits.deadline, runnerLimits.open)],
									() => false
								)
						)
					)
					deepStrictEqual(
						Arr.map(Arr.flatten(results), (result) => result.outcome.kind),
						["passed"]
					)
				}),
		oracle: {
			kind: "specification",
			name: "a pool's worker reports the place its pool gives it, among as many places as the pool says there are"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/runner/pool.ts",
				original: "String(Arr.get(spec.places.at, index).pipe(Option.getOrElse(() => index)))",
				replacement: "String(index)",
				why: "A worker reports its index in its own pool as its place, as before: every lease's workers report place 0 and take their leases on one member of the family (GZ-NETWORK: kill trials waiting 300 s at substrate_lease_gate); this property fails."
			}
		]
	}
)

export const leasesTakeDistinctPlaces = property.explore(
	(source) => {
		const width = source.draw(int(1, 8))
		return { width, leases: source.draw(array(int(1, width), { min: 1, max: 12 })) }
	},
	{
		needs: {},
		situations: ["more places asked at once than the width holds", "all at once within the width"],
		check:
			(_resources, c) =>
			({ width, leases }) =>
				Effect.gen(function* () {
					c.note(
						Arr.reduce(leases, 0, (sum, workers) => sum + workers) > width
							? "more places asked at once than the width holds"
							: "all at once within the width"
					)
					const { placesFor } = placesLeased(width)
					const held = new Set<number>()
					const clashes: Array<number> = []
					let most = 0
					yield* Effect.forEach(
						leases,
						(workers) =>
							Effect.scoped(
								Effect.gen(function* () {
									const taken = yield* placesFor(workers)
									for (const place of taken) {
										if (held.has(place) || place < 0 || place >= width) {
											clashes.push(place)
										}
										held.add(place)
									}
									most = Math.max(most, held.size)
									yield* Effect.yieldNow
									for (const place of taken) {
										held.delete(place)
									}
								})
							),
						{ concurrency: "unbounded", discard: true }
					)
					deepStrictEqual({ clashes, within: most <= width }, { clashes: [], within: true })
				}),
		oracle: {
			kind: "specification",
			name: "the places leases hold at once are distinct and within the pool's width, a lease waiting while too few are free"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/runner/lease.ts",
				original: "\t\t\t\t\t\tEffect.sync(() => free.splice(0, workers)),",
				replacement: "\t\t\t\t\t\tEffect.sync(() => free.slice(0, workers)),",
				why: "A lease takes the first free places without taking them out, so leases open at once share places, as every lease's place 0 did before; this property fails."
			},
			{
				file: "packages/testing/src/runner/lease.ts",
				original: "\t\t\t\tEffect.andThen(leasing.take(workers), () =>",
				replacement: "\t\t\t\tEffect.andThen(Effect.void, () =>",
				why: "A lease takes its places without waiting for them to be free, so more workers are leased at once than the width holds; this property fails."
			}
		]
	}
)

export const startsNever = property.exhaust(finite(boolean), {
	box: "a unit of a property with needs and one without",
	needs: { directory: Scratch.dir },
	situations: [],
	check:
		({ directory }) =>
		(needs) =>
			Effect.gen(function* () {
				const scratch = yield* directory
				const root = yield* unreadyRoot(scratch)
				const results = yield* Effect.scoped(
					Effect.flatMap(
						poolOf({
							entry: WORKER_ENTRY,
							root,
							cwd: root,
							env: {},
							places: placesOf(1),
							execArgv: process.execArgv,
							guide: "notes",
							open: 1000
						}),
						(pool) =>
							pool.evaluator.evaluate([shortCase(loopingProperty(needs), 100, 1000)], () => true)
					)
				)
				deepStrictEqual(
					Arr.map(Arr.flatten(results), (result) =>
						result.outcome.kind === "lost"
							? Str.includes("was not ready within the open bound")(result.outcome.report)
							: false
					),
					[true]
				)
			}),
	oracle: {
		kind: "specification",
		name: "a worker whose runner config's load never ends is ended within the open bound and the grace, its units lost"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/pool.ts",
			original: '\t\t\tQueue.offerUnsafe(events, { kind: "forked", worker })\n',
			replacement: "",
			why: "A worker is watched only once it is ready, as before: one whose runner config's load never ends (CATCH: a mutant of grizzle's engine, which the runner config's support loads) is never ended, nor its units given back, and its search never returns; this property's case hangs past its deadline."
		}
	]
})

export const workersOutliveNoParent = property.exhaust(finite(boolean), {
	box: "a worker held for ever whose parent is killed, twice over",
	needs: { checkout: Checkout.dir, directory: Scratch.dir },
	situations: [],
	check:
		({ checkout, directory }) =>
		() =>
			Effect.gen(function* () {
				const dir = yield* checkout
				const scratch = yield* directory
				const pidFile = `${scratch}/worker`
				const root = yield* unreadyRoot(scratch)
				const held = yield* heldProgram(
					orphansProgram(dir),
					root,
					pidFile,
					runnerLimits.deadline / 2
				)
				const gone = yield* Option.match(held, {
					onNone: () => Effect.succeed(Option.none<number>()),
					onSome: ({ program, worker }) =>
						Effect.ensuring(
							Effect.andThen(
								Effect.sync(() => process.kill(program, "SIGKILL")),
								goneWithin(worker, WATCHDOG_GRACE_MILLIS)
							),
							ended(worker)
						)
				})
				deepStrictEqual(
					{ held: Option.isSome(held), gone: Option.isSome(gone) },
					{ held: true, gone: true }
				)
			}),
	oracle: {
		kind: "specification",
		name: "a worker whose parent is killed ends within the watchdog's grace, even with its main thread held for ever"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/worker.ts",
			original: "\t\t\teval: true\n\t\t}).unref()",
			replacement: "\t\t\teval: true\n\t\t}).terminate()",
			why: "A worker's orphan guard is terminated as it starts, as if it had none, as before: leading a process group of its own, it outlives a parent killed with no finalizer run, and one whose main thread is held runs on for ever (this lane's own kill trials left such workers at a core each); this property fails."
		}
	]
})
