import { Array as Arr, Effect, FileSystem, Option, String as Str } from "effect"
import { assert } from "#assert.ts"
import { countWithin } from "#enumerate.ts"
import { array, boolean, finite, int } from "#gen.ts"
import { waitingOn } from "#live.ts"
import { Checkout } from "#mutate/checkout.ts"
import { property, ReplayToken } from "#property.ts"
import { Scratch } from "#resources/scratch.ts"
import { sharedStore } from "#runner/compile-cache.ts"
/**
 * The pool's teardown (runner/pool.ts), over a pool of its own running a planted property (pool.fixtures.ts) from the
 * checkout (Checkout.dir, so a mutant of pool.ts reaches it): a worker leaves none of the children it started running,
 * for the pool ends the worker's process group with it, at once when the worker ends with no finalizer of its own run
 * (SIGKILL, as its watchdog ends it), while the pool is still open, and once the worker has exited when the pool
 * closes. A unit whose worker never finishes loading its module (its top level loops forever), whatever its property
 * needs, is reported lost while readying, within a load's bound and the silence grace, never left waiting for a word
 * from a worker that cannot send one; and a unit sent to a worker that can no longer say anything (its main thread held
 * between units) is reported lost too, watched from the moment it was sent; and a worker whose runner config's load never
 * ends is ended within a load's bound and the grace, its units lost, not waited for; and a worker whose parent is killed
 * ends with it, with every process it started in its group (its launch binds the group to the parent, pool.ts
 * launchOf), even with its main thread held. Oracle: stated per property.
 */
import { workerEnvironmentOf } from "#runner/environment.ts"
import { placesLeased } from "#runner/lease.ts"
import { needStallMillis, runnerLimits } from "#runner/limits.ts"
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
	exitOf,
	leavings,
	loopingProperty,
	plantedCase,
	RUNAWAY,
	SLOW_START_PROPERTY,
	SLOW_WORKER_DEADLINE,
	shortCase,
	declaredWaitDeadlines,
	legSaid,
	silenceSpace,
	silencerOf,
	silencing,
	speakerOf,
	UNREAD_DEADLINE,
	WAITS_DECLARED,
	slowlyWorkingProperty,
	slowStartRoot,
	unreadyRoot
} from "#runner/pool.fixtures.ts"
import { placesOf, placesShared, poolOf } from "#runner/pool.ts"
import { runPackage, WORKER_ENTRY } from "#runner/run.ts"
import { widthOf } from "#workers.ts"

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
				const scratch = yield* directory
				const file = `${scratch}/children`
				const open = yield* Effect.scoped(
					Effect.gen(function* () {
						const pool = yield* poolOf({
							entry: WORKER_ENTRY,
							root,
							cwd: root,
							env: { ...workerEnvironmentOf([], process.env), [CHILD_FILE]: file },
							compile: sharedStore,
							places: placesOf(widthOf(1)),
							execArgv: process.execArgv,
							served: Option.none(),
							guide: "notes",
							runs: [],
							stall: needStallMillis,
							bounding: "summed"
						})
						const results = yield* pool.evaluator.evaluate(
							[plantedCase(leaving, runnerLimits.deadline)],
							() => true
						)
						const written = yield* fs.readFileString(file)
						const pids = Arr.map(Str.split("\n")(written), Number)
						const endedWhileOpen = leaving.endsItsWorker
							? (yield* Effect.forEach(pids, (pid) => exitOf(pid, scratch))).length
							: 0
						return { results, pids, endedWhileOpen }
					})
				)
				yield* Effect.ensuring(
					Effect.gen(function* () {
						const endedOnceClosed = (yield* Effect.forEach(open.pids, (pid) =>
							exitOf(pid, scratch)
						)).length
						assert.deepEqual(
							{
								outcomes: Arr.map(Arr.flatten(open.results), (result) => result.outcome.kind),
								children: open.pids.length,
								endedWhileOpen: open.endedWhileOpen,
								endedOnceClosed
							},
							{
								outcomes: [leaving.endsItsWorker ? "lost" : "passed"],
								children: leaving.children,
								endedWhileOpen: leaving.endsItsWorker ? leaving.children : 0,
								endedOnceClosed: leaving.children
							}
						)
					}),
					Effect.forEach(open.pids, ended, { discard: true })
				)
			}),
	oracle: {
		kind: "specification",
		name: "a worker leaves none of its children running, ended at once or at the pool's close: each child's exit, waited on, never timed"
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
			original: '\t\t\t\tstdio: ["pipe", "pipe", "pipe", "ipc", "pipe"],\n\t\t\t\tdetached: true',
			replacement: '\t\t\t\tstdio: ["pipe", "pipe", "pipe", "ipc", "pipe"]',
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
							env: workerEnvironmentOf([], process.env),
							compile: sharedStore,
							places: placesOf(widthOf(1)),
							execArgv: process.execArgv,
							served: Option.none(),
							guide: "notes",
							runs: [],
							stall: 1000,
							bounding: "summed"
						}),
						(pool) => pool.evaluator.evaluate([shortCase(loopingProperty(needs), 100)], () => true)
					)
				)
				assert.deepEqual(
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
		name: "a unit whose worker never finishes loading its module is reported lost, readying, within a load's bound and the silence grace"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/pool.ts",
			original: "\t\t\treturn loadBoundOf(stall)\n",
			replacement:
				"\t\t\treturn { cpu: Number.POSITIVE_INFINITY, stall: Number.POSITIVE_INFINITY }\n",
			why: "A unit's readying has no bound, so a worker whose module's load never ends is never ended and its search never returns; this property's case hangs past its deadline."
		}
	]
})

export const slowWorkerKept = property.exhaust(finite(boolean), {
	box: "a slow unit whose work is its worker's, and one whose work is a child's",
	needs: { checkout: Checkout.dir },
	situations: [],
	check:
		({ checkout }) =>
		(inChild) =>
			Effect.gen(function* () {
				const root = yield* checkout
				const outcomes = yield* Effect.scoped(
					Effect.gen(function* () {
						const pool = yield* poolOf({
							entry: WORKER_ENTRY,
							root,
							cwd: root,
							env: workerEnvironmentOf([], process.env),
							compile: sharedStore,
							places: placesOf(widthOf(1)),
							execArgv: process.execArgv,
							served: Option.none(),
							guide: "notes",
							runs: [],
							stall: 1000,
							bounding: "summed"
						})
						const results = yield* pool.evaluator.evaluate(
							[shortCase(slowlyWorkingProperty(inChild), SLOW_WORKER_DEADLINE)],
							() => true
						)
						return Arr.map(Arr.flatten(results), (result) => result.outcome.kind)
					})
				)
				assert.deepEqual(outcomes, ["passed"])
			}),
	oracle: {
		kind: "specification",
		name: "a worker silent past its unit's bound and the silence grace while its process tree's CPU moves and stays within them, in the worker or in a child, is left to finish, never killed as lost"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/pool.ts",
			original: "overrun(work, graced(boundOf(unit.value, phase, spec.stall, spec.bounding)))",
			replacement:
				"overrun({ ...work, effort: () => work.began }, graced(boundOf(unit.value, phase, spec.stall, spec.bounding)))",
			why: "The parent's watch reads a worker's work as never moving, so a worker silent past its bound and grace is killed whatever it is doing, as the live clock's watch killed it: the slow worker's unit is lost; the slow-worker property fails."
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
							env: workerEnvironmentOf([], process.env),
							compile: sharedStore,
							places: placesOf(widthOf(1)),
							execArgv: process.execArgv,
							served: Option.none(),
							guide: "notes",
							runs: [],
							stall: 1000,
							bounding: "summed"
						})
						const silenced = yield* pool.evaluator.evaluate(
							[shortCase(planted.silences, runnerLimits.deadline)],
							() => true
						)
						yield* pool.retire(planted.silences)
						const next = yield* pool.evaluator.evaluate(
							[shortCase(planted.next, runnerLimits.deadline)],
							() => true
						)
						return Arr.map(Arr.flatten([...silenced, ...next]), (result) => result.outcome.kind)
					})
				)
				assert.deepEqual(outcomes, ["passed", "lost"])
			}),
	oracle: {
		kind: "specification",
		name: "a unit sent to a worker that can no longer say anything is reported lost within a load's bound and the silence grace"
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

export const lostNamesItsLeg = property.exhaust(finite(silenceSpace), {
	box: "a worker silenced between units by a loop that spends CPU and by a wait that spends none",
	needs: { checkout: Checkout.dir },
	situations: [],
	check:
		({ checkout }) =>
		(silence) =>
			Effect.gen(function* () {
				const root = yield* checkout
				const outcomes = yield* Effect.scoped(
					Effect.gen(function* () {
						const pool = yield* poolOf({
							entry: WORKER_ENTRY,
							root,
							cwd: root,
							env: workerEnvironmentOf([], process.env),
							compile: sharedStore,
							places: placesOf(widthOf(1)),
							execArgv: process.execArgv,
							served: Option.none(),
							guide: "notes",
							runs: [],
							stall: 1000,
							bounding: "summed"
						})
						const silencer = silencerOf(silence)
						const silenced = yield* pool.evaluator.evaluate(
							[shortCase(silencer, runnerLimits.deadline)],
							() => true
						)
						yield* pool.retire(silencer)
						const next = yield* pool.evaluator.evaluate(
							[shortCase("src/runner/pool.fixtures.ts#passesAtOnce", runnerLimits.deadline)],
							() => true
						)
						return Arr.flatten([...silenced, ...next])
					})
				)
				assert.deepEqual(
					Arr.map(outcomes, (result) => result.outcome.kind),
					["passed", "lost"]
				)
				const lost = Arr.flatMap(outcomes, (result) =>
					result.outcome.kind === "lost" ? [result.outcome.report] : []
				)
				assert.deepEqual(
					Arr.map(lost, (report) => Str.includes(legSaid(silence))(report)),
					[true]
				)
				assert.deepEqual(
					Arr.map(lost, (report) => Str.includes('its last message "done"')(report)),
					[true]
				)
			}),
	oracle: {
		kind: "specification",
		name: "a unit lost with a worker the pool ended names the leg of its watch that fired, the CPU its tree spent or how little it moved over how much wall time against which bound, and the last message the worker sent"
	},
	budget: { runs: 2, steered: 0 },
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/pool.ts",
			original:
				'\t\t\t\t\t\t\tworker.ended = Option.some({ kind: "silent", overrun: event.overrun })\n',
			replacement: "",
			why: "The pool ends a silent worker without keeping the leg that fired, so its lost unit reads as a crash, as every lost report read before (SELECTWHOLE: thirteen kills unjudged, lost with nothing said); the property fails."
		},
		{
			file: "packages/testing/src/runner/work.ts",
			original: '\t\treturn judged({ kind: "spent", spent, budget: bound.cpu })',
			replacement:
				'\t\treturn judged({ kind: "stalled", moved: spent, queued: 0, over: now.wall - window.wall, waited: 0, progress: 0, window: bound.stall })',
			why: "A CPU runaway reported as a stall, so the report names the wrong leg; the spinning worker's case fails."
		},
		{
			file: "packages/testing/src/runner/pool.ts",
			original: "\t\t\t\t\t\tworker.heard = Option.some({ kind: received.kind, at: now })\n",
			replacement: "",
			why: "The worker's last message is never kept, so a lost report says it sent none; the property fails."
		}
	]
})

export const unreadMessageEndsItsWorker = property.exhaust(finite(boolean), {
	box: "a worker whose case sends its parent a message the pool's protocol does not read, then waits for nothing, and one whose case passes at once",
	needs: { checkout: Checkout.dir },
	situations: [],
	check:
		({ checkout }) =>
		(unread) =>
			Effect.gen(function* () {
				const root = yield* checkout
				const outcomes = yield* Effect.scoped(
					Effect.gen(function* () {
						const pool = yield* poolOf({
							entry: WORKER_ENTRY,
							root,
							cwd: root,
							env: workerEnvironmentOf([], process.env),
							compile: sharedStore,
							places: placesOf(widthOf(1)),
							execArgv: process.execArgv,
							served: Option.none(),
							guide: "notes",
							runs: [],
							stall: 1000,
							bounding: "summed"
						})
						const evaluated = yield* pool.evaluator.evaluate(
							[shortCase(speakerOf(unread), UNREAD_DEADLINE)],
							() => true
						)
						return Arr.flatten(evaluated)
					})
				)
				assert.deepEqual(
					Arr.map(outcomes, (result) => result.outcome.kind),
					[unread ? "lost" : "passed"]
				)
				assert.deepEqual(
					Arr.map(
						Arr.flatMap(outcomes, (result) =>
							result.outcome.kind === "lost" ? [result.outcome.report] : []
						),
						(report) =>
							Str.includes("for a message it sent that the pool's protocol does not read")(report)
					),
					unread ? [true] : []
				)
			}),
	oracle: {
		kind: "specification",
		name: "a worker that sends a message the pool's protocol does not read is ended by the pool at once, its unit lost with the report saying why, and one that speaks the protocol passes"
	},
	budget: { runs: 2, steered: 0 },
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/pool.ts",
			original:
				'\t\t\t\t\t\t\tworker.ended = Option.some({\n\t\t\t\t\t\t\t\tkind: "unread",\n\t\t\t\t\t\t\t\tmessage: Str.slice(0, OUTPUT_TAIL)(Inspectable.toStringUnknown(event.message, 0))\n\t\t\t\t\t\t\t})\n\t\t\t\t\t\t\tyield* endGroup(worker.child)\n',
			replacement: "",
			why: "A message the protocol does not read is dropped, as it was: a worker whose code no longer speaks the protocol (a mutant of case.ts made its \"done\" one the schema refuses) keeps its unit unanswered for the unit's whole bound, every case's deadline added up, so the toolchain's own census waited on one trial for hours; here the case runs to its deadline and is hung, and the property fails."
		}
	]
})

export const declaredWaitKept = property.exhaust(finite(declaredWaitDeadlines), {
	box: "a case that waits, declared, six of its pool's windows past its deadline, under two deadlines",
	needs: { checkout: Checkout.dir },
	situations: [],
	check:
		({ checkout }) =>
		(deadline) =>
			Effect.gen(function* () {
				const root = yield* checkout
				const outcomes = yield* Effect.scoped(
					Effect.gen(function* () {
						const pool = yield* poolOf({
							entry: WORKER_ENTRY,
							root,
							cwd: root,
							env: workerEnvironmentOf([], process.env),
							compile: sharedStore,
							places: placesOf(widthOf(1)),
							execArgv: process.execArgv,
							served: Option.none(),
							guide: "notes",
							runs: [],
							stall: 1000,
							bounding: "summed"
						})
						const results = yield* pool.evaluator
							.evaluate([shortCase(WAITS_DECLARED, deadline)], () => true)
							.pipe(
								waitingOn(
									"pool.test.ts declaredWaitKept's pool, its case in a declared wait of its own"
								)
							)
						return Arr.map(Arr.flatten(results), (result) => result.outcome.kind)
					})
				)
				assert.deepEqual(outcomes, ["passed"])
			}),
	oracle: {
		kind: "specification",
		name: "a case that waits, declared, on a resource other processes hold spends no stall: past its deadline and its pool's bound and grace in wall time, spending nothing, it is neither hung by its own guard nor killed by its pool, and passes"
	},
	budget: { runs: 2, steered: 0 },
	kept: [
		{
			token: ReplayToken("src/runner/pool.test.ts#declaredWaitKept:-:0"),
			reason:
				"the shorter deadline's case, whose kill of the pool ignoring declared waits survived one whole-package run when its wait spanned two of the pool's windows, an idle worker read from /proc above the pool's floor in both (2026-11-22)",
			since: "2026-11-22"
		}
	],
	kills: [
		{
			file: "packages/testing/src/runner/pool.ts",
			original: "\t\t\t\t\t\t\t\tyield* worker.waits.entered\n",
			replacement: "",
			why: "The pool ignores a worker's declared waits, so it kills a worker whose case waits on another process's lease past its bound and grace, as the stall leg killed SELECTWHOLE's thirteen; the case is lost and the property fails."
		},
		{
			file: "packages/testing/src/runner/work.ts",
			original: "\tconst waited = now.waited - window.waited\n",
			replacement: "\tconst waited = 0\n",
			why: "No guard counts a declared wait out of its stall leg, so the waiting case is hung, or its worker lost; the property fails."
		},
		{
			file: "packages/testing/src/runner/work.ts",
			original: "\twaits.spent + (waits.open > 0 ? wall - waits.since : 0)",
			replacement: "\twaits.spent",
			why: "An open wait's span counts only once it closes, so a wait longer than a deadline is a stall while it lasts; the property fails."
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
							env: workerEnvironmentOf([], process.env),
							compile: sharedStore,
							places: placesOf(widthOf(1)),
							execArgv: process.execArgv,
							served: Option.none(),
							guide: "notes",
							runs: [],
							stall: needStallMillis,
							bounding: "summed"
						}),
						(pool) =>
							pool.evaluator.count({
								property: COUNTED,
								every,
								cpu: runnerLimits.deadline
							})
					)
				)
				const here = yield* countWithin(countedValues, runnerLimits.deadline, every)
				assert.deepEqual(
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
							env: workerEnvironmentOf([], process.env),
							compile: sharedStore,
							places: placesOf(widthOf(1)),
							execArgv: process.execArgv,
							served: Option.none(),
							guide: "notes",
							runs: [],
							stall: needStallMillis,
							bounding: "summed"
						})
						const dying = yield* pool.evaluator.evaluate(
							[shortCase(dyingProperty(thrown), runnerLimits.deadline)],
							() => false
						)
						const next = yield* pool.evaluator.evaluate(
							[shortCase(silencing(false).next, runnerLimits.deadline)],
							() => false
						)
						return Arr.map(Arr.flatten([...dying, ...next]), (result) =>
							result.outcome.kind === "unopened"
								? `unopened: ${Str.includes(DIED_OPENING)(result.outcome.message) ? "the open's defect" : result.outcome.message}`
								: result.outcome.kind
						)
					})
				)
				assert.deepEqual(outcomes, ["unopened: the open's defect", "passed"])
			}),
	oracle: {
		kind: "specification",
		name: "a need whose open dies refuses its property's cases as unopened, with the defect, and the worker goes on"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/case.ts",
			original: "\t\t\t(cause) => !Cause.hasInterruptsOnly(cause),",
			replacement: "\t\t\t() => false,",
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
						const outcome = yield* runPackage({
							root,
							seedOf: () => 1,
							conductOf: () => "clean",
							reach: "full",
							selected: []
						})
						const files = yield* fs.readDirectory(root)
						return {
							failed: Arr.filter(outcome.properties, (ran) => ran.verdict.kind === "failed").length,
							released: Arr.filter(files, (file) => Str.startsWith(RELEASED)(file)).length
						}
					})
				)
				assert.deepEqual(
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
				"\t\t\tEffect.scoped(\n\t\t\t\tEffect.gen(function* () {\n\t\t\t\t\tconst opening = yield* Effect.sync(() => process.cpuUsage())\n",
			replacement:
				"\t\t\t(<A>(effect: A) => effect)(\n\t\t\t\tEffect.gen(function* () {\n\t\t\t\t\tconst opening = yield* Effect.sync(() => process.cpuUsage())\n",
			why: "A run's pool stays open in its caller's scope past its properties, as before: its workers hold what their services drew (a lease's permit) while the caller goes on, as the kills' trials a run judged after its searches once waited for it (GZ-NETWORK: 32 network modules hung, 64 idle workers holding their leases and five trials waiting on the lease gate); this property fails."
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
								env: workerEnvironmentOf([], process.env),
								compile: sharedStore,
								places: { at: [at], of: widthOf(of) },
								execArgv: process.execArgv,
								served: Option.none(),
								guide: "notes",
								runs: [],
								stall: needStallMillis,
								bounding: "summed"
							}),
							(pool) =>
								pool.evaluator.evaluate([placedCase(at, of, runnerLimits.deadline)], () => false)
						)
					)
					assert.deepEqual(
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
					const { placesFor } = placesLeased(widthOf(width))
					const held = new Set<number>()
					const clashes: Array<number> = []
					let most = 0
					yield* Effect.forEach(
						leases,
						(workers) =>
							Effect.scoped(
								Effect.gen(function* () {
									const taken = yield* placesFor(widthOf(workers))
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
					assert.deepEqual({ clashes, within: most <= width }, { clashes: [], within: true })
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
							env: workerEnvironmentOf([], process.env),
							compile: sharedStore,
							places: placesOf(widthOf(1)),
							execArgv: process.execArgv,
							served: Option.none(),
							guide: "notes",
							runs: [],
							stall: 1000,
							bounding: "summed"
						}),
						(pool) => pool.evaluator.evaluate([shortCase(loopingProperty(needs), 100)], () => true)
					)
				)
				assert.deepEqual(
					Arr.map(Arr.flatten(results), (result) =>
						result.outcome.kind === "lost"
							? Str.includes("was not ready within a load's bound")(result.outcome.report)
							: false
					),
					[true]
				)
			}),
	oracle: {
		kind: "specification",
		name: "a worker whose runner config's load never ends is ended within a load's bound and the grace, its units lost"
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

export const slowStartKept = property.exhaust(finite(int(0, 1)), {
	box: "a package whose runner config's load works slowly past a load's bound and the grace in wall time",
	needs: { directory: Scratch.dir },
	situations: [],
	check:
		({ directory }) =>
		() =>
			Effect.gen(function* () {
				const scratch = yield* directory
				const root = yield* slowStartRoot(scratch)
				const outcomes = yield* Effect.scoped(
					Effect.flatMap(
						poolOf({
							entry: WORKER_ENTRY,
							root,
							cwd: root,
							env: workerEnvironmentOf([], process.env),
							compile: sharedStore,
							places: placesOf(widthOf(1)),
							execArgv: process.execArgv,
							served: Option.none(),
							guide: "notes",
							runs: [],
							stall: 1000,
							bounding: "summed"
						}),
						(pool) =>
							Effect.map(
								pool.evaluator.evaluate(
									[shortCase(SLOW_START_PROPERTY, SLOW_WORKER_DEADLINE)],
									() => true
								),
								(results) => Arr.map(Arr.flatten(results), (result) => result.outcome.kind)
							)
					)
				)
				assert.deepEqual(outcomes, ["passed"])
			}),
	oracle: {
		kind: "specification",
		name: "a worker whose start runs past a load's bound and the grace in wall time while its process tree's CPU moves and stays within them is left to start, never ended as one that cannot"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/pool.ts",
			original: "overrun(work, graced(loadBoundOf(spec.stall)))",
			replacement:
				"overrun({ ...work, effort: () => work.began }, graced(loadBoundOf(spec.stall)))",
			why: "The parent reads a starting worker's work as never moving, so its start is judged by the live clock, as the pool's sleep judged it: a worker past a load's bound and the grace in wall time is ended as one that cannot start whatever it is doing, and the slowly starting package's unit is lost; this property fails."
		}
	]
})

export const workersEndWithTheirParent = property.exhaust(finite(boolean), {
	box: "a worker whose parent is killed, held loading a runner config for ever, or running away for ever with a child it started",
	needs: { checkout: Checkout.dir, directory: Scratch.dir },
	situations: [],
	check:
		({ checkout, directory }) =>
		(runsAway) =>
			Effect.gen(function* () {
				const dir = yield* checkout
				const scratch = yield* directory
				const found = yield* heldProgram(orphansProgram(dir), {
					root: runsAway ? dir : yield* unreadyRoot(scratch),
					held: runsAway ? RUNAWAY : loopingProperty(false),
					pidFile: `${scratch}/worker`,
					childFile: `${scratch}/child`,
					child: runsAway
				})
				yield* Effect.ensuring(
					Effect.andThen(
						Effect.sync(() => process.kill(found.program, "SIGKILL")),
						Effect.forEach(found.held, (pid) => exitOf(pid, scratch))
					),
					Effect.forEach(found.held, ended)
				)
				assert.equal(found.held.length, runsAway ? 2 : 1)
			}),
	oracle: {
		kind: "specification",
		name: "a worker whose parent is killed ends, with every process it started in its group, even with its main thread held: each one's exit, waited on, never timed"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/pool.ts",
			original: "'{ while read -r _; do :; done; kill -KILL 0; }",
			replacement: "'{ while read -r _; do :; done; }",
			why: "A worker's watcher sees its parent gone and ends nothing, as if the worker were not bound to its parent, as before its orphan guard: leading a process group of its own, a worker outlives a parent killed with no finalizer run, and one whose main thread is held runs on for ever with the children it started (kill trials left such workers and their programs at a core each for hours); this property fails."
		}
	]
})

/** A run's kinds of workers as drawn: the machine's width and each kind's weight, its properties. */
type Shared = Readonly<{ width: number; weights: Arr.NonEmptyReadonlyArray<number> }>

export const kindsShareTheWidth = property.explore(
	(source): Shared => ({
		width: source.draw(int(1, 96)),
		weights: Arr.prepend(
			source.draw(array(int(1, 500), { min: 0, max: 3 })),
			source.draw(int(1, 500))
		)
	}),
	{
		needs: {},
		situations: [
			"a single kind",
			"kinds fewer than the width",
			"kinds as many as the width",
			"kinds more than the width"
		],
		check: (_resources, c) => (shared) =>
			Effect.sync(() => {
				const kinds = shared.weights.length
				if (kinds === 1) {
					c.note("a single kind")
				}
				c.note(
					kinds < shared.width
						? "kinds fewer than the width"
						: kinds === shared.width
							? "kinds as many as the width"
							: "kinds more than the width"
				)
				const places = placesShared(widthOf(shared.width), shared.weights)
				const taken = Arr.flatMap(places, ({ at }) => at)
				const total = Arr.reduce(shared.weights, 0, (sum, weight) => sum + weight)
				const extra = shared.width - kinds
				assert.deepEqual(
					{
						kinds: places.length,
						of: Arr.every(places, (one) => one.of === shared.width),
						within: Arr.every(taken, (place) => place >= 0 && place < shared.width),
						distinct: kinds > shared.width || new Set(taken).size === taken.length,
						held: kinds > shared.width ? kinds : taken.length,
						shares:
							kinds > shared.width
								? Arr.map(places, ({ at }) => at.length === 1)
								: Arr.map(places, ({ at }, kind) => {
										const quota = (Arr.getUnsafe(shared.weights, kind) * extra) / total
										return at.length - 1 === Math.floor(quota) || at.length - 1 === Math.ceil(quota)
									})
					},
					{
						kinds,
						of: true,
						within: true,
						distinct: true,
						held: kinds > shared.width ? kinds : shared.width,
						shares: Arr.map(places, () => true)
					}
				)
			}),
		oracle: {
			kind: "specification",
			name: "the kinds hold the width between them, at distinct places, at least one each, the rest in proportion to their weights within one place; a machine narrower than its kinds gives each one place"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/runner/pool.ts",
				original: "\t\tconst start = Arr.getUnsafe(starts, kind)",
				replacement: "\t\tconst start = 0 * Arr.getUnsafe(starts, kind)",
				why: "Every kind's workers start at the first place, so two kinds' workers take one place (one lease on grizzle's cluster family), as each kind's pool of the whole width did before."
			},
			{
				file: "packages/testing/src/runner/pool.ts",
				original: "1 + floor + (bonus.has(kind) ? 1 : 0)",
				replacement: "1 + floor",
				why: "The width's remainder after the floors goes to no kind, so the run holds fewer workers than the machine has."
			},
			{
				file: "packages/testing/src/runner/pool.ts",
				original: "(weight * extra) / total",
				replacement: "extra / kinds",
				why: "The width is split evenly whatever the kinds' weights, so a kind of one property holds as many workers as a kind of a thousand."
			}
		]
	}
)
