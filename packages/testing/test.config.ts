import { fixtureServices } from "#resources/resources.fixtures.ts"
import { defineRunner, noMutation } from "#runner/config.ts"

/**
 * The CPU a run of the testing package may spend (runner/config.ts RunBudget).
 * @limitKind measured
 * @owner the testing library's runner
 * @unit milliseconds of CPU, a run's processes' and its sessions' backends' (runner/usage.ts UsageReport metered)
 * @scope each `toolchain-test run` of this package, every property run and none answered from the verdict cache
 * @evidence ~/.cache/metis/METIS-DBOPT/runs/budget/testing-measure4-1785192992-2926560.json in lane METIS-DBOPT's
 *   tree, the run's own report (`toolchain-test run` writes it; measure.sh beside it started the run)
 * @observed 2026-11-27 02:40 to 04:04 UTC
 * @environment cassowary, Ubuntu 26.04 (Linux 7.0.0-1018-aws) on AWS Graviton3, 64 arm64 CPUs, 247 GiB, load 260 to 420
 *   from other sessions; Node 26.13.1; the toolchain at e14ae5de with the change that states this budget
 * @workload every property of the package, 275, at 4 workers (CPUQuota 800%), none answered from a verdict cache (a
 *   fresh XDG_CACHE_HOME), TEST_SEED unset
 * @result 3,191,067 ms metered: 3,087,067 of its processes (parent 129.7 s, workers 1,369.6 s, their children
 *   1,587.8 s) and 104,000 of its sessions' backends; 5,004 s of wall time; 2 of 275 failed (pg/hold.test.ts's
 *   aRestartUnderItsRunsEndEndsCleanly and resources.test.ts's pollLoopIsHung, each run alone again)
 * @decision twice it, 6,382,135 ms, rounded up to the millisecond
 * @revalidate a property added or one whose work grows, a change to the runner's own work in a run, or another machine
 */
const testingBudget = 6_382_135

/**
 * The testing library's runner config: the test modules toolchain-test runs, every property module of the package; no
 * export conditions; the package's own local cluster (pg.config.ts, resources.fixtures.ts; CONTRIBUTING.md,
 * "Properties that need a database"), built only when a case first opens a need; and the library's operators alone
 * for mutation.
 */
export default defineRunner({
	budget: { kind: "cpu", millis: testingBudget },
	include: [
		"src/fact.test.ts",
		"src/traces.test.ts",
		"src/workers.test.ts",
		"src/oracle.test.ts",
		"src/seeds.test.ts",
		"src/interleave.test.ts",
		"src/commands.test.ts",
		"src/closure.test.ts",
		"src/runner/closure.test.ts",
		"src/runner/keep.test.ts",
		"src/runner/cache.test.ts",
		"src/runner/keys.test.ts",
		"src/runner/compile-cache.test.ts",
		"src/runner/consumer.test.ts",
		"src/runner/named.test.ts",
		"src/runner/flags.test.ts",
		"src/runner/loads.test.ts",
		"src/runner/norun.test.ts",
		"src/vitest/timeouts.test.ts",
		"src/runner/reuse.test.ts",
		"src/runner/observe.test.ts",
		"src/runner/recorder.test.ts",
		"src/resources/scratch.test.ts",
		"src/resources/resources.test.ts",
		"src/pg/settle.test.ts",
		"src/pg/hold.test.ts",
		"src/pg/monitor.test.ts",
		"src/pg/family.test.ts",
		"src/pg/settings.test.ts",
		"src/core.test.ts",
		"src/recorded.test.ts",
		"src/idioms.test.ts",
		"src/shrink.test.ts",
		"src/features.test.ts",
		"src/agree.test.ts",
		"src/fuzz.test.ts",
		"src/sense.test.ts",
		"src/syntax.test.ts",
		"src/blocking.test.ts",
		"src/runner/work.test.ts",
		"src/runner/backends.test.ts",
		"src/runner/search.test.ts",
		"src/runner/case.test.ts",
		"src/explore.test.ts",
		"src/runner/pool.test.ts",
		"src/runner/budget.test.ts",
		"src/runner/session-backends.test.ts",
		"src/runner/migrate.test.ts",
		"src/runner/launcher.test.ts",
		"src/runner/resolutions.test.ts",
		"src/runner/schedule.test.ts",
		"src/runner/opening.test.ts",
		"src/runner/runs.test.ts",
		"src/runner/steer.test.ts",
		"src/runner/touched.test.ts",
		"src/mutate/*.test.ts",
		"src/oxlint/rules.test.ts",
		"src/mutants.test.ts",
		"src/mutate.test.ts"
	],
	smallStack: [],
	conditions: [],
	environment: [],
	layer: fixtureServices,
	mutation: noMutation
})
