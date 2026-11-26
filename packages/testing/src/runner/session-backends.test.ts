import { Array as Arr, Effect } from "effect"
import { assert } from "#assert.ts"
import { finite, int } from "#gen.ts"
import { Checkout } from "#mutate/checkout.ts"
import { property } from "#property.ts"
import { Scratch } from "#resources/scratch.ts"
import { overLineOf } from "#runner/budget.fixtures.ts"
import { runsAtOnce, shortBackendsRun } from "#runner/session-backends.fixtures.ts"

/**
 * A run counts every backend its sessions opened, however briefly it lived (runner/work.ts sessionsSpent): a consumer whose
 * one to three cases each open a backend of their own, spend a second or two of its CPU and close it, all inside one
 * window of the budget meter's, so no reading of the meter's sees it, runs `toolchain-test run` under a budget of 0 ms,
 * and its JSON record's backends hold at least what each backend read of itself just before it closed, and the line it
 * fails on names the CPU it recorded with its backends'. Each case writes the consumer from
 * the checkout's own library (Checkout.dir, so a kill's mutant is in it), with a cluster of its own, and runs it in a
 * unit of systemd's. Oracle: each backend's own CPU, read off /proc/<pid>/stat by the case that opened it.
 */
export const shortBackendsAreCounted = property.exhaust(
	finite((source) => source.draw(int(1, 3))),
	{
		box: "a consumer with a cluster of its own whose one to three cases each spend a second or two in a backend of their own and close it",
		needs: { directory: Scratch.dir, checkout: Checkout.dir },
		situations: [],
		check:
			({ directory, checkout }) =>
			(cases) =>
				Effect.gen(function* () {
					const scratch = yield* directory
					const library = yield* checkout
					const { backends, metered, budgetLines, spent } = yield* shortBackendsRun(
						scratch,
						library,
						cases
					)
					const own = Arr.reduce(spent, 0, (sum, one) => sum + one)
					assert.deepEqual(
						{
							cases: spent.length,
							counted: backends >= own ? "every backend's CPU" : `${String(backends)} ms`,
							budgetLines
						},
						{ cases, counted: "every backend's CPU", budgetLines: [overLineOf(metered, 0)] },
						`the run counted ${String(backends)} ms of its backends' CPU, its cases' backends ${String(own)} ms`
					)
				}),
		oracle: {
			kind: "specification",
			name: "a run's backends' CPU holds every backend it was served, each as it read its own CPU off /proc before it closed"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/runner/work.ts",
				original: "\tledger.closed += backendCpu(pid, counted) - counted\n",
				replacement: "",
				why: "A session's backend is counted only while it is open at a count, so one that came and went inside a unit spends nothing of the run's budget; the property fails."
			},
			{
				file: "packages/testing/src/runner/usage.ts",
				original: "(report.metered)} of CPU, its backends'",
				replacement: "(report.total)} of CPU, its backends'",
				why: "The line a run past its budget fails on names its CPU without its backends', so it understates what a database suite spent; the property fails."
			}
		]
	}
)

/**
 * Two runs on one member at once each count their own backends and none of the other's: a consumer's heavy run opens a
 * backend and counts forty million rows on it while its light run, at once on the family's one member, holds a backend
 * of its own open; each run's JSON record's backends hold at least its own backend's CPU, and the light run's hold less
 * than what the heavy backend spent while the light one was open, which a run counting its member's backends whole
 * would hold. Oracle: each backend's own CPU, read off /proc/<pid>/stat by the cases.
 */
export const runsAtOnceCountTheirOwn = property.exhaust(
	finite((source) => source.draw(int(1, 1))),
	{
		box: "a consumer's heavy run and light run at once on its cluster's one member, the light run's backend open while the heavy one works",
		needs: { directory: Scratch.dir, checkout: Checkout.dir },
		situations: [],
		check:
			({ directory, checkout }) =>
			() =>
				Effect.gen(function* () {
					const scratch = yield* directory
					const library = yield* checkout
					const { heavy, light, wrote } = yield* runsAtOnce(scratch, library)
					assert.deepEqual(
						{
							heavy: heavy >= wrote.heavy ? "its own backend's CPU" : `${String(heavy)} ms`,
							light: light >= wrote.light ? "its own backend's CPU" : `${String(light)} ms`,
							otherRun: light < wrote.overlapped ? "none of it" : `${String(light)} ms`
						},
						{
							heavy: "its own backend's CPU",
							light: "its own backend's CPU",
							otherRun: "none of it"
						},
						`the heavy run counted ${String(heavy)} ms (its backend ${String(wrote.heavy)}), the light run ${String(light)} ms (its backend ${String(wrote.light)}, the heavy backend's while it was open ${String(wrote.overlapped)})`
					)
				}),
		oracle: {
			kind: "specification",
			name: "runs at once on one member each count the backends their own sessions opened, each as it read its own CPU off /proc"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/pg/session.ts",
				original: '\t\t\t\t\t\t\t\t\ttext: "SELECT pg_catalog.pg_backend_pid()::text",\n',
				replacement:
					"\t\t\t\t\t\t\t\t\ttext: \"SELECT pid::text FROM pg_catalog.pg_stat_activity WHERE backend_type = 'client backend'\",\n",
				why: "A session counts every client backend of its member, as a run counting its member's backends whole would, so the light run counts the heavy run's backend; the property fails."
			}
		]
	}
)
