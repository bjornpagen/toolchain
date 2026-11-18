import { Array as Arr, Option, Result, String as Str } from "effect"
import { stalledShare } from "#runner/limits.ts"

/**
 * What a case's deadline measures: the work the case does, not the time the machine takes to let it. A case is hung when
 * its process tree (the process that runs it, the children it waits for, and every live descendant) has spent its
 * deadline in CPU, a runaway; or when, over a whole deadline of wall time, that CPU has not moved, a case blocked on
 * something that will not come. A case the machine merely slows (CPU it waits for, pages it waits on, IO behind other
 * work) keeps moving and is never hung for it: on cassowary at load 260 to 880, one of the toolchain's gate cases took
 * 1.0 to 92.1 s of wall time for the same 0.8 to 4.3 s of its own CPU (CHECK-ROOT, 2026-11-17), so a deadline on the live
 * clock judged the machine, not the case. Nor is a case hung for a declared wait (Waits): a wait on a resource other
 * processes hold, a connection lease's slot behind another run's workers or a template's build lock, spends no CPU of
 * its tree, and its wall time is no stall (SELECTWHOLE, 2026-11-18: thirteen kill trials' first cases waited 66 s and
 * more on a lease slot and were ended as stalled). Linux states a process tree's CPU in /proc; a system without it
 * states only the process's own (process.cpuUsage), and a case that waits on a child there is judged by the stall
 * alone, which is the live clock's old deadline.
 */

/**
 * @formatConstant Linux's /proc/<pid>/stat (proc(5)): its fields after the command's closing parenthesis, from the third
 * (the state); the process's user and system time the 14th and 15th, those of the children it has waited for the 16th
 * and 17th, and the moment it started the 22nd, since the machine booted; every one in clock ticks of USER_HZ, which
 * Linux fixes at 100 a second for every program whatever the kernel's own tick. /proc/<pid>/task/<tid>/children lists
 * the children each thread started.
 */
const PROC = {
	firstField: 3,
	user: 14,
	system: 15,
	childrenUser: 16,
	childrenSystem: 17,
	started: 22,
	ticksPerSecond: 100
} as const

/** Milliseconds in a second. */
const millisPerSecond = 1000

/** Microseconds in a millisecond, process.cpuUsage's unit. */
const microsPerMilli = 1000

/** The smallest change in a child's CPU Linux states, and the grain of a process's start: one clock tick, in ms. */
const TICK_MILLIS = millisPerSecond / PROC.ticksPerSecond

const { readFileSync, readdirSync } = process.getBuiltinModule("node:fs")

/** A file's text, none when it cannot be read (a process gone, a system without /proc). */
const textOf = (path: string): Option.Option<string> =>
	Result.getSuccess(Result.try(() => readFileSync(path, "utf8")))

/** A directory's entries, none when it cannot be read. */
const entriesOf = (path: string): ReadonlyArray<string> =>
	Option.getOrElse(Result.getSuccess(Result.try(() => readdirSync(path))), () => [])

/** A process's stat fields, by number, in milliseconds; none for a process gone or a system without /proc. */
const statOf = (pid: string): Option.Option<(field: number) => number> =>
	Option.flatMap(textOf(`/proc/${pid}/stat`), (stat) =>
		Option.map(Str.lastIndexOf(")")(stat), (closing) => {
			const values = Str.split(" ")(Str.trim(Str.slice(closing + 1)(stat)))
			return (field: number) =>
				(Number(values[field - PROC.firstField]) * millisPerSecond) / PROC.ticksPerSecond
		})
	)

/** A process's CPU and its waited-for children's, in milliseconds. */
const allOf = (field: (field: number) => number): number =>
	field(PROC.user) + field(PROC.system) + field(PROC.childrenUser) + field(PROC.childrenSystem)

/** The children of a process, every thread's. */
const childrenOf = (pid: string): ReadonlyArray<string> =>
	Arr.flatMap(entriesOf(`/proc/${pid}/task`), (thread) =>
		Option.match(textOf(`/proc/${pid}/task/${thread}/children`), {
			onNone: () => [],
			onSome: (text) => Arr.filter(Str.split(" ")(Str.trim(text)), Str.isNonEmpty)
		})
	)

/**
 * The CPU (ms) of a process's live descendants started at or after `since` (ms since the machine booted), each one's own
 * and its waited-for children's: a descendant started earlier (a helper a need left running) is another case's, or no
 * case's, and counts with none of its own descendants either. A descendant reaped between two reads is counted in its
 * reaper's waited-for children from then on.
 */
const descendantsSince = (pid: string, since: number): number =>
	Arr.reduce(childrenOf(pid), 0, (total, child) =>
		Option.match(statOf(child), {
			onNone: () => total,
			onSome: (field) =>
				field(PROC.started) + TICK_MILLIS < since
					? total
					: total + allOf(field) + descendantsSince(child, since)
		})
	)

/** This process's own CPU so far, every thread's, in milliseconds: process.cpuUsage, a system call and no file. */
export const ownCpu = (): number => {
	const own = process.cpuUsage()
	return (own.user + own.system) / microsPerMilli
}

/** The CPU (ms) of the children a process has waited for. */
const reapedOf = (field: (field: number) => number): number =>
	field(PROC.childrenUser) + field(PROC.childrenSystem)

/**
 * A moment on the live clock as milliseconds since the machine booted, the clock a process's start is stated in: the two
 * meet at this process's start (performance.timeOrigin), to a tick. None without /proc.
 */
const sinceBootAt = (
	self: Option.Option<(field: number) => number>,
	wall: number
): Option.Option<number> =>
	Option.map(self, (field) => field(PROC.started) + (wall - performance.timeOrigin))

/**
 * A process's declared waits (live.ts waitingOn): how many are open, since when (ms on the live clock) the first of the
 * open ones began, and the wall milliseconds the closed ones spent. A declared wait waits on a resource other processes
 * hold or make: a connection lease's slot, a template's build lock, PostgreSQL's work behind a need's open or take. It
 * spends no CPU of the waiter's tree, and it ends once those processes give the resource up, each of them guarded in
 * turn (another run's worker by its own pool, a backend by PostgreSQL once its client is gone), so a guard's stall leg
 * counts none of its wall time: the leg is for work blocked on something that will not come.
 */
export type Waits = Readonly<{ open: number; since: number; spent: number }>

/** No wait declared yet. */
export const noWaits: Waits = { open: 0, since: 0, spent: 0 }

/** `waits` with one more wait open, entered at `wall`. */
export const waitEntered = (waits: Waits, wall: number): Waits =>
	waits.open === 0
		? { open: 1, since: wall, spent: waits.spent }
		: { open: waits.open + 1, since: waits.since, spent: waits.spent }

/** `waits` with one open wait closed at `wall`; the last to close ends the span the first opened. */
export const waitLeft = (waits: Waits, wall: number): Waits =>
	waits.open === 1
		? { open: 0, since: 0, spent: waits.spent + (wall - waits.since) }
		: { open: waits.open - 1, since: waits.since, spent: waits.spent }

/** The wall milliseconds spent in declared waits by `wall`: the closed ones', and the open span's so far. */
export const waitedBy = (waits: Waits, wall: number): number =>
	waits.spent + (waits.open > 0 ? wall - waits.since : 0)

/**
 * A process's declared waits, and where it reports whether it waits each time that changes: to its pool, in a worker
 * (runner/worker.ts), since the pool watches the worker from outside it; nowhere in a process no pool watches.
 */
type ProcessWaits = { waits: Waits; report: Option.Option<(waiting: boolean) => void> }

declare global {
	var bjornpagenTestingWaits: ProcessWaits | undefined
}

/** This process's declared waits: one ledger a process, as its waits are its own whatever run or case opened them. */
const processWaits = (): ProcessWaits => {
	globalThis.bjornpagenTestingWaits ??= { waits: noWaits, report: Option.none() }
	return globalThis.bjornpagenTestingWaits
}

/** This process's declared waits are reported to `report` from now on, whether it waits after each change. */
export const reportWaitsTo = (report: (waiting: boolean) => void): void => {
	processWaits().report = Option.some(report)
}

/** One of this process's declared waits opens at `wall` (live.ts waitingOn), reported when it is the first open. */
export const enterWait = (wall: number): void => {
	const ledger = processWaits()
	ledger.waits = waitEntered(ledger.waits, wall)
	if (ledger.waits.open === 1) {
		Option.map(ledger.report, (report) => report(true))
	}
}

/** One of this process's declared waits closes at `wall`, reported when it was the last open. */
export const leaveWait = (wall: number): void => {
	const ledger = processWaits()
	ledger.waits = waitLeft(ledger.waits, wall)
	if (ledger.waits.open === 0) {
		Option.map(ledger.report, (report) => report(false))
	}
}

/** The wall milliseconds this process has spent in declared waits by `wall`. */
const ownWaited = (wall: number): number => waitedBy(processWaits().waits, wall)

/**
 * A process tree's work as a guard reads it: where it began, the CPU (ms) it has spent by now, on the same scale, and
 * the wall milliseconds it has spent in declared waits by a moment on the live clock (Waits). Its live descendants count
 * only when started since it began; a descendant started earlier (a helper a need left running) is no part of this
 * work.
 */
export type TreeWork = Readonly<{
	began: Reading
	cpu: () => number
	waited: (wall: number) => number
}>

/**
 * This process's work, begun at `wall` on the live clock with `own` CPU (ownCpu, read before the work started): its own
 * CPU, its waited-for children's, and its live descendants'. Read when a guard first needs it, once the work has
 * yielded, so work that runs to its end synchronously reads no file; it reads /proc/self/stat once, and no descendant,
 * since none the work started is counted until its first reading, all of whose CPU is the work's. Without /proc its own
 * CPU counts alone.
 */
export const ownWork = (wall: number, own: number): TreeWork => {
	const self = statOf("self")
	const since = sinceBootAt(self, wall)
	return {
		began: {
			wall,
			cpu: own + Option.match(self, { onNone: () => 0, onSome: reapedOf }),
			waited: ownWaited(wall)
		},
		waited: ownWaited,
		cpu: () =>
			ownCpu() +
			Option.match(statOf("self"), {
				onNone: () => 0,
				onSome: (field) =>
					reapedOf(field) +
					Option.match(since, {
						onNone: () => 0,
						onSome: (at) => descendantsSince("self", at)
					})
			})
	}
}

/**
 * Another process's work, begun at `wall` on the live clock (the pool's watch of a worker): its own CPU, its waited-for
 * children's, and its live descendants' started since, and the wall time `waited` says it spent in declared waits, as
 * it reported them. A process this one cannot read (none started, gone, or no /proc) reads as spending nothing, so its
 * work never moves and a guard ends it after one deadline of wall time outside its waits, as the live clock did.
 */
export const processWork = (
	pid: Option.Option<number>,
	wall: number,
	waited: (wall: number) => number
): TreeWork => {
	const since = sinceBootAt(statOf("self"), wall)
	const own = () =>
		Option.match(
			Option.flatMap(pid, (id) => statOf(String(id))),
			{
				onNone: () => 0,
				onSome: allOf
			}
		)
	return {
		began: { wall, cpu: own(), waited: waited(wall) },
		waited,
		cpu: () =>
			own() +
			Option.match(
				Option.zipWith(pid, since, (id, at) => descendantsSince(String(id), at)),
				{
					onNone: () => 0,
					onSome: (descendants) => descendants
				}
			)
	}
}

/**
 * This process's work as its watchdog reads it while a case holds the main thread (live.ts watchedCase): its own CPU,
 * every thread's, and its live descendants' started since `wall`. It reads nothing until the watchdog asks, so a case
 * pays one process.cpuUsage for it; it leaves out the children the process waits for meanwhile, which a held main
 * thread reaps only through a synchronous spawn, whose child it counts while the child lives.
 */
export const heldWork = (wall: number, own: number): TreeWork => ({
	began: { wall, cpu: own, waited: ownWaited(wall) },
	waited: ownWaited,
	cpu: () =>
		ownCpu() +
		Option.match(sinceBootAt(statOf("self"), wall), {
			onNone: () => 0,
			onSome: (at) => descendantsSince("self", at)
		})
})

/**
 * A judge of `work` under `deadline` milliseconds that keeps its window between readings: at each reading, at `wall` on
 * the live clock, it says whether the work is over its deadline (spent, or stalled over a whole window) and carries a
 * working window forward.
 */
export const judgeOf = (work: TreeWork, deadline: number): ((wall: number) => boolean) => {
	let window = work.began
	return (wall) => {
		const standing = standingOf({
			began: work.began,
			window,
			now: { wall, cpu: work.cpu(), waited: work.waited(wall) },
			deadline
		})
		if (standing.kind !== "working") {
			return true
		}
		window = standing.window
		return false
	}
}

/**
 * A reading of a case's work: the live clock, the CPU its process tree has spent, and the wall time it has spent in
 * declared waits (Waits), all in milliseconds.
 */
export type Reading = Readonly<{ wall: number; cpu: number; waited: number }>

/**
 * Where a case stands against its deadline at a reading: working, with the window it is judged over next (the reading
 * its current window began at, or this one once a whole deadline of wall time outside declared waits has passed) and
 * when to read it again; or over its deadline (Overrun).
 */
export type Standing = Readonly<{ kind: "working"; window: Reading; readAgainAt: number }> | Overrun

/**
 * Which of a guard's two legs a piece of work is over its `deadline` milliseconds by, with what it measured: `spent`, its
 * tree's CPU since it began (`spent`, ms) at the deadline, a runaway; or `stalled`, its tree's CPU moved by `moved` ms
 * over a window of `over` ms of wall time outside its declared waits, a whole deadline, which is less than the
 * `progress` ms that shows progress there, so it waited on something that did not come; `waited`, the window's wall
 * time in declared waits besides, which the leg counts none of.
 */
export type Overrun =
	| Readonly<{ kind: "spent"; spent: number; deadline: number }>
	| Readonly<{
			kind: "stalled"
			moved: number
			over: number
			waited: number
			progress: number
			deadline: number
	  }>

/** Milliseconds as seconds to the tenth, as a report states them. */
const seconds = (millis: number): string => `${(millis / millisPerSecond).toFixed(1)} s`

/** An Overrun as a report states it: the leg that fired, what it measured, and the bound it measured against. */
export const overrunText = (overrun: Overrun): string => {
	switch (overrun.kind) {
		case "spent":
			return `its process tree spent ${seconds(overrun.spent)} of CPU, its bound ${seconds(overrun.deadline)}`
		case "stalled":
			return `its process tree's CPU moved ${overrun.moved.toFixed(0)} ms over ${seconds(overrun.over)} of wall time outside declared waits (${seconds(overrun.waited)} in them besides), under the ${overrun.progress.toFixed(0)} ms that shows progress over its bound of ${seconds(overrun.deadline)}`
	}
}

/**
 * How much a tree's CPU must move over a window of `deadline` wall milliseconds to be progress: stalledShare of one CPU
 * over it, and never less than one clock tick, the smallest change Linux states of a child's CPU (and more than a timer's
 * wake-up and a reading cost a process that waits).
 */
const progressOver = (deadline: number): number => Math.max(deadline * stalledShare, TICK_MILLIS)

/**
 * A case's standing at `now`, having begun at `began`, its current window begun at `window`, under `deadline`
 * milliseconds. A window is whole once a deadline of its wall time lies outside declared waits. A working case is read
 * again when its window could next be whole, or sooner when its remaining CPU, spent at one CPU, would reach the
 * deadline first.
 */
export const standingOf = (
	input: Readonly<{ began: Reading; window: Reading; now: Reading; deadline: number }>
): Standing => {
	const { began, window, now, deadline } = input
	const spent = now.cpu - began.cpu
	if (spent >= deadline) {
		return { kind: "spent", spent, deadline }
	}
	const waited = now.waited - window.waited
	const over = now.wall - window.wall - waited
	const moved = now.cpu - window.cpu
	const progress = progressOver(deadline)
	const whole = over >= deadline
	if (whole && moved < progress) {
		return { kind: "stalled", moved, over, waited, progress, deadline }
	}
	return {
		kind: "working",
		window: whole ? now : window,
		readAgainAt: now.wall + Math.min(whole ? deadline : deadline - over, deadline - spent)
	}
}
