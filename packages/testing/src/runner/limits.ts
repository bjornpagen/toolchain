/**
 * The runner's budgets, which no property states: every search runs the required situations' witnesses and these
 * counts. A property that needs more says so with a cited Limit of its own; nothing else moves them.
 */

/**
 * How many independent cases a search's rotating stream runs: the run's fresh sample, the only one the residual
 * estimates from, and its budget for finding failures under test. A deeper search is a fuzz run with a budget of its
 * own.
 *
 * @limitKind derived
 * @owner the testing library's runner (runner/search.ts)
 * @unit cases per search per run
 * @scope one property's rotating stream in one run; every property runs its own
 * @derivation the median of the `runs` the suites of grizzle, den and edullm stated to Vitest's explore (934, 990 and
 * 1,095 statements; medians 150, 160 and 150, surveyed 2026-11-16 with grep over their test trees): the budget their
 * authors chose case by case, now one runner default, so the sample a suite ran keeps its size
 */
const DEFAULT_RUNS = 150

/**
 * How many cases a search's floor stream runs: the witnesses the suite's identity fixes, the same on every run seed, a
 * quarter of the rotating stream's, as the library's explore ran them.
 *
 * @limitKind derived
 * @owner the testing library's runner (runner/search.ts)
 * @unit cases per search
 * @scope one property's floor stream; every property runs its own
 * @derivation DEFAULT_RUNS / 4, rounded up: explore's floor rule (a quarter of `runs`, at least one), kept so every
 * suite's floor holds the witnesses it held
 */
const FLOOR_CASES = Math.ceil(DEFAULT_RUNS / 4)

/**
 * How many cases a search's steered phase may run while a required situation is still unreached: mutants of the floor's
 * finds, aimed at what is pending, on a stream the suite's identity fixes.
 *
 * @limitKind derived
 * @owner the testing library's runner (runner/search.ts)
 * @unit cases per search, at most
 * @scope one property's steered phase, which stops as soon as every required situation is reached
 * @derivation the median steered budget the suites of grizzle, den, edullm and the toolchain stated (`{ cases: N,
 * sense }`, 2,493 statements, every one with notesOnly; median 200, surveyed 2026-11-16 with grep)
 */
const STEERED_CASES = 200

/**
 * How many cases one steering window holds: the cases drawn under one snapshot of what is pending, so a window's cases
 * aim at distinct requirements and run at once. A constant of the runner, never of the machine, so the same seed draws
 * the same cases at any width.
 *
 * @limitKind derived
 * @owner the testing library's runner (runner/search.ts)
 * @unit cases per window
 * @scope every window of every search
 * @derivation the `steerEvery` 2,611 of the 3,088 suites of grizzle, den, edullm and the toolchain stated (surveyed
 * 2026-11-16 with grep; 8 in 223, 4 in 204, others fewer), so their steering keeps its rhythm
 */
const STEERING_WINDOW = 16

/**
 * How long one case may run before it is hung: the runner-wide case deadline, which replaces every suite's caseHang.
 * The worker's guard stops a case that yields past it; its watchdog ends a worker whose case holds the event loop past
 * it; the parent kills a worker silent past it and its grace.
 *
 * @limitKind derived
 * @owner the testing library's runner (runner/case.ts, runner/pool.ts)
 * @unit milliseconds per case
 * @scope every case of every property, on every worker
 * @derivation the caseHang 356 of the 549 statements in grizzle, den, edullm and the toolchain chose, one minute
 * (surveyed 2026-11-16 with grep; 69 chose 10 s, 63 chose 30 s, 31 chose 5 min, the five-minute ones grizzle's
 * whole-cluster lifecycles), so no case that ran under its suite's limit is hung by the runner's
 */
const CASE_DEADLINE_MILLIS = 60_000

/** The budgets one search runs under. */
export type Limits = Readonly<{
	runs: number
	floor: number
	steered: number
	window: number
	deadline: number
}>

/** The runner's own budgets. */
export const runnerLimits: Limits = {
	runs: DEFAULT_RUNS,
	floor: FLOOR_CASES,
	steered: STEERED_CASES,
	window: STEERING_WINDOW,
	deadline: CASE_DEADLINE_MILLIS
}
