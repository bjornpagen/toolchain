import { type Context, Deferred, Effect, type FileSystem, Scope } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { type Reservation, reserved } from "#pg/lease.ts"
import { NeedFailed, RunLease } from "#runner/services.ts"

/**
 * A run's leases on the clusters its needs reach (pg/lease.ts): one reservation a cluster, by its gate, held for the
 * run's life however many of its workers ask, each asker its answer. The run's parent holds them (pool.ts) and answers
 * its workers' asks, so the run, not a worker, holds what its workers use; an inline run holds its own.
 */

/** A lease's answer, as the parent sends it to a worker: held, or refused and why. */
export type LeaseAnswer =
	| Readonly<{ kind: "leased" }>
	| Readonly<{ kind: "refused"; message: string }>

/** The asks of one reservation, by its gate, each awaiting the one answer. */
const askedOnce = (
	asked: Map<string, Deferred.Deferred<void, NeedFailed>>,
	reservation: Reservation,
	first: Effect.Effect<void>
): Effect.Effect<void, NeedFailed> =>
	Effect.suspend(() => {
		const held = asked.get(reservation.gate)
		if (held !== undefined) {
			return Deferred.await(held)
		}
		const made = Deferred.makeUnsafe<void, NeedFailed>()
		asked.set(reservation.gate, made)
		return Effect.andThen(first, Deferred.await(made))
	})

/** The need a refused lease fails. */
const refusedLease = (message: string): NeedFailed =>
	NeedFailed.make({ need: "the local cluster's lease", message })

/**
 * The RunLease of a run that holds its reservations itself, in `scope`, the run's: the run's parent, which answers its
 * workers with it, and an inline run.
 */
export const runLeasesIn = (
	scope: Scope.Scope,
	platform: Context.Context<FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner>
): Context.Service.Shape<typeof RunLease> => {
	const asked = new Map<string, Deferred.Deferred<void, NeedFailed>>()
	return RunLease.of({
		reserve: (reservation) =>
			askedOnce(
				asked,
				reservation,
				Effect.flatMap(
					Effect.result(
						Scope.provide(Effect.provideContext(reserved(reservation), platform), scope)
					),
					(held) =>
						Effect.suspend(() => {
							const made = asked.get(reservation.gate)
							return made === undefined
								? Effect.void
								: Effect.asVoid(
										held._tag === "Success"
											? Deferred.succeed(made, undefined)
											: Deferred.fail(made, refusedLease(held.failure.message))
									)
						})
				)
			)
	})
}

/** A worker's RunLease, and where its message loop hands it the parent's answers. */
export type AskedLeases = Readonly<{
	service: Context.Service.Shape<typeof RunLease>
	answered: (gate: string, answer: LeaseAnswer) => Effect.Effect<void>
}>

/** The RunLease of a worker that asks the run's parent through `ask`: one ask a cluster, every caller its answer. */
export const askedLeasesOf = (
	ask: (reservation: Reservation) => Effect.Effect<void>
): AskedLeases => {
	const asked = new Map<string, Deferred.Deferred<void, NeedFailed>>()
	return {
		service: RunLease.of({
			reserve: (reservation) => askedOnce(asked, reservation, ask(reservation))
		}),
		answered: (gate, answer) =>
			Effect.suspend(() => {
				const held = asked.get(gate)
				if (held === undefined) {
					return Effect.void
				}
				switch (answer.kind) {
					case "leased":
						return Effect.asVoid(Deferred.succeed(held, undefined))
					case "refused":
						return Effect.asVoid(Deferred.fail(held, refusedLease(answer.message)))
				}
			})
	}
}
