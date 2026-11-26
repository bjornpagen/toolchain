import { defineRunner, noMutation } from "@bjornpagen/testing/runner"
import { Layer } from "effect"

/**
 * The CPU a run of the dev tools' package may spend (runner/config.ts RunBudget).
 * @limitKind measured
 * @owner the testing library's runner
 * @unit milliseconds of CPU, a run's processes' and its sessions' backends' (runner/usage.ts UsageReport metered)
 * @scope each `toolchain-test run` of this package, every property run and none answered from the verdict cache
 * @evidence ~/.cache/metis/METIS-DBOPT/runs/budget/devtools-measure2-3583184708-2515528.json in lane METIS-DBOPT's
 *   tree, the run's own report (`toolchain-test run` writes it; measure.sh beside it started the run)
 * @observed 2026-11-27 01:19 to 01:25 UTC
 * @environment cassowary, Ubuntu 26.04 (Linux 7.0.0-1018-aws) on AWS Graviton3, 64 arm64 CPUs, 247 GiB, load 360 to 480
 *   from other sessions; Node 26.13.1; the toolchain at e14ae5de with the change that states this budget
 * @workload every property of the package, 29, at 4 workers (CPUQuota 800%), none answered from a verdict cache (a
 *   fresh XDG_CACHE_HOME), TEST_SEED unset
 * @result 190,371 ms metered, all of it its processes' (parent 16.7 s, workers 28.9 s, their children 144.7 s), no
 *   session backends; 319 s of wall time; 29 of 29 passed
 * @decision twice it, 380,743 ms, rounded up to the millisecond
 * @revalidate a property added or one whose work grows, a change to the runner's own work in a run, or another machine
 */
const devtoolsBudget = 380_743

/**
 * The dev tools' runner config: the test modules toolchain-test runs, every property module of the package; no export
 * conditions; no services beyond the runner's own; and the library's operators alone for mutation.
 */
export default defineRunner({
	budget: { kind: "cpu", millis: devtoolsBudget },
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
