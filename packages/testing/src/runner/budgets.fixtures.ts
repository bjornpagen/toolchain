/**
 * Both parts of the CPU budget (runner/config.ts RunBudget run and import) of every fixture runner config no
 * `toolchain-test run` reaches: none. Each
 * is loaded alone (by a property that reads its include, its conditions or its mutation, as `load`, `kills` and
 * `mutate` do), run by runPackage in a worker's own process, whose run no budget judges, or refused before any run (its
 * include holds no property), so no run of it spends what a budget reads. A `toolchain-test run` that came to reach one
 * would fail at once, naming what it spent, and be measured then.
 * @limitKind measured
 * @owner the testing library's fixtures
 * @unit milliseconds of CPU, each of a run budget's parts (runner/config.ts RunBudget run and import)
 * @scope a `toolchain-test run` of each fixture runner config that states it
 * @evidence ~/.cache/metis/METIS-DBOPT/runs/budget/measure4.jsonl in lane METIS-DBOPT's tree: one line per runPackage
 *   of any runner config during a whole run of the testing package, written by instrument.patch over runner/run.ts, the
 *   run started by measure.sh and its lines read by budget-measure.py, all beside it
 * @observed 2026-11-27 02:40 to 04:04 UTC
 * @environment cassowary, Ubuntu 26.04 (Linux 7.0.0-1018-aws) on AWS Graviton3, 64 arm64 CPUs, 247 GiB, load 260 to
 *   420 from other sessions; Node 26.13.1; the toolchain at e14ae5de with the change that states these budgets
 * @workload every property of the testing package, 275, at 4 workers (CPUQuota 800%), none answered from a verdict
 *   cache (a fresh XDG_CACHE_HOME)
 * @result no `toolchain-test run` of any config that states this: pool.fixtures.ts' held root ran twice and
 *   runs.fixtures.ts' counted root three times, each by runPackage in a worker's process (whose report holds that
 *   process's whole CPU, so it measures nothing of the fixture); the rest never ran
 * @decision none, 0 ms: twice nothing
 * @revalidate a property that runs one of these configs through `toolchain-test run`
 */
export const UNRUN_BUDGET = 0
