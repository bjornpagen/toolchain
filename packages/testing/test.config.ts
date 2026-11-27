import { fixtureServices } from "#resources/resources.fixtures.ts"
import { defineRunner, noMutation } from "#runner/config.ts"

/**
 * The CPU a run of the testing package may spend beyond its workers' starts and readyings and its run needs' opens
 * (runner/config.ts RunBudget run).
 * @limitKind measured
 * @owner the testing library's runner
 * @unit milliseconds of CPU, the run's parent's outside its run needs' opens and its cases', their children's and
 *   backends' among it (runner/usage.ts UsageReport run)
 * @scope each `toolchain-test run` of this package, every property run and none answered from the verdict cache
 * @evidence ~/.cache/metis/METIS-DBOPT/runs/budget/3b/4262911627-3040743.json in lane METIS-DBOPT's tree, the run's own report, and dbopt-3b-measure.log
 *   beside it, its output
 * @observed 2026-11-27 13:30 to 14:42 UTC
 * @environment cassowary, Ubuntu 26.04 (Linux 7.0.0-1018-aws) on AWS Graviton3, 64 arm64 CPUs, 247 GiB, load 340 to
 *   480 from other sessions; Node 26.13.1; the toolchain at 24300eac with the change that states this budget
 * @workload every property of the testing package, 284, at 4 workers (CPUQuota 800%), none answered from a verdict
 *   cache (a fresh XDG_CACHE_HOME), TEST_SEED unset
 * @result 3,887,113 ms: the parent's 156,896 less its run needs' opens' 1, and its cases' 3,730,218; 3 of 284 failed
 *   (budget.test.ts's aRunsPartIsTheSameAtEveryWidth and aWorkerStartsWithinItsBudget on their first form, since
 *   rewritten, and recorder.test.ts's aRecordedChildRunsUnstopped at 130 context switches past its 128, load 480)
 * @decision twice it, 7,774,226 ms
 * @revalidate a property added or one whose work grows, a change to the runner's own work in a run, or another machine
 */
const testingRunBudget = 7_774_226

/**
 * The CPU one worker of a run of the testing package may spend importing one property's module (runner/config.ts
 * RunBudget import).
 * @limitKind measured
 * @owner the testing library's runner
 * @unit milliseconds of CPU, a worker's own (runner/usage.ts PropertyUsage imports)
 * @scope each import of a test module on a worker of a `toolchain-test run` of this package
 * @evidence ~/.cache/metis/METIS-DBOPT/runs/budget/3b/4262911627-3040743.json in lane METIS-DBOPT's tree, the run's own report
 * @observed 2026-11-27 13:30 to 14:42 UTC
 * @environment cassowary, Ubuntu 26.04 (Linux 7.0.0-1018-aws) on AWS Graviton3, 64 arm64 CPUs, 247 GiB, load 340 to
 *   480 from other sessions; Node 26.13.1; the toolchain at 24300eac with the change that states this budget
 * @workload every property of the testing package, 284, at 4 workers (CPUQuota 800%), none answered from a verdict
 *   cache (a fresh XDG_CACHE_HOME), TEST_SEED unset
 * @result 286 imports, the most 220 ms
 * @decision twice it, 440 ms
 * @revalidate a test module's imports grown, a Node upgrade, or another machine
 */
const testingImportBudget = 440

/**
 * The testing library's runner config: the test modules toolchain-test runs, every property module of the package; no
 * export conditions; the package's own local cluster (pg.config.ts, resources.fixtures.ts; CONTRIBUTING.md,
 * "Properties that need a database"), built only when a case first opens a need; and the library's operators alone
 * for mutation.
 */
export default defineRunner({
	budget: { kind: "cpu", run: testingRunBudget, import: testingImportBudget },
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
