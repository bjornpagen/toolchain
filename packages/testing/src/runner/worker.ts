import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Array as Arr, Context, Effect, Latch, Option, Queue, Schema, Scope } from "effect"
import { LateUses, NeedCache, needCacheOf, Stopped, stoppedOf } from "#runner/case.ts"
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
 * hand to an idle worker. A property's module is imported the first time a unit of it arrives and stays loaded; a
 * need is opened the first time a case here takes it and stays open, in the worker's scope, until the parent
 * disconnects. When its run guides a search by blocks, it starts V8's precise coverage before it loads any module.
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

	const evaluate = (unit: Unit) =>
		Effect.andThen(
			send({ kind: "started", unit: unit.unit }),
			Effect.matchEffect(propertyAt(root, runOfLabel(Arr.headNonEmpty(unit.batch).property).id), {
				onFailure: (failed) =>
					send({
						kind: "done",
						unit: unit.unit,
						results: Arr.map(unit.batch, () => lostResult(failed.message))
					}),
				onSuccess: (property) =>
					Effect.flatMap(
						property.evaluate(unit.batch).pipe(
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
						),
						(results) => send({ kind: "done", unit: unit.unit, results })
					)
			})
		)

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
