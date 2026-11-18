/**
 * How many independent cases a search's rotating stream runs (runner/limits.ts): the run's fresh sample, the only one
 * the residual estimates from, and its budget for finding failures under test.
 *
 * @limitKind provisional
 * @owner the testing library's runner (runner/search.ts)
 * @unit cases per search per run
 * @scope one property's rotating stream in one run; every property runs its own
 * @guards without a budget a search's rotating stream draws cases until its test's deadline, so every test runs as
 *   long as it is allowed and its residual is estimated from whatever sample the clock left
 * @measure run the suites of grizzle, den, edullm and the toolchain, with every kill (property.ts Kill) in, at 50,
 *   150, 500 and 1,500 runs, several seeds each, and keep the smallest at which every kill fails its property, its run
 *   time stated beside
 * @origin the median of the runs the suites stated to explore (934, 990 and 1,095 statements in grizzle, den and
 *   edullm; medians 150, 160 and 150); surveyed 2026-11-16 with grep over the test trees of grizzle, den, edullm and
 *   the toolchain, when the runner (TESTSYS, 7a2cb07) replaced every suite's own number with one of its own: the value
 *   most of their statements chose, so a suite's search keeps the size it had. A survey of what authors chose is no
 *   measurement of what the number should be
 * @recorded 2026-11-16
 */
const searchRuns = 150

/**
 * How many cases a search's floor stream runs (runner/limits.ts): the witnesses the suite's identity fixes.
 *
 * @limitKind derived
 * @owner the testing library's runner (runner/search.ts)
 * @unit cases per search
 * @scope one property's floor stream, the same on every run seed; every property runs its own
 * @derivation a quarter of the rotating stream's runs, rounded up: the library's explore ran its floor so, and keeping
 *   the rule keeps every suite's floor holding the witnesses it held
 * @from {@link searchRuns}
 */
const floorCases = Math.ceil(searchRuns / 4)

/**
 * How many cases a search's steered phase may run while a required situation is still unreached (runner/limits.ts):
 * mutants of the floor's finds, aimed at what is pending.
 *
 * @limitKind provisional
 * @owner the testing library's runner (runner/search.ts)
 * @unit cases per search, at most
 * @scope one property's steered phase, which stops as soon as every required situation is reached
 * @guards a required situation no case can reach would keep the steered phase drawing until its test's deadline; the
 *   budget ends it, and the situation is reported unreached
 * @measure record how many steered cases each required situation of the four repositories' suites takes to reach, over
 *   several seeds, and keep the budget above the slowest one reached, its headroom stated
 * @origin the median steered budget the suites stated ({ cases: N, sense }, 2,493 statements; median 200); surveyed
 *   2026-11-16 with grep over the test trees of grizzle, den, edullm and the toolchain, when the runner (TESTSYS,
 *   7a2cb07) replaced every suite's own number with one of its own: the value most of their statements chose, so a
 *   suite's search keeps the size it had. A survey of what authors chose is no measurement of what the number should
 *   be
 * @recorded 2026-11-16
 */
const steeredCases = 200

/**
 * How many cases one steering window holds (runner/limits.ts): the cases drawn under one snapshot of what is pending,
 * which run at once. A constant of the runner, never of the machine, so one seed draws the same cases at any width.
 *
 * @limitKind provisional
 * @owner the testing library's runner (runner/search.ts)
 * @unit cases per window
 * @scope every window of every search
 * @guards with no window, every case of a search is drawn under the first snapshot of what is pending, so steering
 *   never moves; with a window of one, each case waits for the one before it to run and re-reads the snapshot
 * @measure run the four repositories' suites at windows of 4, 8, 16 and 32 and record each required situation's
 *   steered cases to reach and each suite's run time; keep the window past which reaching takes more cases than the
 *   run time saves
 * @origin the steerEvery 2,611 of 3,088 suites stated (8 in 223, 4 in 204, others fewer); surveyed 2026-11-16 with
 *   grep over the test trees of grizzle, den, edullm and the toolchain, when the runner (TESTSYS, 7a2cb07) replaced
 *   every suite's own number with one of its own: the value most of their statements chose, so a suite's search keeps
 *   the size it had. A survey of what authors chose is no measurement of what the number should be
 * @recorded 2026-11-16
 */
const steeringWindow = 16

/**
 * How much work one case may do before it is hung (runner/limits.ts): the runner-wide case deadline, a budget of the
 * case's own work (runner/work.ts). The worker's guard stops a case whose process tree has spent it in CPU, or whose
 * CPU has not moved over a whole deadline of wall time; its watchdog ends a worker whose case holds the event loop past
 * it; and the parent kills a worker silent past it and its grace.
 *
 * @limitKind provisional
 * @owner the testing library's runner (runner/case.ts, runner/pool.ts)
 * @unit milliseconds per case
 * @scope every case of every property, on every worker
 * @guards a case that hangs would hold its worker, and its test, until someone stopped the run
 * @measure record every case's run time across the four repositories' suites on cassowary over several runs, and keep
 *   the deadline above the slowest case that passed, its headroom stated; grizzle's whole-cluster lifecycles, the
 *   slowest known, may need a deadline of their own as a property's input
 * @origin the caseHang 356 of 549 statements chose, one minute (69 chose 10 s, 63 chose 30 s, 31 chose 5 min, those
 *   grizzle's whole-cluster lifecycles); surveyed 2026-11-16 with grep over the test trees of grizzle, den, edullm and
 *   the toolchain, when the runner (TESTSYS, 7a2cb07) replaced every suite's own number with one of its own: the value
 *   most of their statements chose, so a suite's search keeps the size it had. A survey of what authors chose is no
 *   measurement of what the number should be
 * @recorded 2026-11-16
 */
const caseDeadlineMillis = 60_000

/**
 * How long one need may take to open on a worker that has not opened it (runner/case.ts NeedCache): the open runs once
 * per worker per need key, when the worker readies the first property that needs it, before that property's first case
 * and outside every case's deadline. It bounds the open's work, as a case's deadline bounds a case's (runner/work.ts):
 * its CPU, or its CPU's stall over a whole bound of wall time outside declared waits, so an open that waits on another
 * run's lease or a builder's lock is not cut short for it (2026-11-18: ten properties' opens waited past five minutes of
 * wall time on lease slots MANIFEST's and SETSREAD's runs held, and failed as unopened). An open past it fails the
 * property on that worker, once, as unopened; the parent watches a readying worker for this long and its silence grace.
 *
 * @limitKind measured
 * @owner the testing library's runner (runner/case.ts NeedCache, runner/worker.ts, runner/pool.ts)
 * @unit milliseconds per need's open
 * @scope each need's open on one worker, once per worker per need key; a property's needs open at once, each under it
 * @evidence packages/testing/out/need-open/ in TESTSYS lane CORE-2's toolchain clone
 *   (~/.cache/grizzle-release/TESTSYS/CORE-2/toolchain), the uncommitted record of `GRIZZLE_PG_CLUSTER=5967 sh
 *   forms.sh forms-cold-1` and `... forms-warm-2`: forms.sh, instrument.patch (each worker appends one JSON line per
 *   property it readies, the readying's wall and CPU milliseconds), forms-uncited.patch (no property cites a case
 *   deadline of its own), and per run <name>.readying.jsonl, .json, .time and .load. Beside it, lane GZ-FOUNDATION's
 *   ~/.cache/grizzle-release/TESTSYS/GZ-FOUNDATION/measure/overhead1.jsonl (a worker's first take of a built template,
 *   its open included, at 64 workers) and out/forms3.log (the forms at load 616 to 1,127, templates unbuilt, under a
 *   cited 240 s first-case deadline)
 * @observed 2026-11-16 10:30:19 to 10:32:41 UTC
 * @environment cassowary, Ubuntu 26.04.1 (Linux 7.0.0-1016-aws) on an AWS Graviton3 (arm64) instance with 64 logical
 *   CPUs and 247 GiB, Node 26.13.1; a private family of four PostgreSQL 19rc2 members (grizzle's scripts/pg/init.sh,
 *   fsync off, on GRIZZLE_PG_CLUSTER=5967) made just before; grizzle 0baff5d6, toolchain 88d76b7 (this lane's
 *   need-open phase); load average 391 to 468 from other sessions
 * @workload grizzle's template forms, test/pg/substrate/forms.test.ts (freshBase, freshInstalled, seated, rolledBack,
 *   oneOfTemplates, served), 150 cases each at full width (64 workers), every case under the runner's 60 s case
 *   deadline: first on the new family, every template unbuilt (each member's first worker builds it under its build
 *   lock while the others wait), then again with them built. A worker's readying is timed from before its first
 *   property of the module is imported to its needs open (each module's import, its import closure hashed for the
 *   template's name, the install's plan, the template's build or the wait on it, the clone pool started), so it bounds
 *   the opens from above
 * @result unbuilt: 323 readyings, p50 0.6 s, p90 19.2 s, p99 32.2 s, slowest 34.7 s (oneOfTemplates; freshInstalled
 *   33.7 s, rolledBack 32.4 s, seated 28.3 s, freshBase 13.3 s, served 4.6 s); built: 295 readyings, p50 1.0 s, p90
 *   15.6 s, p99 20.7 s, slowest 22.9 s. No open failed; every property passed both runs (0 of 6 failed, 63 s each),
 *   where before this phase every first case of these forms was cut at 60 s at load 400 to 600. GZ-FOUNDATION's
 *   built-template first takes at load 300 to 350 reached 18.5 s; its unbuilt run at load 616 to 1,127 ended every
 *   first case within the 240 s it cited. Not measured: opens with fsync on, where a member's DROP DATABASE waits on
 *   the checkpoints it forces (RESOURCES saw clone waits to 84 s there)
 * @decision 300 s: 8.6 times the slowest open measured here (34.7 s at load 391 to 468), 3.3 times that open scaled to
 *   the worst load seen today (1,127, 2.6 times as loaded: about 91 s), and above the 240 s within which every first
 *   case of the unbuilt forms ended at that load. The costs are lopsided: a bound too short fails a property whose
 *   need was only slow to open, one too long only delays the report of an open that hangs, so the headroom is wide.
 *   Unmeasured gap: opens at loads past 1,127, and with fsync on
 * @revalidate a template whose build takes minutes (an install of many migrations), a family with fsync on, a run
 *   whose readyings come near a minute, a property reported unopened for running past it, another machine or a
 *   PostgreSQL repin
 */
const needOpenMillis = 300_000

/**
 * How many independent cases a search's rotating stream runs: the run's fresh sample, the only one the residual
 * estimates from, and its budget for finding failures under test. A deeper search is a fuzz run with a budget of its
 * own.
 */
const DEFAULT_RUNS = searchRuns

/**
 * How many cases a search's floor stream runs: the witnesses the suite's identity fixes, the same on every run seed, a
 * quarter of the rotating stream's, as the library's explore ran them.
 */
const FLOOR_CASES = floorCases

/**
 * How many cases a search's steered phase may run while a required situation is still unreached: mutants of the floor's
 * finds, aimed at what is pending, on a stream the suite's identity fixes.
 */
const STEERED_CASES = steeredCases

/**
 * How many cases one steering window holds: the cases drawn under one snapshot of what is pending, so a window's cases
 * aim at distinct requirements and run at once. A constant of the runner, never of the machine, so the same seed draws
 * the same cases at any width.
 */
const STEERING_WINDOW = steeringWindow

/**
 * How much work one case may do before it is hung: the runner-wide case deadline, which replaces every suite's
 * caseHang, as CPU its process tree may spend and as the wall time over which that CPU must move (runner/work.ts).
 */
const CASE_DEADLINE_MILLIS = caseDeadlineMillis

/**
 * The share of one CPU a case's process tree must spend over a window of its deadline's wall time for its work to count
 * as moving (runner/work.ts progressOver): a tree that spends less over a whole deadline is stalled, blocked on
 * something that will not come, and its case is hung. A process that waits spends almost none, a case the machine
 * slows still spends some, and the share sits between them.
 *
 * @limitKind measured
 * @owner the testing library's runner (runner/work.ts, runner/case.ts guarded)
 * @unit CPU milliseconds per wall millisecond
 * @scope every window of every case's deadline, on every worker
 * @evidence ~/.cache/grizzle-release/CHECK-ROOT/scratch/idle.mjs (a Node process shaped like a worker: an IPC-free
 *   main thread with a pending timer and a worker thread parked on Atomics.waitAsync, as the watchdog's is) and
 *   ~/.cache/grizzle-release/CHECK-ROOT/out/flake/{solo,full-1,full-2,full-3,full-4}.tsv (every case of the
 *   toolchain's gate.test.ts#filledSubmodule, its wall and its own CPU with its waited-for children's, alone and under
 *   the toolchain's whole suite)
 * @observed 2026-11-17 05:15 UTC (idle.mjs); 2026-11-17 04:3x to 04:5x UTC (the gate cases)
 * @environment cassowary, Ubuntu 26.04 (Linux 7.0.0-1016-aws) on an AWS Graviton3 (arm64) instance with 64 logical
 *   CPUs and 247 GiB, Node 26.13.1; load average 220 to 880, 80 GB of swap in use during the suite runs
 * @workload idle.mjs: 60 s of nothing, its CPU read every 10 s. The gate cases: 32 cases alone, then four runs of the
 *   devtools package's whole suite beside the machine's other lanes
 * @result idle: 0.3 to 1.2 ms of CPU per 10 s after start, 0.003 % to 0.012 % of one CPU. The gate cases: the slowest,
 *   92.1 s of wall, spent 0.76 s and more of CPU, 0.83 % of one CPU; none spent less than 0.76 s in any case
 * @decision a thousandth of one CPU, 0.1 %: eight times the idle process's most and eight times under the slowest
 *   working case's least. At the runner's 60 s deadline a case must spend 60 ms in a minute to be moving
 * @revalidate a worker that does more while it waits (a heartbeat, a poll), which raises the idle side; a suite whose
 *   working cases spend less of a CPU than 0.8 % under load; another machine
 */
const stalledShareOfCpu = 0.001

/** The share of one CPU a case's tree must spend over a deadline's wall time to be moving: stalledShareOfCpu. */
export const stalledShare = stalledShareOfCpu

/**
 * How long a property's needs may take to open on a process that has not opened them, before its first case there and
 * outside every case's deadline: a need's one-time cost (a template built or awaited, a module's import closure hashed,
 * an install planned) is the process's, never a case's. A need that outruns it fails the property, once.
 */
const NEED_OPEN_MILLIS = needOpenMillis

/** The budgets one search runs under, and the bounds its cases' orders carry: a case's deadline and its needs' open. */
export type Limits = Readonly<{
	runs: number
	floor: number
	steered: number
	window: number
	deadline: number
	open: number
}>

/** The runner's own budgets. */
export const runnerLimits: Limits = {
	runs: DEFAULT_RUNS,
	floor: FLOOR_CASES,
	steered: STEERED_CASES,
	window: STEERING_WINDOW,
	deadline: CASE_DEADLINE_MILLIS,
	open: NEED_OPEN_MILLIS
}
