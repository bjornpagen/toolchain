/**
 * A run a case starts, a pool of its own workers or an inline search in the case's process, draws on the lease of the
 * run the case runs in (leases.ts drawnLease, CheckContext's RunLease): a need of the nested run that takes the lease of
 * a cluster its enclosing run is waiting for joins that run's ask, is answered with it, and the nested run completes,
 * reserving nothing again. Before, a nested run held leases of its own and reserved again what its enclosing run held,
 * waiting on those slots for ever: trialTemplatesApart's kill trials deadlocked under a gate run that held every slot of
 * 5441. Once the enclosing run holds its lease, a run the case starts finds it in its environment too (pg/lease.ts
 * LEASED, lease.test.ts's nested properties); the ask that comes while the enclosing run still waits finds it only
 * through the run it is started in, which is why each case asks then. Each case's cluster is a lease directory of the
 * case's own, one member admitting one worker, whose slot another lease holds while the enclosing run asks for it, and
 * which is let go once the nested run asks too; no server is involved. Oracle: the specification, stated in the check.
 */
import { Array as Arr, Deferred, Effect, Fiber, Option } from "effect"
import { assert } from "#assert.ts"
import { awaitFact } from "#fact.ts"
import { Checkout } from "#mutate/checkout.ts"
import { heldUntil, shieldsIn } from "#pg/lease.fixtures.ts"
import { familyOf } from "#pg/lease.ts"
import { property } from "#property.ts"
import { Scratch } from "#resources/scratch.ts"
import { inlineRun, searchInline } from "#runner/inline.ts"
import { runnerLimits } from "#runner/limits.ts"
import {
	NESTED_RESERVATION,
	nestedRuns,
	oneSlotReservation,
	RESERVES,
	reservationText,
	reservesOn
} from "#runner/nested.fixtures.ts"
import { shortCase } from "#runner/pool.fixtures.ts"
import { placesOf, poolOf } from "#runner/pool.ts"
import { WORKER_ENTRY } from "#runner/run.ts"
import { RunLease } from "#runner/services.ts"
import { lockWaitsNow } from "#runner/work.ts"

export const nestedRunsDrawOnTheirRun = property.exhaust(nestedRuns, {
	box: "a pool a case starts and an inline search a case runs, each needing the lease of a cluster its enclosing run waits for",
	needs: { checkout: Checkout.dir, directory: Scratch.dir },
	situations: [],
	check:
		({ checkout, directory }) =>
		(nested) =>
			Effect.gen(function* () {
				const root = yield* checkout
				const scratch = yield* directory
				const reservation = yield* oneSlotReservation(scratch)
				const enclosing = yield* RunLease
				const release = yield* Deferred.make<void>()
				const other = yield* heldUntil(reservation, release)
				yield* Deferred.await(other)
				const asking = yield* Effect.forkScoped(enclosing.reserve(reservation))
				yield* awaitFact(
					Effect.map(shieldsIn(`${scratch}/lease`), (shields) =>
						shields.length > 0 ? Option.some(true) : Option.none()
					)
				)
				const queue = familyOf(reservation)
				const asked = (count: number) =>
					awaitFact(
						Effect.sync(() =>
							Arr.filter(lockWaitsNow(), (files) => Arr.contains(files, queue)).length >= count
								? Option.some(true)
								: Option.none()
						)
					)
				yield* asked(1)
				const released = Effect.andThen(asked(2), Deferred.succeed(release, undefined))
				if (nested === "an inline search a case runs") {
					const [verdict] = yield* Effect.all(
						[
							Effect.scoped(
								searchInline(reservesOn(Effect.succeed(reservation)), inlineRun("nested inline", 1))
							),
							released
						],
						{ concurrency: "unbounded" }
					)
					yield* Fiber.join(asking)
					assert.ok(
						verdict.kind === "exhausted",
						`an inline search asking its case's lease while its run waits for it completes: ${verdict.kind}`
					)
					return
				}
				const text = yield* reservationText(reservation)
				yield* Effect.forkScoped(released)
				const outcomes = yield* Effect.scoped(
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
							open: runnerLimits.open
						})
						const results = yield* pool.evaluator.evaluate(
							[shortCase(RESERVES, runnerLimits.deadline, runnerLimits.open)],
							() => true
						)
						return Arr.map(Arr.flatten(results), (result) => result.outcome.kind)
					})
				)
				yield* Fiber.join(asking)
				assert.deepEqual(
					outcomes,
					["passed"],
					"a pool asking its case's lease while its run waits for it completes its case"
				)
			}),
	oracle: {
		kind: "specification",
		name: "a run a case starts draws on its enclosing run's lease, so a need of it on a cluster that run is waiting for is answered with that run's lease, and it completes"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/leases.ts",
			original: "export const drawnLease = Effect.service(RunLease)\n",
			replacement:
				"export const drawnLease = Effect.map(Effect.context<Scope.Scope | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner>(), (context) => runLeasesIn(Context.get(context, Scope.Scope), context))\n",
			why: "A nested run holds a lease of its own, as before, and asks again for the slot its enclosing run waits for, queued behind that run, which then holds it for its life, so the nested run waits on it for ever (trialTemplatesApart's deadlock); the property's case hangs."
		}
	]
})
