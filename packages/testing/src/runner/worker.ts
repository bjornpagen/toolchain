import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Array as Arr, Context, Effect, Latch, Option, Queue, Schema, Scope } from "effect"
import {
	LateUses,
	NeedCache,
	needCacheOf,
	type Readied,
	readiedOf,
	resultsOf,
	Stopped,
	stoppedOf
} from "#runner/case.ts"
import { askedClosuresOf } from "#runner/closure-requests.ts"
import { configOf, propertyAt } from "#runner/load.ts"
import { Perception, perceptionOf } from "#runner/perceive.ts"
import { type Batch, FromWorker, lostResult, ToWorker } from "#runner/protocol.ts"
import { ModuleClosure, WorkerIndex } from "#runner/services.ts"
import { runOfLabel } from "#runner/stack.ts"
import { startProcessCoverage } from "#sense.ts"

/**
 * A worker of the pool: a child process the parent forks, one a core, warm across properties. It loads the package's
 * runner config, then evaluates the units the parent sends, one at a time, in the order sent: it tells the parent when
 * it starts each, so the parent knows which are unstarted, and gives back the unstarted ones the parent revokes to
 * hand to an idle worker. The first unit of a property here readies it first, a phase of its own that it tells the
 * parent of: its module is imported (once, and it stays loaded) and its needs are opened within the open bound its
 * orders carry (each once per key, staying open in the worker's scope until the parent disconnects), before any case
 * of it starts and outside every case's deadline. A property that could not be readied (its module did not load, a
 * need did not open) gives every case of it here that one outcome. When its run guides a search by blocks, it starts
 * V8's precise coverage before it loads any module.
 *
 *   node runner/worker.ts <package root> <index> <workers> <notes | blocks>
 */

/** One unit the parent sent: its id, and the batch it evaluates. */
type Unit = Readonly<{ unit: number; batch: Batch }>

/** What the worker was forked with, from its arguments. */
const Arguments = Schema.Tuple([
	Schema.String,
	Schema.FiniteFromString,
	Schema.FiniteFromString,
	Schema.Literals(["notes", "blocks"])
])

/** Sends a message to the parent over the IPC channel the worker was forked with, now. */
const sendNow = (message: FromWorker): void => {
	process.send?.(message)
}

/** Sends a message to the parent over the IPC channel the worker was forked with. */
const send = (message: FromWorker): Effect.Effect<void> => Effect.sync(() => sendNow(message))

const main = Effect.gen(function* () {
	const [root, index, workers, guide] = yield* Schema.decodeUnknownEffect(Arguments)(
		Arr.drop(process.argv, 2)
	)
	if (guide === "blocks") {
		yield* startProcessCoverage
	}
	const config = yield* configOf(root)
	const scope = yield* Scope.Scope
	const platform = yield* Effect.context<NodeServices.NodeServices>()
	const closures = askedClosuresOf((module) => send({ kind: "closure", module }))
	const runner = Context.add(
		Context.add(
			Context.merge(Context.make(WorkerIndex, { index, workers }), platform),
			ModuleClosure,
			closures.service
		),
		Scope.Scope,
		scope
	)
	const services = yield* Effect.cached(
		Effect.map(Scope.provide(scope)(Effect.provideContext(config.services, runner)), (built) =>
			Context.merge(runner, built)
		)
	)
	const cache = needCacheOf(services)
	const stopped = stoppedOf()
	const perception = yield* perceptionOf
	const pending: Array<Unit> = []
	const work = Latch.makeUnsafe(false)
	const inbox = yield* Queue.unbounded<unknown>()
	process.on("message", (message: unknown) => {
		Queue.offerUnsafe(inbox, message)
	})
	process.on("disconnect", () => {
		Queue.offerUnsafe(inbox, { kind: "disconnect" })
	})
	const decode = Schema.decodeUnknownOption(ToWorker)

	const receive = Effect.gen(function* () {
		for (;;) {
			const message = yield* Queue.take(inbox)
			const decoded = decode(message)
			if (Option.isNone(decoded)) {
				return
			}
			const order = decoded.value
			switch (order.kind) {
				case "evaluate":
					for (const unit of order.units) {
						pending.push(unit)
					}
					work.openUnsafe()
					break
				case "revoke": {
					const revoked = new Set(order.units)
					const given = Arr.filter(pending, (unit) => revoked.has(unit.unit))
					const kept = Arr.filter(pending, (unit) => !revoked.has(unit.unit))
					pending.length = 0
					for (const unit of kept) {
						pending.push(unit)
					}
					yield* send({ kind: "revoked", units: Arr.map(given, (unit) => unit.unit) })
					break
				}
				case "closure":
					yield* closures.answered(order.module, order.answer)
					break
			}
		}
	})

	const readied = new Map<string, Readied>()

	/** A property readied here, its module imported and its needs opened within `bound`, before any case of it. */
	const ready = (label: string, bound: number): Effect.Effect<Readied> =>
		Effect.matchEffect(propertyAt(root, runOfLabel(label).id), {
			onFailure: (failed) =>
				Effect.succeed<Readied>({ kind: "refused", result: lostResult(failed.message) }),
			onSuccess: (property) =>
				readiedOf(property.ready, bound).pipe(Effect.provideService(NeedCache, cache))
		}).pipe(Effect.provideContext(platform))

	/** The unit's property as this worker readied it, readying it first, and telling the parent so, when it is new here. */
	const readiedFor = (unit: Unit): Effect.Effect<Readied> => {
		const first = Arr.headNonEmpty(unit.batch)
		return Option.match(Option.fromUndefinedOr(readied.get(first.property)), {
			onSome: Effect.succeed,
			onNone: () =>
				Effect.gen(function* () {
					yield* send({ kind: "readying", unit: unit.unit })
					const made = yield* ready(first.property, first.open)
					readied.set(first.property, made)
					return made
				})
		})
	}

	const evaluate = (unit: Unit) =>
		Effect.gen(function* () {
			const made = yield* readiedFor(unit)
			yield* send({ kind: "started", unit: unit.unit })
			const results = yield* resultsOf(made, unit.batch).pipe(
				Effect.provideService(NeedCache, cache),
				Effect.provideService(Perception, perception),
				Effect.provideService(Stopped, stopped),
				Effect.provideService(LateUses, {
					report: (order, printed) => {
						Option.map(
							Arr.findFirstIndex(unit.batch, (sent) => sent === order),
							(at) => sendNow({ kind: "misused", unit: unit.unit, at, printed })
						)
					}
				}),
				Effect.provideContext(platform)
			)
			yield* send({ kind: "done", unit: unit.unit, results })
		})

	const evaluating = Effect.gen(function* () {
		for (;;) {
			const next = pending.shift()
			if (next === undefined) {
				work.closeUnsafe()
				yield* work.await
				continue
			}
			yield* stopped.drained
			yield* evaluate(next)
		}
	})

	yield* send({ kind: "ready" })
	yield* Effect.raceFirst(receive, evaluating)
})

NodeRuntime.runMain(
	Effect.scoped(main).pipe(
		Effect.catchCause((cause) => send({ kind: "failed", message: String(cause) })),
		Effect.ensuring(Effect.sync(() => process.disconnect?.())),
		Effect.provide(NodeServices.layer)
	)
)
