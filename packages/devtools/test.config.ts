import { defineRunner, noMutation } from "@bjornpagen/testing/runner"
import { Layer } from "effect"

/**
 * The CPU a run of the dev tools' package may spend beyond its workers' starts and readyings and its run needs' opens
 * (runner/config.ts RunBudget run).
 * @limitKind measured
 * @owner the testing library's runner
 * @unit milliseconds of CPU, the run's parent's outside its run needs' opens and its cases', their children's and
 *   backends' among it (runner/usage.ts UsageReport run)
 * @scope each `toolchain-test run` of this package, every property run and none answered from the verdict cache
 * @evidence ~/.cache/metis/METIS-DBOPT/runs/budget/3b/475789729-2121283.json in lane METIS-DBOPT's tree, the run's own report
 * @observed 2026-11-27 14:43 to 14:45 UTC
 * @environment cassowary, Ubuntu 26.04 (Linux 7.0.0-1018-aws) on AWS Graviton3, 64 arm64 CPUs, 247 GiB, load 340 to
 *   480 from other sessions; Node 26.13.1; the toolchain at 24300eac with the change that states this budget
 * @workload every property of the dev tools' package, 29, at 4 workers (CPUQuota 800%), none answered from a verdict
 *   cache (a fresh XDG_CACHE_HOME), TEST_SEED unset
 * @result 166,514 ms: the parent's 14,058 and its cases' 152,456; 0 of 29 failed
 * @decision twice it, 333,028 ms
 * @revalidate a property added or one whose work grows, a change to the runner's own work in a run, or another machine
 */
const devtoolsRunBudget = 333_028

/**
 * The CPU one worker of a run of the dev tools' package may spend importing one property's module (runner/config.ts
 * RunBudget import).
 * @limitKind measured
 * @owner the testing library's runner
 * @unit milliseconds of CPU, a worker's own (runner/usage.ts PropertyUsage imports)
 * @scope each import of a test module on a worker of a `toolchain-test run` of this package
 * @evidence ~/.cache/metis/METIS-DBOPT/runs/budget/3b/475789729-2121283.json in lane METIS-DBOPT's tree, the run's own report
 * @observed 2026-11-27 14:43 to 14:45 UTC
 * @environment cassowary, Ubuntu 26.04 (Linux 7.0.0-1018-aws) on AWS Graviton3, 64 arm64 CPUs, 247 GiB, load 340 to
 *   480 from other sessions; Node 26.13.1; the toolchain at 24300eac with the change that states this budget
 * @workload every property of the dev tools' package, 29, at 4 workers (CPUQuota 800%), none answered from a verdict
 *   cache (a fresh XDG_CACHE_HOME), TEST_SEED unset
 * @result the most 419 ms
 * @decision twice it, 838 ms
 * @revalidate a test module's imports grown, a Node upgrade, or another machine
 */
const devtoolsImportBudget = 838

/**
 * The dev tools' runner config: the test modules toolchain-test runs, every property module of the package; no export
 * conditions; no services beyond the runner's own; and the library's operators alone for mutation.
 */
export default defineRunner({
	budget: { kind: "cpu", run: devtoolsRunBudget, import: devtoolsImportBudget },
	include: [
		"src/land.test.ts",
		"src/threads.test.ts",
		"src/compile-cache.test.ts",
		"src/typecheck.test.ts",
		"src/preset.test.ts",
		"src/preset-types.test.ts",
		"src/oxlint/environment.test.ts",
		"src/workspace/tsconfigs.test.ts",
		"src/workspace/core-lint.test.ts",
		"src/oxlint/rules/bearer-owners.test.ts",
		"src/oxlint/rules/side-effect-free.test.ts",
		"src/oxlint/rules/no-case-list.test.ts",
		"src/oxlint/rules/no-variadic-callback.test.ts",
		"src/oxlint/rules/no-plant.test.ts",
		"src/oxlint/rules/single-permit-owners.test.ts",
		"src/shared/git.test.ts",
		"src/workspace/banned-packages.test.ts",
		"src/workspace/catalog-agreement.test.ts",
		"src/workspace/compile-cache.test.ts",
		"src/workspace/dead-paths.test.ts",
		"src/workspace/quarantine.test.ts",
		"src/workspace/root-files.test.ts",
		"src/workspace/root-tasks.test.ts",
		"src/workspace/test-system.test.ts"
	],
	smallStack: [],
	conditions: [],
	environment: [],
	layer: Layer.empty,
	mutation: noMutation
})
