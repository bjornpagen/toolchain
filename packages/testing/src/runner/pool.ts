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
import {
	type Batch,
	type CaseResult,
	type Evaluator,
	FromWorker,
	lostResult,
	type ToWorker
} from "#runner/protocol.ts"

/**
 * The pool: worker processes, one a core, that evaluate the cases of every property of a run, and the parent's side of
 * them. Every search's evaluator puts its batches (units) on one queue; an idle worker is sent a message of units of
 * one property, its fair share of what is queued (what is queued over the workers, one at least), so a long queue goes
 * out in few messages and a short one spreads over every worker; a worker that goes idle with nothing queued
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
 * What the pool is forked to run: the package root, how many workers (one a core), their flags, and whether any
 * search guides by blocks (each worker then starts V8's coverage before it loads a module).
 */
export type PoolSpec = Readonly<{
	root: string
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
		const broken = new Set<number>()
		const started = yield* Deferred.make<void, PoolFailed>()
		let unitIds = 0
		let closing = false

		const send = (worker: Worker, message: ToWorker) => {
			worker.child.send(message)
		}

		/** How many units of a property one message carries: its fair share of what is queued, one at least. */
		const perMessage = (): number => Math.max(1, Math.ceil(queue.length / workers.length))

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
			const count = perMessage()
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
			Deferred.doneUnsafe(unit.done, Effect.succeed(results))
		}

		const deadlineOf = (unit: Unit) =>
			Arr.reduce(unit.batch, 0, (total, order) => total + order.deadline) + SILENCE_GRACE_MILLIS

		const spawn = (index: number): Worker => {
			const child = childProcesses.fork(
				`${import.meta.dirname}/worker.ts`,
				[spec.root, String(index), String(spec.workers), spec.guide],
				{
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
								broken.add(worker.index)
								if (broken.size === spec.workers) {
									yield* Deferred.fail(started, PoolFailed.make({ message: received.message }))
								}
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
			Effect.sync(() => {
				closing = true
				for (const worker of workers) {
					worker.child.disconnect()
				}
			})
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
						return results
					}
					return results
				}),
			width: Effect.sync(() => Math.max(1, Arr.filter(workers, idle).length - queue.length))
		}
		return { evaluator, cases: Effect.sync(() => Arr.copy(counts)) }
	})
