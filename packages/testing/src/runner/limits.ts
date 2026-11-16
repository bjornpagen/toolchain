/**
 * The runner's budgets, which no property states: every search runs the required situations' witnesses and these
 * counts. A property that needs more says so with a cited Limit of its own; nothing else moves them. Each is a Limit of
 * @bjornpagen/limits (searchRuns, floorCases, steeredCases, steeringWindow, caseDeadlineMillis, needOpenMillis), with
 * its evidence.
 */
import {
	caseDeadlineMillis,
	floorCases,
	needOpenMillis,
	searchRuns,
	steeredCases,
	steeringWindow
} from "@bjornpagen/limits"

/**
 * How many independent cases a search's rotating stream runs: the run's fresh sample, the only one the residual
 * estimates from, and its budget for finding failures under test. A deeper search is a fuzz run with a budget of its
 * own.
 */
const DEFAULT_RUNS = searchRuns.value

/**
 * How many cases a search's floor stream runs: the witnesses the suite's identity fixes, the same on every run seed, a
 * quarter of the rotating stream's, as the library's explore ran them.
 */
const FLOOR_CASES = floorCases.value

/**
 * How many cases a search's steered phase may run while a required situation is still unreached: mutants of the floor's
 * finds, aimed at what is pending, on a stream the suite's identity fixes.
 */
const STEERED_CASES = steeredCases.value

/**
 * How many cases one steering window holds: the cases drawn under one snapshot of what is pending, so a window's cases
 * aim at distinct requirements and run at once. A constant of the runner, never of the machine, so the same seed draws
 * the same cases at any width.
 */
const STEERING_WINDOW = steeringWindow.value

/**
 * How long one case may run before it is hung: the runner-wide case deadline, which replaces every suite's caseHang.
 * The worker's guard stops a case that yields past it; its watchdog ends a worker whose case holds the event loop past
 * it; the parent kills a worker silent past it and its grace.
 */
const CASE_DEADLINE_MILLIS = caseDeadlineMillis.value

/**
 * How long a property's needs may take to open on a process that has not opened them, before its first case there and
 * outside every case's deadline: a need's one-time cost (a template built or awaited, a module's import closure hashed,
 * an install planned) is the process's, never a case's. A need that outruns it fails the property, once.
 */
const NEED_OPEN_MILLIS = needOpenMillis.value

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
