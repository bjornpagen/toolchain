/**
 * A run a case starts, a pool of its own workers or an inline search in the case's process, draws on the lease of the
 * run the case runs in (leases.ts drawnLease, CheckContext's RunLease): a need of the nested run that takes the lease of
 * a cluster the enclosing run already holds whole is answered from what that run holds, and the nested run completes,
 * reserving nothing again. Before, a nested run held leases of its own and reserved again what its enclosing run held,
 * waiting on those slots for ever: trialTemplatesApart's kill trials deadlocked under a gate run that held every slot of
 * 5441. Each case's cluster is a lease directory of the case's own, one member admitting one worker, whose slot the
 * enclosing run takes first; no server is involved. Oracle: the specification, stated in the check.
 */
import { Array as Arr, Effect, Option } from "effect"
import { assertTrue, deepStrictEqual } from "#assert.ts"
import { Checkout } from "#mutate/checkout.ts"
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

export const nestedRunsDrawOnTheirRun = property.exhaust(nestedRuns, {
	box: "a pool a case starts and an inline search a case runs, each needing the lease of a cluster its enclosing run holds whole",
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
				yield* enclosing.reserve(reservation)
				if (nested === "an inline search a case runs") {
					const verdict = yield* Effect.scoped(
						searchInline(reservesOn(Effect.succeed(reservation)), inlineRun("nested inline", 1))
					)
					assertTrue(
						verdict.kind === "exhausted",
						`an inline search under its case's held lease completes: ${verdict.kind}`
					)
					return
				}
				const text = yield* reservationText(reservation)
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
				deepStrictEqual(
					outcomes,
					["passed"],
					"a pool under its case's held lease completes its case"
				)
			}),
	oracle: {
		kind: "specification",
		name: "a run a case starts draws on its enclosing run's lease, so a need of it on a cluster that run holds whole is answered, and it completes"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/leases.ts",
			original: "export const drawnLease = Effect.service(RunLease)\n",
			replacement:
				"export const drawnLease = Effect.map(Effect.context<Scope.Scope | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner>(), (context) => runLeasesIn(Context.get(context, Scope.Scope), context))\n",
			why: "A nested run holds a lease of its own, as before, and reserves again the slot its enclosing run holds, waiting on it for ever (trialTemplatesApart's deadlock); the property's case hangs."
		}
	]
})
