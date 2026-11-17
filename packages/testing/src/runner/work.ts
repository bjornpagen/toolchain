import { Array as Arr, Option, Result, String as Str } from "effect"
import { stalledShare } from "#runner/limits.ts"

/**
 * What a case's deadline measures: the work the case does, not the time the machine takes to let it. A case is hung when
 * its process tree (the process that runs it, the children it waits for, and every live descendant) has spent its
 * deadline in CPU, a runaway; or when, over a whole deadline of wall time, that CPU has not moved, a case blocked on
 * something that will not come. A case the machine merely slows (CPU it waits for, pages it waits on, IO behind other
 * work) keeps moving and is never hung for it: on cassowary at load 260 to 880, one of the toolchain's gate cases took
 * 1.0 to 92.1 s of wall time for the same 0.8 to 4.3 s of its own CPU (CHECK-ROOT, 2026-11-17), so a deadline on the live
 * clock judged the machine, not the case. Linux states a process tree's CPU in /proc; a system without it states only
 * the process's own (process.cpuUsage), and a case that waits on a child there is judged by the stall alone, which is
 * the live clock's old deadline.
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

/**
 * Where a case's work begins: the live clock, this process's own CPU (every thread's) and its waited-for children's, in
 * milliseconds, and when this process started, in milliseconds since the machine booted (none without /proc, where the
 * children's CPU is none too).
 */
export type Began = Readonly<{ wall: number; cpu: number; booted: Option.Option<number> }>

/** This process's own CPU so far, every thread's, in milliseconds: process.cpuUsage, a system call and no file. */
export const ownCpu = (): number => {
	const own = process.cpuUsage()
	return (own.user + own.system) / microsPerMilli
}

/**
 * Where a case's work began, at `wall` on the live clock with `own` CPU: read when its guard first needs it, once the
 * case has yielded, so a case that runs to its end synchronously reads no file. One read of /proc/self/stat; no
 * descendant is read, since none the case started is counted until its first reading (treeCpuAt), all of whose CPU is
 * the case's.
 */
export const beganAt = (wall: number, own: number): Began => {
	const self = statOf("self")
	return {
		wall,
		cpu:
			own +
			Option.match(self, {
				onNone: () => 0,
				onSome: (field) => field(PROC.childrenUser) + field(PROC.childrenSystem)
			}),
		booted: Option.map(self, (field) => field(PROC.started))
	}
}

/**
 * The CPU (ms) this process's tree has spent, for a case begun at `began`: its own, its waited-for children's, and every
 * live descendant's started since the case began. The live clock and the boot clock meet at this process's start
 * (performance.timeOrigin), to a tick.
 */
export const treeCpuAt = (began: Began): number =>
	ownCpu() +
	Option.match(statOf("self"), {
		onNone: () => 0,
		onSome: (field) =>
			field(PROC.childrenUser) +
			field(PROC.childrenSystem) +
			Option.match(began.booted, {
				onNone: () => 0,
				onSome: (booted) => descendantsSince("self", booted + (began.wall - performance.timeOrigin))
			})
	})

/** A reading of a case's work: the live clock, and the CPU its process tree has spent, both in milliseconds. */
export type Reading = Readonly<{ wall: number; cpu: number }>

/**
 * Where a case stands against its deadline at a reading: working, with the window it is judged over next (the reading
 * its current window began at, or this one once a whole deadline of wall time has passed) and when to read it again;
 * spent, its tree's CPU since it began at its deadline; or stalled, its tree's CPU moved by less than it takes to show
 * progress over a whole deadline of wall time.
 */
export type Standing =
	| Readonly<{ kind: "working"; window: Reading; readAgainAt: number }>
	| Readonly<{ kind: "spent" }>
	| Readonly<{ kind: "stalled" }>

/**
 * How much a tree's CPU must move over a window of `deadline` wall milliseconds to be progress: stalledShare of one CPU
 * over it, and never less than one clock tick, the smallest change Linux states of a child's CPU (and more than a timer's
 * wake-up and a reading cost a process that waits).
 */
const progressOver = (deadline: number): number => Math.max(deadline * stalledShare, TICK_MILLIS)

/**
 * A case's standing at `now`, having begun at `began`, its current window begun at `window`, under `deadline`
 * milliseconds. A working case is read again at its window's end, or sooner when its remaining CPU, spent at one CPU,
 * would reach the deadline first.
 */
export const standingOf = (
	input: Readonly<{ began: Reading; window: Reading; now: Reading; deadline: number }>
): Standing => {
	const { began, window, now, deadline } = input
	const spent = now.cpu - began.cpu
	if (spent >= deadline) {
		return { kind: "spent" }
	}
	const whole = now.wall - window.wall >= deadline
	if (whole && now.cpu - window.cpu < progressOver(deadline)) {
		return { kind: "stalled" }
	}
	const next = whole ? now : window
	return {
		kind: "working",
		window: next,
		readAgainAt: Math.min(next.wall + deadline, now.wall + (deadline - spent))
	}
}
