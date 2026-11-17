import {
	Array as Arr,
	Deferred,
	Duration,
	Effect,
	Fiber,
	Option,
	Queue,
	Record as Rec,
	Result,
	Schema,
	Scope,
	String as Str
} from "effect"
import { HUNG_CLEANUP_GRACE, liveMillis, WATCHDOG_GRACE_MILLIS } from "#live.ts"
import { withLateUses } from "#runner/case.ts"
import { compileCacheDirectory, readsCoverage } from "#runner/compile-cache.ts"
import { moduleClosureAt } from "#runner/module-closure.ts"
import {
	type CountAnswer,
	countAnswerOf,
	type Done,
	deadlinesOf,
	doneWith,
	type Evaluator,
	FromWorker,
	lostResult,
	type ChildrenCpu,
	type Printed,
	ranOf,
	resultsOf,
	seriesRanOf,
	type ToWorker,
	type Work,
	workOf
} from "#runner/protocol.ts"
import {
	afterFinished,
	afterQueued,
	type Choice,
	feedAll as feedIdle,
	forksOf,
	moduleOfLabel,
	schedulerOf,
	type View
} from "#runner/schedule.ts"
import type { ChildrenStated, PoolUsage, PropertyUsage } from "#runner/usage.ts"

/**
 * The pool: worker processes, at most one a core and forked as the queue wants them (one for each module no worker
 * holds, more as a module outgrows its holders within a new worker's start), that evaluate the cases of every property
 * of a run, and the parent's side of them. Every search's evaluator puts its batches (units) on one queue, and the pool's scheduling (runner/schedule.ts)
 * gives each idle worker what it should run next: queued units of one property of a module it holds (it readied a
 * property there), else of a module no worker holds, else of a module whose queued work outgrows what its holders drain
 * within the module's measured readying, each message as many units as fill messageWorkMillis (runner/schedule.ts) at
 * the property's measured mean case time, never more than its fair share of what is queued; or, when it may take
 * nothing queued, a busy worker's unstarted tail, revoked from it and handed to this worker, by the same preference. A
 * worker reports how long it spent readying each property, which is what the scheduling measures a module's readying
 * by. Which worker runs a case never reaches its result. A worker runs a unit in
 * phases it tells the parent of: readying the unit's property, the first unit of it the worker took (its module
 * imported, its needs opened), then evaluating its cases; the parent watches a unit from the moment it sends it, in the
 * readying phase until the worker says otherwise, since a worker whose module's load never ends (a top-level loop, a
 * mutant's) may never get a word out; a worker silent past its phase's bound (the needs' open bound, or the cases'
 * deadlines added up) and the silence grace is killed, its unit reported lost with the phase it was in, and a new
 * worker forked in its place. Which worker ran a case never reaches a result, so a search finds the same at
 * any width.
 */

/**
 * One unit of work: a batch of one property's orders or a series of its cases, the property and the module it is
 * declared in, how many cases it holds (a series, those its source names), and where what it gives back goes.
 */
type Unit = Readonly<{
	id: number
	work: Work
	property: string
	module: string
	cases: number
	done: Deferred.Deferred<Done>
}>

/**
 * What a worker is doing with the unit it runs: readying the unit's property (importing its module, opening its needs,
 * before any case of it and outside every case's deadline), or evaluating its cases; the parent watches each phase
 * under its own bound.
 */
type Phase = "readying" | "evaluating"

/**
 * A worker process and what the parent knows of it: the units it was sent and has not finished, the one it runs and in
 * what phase, the idle worker its unstarted tail is being revoked for, the busy worker whose tail it waits for, the
 * last of what it wrote, what its process reported of its CPU, and since when (on the parent's clock) its next unit to
 * finish has held it, with the readying in that time to take out.
 */
type Worker = {
	readonly index: number
	child: ChildProcess
	ready: boolean
	sent: Array<Unit>
	running: Option.Option<Readonly<{ unit: Unit; phase: Phase; silence: Fiber.Fiber<void> }>>
	revokingFor: Option.Option<Worker>
	awaiting: Option.Option<Worker>
	output: string
	usage: { started: number; reported: number }
	occupiedSince: number
	readyingMillis: number
}

/** How much of what a worker wrote the parent keeps, to report a lost case with: the end of it. */
const OUTPUT_TAIL = 16_384

/** The report of a count the pool gave back no answer for, which ranInOrder never does with a unit queued. */
const uncounted = "the pool gave back no answer for a count it was sent"

/**
 * What the pool's workers start from: the worker's entry module, the package root its test modules load from, the
 * directory it runs in, its Node flags and what its environment adds to this process's; how many workers (one a core
 * for a run); and whether any search guides by blocks (each worker then starts V8's coverage before it loads a module).
 * A worker the parent kills is forked again from the same spec. `open` is the run's open bound: within it and the
 * silence grace a worker must be ready (its runner config loaded, its services declared), or it is ended as one that
 * cannot start.
 */
export type PoolSpec = Readonly<{
	entry: string
	root: string
	cwd: string
	env: Readonly<Record<string, string>>
	workers: number
	execArgv: ReadonlyArray<string>
	guide: "notes" | "blocks"
	open: number
}>

/**
 * The pool as a run uses it: the evaluator every search shares; `retire`, which tells every worker a property's search
 * ended, so a worker releases the needs only that property held there; how many cases each worker finished, how many
 * modules each holds (readied a property of), and what its workers measured of their CPU (runner/usage.ts).
 */
export type Pool = Readonly<{
	evaluator: Evaluator
	retire: (property: string) => Effect.Effect<void>
	cases: Effect.Effect<ReadonlyArray<number>>
	held: Effect.Effect<ReadonlyArray<number>>
	usage: Effect.Effect<PoolUsage>
}>

/** The pool failed to start: a worker could not load the package's runner config, and why. */
export class PoolFailed extends Schema.TaggedError<PoolFailed, { readonly brand: unique symbol }>()(
	"PoolFailed",
	{ message: Schema.String }
) {}

const decode = Schema.decodeUnknownOption(FromWorker)

/**
 * Node's child processes, which the pool forks with an IPC channel and structured cloning: Effect's ChildProcess
 * spawns without one, so the pool takes Node's own module, as the process holds it.
 */
const childProcesses = process.getBuiltinModule("node:child_process")

/** A forked worker process. */
type ChildProcess = ReturnType<typeof childProcesses.fork>

/**
 * Ends a worker with every process it started and did not detach (a property's program, a server its need started):
 * the worker leads a process group of its own (it is forked detached), and the whole group is sent SIGKILL. A worker
 * ended by SIGKILL, by its watchdog or by the pool, runs no finalizer, so its children would otherwise run on, parented
 * to init, past the run (MIGRATE-TC found a mutant's runaway programs at a core each hours after their kill trials). A
 * group with no process left in it has nothing to end, the one failure a signal to a group this process made can meet
 * (ESRCH).
 */
const endGroup = (child: ChildProcess): Effect.Effect<void> =>
	Option.match(Option.fromUndefinedOr(child.pid), {
		onNone: () => Effect.void,
		onSome: (pid) =>
			Effect.ignore(
				Effect.try({
					try: () => process.kill(-pid, "SIGKILL"),
					catch: () => "no process left in the group" as const
				})
			)
	})

/** What happens to a worker, as the pool's one fiber handles it, in order: it was forked, or is still not ready past
 * the open bound and the grace; units sent to it, a message, its exit, or its silence past a phase of a unit's bound and
 * grace. */
type Event =
	| Readonly<{ kind: "forked"; worker: Worker }>
	| Readonly<{ kind: "unready"; worker: Worker }>
	| Readonly<{ kind: "sent"; worker: Worker; unit: number }>
	| Readonly<{ kind: "message"; worker: Worker; message: unknown }>
	| Readonly<{ kind: "exit"; worker: Worker; code: number | null; signal: string | null }>
	| Readonly<{ kind: "silent"; worker: Worker; unit: number; phase: Phase }>

/**
 * How long past a phase's bound the parent waits before it kills a worker that has not answered: the watchdog's grace
 * twice (its ping's, then its inspector's, should the main thread be blocked), and the cleanup grace a hung case's
 * guard waits; past that the worker's own guards have failed.
 */
const SILENCE_GRACE_MILLIS = 2 * WATCHDOG_GRACE_MILLIS + Duration.toMillis(HUNG_CLEANUP_GRACE)

/**
 * A phase's bound for a unit: readying, its orders' open bound, within which each need opens on the worker (the
 * module's import shares it); evaluating, each case's deadline, added up.
 */
const boundOf = (unit: Unit, phase: Phase): number => {
	switch (phase) {
		case "readying":
			return workOf(unit.work).open
		case "evaluating":
			return deadlinesOf(unit.work)
	}
}

/** What the report of a unit lost with its worker says the worker was doing. */
const lostIn = (unit: Unit, phase: Phase): string => {
	switch (phase) {
		case "readying":
			return `the worker readying its property (importing its module and opening its needs, each need within the open bound of ${Duration.format(Duration.millis(boundOf(unit, phase)))})`
		case "evaluating":
			return "the worker running it"
	}
}

/**
 * What a worker's environment adds for Node's compile cache (runner/compile-cache.ts): its directory, for workers that
 * read no coverage (their guide is notes and neither their image nor this process names NODE_V8_COVERAGE), and nothing
 * for the others, whose environment drops the cache this process may have been started with (the launcher sets it).
 */
/** This process's environment without the compile cache it may have been started with, which a worker gets anew. */
const inherited = Rec.fromEntries(
	Arr.filter(Rec.toEntries(process.env), ([key]) => key !== "NODE_COMPILE_CACHE")
)

const compilingOf = (spec: PoolSpec) =>
	Effect.gen(function* () {
		const coverage = (yield* readsCoverage) || "NODE_V8_COVERAGE" in spec.env
		if (spec.guide === "blocks" || coverage) {
			return {}
		}
		return { NODE_COMPILE_CACHE: yield* compileCacheDirectory }
	})

/**
 * A pool in the run's scope, which forks its workers as its queue wants them, none before a unit is queued (a run with
 * nothing to run boots no worker): closing it disconnects each worker and waits for it to exit on its own (its
 * finalizers run, a coverage dump is written), then ends its process group (endGroup), which kills a worker still alive
 * past SILENCE_GRACE_MILLIS, a finalizer that hangs, and whatever it left running. A worker that ends while the pool is
 * open, however it ends, has its group ended too.
 */
export const poolOf = (spec: PoolSpec): Effect.Effect<Pool, PoolFailed, Scope.Scope> =>
	Effect.gen(function* () {
		const scope = yield* Scope.Scope
		const closures = yield* moduleClosureAt(spec.root)
		const events = yield* Queue.unbounded<Event>()
		const scheduler = schedulerOf<Unit>(spec.workers)
		let now = yield* liveMillis
		const compiling = yield* Effect.mapError(compilingOf(spec), (missing) =>
			PoolFailed.make({ message: `the compile cache has no directory: ${missing.message}` })
		)
		const workers: Array<Worker> = []
		const counts: Array<number> = Array.from({ length: spec.workers }, () => 0)
		const lateUses = new Map<number, Map<number, Printed>>()
		const properties = new Map<string, PropertyUsage>()
		const processes: Array<Worker["usage"]> = []

		let childrenStated: ChildrenStated = "stated"

		/** Adds what a property's cases or readying cost to its usage, and what the children they ran cost. */
		const spent = (
			label: string,
			cost: Readonly<{ cases: number; casesCpu: number; readyingCpu: number; childrenCpu: number }>
		) => {
			const before = properties.get(label) ?? {
				label,
				cases: 0,
				casesCpu: 0,
				readyingCpu: 0,
				childrenCpu: 0
			}
			properties.set(label, {
				label,
				cases: before.cases + cost.cases,
				casesCpu: before.casesCpu + cost.casesCpu,
				readyingCpu: before.readyingCpu + cost.readyingCpu,
				childrenCpu: before.childrenCpu + cost.childrenCpu
			})
		}

		/** The CPU a worker's reading of its children states, noting a reading that states none. */
		const childrenMillis = (children: ChildrenCpu): number => {
			switch (children.kind) {
				case "stated":
					return children.millis
				case "unstated":
					childrenStated = "unstated"
					return 0
			}
		}
		const broken = new Set<number>()
		let unitIds = 0
		let closing = false

		/**
		 * Sends a worker a message. A worker whose channel has closed is ending, and its exit, which the pool handles,
		 * gives back every unit it was sent; so a message it can no longer take is not sent, and a send that fails as it
		 * closes reaches the callback, never the child's error event, which nothing listens to.
		 */
		const send = (worker: Worker, message: ToWorker) => {
			if (worker.child.connected) {
				worker.child.send(message, () => undefined)
			}
		}

		const idle = (worker: Worker) =>
			worker.ready && worker.sent.length === 0 && Option.isNone(worker.awaiting)

		/** The units a worker was sent that it has not started: all but the one it runs. */
		const unstartedOf = (worker: Worker) =>
			Arr.filter(worker.sent, (unit) =>
				Option.match(worker.running, {
					onNone: () => true,
					onSome: (running) => running.unit.id !== unit.id
				})
			)

		/** The workers as the scheduling reads them, on demand, by index: as many as are forked so far. */
		const view: View<Unit> = {
			get workers() {
				return workers.length
			},
			sentOf: (index) => workers[index]?.sent ?? [],
			unstartedOf: (index) => {
				const worker = workers[index]
				return worker === undefined ? [] : unstartedOf(worker)
			},
			stealable: (index) => {
				const worker = workers[index]
				return worker !== undefined && worker.ready && Option.isNone(worker.revokingFor)
			},
			idle: (index) => {
				const worker = workers[index]
				return !closing && worker !== undefined && idle(worker)
			}
		}

		/**
		 * Sends a worker units to evaluate, and has the first watched from now, in the readying phase until the worker says
		 * otherwise (Event "sent").
		 */
		const give = (worker: Worker, units: ReadonlyArray<Unit>) => {
			worker.sent = [...units]
			worker.occupiedSince = now
			const sent = Arr.map(units, (unit) => ({ unit: unit.id, work: unit.work }))
			if (Arr.isReadonlyArrayNonEmpty(sent)) {
				send(worker, { kind: "evaluate", units: sent })
				Queue.offerUnsafe(events, { kind: "sent", worker, unit: Arr.headNonEmpty(sent).unit })
			}
		}

		/**
		 * Does what the scheduling chose for an idle worker: queued units, sent at once; a busy worker's unstarted tail,
		 * revoked from it for this worker, which waits for it.
		 */
		const apply = (index: number, choice: Choice<Unit>) =>
			Option.map(Option.fromUndefinedOr(workers[index]), (worker) => {
				switch (choice.kind) {
					case "wait":
						return
					case "take":
						give(worker, choice.units)
						return
					case "steal":
						Option.map(Option.fromUndefinedOr(workers[choice.victim]), (victim) => {
							victim.revokingFor = Option.some(worker)
							worker.awaiting = Option.some(victim)
							send(victim, { kind: "revoke", units: Arr.map(choice.units, (unit) => unit.id) })
						})
						return
				}
			})

		/** How long a worker took to start, as the workers measured it, by count and milliseconds. */
		const starts = { count: 0, millis: 0 }

		/**
		 * Forks the workers the queue wants and no worker idle or starting will take: one for each queued module no worker
		 * holds, and one for each module outgrowing its holders within a new worker's measured start and its readying, so a
		 * pool is as wide as its work (a module's cases on one worker, a run of one small module on one process) and never
		 * wider than one worker a core. A worker that could not start stops the forking.
		 */
		const grow = () => {
			if (closing || broken.size > 0) {
				return
			}
			const forks = forksOf(scheduler, view, {
				idling: Arr.filter(workers, idle).length,
				starting: Arr.filter(workers, (worker) => !worker.ready).length,
				most: spec.workers,
				started: starts.count === 0 ? Option.none() : Option.some(starts.millis / starts.count)
			})
			for (let more = forks; more > 0; more -= 1) {
				workers.push(spawn(workers.length))
			}
		}

		/** Re-decides every idle worker, then forks the workers the queue still wants. */
		const feedAll = () => {
			feedIdle(scheduler, view, apply)
			grow()
		}

		/**
		 * Units a revocation gave back: handed to the worker they were revoked for when it still waits for them, and put
		 * back in the queue otherwise.
		 */
		const handBack = (victim: Worker, given: ReadonlyArray<Unit>) => {
			const thief = Option.filter(
				victim.revokingFor,
				(waiting) =>
					workers[waiting.index] === waiting &&
					Option.exists(waiting.awaiting, (awaited) => awaited === victim)
			)
			victim.revokingFor = Option.none()
			Option.match(thief, {
				onNone: () => scheduler.requeue(given),
				onSome: (waiting) => {
					waiting.awaiting = Option.none()
					scheduler.hand(waiting.index, given)
					give(waiting, given)
				}
			})
			for (const waiting of workers) {
				if (Option.exists(waiting.awaiting, (awaited) => awaited === victim)) {
					waiting.awaiting = Option.none()
				}
			}
		}

		const finish = (worker: Worker, unit: Unit, done: Done) => {
			worker.sent = Arr.filter(worker.sent, (sent) => sent.id !== unit.id)
			const ran = ranOf(done)
			counts[worker.index] = (counts[worker.index] ?? 0) + ran.cases
			scheduler.finished(unit.property, ran.cases, ran.millis)
			spent(unit.property, { cases: ran.cases, casesCpu: ran.cpu, readyingCpu: 0, childrenCpu: 0 })
			Deferred.doneUnsafe(unit.done, Effect.succeed(done))
		}

		const spawn = (index: number): Worker => {
			const child = childProcesses.fork(
				spec.entry,
				[spec.root, String(index), String(spec.workers), spec.guide, String(process.pid)],
				{
					cwd: spec.cwd,
					env: { ...inherited, ...spec.env, ...compiling },
					execArgv: Arr.copy(spec.execArgv),
					serialization: "advanced",
					stdio: ["ignore", "pipe", "pipe", "ipc"],
					detached: true
				}
			)
			const worker: Worker = {
				index,
				child,
				ready: false,
				sent: [],
				running: Option.none(),
				revokingFor: Option.none(),
				awaiting: Option.none(),
				output: "",
				usage: { started: 0, reported: 0 },
				occupiedSince: now,
				readyingMillis: 0
			}
			processes.push(worker.usage)
			const keep = (chunk: unknown) => {
				worker.output = Str.slice(-OUTPUT_TAIL)(worker.output + String(chunk))
			}
			child.stdout?.on("data", keep)
			child.stderr?.on("data", keep)
			child.on("message", (message: unknown) => {
				Queue.offerUnsafe(events, { kind: "message", worker, message })
			})
			child.on("exit", (code, signal) => {
				Queue.offerUnsafe(events, { kind: "exit", worker, code, signal })
			})
			Queue.offerUnsafe(events, { kind: "forked", worker })
			return worker
		}

		/** Ends the watch on a worker's running unit, and gives the unit and the phase it was in. */
		const settle = (worker: Worker) =>
			Effect.gen(function* () {
				const running = worker.running
				worker.running = Option.none()
				if (Option.isSome(running)) {
					yield* Fiber.interrupt(running.value.silence)
				}
				return Option.map(running, (ran) => ({ unit: ran.unit, phase: ran.phase }))
			})

		/** Watches a worker in a phase of one of its units: silent past the phase's bound and the grace, it is killed. */
		const watch = (worker: Worker, id: number, phase: Phase) =>
			Effect.gen(function* () {
				yield* settle(worker)
				const unit = Arr.findFirst(worker.sent, (sent) => sent.id === id)
				if (Option.isNone(unit)) {
					return
				}
				const silence = yield* Effect.forkIn(
					Effect.andThen(
						Effect.sleep(Duration.millis(boundOf(unit.value, phase) + SILENCE_GRACE_MILLIS)),
						Queue.offer(events, { kind: "silent", worker, unit: id, phase })
					).pipe(Effect.asVoid),
					scope
				)
				worker.running = Option.some({ unit: unit.value, phase, silence })
			})

		/**
		 * A worker that cannot start (it failed before it was ready, or ended before it was): it is not forked again, and
		 * the pool forks no further worker. Once every worker forked is so, the pool cannot run a case: every unit queued
		 * or sent is given back lost with the last worker's report, so no evaluator waits on a pool with no worker.
		 */
		const breaks = (worker: Worker, report: string) =>
			Effect.sync(() => {
				broken.add(worker.index)
				if (broken.size < workers.length) {
					return
				}
				const stranded = [...scheduler.drain(), ...Arr.flatMap(workers, (other) => other.sent)]
				for (const other of workers) {
					other.sent = []
				}
				for (const unit of stranded) {
					Deferred.doneUnsafe(unit.done, Effect.succeed(doneWith(unit.work, lostResult(report))))
				}
			})

		const handle = (event: Event): Effect.Effect<void> =>
			Effect.gen(function* () {
				now = yield* liveMillis
				const worker = event.worker
				switch (event.kind) {
					case "forked":
						yield* Effect.forkIn(
							Effect.andThen(
								Effect.sleep(Duration.millis(spec.open + SILENCE_GRACE_MILLIS)),
								Queue.offer(events, { kind: "unready", worker })
							).pipe(Effect.asVoid),
							scope
						)
						return
					case "unready":
						if (!worker.ready && workers[worker.index] === worker) {
							yield* breaks(
								worker,
								`a worker was not ready within the open bound of ${Duration.format(Duration.millis(spec.open))} and the grace (its runner config's load never ended, or its services never came), so it is ended and not forked again; what it last wrote:\n${worker.output}`
							)
							yield* endGroup(worker.child)
						}
						return
					case "sent":
						if (Option.isNone(worker.running)) {
							yield* watch(worker, event.unit, "readying")
						}
						return
					case "silent":
						if (
							Option.exists(
								worker.running,
								(running) => running.unit.id === event.unit && running.phase === event.phase
							)
						) {
							yield* endGroup(worker.child)
						}
						return
					case "exit": {
						yield* endGroup(worker.child)
						const wasReady = worker.ready
						const lost = yield* settle(worker)
						const requeued = Arr.filter(worker.sent, (unit) =>
							Option.match(lost, {
								onNone: () => true,
								onSome: (running) => running.unit.id !== unit.id
							})
						)
						worker.sent = []
						worker.ready = false
						Option.map(lost, ({ unit, phase }) => {
							const how = event.signal ?? `exit ${event.code}`
							const report = `${lostIn(unit, phase)} ended (${how}), past its bound and grace or by a crash; what it last wrote:\n${worker.output}`
							finish(worker, unit, doneWith(unit.work, lostResult(report)))
						})
						handBack(worker, [])
						scheduler.requeue(requeued)
						scheduler.forget(worker.index)
						if (!wasReady) {
							yield* breaks(
								worker,
								`a worker ended (${event.signal ?? `exit ${event.code}`}) before it was ready, so it is not forked again; what it last wrote:\n${worker.output}`
							)
						}
						if (!closing && !broken.has(worker.index)) {
							const replacement = spawn(worker.index)
							workers[worker.index] = replacement
						}
						feedAll()
						return
					}
					case "message": {
						const decoded = decode(event.message)
						if (Option.isNone(decoded)) {
							return
						}
						const received = decoded.value
						switch (received.kind) {
							case "ready":
								worker.usage.started = received.cpu
								worker.usage.reported = received.cpu
								starts.count += 1
								starts.millis += received.millis
								worker.ready = true
								feedAll()
								return
							case "failed":
								worker.output = Str.slice(-OUTPUT_TAIL)(`${worker.output}${received.message}\n`)
								if (!worker.ready) {
									yield* breaks(worker, received.message)
								}
								return
							case "readying":
								yield* watch(worker, received.unit, "readying")
								return
							case "readied":
								Option.map(
									Arr.findFirst(worker.sent, (sent) => sent.id === received.unit),
									(unit) => {
										scheduler.readied(worker.index, unit.module, unit.property, {
											importing: received.imported,
											opening: Math.max(0, received.millis - received.imported)
										})
										worker.readyingMillis += received.millis
										spent(unit.property, {
											cases: 0,
											casesCpu: 0,
											readyingCpu: received.cpu,
											childrenCpu: childrenMillis(received.children)
										})
										afterFinished(scheduler, view, apply, worker.index, unit.module)
										grow()
									}
								)
								return
							case "started":
								yield* watch(worker, received.unit, "evaluating")
								return
							case "done": {
								worker.usage.reported = received.cpu
								const unit = Arr.findFirst(worker.sent, (sent) => sent.id === received.unit)
								if (Option.isSome(unit)) {
									yield* settle(worker)
									scheduler.occupied(
										worker.index,
										unit.value.property,
										ranOf(received.done).cases,
										Math.max(0, now - worker.occupiedSince - worker.readyingMillis)
									)
									worker.occupiedSince = now
									worker.readyingMillis = 0
									finish(worker, unit.value, received.done)
									spent(unit.value.property, {
										cases: 0,
										casesCpu: 0,
										readyingCpu: 0,
										childrenCpu: childrenMillis(received.children)
									})
									afterFinished(scheduler, view, apply, worker.index, unit.value.module)
									grow()
								}
								return
							}
							case "misused": {
								const marks = lateUses.get(received.unit) ?? new Map<number, Printed>()
								marks.set(received.at, received.printed)
								lateUses.set(received.unit, marks)
								return
							}
							case "closure": {
								const module = received.module
								yield* Effect.forkIn(
									Effect.flatMap(Effect.result(closures.hashOf(module)), (hashed) =>
										Effect.sync(() => {
											send(worker, {
												kind: "closure",
												module,
												answer: Result.match(hashed, {
													onSuccess: (hash) => ({ kind: "hashed", hash }),
													onFailure: (failure) => ({ kind: "unhashed", message: failure.message })
												})
											})
										})
									),
									scope
								)
								return
							}
							case "revoked": {
								const revoked = new Set(received.units)
								const given = Arr.filter(worker.sent, (unit) => revoked.has(unit.id))
								worker.sent = Arr.filter(worker.sent, (unit) => !revoked.has(unit.id))
								handBack(worker, given)
								feedAll()
								return
							}
						}
					}
				}
			})

		yield* Effect.forkIn(Effect.forever(Effect.flatMap(Queue.take(events), handle)), scope)
		yield* Effect.addFinalizer(() =>
			Effect.andThen(
				Effect.sync(() => {
					closing = true
				}),
				Effect.forEach(
					workers,
					(worker) =>
						Effect.andThen(
							Effect.raceFirst(
								Effect.callback<void>((resume) => {
									if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
										resume(Effect.void)
										return
									}
									worker.child.once("exit", () => resume(Effect.void))
									if (worker.child.connected) {
										worker.child.disconnect()
									}
								}),
								Effect.sleep(Duration.millis(SILENCE_GRACE_MILLIS))
							),
							endGroup(worker.child)
						),
					{ concurrency: "unbounded", discard: true }
				)
			).pipe(Effect.uninterruptible)
		)

		const enqueue = (work: Work): Unit => {
			unitIds += 1
			const { property, cases } = workOf(work)
			const unit: Unit = {
				id: unitIds,
				work,
				property,
				module: moduleOfLabel(property),
				cases,
				done: Deferred.makeUnsafe<Done>()
			}
			scheduler.enqueue(unit)
			return unit
		}

		/**
		 * Queues units and gives back what each gave, in order, through the first that `stops`: the units after it that
		 * have not started are taken out of the queue, and those that have run to their end are not read. A search that
		 * stops waiting (a witness that failed while its rotating stream was out) takes its unstarted units out too.
		 */
		const ranInOrder = <A>(
			works: ReadonlyArray<Work>,
			read: (done: Done) => A,
			stops: (read: A) => boolean
		): Effect.Effect<ReadonlyArray<readonly [Unit, A]>> =>
			Effect.gen(function* () {
				now = yield* liveMillis
				const units = Arr.map(works, enqueue)
				for (const module of new Set(Arr.map(units, (unit) => unit.module))) {
					afterQueued(scheduler, view, apply, module)
				}
				grow()
				const given: Array<readonly [Unit, A]> = []
				return yield* Effect.gen(function* () {
					for (const [at, unit] of units.entries()) {
						const answered = yield* Deferred.await(unit.done)
						const done = read(answered)
						given.push([unit, done])
						if (stops(done)) {
							scheduler.drop(new Set(Arr.map(Arr.drop(units, at + 1), (other) => other.id)))
							return given
						}
					}
					return given
				}).pipe(
					Effect.onInterrupt(() =>
						Effect.sync(() => {
							scheduler.drop(new Set(Arr.map(Arr.drop(units, given.length), (other) => other.id)))
						})
					)
				)
			})

		const evaluator: Evaluator = {
			evaluate: (batches, stop) =>
				Effect.map(
					ranInOrder(
						Arr.map(batches, (batch): Work => ({ kind: "cases", batch })),
						resultsOf,
						(results) => Arr.some(results, stop)
					),
					(given) => {
						const marked = withLateUses(
							Arr.map(given, ([, results]) => results),
							(batchAt, at) =>
								Option.flatMap(Arr.get(given, batchAt), ([unit]) =>
									Option.fromUndefinedOr(lateUses.get(unit.id)?.get(at))
								),
							stop
						)
						for (const [unit] of given) {
							lateUses.delete(unit.id)
						}
						return marked
					}
				),
			series: (orders) =>
				Effect.map(
					ranInOrder(
						Arr.map(orders, (series): Work => ({ kind: "series", series })),
						seriesRanOf,
						(ran) => ran.stopped.kind === "stopped"
					),
					Arr.map(([, ran]) => ran)
				),
			count: (order) =>
				Effect.map(
					ranInOrder([{ kind: "count", count: order }], countAnswerOf, () => false),
					(given): CountAnswer =>
						Option.match(Arr.head(given), {
							onNone: () => ({ kind: "stopped", result: lostResult(uncounted) }),
							onSome: ([, answer]) => answer
						})
				),
			width: Effect.sync(() => Math.max(1, Arr.filter(workers, idle).length - scheduler.queued())),
			workers: spec.workers
		}
		return {
			evaluator,
			retire: (property) =>
				Effect.sync(() => {
					for (const worker of workers) {
						if (worker.ready && worker.child.connected) {
							send(worker, { kind: "retire", property })
						}
					}
				}),
			cases: Effect.sync(() => Arr.take(counts, workers.length)),
			held: Effect.sync(() => Arr.take(scheduler.held(), workers.length)),
			usage: Effect.sync((): PoolUsage => ({
				properties: Arr.fromIterable(properties.values()),
				workers: Arr.map(processes, (usage) => ({ ...usage })),
				children: childrenStated
			}))
		}
	})
