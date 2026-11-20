import { Context, Deferred, Effect, type FileSystem, Scope } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { waitingFor } from "#live.ts"
import {
	familyOf,
	type Placement,
	type Reservation,
	reservationFiles,
	reserved
} from "#pg/lease.ts"
import { NeedFailed, RunLease } from "#runner/services.ts"

/**
 * A run's leases on the clusters its needs reach (pg/lease.ts): one reservation a cluster, by its family, held for the
 * run's life however many of its workers ask, each asker its answer, where the reservation put the run's workers. A run of its own (a command, a program: runOfItsOwn)
 * holds them, and its pool's parent answers its workers' asks with them (pool.ts), so the run, not a worker, holds what
 * its workers use. A run a case starts (a pool, an inline search) is no run of its own: it draws on the lease of the run
 * the case runs in, its worker's (askedLeasesOf), which asks that run's parent, so a nested run never reserves again
 * what its enclosing run holds, where it waited on those slots for ever (trialTemplatesApart's kill trials under a gate
 * run that held every slot of 5441).
 */

/** A lease's answer, as the parent sends it to a worker: held, with where it put the run's workers, or refused and why. */
export type LeaseAnswer =
	| Readonly<{ kind: "leased"; members: Placement }>
	| Readonly<{ kind: "refused"; message: string }>

/** The asks of one reservation, by its family, each awaiting the one answer. */
const askedOnce = (
	asked: Map<string, Deferred.Deferred<Placement, NeedFailed>>,
	reservation: Reservation,
	first: Effect.Effect<void>
): Effect.Effect<Placement, NeedFailed> =>
	Effect.suspend(() => {
		const held = asked.get(familyOf(reservation))
		if (held !== undefined) {
			return Deferred.await(held)
		}
		const made = Deferred.makeUnsafe<Placement, NeedFailed>()
		asked.set(familyOf(reservation), made)
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
	const asked = new Map<string, Deferred.Deferred<Placement, NeedFailed>>()
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
							const made = asked.get(familyOf(reservation))
							return made === undefined
								? Effect.void
								: Effect.asVoid(
										held._tag === "Success"
											? Deferred.succeed(made, held.success)
											: Deferred.fail(made, refusedLease(held.failure.message))
									)
						})
				)
			)
	})
}

/**
 * The lease a pool or an inline search draws on: its context's RunLease, the lease of the run it is started in (a
 * command's own, runOfItsOwn; a worker's, askedLeasesOf, when a case starts it), never one of its own, so a run nested in
 * another's case is answered from what that run holds and never waits on it.
 */
export const drawnLease = Effect.service(RunLease)

/**
 * `effect` as a run of its own: the RunLease it, and every run it starts, draws on, held in a scope of its own that ends
 * with it (runLeasesIn). A command's and a program's run is one; a run a case starts never is: it draws on the lease of
 * the run the case runs in (CheckContext's RunLease).
 */
export const runOfItsOwn = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.scoped(
		Effect.flatMap(
			Effect.context<
				Scope.Scope | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
			>(),
			(context) =>
				Effect.provideService(
					effect,
					RunLease,
					runLeasesIn(Context.get(context, Scope.Scope), context)
				)
		)
	)

/** A worker's RunLease, and where its message loop hands it the parent's answers. */
export type AskedLeases = Readonly<{
	service: Context.Service.Shape<typeof RunLease>
	answered: (family: string, answer: LeaseAnswer) => Effect.Effect<void>
}>

/**
 * The RunLease of a worker that asks the run's parent through `ask`: one ask a cluster, every caller its answer. A
 * caller waits for the answer as a wait for the reservation's locks (live.ts waitingFor), which the parent takes for it:
 * the worker's guards and its pool's judge it by the work of the runs that hold them, so a worker whose run waits behind
 * another run's slots is not stalled for it (5442's installs, 2026-11-20, ended at their open bound at no CPU while a
 * full suite held the slots), and one whose lock is held by a run that encloses its own is deadlocked.
 */
export const askedLeasesOf = (
	ask: (reservation: Reservation) => Effect.Effect<void>
): AskedLeases => {
	const asked = new Map<string, Deferred.Deferred<Placement, NeedFailed>>()
	return {
		service: RunLease.of({
			reserve: (reservation) =>
				waitingFor(reservationFiles(reservation))(askedOnce(asked, reservation, ask(reservation)))
		}),
		answered: (family, answer) =>
			Effect.suspend(() => {
				const held = asked.get(family)
				if (held === undefined) {
					return Effect.void
				}
				switch (answer.kind) {
					case "leased":
						return Effect.asVoid(Deferred.succeed(held, answer.members))
					case "refused":
						return Effect.asVoid(Deferred.fail(held, refusedLease(answer.message)))
				}
			})
	}
}
