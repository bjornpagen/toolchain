import { messageWorkMillis } from "@bjornpagen/limits"
import {
	Array as Arr,
	Deferred,
	Duration,
	Effect,
	Fiber,
	Option,
	Queue,
	Schema,
	Scope,
	String as Str
} from "effect"
import { HUNG_CLEANUP_GRACE, WATCHDOG_GRACE_MILLIS } from "#live.ts"
import { withLateUses } from "#runner/case.ts"
import {
	type Batch,
	type CaseResult,
	type Evaluator,
	FromWorker,
	lostResult,
	type Printed,
	type ToWorker
} from "#runner/protocol.ts"

/**
 * The pool: worker processes, one a core, that evaluate the cases of every property of a run, and the parent's side of
 * them. Every search's evaluator puts its batches (units) on one queue; an idle worker is sent a message of units of
 * one property, as many as fill @bjornpagen/limits's messageWorkMillis at the property's measured mean case time (one
 * while the property has none), never more than its fair share of what is queued (what is queued over the workers);
 * a worker that goes idle with nothing queued
 * takes the unstarted tail of the busiest worker's units, which the parent revokes from it. A unit that runs past its
 * cases' deadlines and the watchdog's grace has a silent worker: the parent kills it, reports the unit lost, and
 * forks a new worker in its place. Which worker ran a case never reaches a result, so a search finds the same at any
 * width.
 */

/** One unit of work: a batch of one property's orders, and where its results go. */
type Unit = Readonly<{
	id: number
	batch: Batch
	property: string
	done: Deferred.Deferred<ReadonlyArray<CaseResult>>
}>

/** A worker process and what the parent knows of it: the units it was sent and has not finished, the one it runs and
 * since when, how many cases it finished, and the last of what it wrote. */
type Worker = {
	readonly index: number
	child: ChildProcess
	ready: boolean
	sent: Array<Unit>
	running: Option.Option<Readonly<{ unit: Unit; silence: Fiber.Fiber<void> }>>
	revoking: boolean
	output: string
}

/** How much of what a worker wrote the parent keeps, to report a lost case with: the end of it. */
const OUTPUT_TAIL = 16_384

/**
 * What the pool's workers start from: the worker's entry module, the package root its test modules load from, the
 * directory it runs in, its Node flags and what its environment adds to this process's; how many workers (one a core
 * for a run); and whether any search guides by blocks (each worker then starts V8's coverage before it loads a module).
 * A worker the parent kills is forked again from the same spec.
 */
export type PoolSpec = Readonly<{
	entry: string
	root: string
	cwd: string
	env: Readonly<Record<string, string>>
	workers: number
	execArgv: ReadonlyArray<string>
	guide: "notes" | "blocks"
}>

/** The pool as a run uses it: the evaluator every search shares, and how many cases each worker finished. */
export type Pool = Readonly<{ evaluator: Evaluator; cases: Effect.Effect<ReadonlyArray<number>> }>

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

/** What happens to a worker, as the pool's one fiber handles it, in order: a message, its exit, or its silence past a
 * unit's deadline and grace. */
type Event =
	| Readonly<{ kind: "message"; worker: Worker; message: unknown }>
	| Readonly<{ kind: "exit"; worker: Worker; code: number | null; signal: string | null }>
	| Readonly<{ kind: "silent"; worker: Worker; unit: number }>

/**
 * How long past a unit's deadlines (each case's, added up) the parent waits before it kills a worker that has not
 * answered: the watchdog's grace twice (its ping's, then its inspector's, should the main thread be blocked), and the
 * cleanup grace a hung case's guard waits; past that the worker's own guards have failed.
 */
const SILENCE_GRACE_MILLIS = 2 * WATCHDOG_GRACE_MILLIS + Duration.toMillis(HUNG_CLEANUP_GRACE)

/** Forks the pool's workers, in the run's scope: each is disconnected, and so ends, when the scope closes. */
export const poolOf = (spec: PoolSpec): Effect.Effect<Pool, PoolFailed, Scope.Scope> =>
	Effect.gen(function* () {
		const scope = yield* Scope.Scope
		const events = yield* Queue.unbounded<Event>()
		const queue: Array<Unit> = []
		const workers: Array<Worker> = []
		const counts: Array<number> = Array.from({ length: spec.workers }, () => 0)
		const lateUses = new Map<number, Map<number, Printed>>()
		const broken = new Set<number>()
		const started = yield* Deferred.make<void, PoolFailed>()
		let unitIds = 0
		let closing = false

		const send = (worker: Worker, message: ToWorker) => {
			worker.child.send(message)
		}

		/** A property's measured case time so far: cases finished and their milliseconds. */
		const measured = new Map<string, Readonly<{ cases: number; millis: number }>>()

		/**
		 * How many units of `property` one message carries: as many as fill the work a message aims for at the property's
		 * mean case time, one while it has none, and never more than its fair share of what is queued.
		 */
		const perMessage = (property: string): number => {
			const fair = Math.max(1, Math.ceil(queue.length / workers.length))
			return Option.match(Option.fromUndefinedOr(measured.get(property)), {
				onNone: () => 1,
				onSome: (stats) =>
					Math.max(
						1,
						Math.min(
							fair,
							Math.floor(
								(messageWorkMillis.value * stats.cases) / Math.max(stats.millis, Number.MIN_VALUE)
							)
						)
					)
			})
		}

		const idle = (worker: Worker) => worker.ready && worker.sent.length === 0

		/** Sends an idle worker the next units of the queue's first property, or steals for it when nothing is queued. */
		const feed = (worker: Worker) => {
			if (!idle(worker) || closing) {
				return
			}
			const first = Arr.head(queue)
			if (Option.isNone(first)) {
				steal()
				return
			}
			const property = first.value.property
			const count = perMessage(property)
			const taken: Array<Unit> = []
			for (let at = 0; at < queue.length && taken.length < count;) {
				const unit = Arr.getUnsafe(queue, at)
				if (unit.property === property) {
					taken.push(unit)
					queue.splice(at, 1)
				} else {
					at += 1
				}
			}
			worker.sent = taken
			const units = Arr.map(taken, (unit) => ({ unit: unit.id, batch: unit.batch }))
			if (Arr.isReadonlyArrayNonEmpty(units)) {
				send(worker, { kind: "evaluate", units })
			}
		}

		/** Puts units back at the head of the queue, in their order: they were queued before anything there. */
		const requeue = (units: ReadonlyArray<Unit>) => {
			for (const unit of Arr.reverse(units)) {
				queue.unshift(unit)
			}
		}

		const feedAll = () => {
			for (const worker of workers) {
				feed(worker)
			}
		}

		/** Revokes the unstarted tail of the busiest worker's units, for the idle ones. */
		const steal = () => {
			const unstartedOf = (worker: Worker) =>
				Arr.filter(worker.sent, (unit) =>
					Option.match(worker.running, {
						onNone: () => true,
						onSome: (running) => running.unit.id !== unit.id
					})
				)
			const busiest = Arr.reduce(workers, Option.none<Worker>(), (best, worker) =>
				!worker.revoking &&
				unstartedOf(worker).length >= 2 &&
				Option.match(best, {
					onNone: () => true,
					onSome: (other) => unstartedOf(worker).length > unstartedOf(other).length
				})
					? Option.some(worker)
					: best
			)
			Option.map(busiest, (worker) => {
				const unstarted = unstartedOf(worker)
				const tail = Arr.drop(unstarted, Math.ceil(unstarted.length / 2))
				worker.revoking = true
				send(worker, { kind: "revoke", units: Arr.map(tail, (unit) => unit.id) })
			})
		}

		const finish = (worker: Worker, unit: Unit, results: ReadonlyArray<CaseResult>) => {
			worker.sent = Arr.filter(worker.sent, (sent) => sent.id !== unit.id)
			counts[worker.index] = (counts[worker.index] ?? 0) + results.length
			const before = measured.get(unit.property) ?? { cases: 0, millis: 0 }
			measured.set(unit.property, {
				cases: before.cases + results.length,
				millis: Arr.reduce(results, before.millis, (total, result) => total + result.millis)
			})
			Deferred.doneUnsafe(unit.done, Effect.succeed(results))
		}

		const deadlineOf = (unit: Unit) =>
			Arr.reduce(unit.batch, 0, (total, order) => total + order.deadline) + SILENCE_GRACE_MILLIS

		const spawn = (index: number): Worker => {
			const child = childProcesses.fork(
				spec.entry,
				[spec.root, String(index), String(spec.workers), spec.guide],
				{
					cwd: spec.cwd,
					env: { ...process.env, ...spec.env },
					execArgv: Arr.copy(spec.execArgv),
					serialization: "advanced",
					stdio: ["ignore", "pipe", "pipe", "ipc"]
				}
			)
			const worker: Worker = {
				index,
				child,
				ready: false,
				sent: [],
				running: Option.none(),
				revoking: false,
				output: ""
			}
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
			return worker
		}

		/** Ends the watch on a worker's running unit. */
		const settle = (worker: Worker) =>
			Effect.gen(function* () {
				const running = worker.running
				worker.running = Option.none()
				if (Option.isSome(running)) {
					yield* Fiber.interrupt(running.value.silence)
				}
				return Option.map(running, (ran) => ran.unit)
			})

		/**
		 * A worker that cannot start (it failed before it was ready, or ended before it was): it is not forked again. Once
		 * every worker is so, the pool cannot run a case: its start fails with the last worker's report, and every unit
		 * queued or sent is given back lost with it, so no evaluator waits on a pool with no worker.
		 */
		const breaks = (worker: Worker, report: string) =>
			Effect.gen(function* () {
				broken.add(worker.index)
				if (broken.size < spec.workers) {
					return
				}
				yield* Deferred.fail(started, PoolFailed.make({ message: report }))
				const stranded = [...queue, ...Arr.flatMap(workers, (other) => other.sent)]
				queue.length = 0
				for (const other of workers) {
					other.sent = []
				}
				for (const unit of stranded) {
					Deferred.doneUnsafe(
						unit.done,
						Effect.succeed(Arr.map(unit.batch, () => lostResult(report)))
					)
				}
			})

		const handle = (event: Event): Effect.Effect<void> =>
			Effect.gen(function* () {
				const worker = event.worker
				switch (event.kind) {
					case "silent":
						if (Option.exists(worker.running, (running) => running.unit.id === event.unit)) {
							worker.child.kill("SIGKILL")
						}
						return
					case "exit": {
						const wasReady = worker.ready
						const lost = yield* settle(worker)
						const requeued = Arr.filter(worker.sent, (unit) =>
							Option.match(lost, {
								onNone: () => true,
								onSome: (running) => running.id !== unit.id
							})
						)
						worker.sent = []
						worker.ready = false
						Option.map(lost, (unit) => {
							const how = event.signal ?? `exit ${event.code}`
							const report = `the worker running it ended (${how}), past its deadline and grace or by a crash; what it last wrote:\n${worker.output}`
							finish(
								worker,
								unit,
								Arr.map(unit.batch, () => lostResult(report))
							)
						})
						requeue(requeued)
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
								worker.ready = true
								yield* Deferred.succeed(started, undefined)
								feed(worker)
								return
							case "failed":
								yield* breaks(worker, received.message)
								return
							case "started": {
								const unit = Arr.findFirst(worker.sent, (sent) => sent.id === received.unit)
								if (Option.isSome(unit)) {
									const silence = yield* Effect.forkIn(
										Effect.andThen(
											Effect.sleep(Duration.millis(deadlineOf(unit.value))),
											Queue.offer(events, { kind: "silent", worker, unit: received.unit })
										).pipe(Effect.asVoid),
										scope
									)
									worker.running = Option.some({ unit: unit.value, silence })
								}
								return
							}
							case "done": {
								const unit = Arr.findFirst(worker.sent, (sent) => sent.id === received.unit)
								if (Option.isSome(unit)) {
									yield* settle(worker)
									finish(worker, unit.value, received.results)
								}
								feed(worker)
								return
							}
							case "misused": {
								const marks = lateUses.get(received.unit) ?? new Map<number, Printed>()
								marks.set(received.at, received.printed)
								lateUses.set(received.unit, marks)
								return
							}
							case "revoked": {
								const revoked = new Set(received.units)
								const given = Arr.filter(worker.sent, (unit) => revoked.has(unit.id))
								worker.sent = Arr.filter(worker.sent, (unit) => !revoked.has(unit.id))
								worker.revoking = false
								requeue(given)
								feedAll()
								return
							}
						}
					}
				}
			})

		for (let index = 0; index < spec.workers; index += 1) {
			workers.push(spawn(index))
		}
		yield* Effect.forkIn(Effect.forever(Effect.flatMap(Queue.take(events), handle)), scope)
		yield* Effect.addFinalizer(() =>
			Effect.andThen(
				Effect.sync(() => {
					closing = true
				}),
				Effect.forEach(
					workers,
					(worker) =>
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
					{ concurrency: "unbounded", discard: true }
				)
			).pipe(Effect.uninterruptible)
		)
		yield* Deferred.await(started)

		const enqueue = (batch: Batch): Unit => {
			unitIds += 1
			const unit: Unit = {
				id: unitIds,
				batch,
				property: Arr.headNonEmpty(batch).property,
				done: Deferred.makeUnsafe<ReadonlyArray<CaseResult>>()
			}
			queue.push(unit)
			return unit
		}

		const evaluator: Evaluator = {
			evaluate: (batches, stop) =>
				Effect.gen(function* () {
					const units = Arr.map(batches, enqueue)
					feedAll()
					const results: Array<ReadonlyArray<CaseResult>> = []
					const judged = () => {
						const marked = withLateUses(
							results,
							(batchAt, at) =>
								Option.flatMap(Arr.get(units, batchAt), (unit) =>
									Option.fromUndefinedOr(lateUses.get(unit.id)?.get(at))
								),
							stop
						)
						for (const unit of units) {
							lateUses.delete(unit.id)
						}
						return marked
					}
					for (const [at, unit] of units.entries()) {
						const done = yield* Deferred.await(unit.done)
						results.push(done)
						if (!Arr.some(done, stop)) {
							continue
						}
						const later = new Set(Arr.map(Arr.drop(units, at + 1), (other) => other.id))
						const kept = Arr.filter(queue, (queued) => !later.has(queued.id))
						queue.length = 0
						for (const queued of kept) {
							queue.push(queued)
						}
						return judged()
					}
					return judged()
				}),
			width: Effect.sync(() => Math.max(1, Arr.filter(workers, idle).length - queue.length))
		}
		return { evaluator, cases: Effect.sync(() => Arr.copy(counts)) }
	})
