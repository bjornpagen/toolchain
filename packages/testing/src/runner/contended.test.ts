/**
 * Two runs contend for one family (runner/leases.ts, runner/work.ts Held): a run of its own holds a family's one slot,
 * a process apart, as another lane's suite holds a shared family's slots, for longer than the need of a worker of the
 * other run may take to open and than that worker's pool waits on it, and the worker's need asks its run for the
 * family's lease, which its run's parent waits for. The worker's wait is a wait for the lease's locks, which its own
 * guards and its pool judge by the work of the run that holds them, not by the worker's CPU: behind a holder whose tree
 * works, the worker waits as long as the hold lasts and its case passes once the holder lets go (where it was ended at
 * its open bound at no CPU: 5442's installs, 2026-11-20); behind a holder that has stopped, its need fails to open,
 * stalled at its open bound. The family is a lease directory of the case's own, one member admitting one worker; no
 * server is involved. Oracle: the specification, stated in the check.
 */
import { Array as Arr, Effect, Option } from "effect"
import { assert } from "#assert.ts"
import { Checkout } from "#mutate/checkout.ts"
import { property } from "#property.ts"
import { Scratch } from "#resources/scratch.ts"
import { heldApart, holders, OPEN_MILLIS, outcomeBehind } from "#runner/contended.fixtures.ts"
import { runOfItsOwn } from "#runner/leases.ts"
import { runnerLimits } from "#runner/limits.ts"
import {
	NESTED_RESERVATION,
	oneSlotReservation,
	RESERVES,
	reservationText
} from "#runner/nested.fixtures.ts"
import { shortCase } from "#runner/pool.fixtures.ts"
import { placesOf, poolOf } from "#runner/pool.ts"
import { WORKER_ENTRY } from "#runner/run.ts"

export const contendedLeaseWaits = property.exhaust(holders, {
	box: "a worker whose need waits for a family's one slot, which another run holds past the need's open bound and the pool's bound and grace, working or stopped",
	needs: { checkout: Checkout.dir, directory: Scratch.dir },
	situations: [],
	check:
		({ checkout, directory }) =>
		(holder) =>
			Effect.scoped(
				Effect.gen(function* () {
					const root = yield* checkout
					const scratch = yield* directory
					const reservation = yield* oneSlotReservation(scratch)
					yield* heldApart(reservation, holder)
					const text = yield* reservationText(reservation)
					const outcomes = yield* runOfItsOwn(
						Effect.gen(function* () {
							const pool = yield* poolOf({
								entry: WORKER_ENTRY,
								root,
								cwd: root,
								env: { [NESTED_RESERVATION]: text },
								places: placesOf(1),
								execArgv: process.execArgv,
								served: Option.none(),
								guide: "notes",
								open: OPEN_MILLIS
							})
							const results = yield* pool.evaluator.evaluate(
								[shortCase(RESERVES, runnerLimits.deadline, OPEN_MILLIS)],
								() => true
							)
							return Arr.map(Arr.flatten(results), (result) =>
								result.outcome.kind === "lost"
									? result.outcome.report
									: result.outcome.kind === "unopened" && holder === "a holder that works"
										? result.outcome.message
										: result.outcome.kind
							)
						})
					)
					assert.deepEqual(outcomes, [outcomeBehind(holder)])
				})
			),
	oracle: {
		kind: "specification",
		name: "a worker's wait for its run's lease is judged by the work of the run that holds the slots: behind a holder that works it outlasts its need's open bound and its pool's bound and grace and passes, and behind one that has stopped its need is stalled at its open bound"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/leases.ts",
			original:
				"waitingFor(reservationFiles(reservation))(askedOnce(asked, reservation, ask(reservation)))",
			replacement: "askedOnce(asked, reservation, ask(reservation))",
			why: "A worker's ask for its run's lease is no declared wait, as it was: the worker spends nothing while its run's parent waits for the slots another run holds, so its need is stalled at its open bound whatever the holder does (5442's installs, 2026-11-20); the property fails behind the holder that works."
		},
		{
			file: "packages/testing/src/runner/work.ts",
			original:
				"\t!sameRuns(before.held.runs, after.held.runs) ||\n\tafter.held.cpu > before.held.cpu ||\n\tstirred(before.held.stir, after.held.stir) ||\n",
			replacement: "",
			why: "A lock wait's holders' work never moves for the waiter, so a worker behind a holder that works is judged by its own CPU, which waiting spends none of, and stalled at its open bound; the property fails behind the holder that works."
		},
		{
			file: "packages/testing/src/live.ts",
			original:
				"\t\t\tEffect.sync(() => enterLockWait(files)),\n\t\t\t() => effect,\n\t\t\t() => Effect.sync(() => leaveLockWait(files))",
			replacement:
				"\t\t\tEffect.flatMap(liveMillis, (wall) => Effect.sync(() => enterWait(wall, files[0]))),\n\t\t\t() => effect,\n\t\t\t() => Effect.flatMap(liveMillis, (wall) => Effect.sync(() => leaveWait(wall, files[0])))",
			why: "A lock wait is a wait on work whose wall time no stall counts (TOOLCHAIN5's e094331), so a worker behind a holder that has stopped waits as long as the hold lasts and passes, where it waits on nothing that will come; the property fails behind the holder that stops."
		}
	]
})
