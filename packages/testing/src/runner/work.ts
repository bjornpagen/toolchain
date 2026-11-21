import { Array as Arr, Equivalence, Option, Order, Result, String as Str } from "effect"
import { stalledShareOfCpu } from "#runner/limits.ts"

/**
 * What a case's deadline measures: the work the case does, not the time the machine takes to let it. A case is hung when
 * its process tree (the process that runs it, the children it waits for, and every live descendant) has spent its
 * deadline in CPU, a runaway; or when, over a whole deadline of wall time, that CPU has not moved, a case blocked on
 * something that will not come. A case the machine merely slows (CPU it waits for, pages it waits on, IO behind other
 * work) keeps moving and is never hung for it: on cassowary at load 260 to 880, one of the toolchain's gate cases took
 * 1.0 to 92.1 s of wall time for the same 0.8 to 4.3 s of its own CPU (CHECK-ROOT, 2026-11-17), so a deadline on the live
 * clock judged the machine, not the case. Nor is a case hung for a declared wait on work other processes do (Waits): a
 * template's build lock, PostgreSQL's work behind a need's open, spends no CPU of its tree, and its wall time is no
 * stall. A wait for kernel locks other processes hold (LockWaits: a run's lease on a cluster, its slots behind another
 * run's workers, or a cluster's lifecycle lock) is judged by its holders' work instead (Held): the CPU of each holder's
 * run moves for the waiter, so a wait behind a run that works is never a stall however long it lasts, while a wait
 * behind a holder that has stopped is one (SELECTWHOLE, 2026-11-18: thirteen kill trials' first cases waited 66 s and
 * more on a lease slot and were ended as stalled; 5442, 2026-11-20: every install's open waited past its 300 s bound at
 * no CPU while a full suite held the slots), and a wait whose holder's run encloses the run that waits never ends, a
 * deadlock, and is hung at its first reading (a nested run that reserved again what its enclosing run held:
 * trialTemplatesApart's kill trials under a gate run that held every slot of 5441). Linux states a process tree's CPU
 * and its locks in /proc; a system without it states only the process's own CPU (process.cpuUsage), and a case that
 * waits on a child or a lock there is judged by the stall alone, which is the live clock's old deadline.
 */

/**
 * @formatConstant Linux's /proc/<pid>/stat (proc(5)): its fields after the command's closing parenthesis, from the third
 * (the state); the parent's pid the 4th; its major page faults (each a page read from storage or swap) the 12th; the
 * process's user and system time the 14th and 15th, those of the children it
 * has waited for the 16th and 17th, and the moment it started the 22nd, since the machine booted; every time in clock
 * ticks of USER_HZ, which Linux fixes at 100 a second for every program whatever the kernel's own tick.
 * /proc/<pid>/task/<tid>/children lists the children each thread started.
 */
const PROC = {
	firstField: 3,
	parent: 4,
	majorFaults: 12,
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
export const TICK_MILLIS = millisPerSecond / PROC.ticksPerSecond

const { readFileSync, readdirSync, statSync } = process.getBuiltinModule("node:fs")

/** A file's text, none when it cannot be read (a process gone, a system without /proc). */
const textOf = (path: string): Option.Option<string> =>
	Result.getSuccess(Result.try(() => readFileSync(path, "utf8")))

/** A directory's entries, none when it cannot be read. */
const entriesOf = (path: string): ReadonlyArray<string> =>
	Option.getOrElse(Result.getSuccess(Result.try(() => readdirSync(path))), () => [])

/** A process's stat fields, by number, as /proc states them; none for a process gone or a system without /proc. */
const fieldsOf = (pid: string): Option.Option<(field: number) => number> =>
	Option.flatMap(textOf(`/proc/${pid}/stat`), (stat) =>
		Option.map(Str.lastIndexOf(")")(stat), (closing) => {
			const values = Str.split(" ")(Str.trim(Str.slice(closing + 1)(stat)))
			return (field: number) => Number(values[field - PROC.firstField])
		})
	)

/** A process's stat fields, by number, in milliseconds; none for a process gone or a system without /proc. */
const statOf = (pid: string): Option.Option<(field: number) => number> =>
	Option.map(
		fieldsOf(pid),
		(field) => (at: number) => (field(at) * millisPerSecond) / PROC.ticksPerSecond
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
 * A process's live descendants started at or after `since` (ms since the machine booted): a descendant started earlier
 * (a helper a need left running) is another case's, or no case's, and none of its own descendants is either. A
 * descendant reaped between two reads is counted in its reaper's waited-for children from then on.
 */
const descendantsOf = (pid: string, since: number): ReadonlyArray<string> =>
	Arr.flatMap(childrenOf(pid), (child) =>
		Option.match(statOf(child), {
			onNone: () => [],
			onSome: (field) =>
				field(PROC.started) + TICK_MILLIS < since ? [] : [child, ...descendantsOf(child, since)]
		})
	)

/**
 * What a process tree has done that a guard counts beside its CPU: `queued`, the milliseconds its processes waited on a
 * runqueue while runnable, the machine's delay of work that wants to run; and `stored`, its storage work, the bytes it
 * read from and wrote to storage and the pages it faulted in, a process blocked on storage or swap doing its work. Both
 * only grow; a process blocked on something that does not come (a lock, a pipe, a stop) moves neither.
 */
export type Stir = Readonly<{ queued: number; stored: number }>

/** No stir: a tree of no other process. */
const noStir: Stir = { queued: 0, stored: 0 }

/**
 * @formatConstant Linux's /proc/<pid>/schedstat (Documentation/scheduler/sched-stats.rst): three numbers on a line, the
 * time the process ran, the time it spent runnable on a runqueue waiting to run, both in nanoseconds, and the timeslices
 * it ran; and /proc/<pid>/io (proc(5)): `name: value` lines, read_bytes and write_bytes the bytes it caused to be read
 * from and written to storage.
 */
const SCHEDSTAT = {
	waited: 1,
	nanosPerMilli: 1_000_000,
	read: "read_bytes",
	written: "write_bytes"
} as const

/**
 * A process tree's work as a guard reads it at once: the CPU (ms) its processes spent, each one's own and its
 * waited-for children's, and what they did beside (Stir), read in one walk of the tree, so a reading costs its process
 * no more than its CPU's reading did.
 */
export type Effort = Readonly<{ cpu: number; stir: Stir }>

/** No effort: no process. */
const noEffort: Effort = { cpu: 0, stir: noStir }

/**
 * What a process has done, its CPU and its stir: the time it waited to run while runnable, in milliseconds
 * (/proc/<pid>/schedstat, its first thread's), and its storage work, the bytes it read from and wrote to storage and the
 * pages it faulted in (/proc/<pid>/io, its stat's major faults); none for a process gone or a system without /proc.
 */
const effortOfProcess = (pid: string): Effort =>
	Option.match(fieldsOf(pid), {
		onNone: () => noEffort,
		onSome: (field) => {
			const queued = Option.match(
				Option.flatMap(textOf(`/proc/${pid}/schedstat`), (text) =>
					Arr.get(Str.split(" ")(Str.trim(text)), SCHEDSTAT.waited)
				),
				{ onNone: () => 0, onSome: (nanos) => Number(nanos) / SCHEDSTAT.nanosPerMilli }
			)
			const io = Option.match(textOf(`/proc/${pid}/io`), {
				onNone: () => 0,
				onSome: (text) =>
					Arr.reduce(Str.split("\n")(text), 0, (total, line) => {
						const [name, value] = Str.split(":")(line)
						return name === SCHEDSTAT.read || name === SCHEDSTAT.written
							? total + Number(value)
							: total
					})
			})
			const ticks = (at: number) => (field(at) * millisPerSecond) / PROC.ticksPerSecond
			return {
				cpu:
					ticks(PROC.user) +
					ticks(PROC.system) +
					ticks(PROC.childrenUser) +
					ticks(PROC.childrenSystem),
				stir: { queued, stored: io + field(PROC.majorFaults) }
			}
		}
	})

/** Two stirs summed. */
const stirPlus = (one: Stir, other: Stir): Stir => ({
	queued: one.queued + other.queued,
	stored: one.stored + other.stored
})

/** The effort of processes, each one's summed. */
const effortOfAll = (pids: ReadonlyArray<string>): Effort =>
	Arr.reduce(pids, noEffort, (total, pid) => {
		const one = effortOfProcess(pid)
		return { cpu: total.cpu + one.cpu, stir: stirPlus(total.stir, one.stir) }
	})

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
 * A process's declared waits on work other processes do (live.ts waitingOn): how many are open, since when (ms on the
 * live clock) the first of the open ones began, and the wall milliseconds the closed ones spent. Such a wait waits on
 * work that names no holder this process can read: a template's build lock, PostgreSQL's work behind a need's open or
 * take. It spends no CPU of the waiter's tree, and it ends once that work is done, each of its doers guarded in turn (a
 * backend by PostgreSQL once its client is gone), so a guard's stall leg counts none of its wall time: the leg is for
 * work blocked on something that will not come.
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
 * A process's declared waits for kernel locks (live.ts waitingFor), one entry an open wait, the files it waits to lock:
 * a run's lease on a cluster and a cluster's lifecycle lock (pg/hold.ts), and a worker's ask for its run's lease, which
 * the run's parent takes (runner/leases.ts). Its wall time is no wait the stall leg leaves out: the leg reads the work
 * of the locks' holders as the waiter's (Held), so a wait behind a holder that works moves, and one behind a holder that
 * has stopped, or behind one whose run encloses the waiter's, is judged for what it is.
 */
type LockWaits = ReadonlyArray<Arr.NonEmptyReadonlyArray<string>>

/** The files open lock waits wait to lock, each once, in order. */
const lockedFiles = (locks: LockWaits): ReadonlyArray<string> =>
	Arr.sort(Arr.dedupe(Arr.flatten(locks)), Order.String)

/**
 * A change of a process's declared waits that its pool is told of (runner/protocol.ts FromWorker): its first wait on
 * work opened (`waiting`), or its last one closed (`waited`), or the files its lock waits wait to lock became `files`.
 */
export type WaitChange =
	| Readonly<{ kind: "waiting" }>
	| Readonly<{ kind: "waited" }>
	| Readonly<{ kind: "locks"; files: ReadonlyArray<string> }>

/**
 * A process's declared waits, what each open wait on work waits on (`on`, its name: the statement a member runs for
 * it, a template's build), and where it reports each change of them: to its pool, in a worker (runner/worker.ts), since
 * the pool watches the worker from outside it; nowhere in a process no pool watches.
 */
type ProcessWaits = {
	waits: Waits
	on: ReadonlyArray<string>
	locks: LockWaits
	report: Option.Option<(change: WaitChange) => void>
}

declare global {
	var bjornpagenTestingWaits: ProcessWaits | undefined
}

/** This process's declared waits: one ledger a process, as its waits are its own whatever run or case opened them. */
const processWaits = (): ProcessWaits => {
	globalThis.bjornpagenTestingWaits ??= {
		waits: noWaits,
		on: [],
		locks: [],
		report: Option.none()
	}
	return globalThis.bjornpagenTestingWaits
}

/** This process's declared waits are reported to `report` from now on, at each change. */
export const reportWaitsTo = (report: (change: WaitChange) => void): void => {
	processWaits().report = Option.some(report)
}

/**
 * One of this process's declared waits opens at `wall`, waiting on `on` (live.ts waitingOn), reported when it is the
 * first open.
 */
export const enterWait = (wall: number, on: string): void => {
	const ledger = processWaits()
	ledger.waits = waitEntered(ledger.waits, wall)
	ledger.on = [...ledger.on, on]
	if (ledger.waits.open === 1) {
		Option.map(ledger.report, (report) => report({ kind: "waiting" }))
	}
}

/** The declared wait on `on` closes at `wall`, reported when it was the last open. */
export const leaveWait = (wall: number, on: string): void => {
	const ledger = processWaits()
	ledger.waits = waitLeft(ledger.waits, wall)
	ledger.on = Option.match(
		Arr.findFirstIndex(ledger.on, (open) => open === on),
		{
			onNone: () => ledger.on,
			onSome: (at) => Arr.remove(ledger.on, at)
		}
	)
	if (ledger.waits.open === 0) {
		Option.map(ledger.report, (report) => report({ kind: "waited" }))
	}
}

/** What this process's open declared waits on work wait on, in the order they opened: what a verdict's report names. */
export const waitedOnNow = (): ReadonlyArray<string> => processWaits().on

/** The files each of this process's open lock waits waits to lock, in the order they opened. */
export const lockWaitsNow = (): LockWaits => processWaits().locks

/** This process's lock waits became `locks`: the ledger holds them, and the files they wait to lock are reported. */
const locksBecame = (locks: LockWaits): void => {
	const ledger = processWaits()
	ledger.locks = locks
	Option.map(ledger.report, (report) => report({ kind: "locks", files: lockedFiles(locks) }))
}

/** One of this process's lock waits opens, for `files` (live.ts waitingFor). */
export const enterLockWait = (files: Arr.NonEmptyReadonlyArray<string>): void => {
	locksBecame([...processWaits().locks, files])
}

/** The lock wait that opened for `files`, this very list, closes. */
export const leaveLockWait = (files: Arr.NonEmptyReadonlyArray<string>): void => {
	const { locks } = processWaits()
	locksBecame(
		Option.match(
			Arr.findFirstIndex(locks, (open) => open === files),
			{
				onNone: () => locks,
				onSome: (at) => Arr.remove(locks, at)
			}
		)
	)
}

/** The files this process's lock waits wait to lock now. */
const ownLocked = (): ReadonlyArray<string> => lockedFiles(processWaits().locks)

/**
 * Whose work a wait for kernel locks waits on, at a reading: the runs of the processes that hold the locks it waits for
 * and wait for none of them themselves, by pid, ascending (a holder is the toolchain's holder of kernel locks,
 * scripts/hold.pl, and its run the process that started it and holds its standard input open, which ends its hold),
 * and the CPU (ms) those runs' process trees have spent; and, when one is, the holder whose run encloses the run that
 * waits (Enclosing).
 */
export type Held = Readonly<{
	runs: ReadonlyArray<number>
	cpu: number
	stir: Stir
	enclosing: Option.Option<Enclosing>
}>

/**
 * A wait that never ends: process `waiter`, which waits to lock `file` for the work (the work's own process, or one
 * that encloses it), is blocked by process `holder`, whose run `run` encloses the waiter's own run, so it holds the lock
 * until after the work that waits for it has ended.
 */
export type Enclosing = Readonly<{ file: string; waiter: number; holder: number; run: number }>

/** A wait for no lock: no holder, no CPU, no stir. */
const unheld: Held = { runs: [], cpu: 0, stir: noStir, enclosing: Option.none() }

/**
 * @formatConstant Linux's /proc/locks (proc(5)): a line a lock, its fields split by spaces: the lock's number and a
 * colon; `->` when the line is a process blocked waiting for the lock of that number, listed after it; then the lock's
 * class (FLOCK for flock(2)), its mode and kind, the pid of the process that took it or waits for it, and its file as
 * `major:minor:inode`, the device's numbers in hexadecimal of two digits at least: the pid and file the 4th and 5th
 * fields after the number and the arrow.
 */
const LOCKS = { file: "/proc/locks", blocked: "->", pid: 3, inode: 4 } as const

/** A line of /proc/locks: the lock's number, whether the process blocks on it, the process, and the file's identity. */
type LockLine = Readonly<{ lock: string; blocked: boolean; pid: number; file: string }>

/** The locks Linux lists now; none without /proc. */
const locksNow = (): ReadonlyArray<LockLine> =>
	Arr.flatMap(
		Option.match(textOf(LOCKS.file), { onNone: () => [], onSome: Str.split("\n") }),
		(line): ReadonlyArray<LockLine> => {
			const fields = Arr.filter(Str.split(" ")(line), Str.isNonEmpty)
			const blocked = Option.contains(Arr.get(fields, 1), LOCKS.blocked)
			const rest = Arr.drop(fields, blocked ? 2 : 1)
			return Option.match(
				Option.all([Arr.head(fields), Arr.get(rest, LOCKS.pid), Arr.get(rest, LOCKS.inode)]),
				{
					onNone: () => [],
					onSome: ([lock, pid, file]) => [{ lock, blocked, pid: Number(pid), file }]
				}
			)
		}
	)

/** A device's major or minor number as /proc/locks writes it: hexadecimal, two digits at least. */
const deviceDigits = (number: bigint): string => Str.padStart(2, "0")(number.toString(16))

/**
 * A file's identity as /proc/locks writes it (LOCKS), from the device and inode its status states, the device split as
 * Linux encodes it (glibc's major and minor); none for a file that is not there.
 */
const lockFileOf = (path: string): Option.Option<string> =>
	Option.map(Result.getSuccess(Result.try(() => statSync(path, { bigint: true }))), (info) => {
		const major = ((info.dev >> 8n) & 0xfffn) | ((info.dev >> 32n) & 0xfffff000n)
		const minor = (info.dev & 0xffn) | ((info.dev >> 12n) & 0xffffff00n)
		return `${deviceDigits(major)}:${deviceDigits(minor)}:${info.ino.toString()}`
	})

/** A process's parent; none for a process gone, the first process, or a system without /proc. */
const parentOf = (pid: number): Option.Option<number> =>
	Option.filter(
		Option.map(fieldsOf(String(pid)), (field) => field(PROC.parent)),
		(parent) => parent > 0
	)

/** A process and every process above it, its parent first. */
const lineageOf = (pid: number): ReadonlyArray<number> => [
	pid,
	...Option.match(parentOf(pid), { onNone: () => [], onSome: lineageOf })
]

/**
 * Whose work the wait of the work whose process is `work` waits on, for locks on `files` (Held): the processes holding
 * a lock on one of them that are blocked on none of them (a process blocked on one, its own run's holder among them,
 * waits in the same queue), each by its run, the process that started it; and the first process blocked on one whose
 * run is the work's process or encloses it, if any, blocked by a holder whose run encloses that run in turn. A lock of a
 * process whose parent holds a lock on one of them is its parent's: the family queue's holder waits for each slot by a
 * child of its own (scripts/hold.pl's collectors), so a child's wait is the holder's, the holder is queued, never a
 * holder its waiters count the work of, and its run is the run whose wait it is, which deadlock detection reads.
 */
const heldOf = (files: ReadonlyArray<string>, work: number): Held => {
	const named = new Map(
		Arr.flatMap(files, (path) =>
			Option.match(lockFileOf(path), {
				onNone: () => [],
				onSome: (file) => [[file, path] as const]
			})
		)
	)
	if (named.size === 0) {
		return unheld
	}
	const found = Arr.flatMap(locksNow(), (lock) =>
		Option.match(Option.fromUndefinedOr(named.get(lock.file)), {
			onNone: () => [],
			onSome: (path) => [{ ...lock, path }]
		})
	)
	const holding = new Set(
		Arr.map(
			Arr.filter(found, (lock) => !lock.blocked),
			(lock) => lock.pid
		)
	)
	const locks = Arr.map(found, (lock) => ({
		...lock,
		pid: Option.getOrElse(
			Option.filter(parentOf(lock.pid), (parent) => holding.has(parent)),
			() => lock.pid
		)
	}))
	const queued = new Set(
		Arr.map(
			Arr.filter(locks, (lock) => lock.blocked),
			(lock) => lock.pid
		)
	)
	const runs = Arr.sort(
		Arr.dedupe(
			Arr.flatMap(locks, (lock) =>
				lock.blocked || queued.has(lock.pid) ? [] : Option.toArray(parentOf(lock.pid))
			)
		),
		Order.Number
	)
	const lineage = new Set(lineageOf(work))
	const enclosing = Arr.findFirst(locks, (waiter): Option.Option<Enclosing> =>
		Option.flatMap(
			Option.filter(parentOf(waiter.pid), (run) => waiter.blocked && lineage.has(run)),
			(own) =>
				Option.flatMap(
					Arr.findFirst(locks, (lock) => !lock.blocked && lock.lock === waiter.lock),
					(blocker) =>
						Option.map(
							Option.filter(parentOf(blocker.pid), (run) =>
								Arr.contains(Arr.drop(lineageOf(own), 1), run)
							),
							(run): Enclosing => ({
								file: waiter.path,
								waiter: waiter.pid,
								holder: blocker.pid,
								run
							})
						)
				)
		)
	)
	const effort = effortOfAll(
		Arr.flatMap(runs, (run) => [String(run), ...descendantsOf(String(run), 0)])
	)
	return { runs, cpu: effort.cpu, stir: effort.stir, enclosing }
}

/** The wall milliseconds this process has spent in declared waits by `wall`. */
const ownWaited = (wall: number): number => waitedBy(processWaits().waits, wall)

/**
 * A process tree's work as a guard reads it: where it began, the CPU (ms) it has spent by now, on the same scale, the
 * wall milliseconds it has spent in declared waits on work by a moment on the live clock (Waits), and whose work its
 * lock waits wait on now (Held). Its live descendants count only when started since it began; a descendant started
 * earlier (a helper a need left running) is no part of this work.
 */
export type TreeWork = Readonly<{
	began: Reading
	waited: (wall: number) => number
	held: () => Held
	effort: () => Effort
}>

/** A reading of `work` at `wall` on the live clock. */
export const readingOf = (work: TreeWork, wall: number): Reading => {
	const effort = work.effort()
	return { wall, cpu: effort.cpu, waited: work.waited(wall), held: work.held(), stir: effort.stir }
}

/** Whose work this process's lock waits wait on now. */
const ownHeld = (): Held => heldOf(ownLocked(), process.pid)

/**
 * This process's work, begun at `wall` on the live clock with `own` CPU (ownCpu, read before the work started): its own
 * CPU, every thread's, its waited-for children's, and its live descendants'; its descendants' stir, and its own as
 * `stirOwn` reads it. Read when a guard first needs it, once the work has yielded, so work that runs to its end
 * synchronously reads no file; it reads /proc/self/stat once to begin, and no descendant, since none the work started is
 * counted until its first reading, all of whose CPU is the work's. Without /proc its own CPU counts alone.
 */
const selfWork = (wall: number, own: number, stirOwn: () => Stir): TreeWork => {
	const self = statOf("self")
	const since = sinceBootAt(self, wall)
	const reaped = (stat: Option.Option<(field: number) => number>) =>
		Option.match(stat, { onNone: () => 0, onSome: reapedOf })
	return {
		began: {
			wall,
			cpu: own + reaped(self),
			waited: ownWaited(wall),
			held: ownHeld(),
			stir: stirOwn()
		},
		waited: ownWaited,
		held: ownHeld,
		effort: () => {
			const descendants = effortOfAll(
				Option.match(since, { onNone: () => [], onSome: (at) => descendantsOf("self", at) })
			)
			return {
				cpu: ownCpu() + reaped(statOf("self")) + descendants.cpu,
				stir: stirPlus(stirOwn(), descendants.stir)
			}
		}
	}
}

/**
 * This process's work as its own guards read it (selfWork), its stir its descendants' alone: a process whose guards
 * judge it wakes on its own, so waiting to run or faulting its pages in only delays a guard that sees the rest.
 */
export const ownWork = (wall: number, own: number): TreeWork => selfWork(wall, own, () => noStir)

/**
 * Another process's work, begun at `wall` on the live clock (the pool's watch of a worker): its own CPU, its waited-for
 * children's, and its live descendants' started since, the wall time `waited` says it spent in declared waits on work,
 * whose work the locks `locked` says its lock waits wait for are held by, as it reported them, and the stir of its
 * descendants: the worker's own is a guard's process's too (its own guards wake it), judged by its CPU alone. A process this one
 * cannot read (none started, gone, or no /proc) reads as spending nothing, so its work never moves and a guard ends it
 * after one deadline of wall time outside its waits, as the live clock did.
 */
export const processWork = (
	pid: Option.Option<number>,
	wall: number,
	waited: (wall: number) => number,
	locked: () => ReadonlyArray<string>
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
	const held = (): Held =>
		Option.match(pid, {
			onNone: () => unheld,
			onSome: (id) => heldOf(locked(), id)
		})
	const descendants = (): Effort =>
		effortOfAll(
			Option.getOrElse(
				Option.zipWith(pid, since, (id, at) => descendantsOf(String(id), at)),
				(): ReadonlyArray<string> => []
			)
		)
	const effort = (): Effort => {
		const theirs = descendants()
		return { cpu: own() + theirs.cpu, stir: theirs.stir }
	}
	const began = effort()
	return {
		began: { wall, cpu: began.cpu, waited: waited(wall), held: held(), stir: began.stir },
		waited,
		held,
		effort
	}
}

/**
 * This process's work as its watchdog reads it while a case holds the main thread (live.ts watchedCase, selfWork): its
 * CPU, the children a synchronous spawn reaped among it (the only reaping a held main thread does), and the stir of the
 * process itself beside its descendants': a held main thread
 * that waits to run or faults its pages in (a machine that starves it or pages it out) is waiting on the machine, not
 * stalled, and no guard of its own wakes it while it is held, which is why a pool judges a worker by its CPU alone and
 * the watchdog need not (the REDFIX2 deaths, 2026-11-20: two cases killed under 63 to 74% memory pressure).
 */
export const heldWork = (wall: number, own: number): TreeWork =>
	selfWork(wall, own, () => effortOfProcess("self").stir)

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
			now: readingOf(work, wall),
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
 * declared waits on work (Waits), all in milliseconds; whose work its lock waits wait on (Held); and the stir of the
 * processes of its tree but the guard's own (Stir).
 */
export type Reading = Readonly<{
	wall: number
	cpu: number
	waited: number
	held: Held
	stir: Stir
}>

/**
 * Where a case stands against its deadline at a reading: working, with the window it is judged over next (the reading
 * its current window began at, or this one once a whole deadline of wall time outside declared waits has passed) and
 * when to read it again; or over its deadline (Overrun).
 */
export type Standing = Readonly<{ kind: "working"; window: Reading; readAgainAt: number }> | Overrun

/**
 * Which of a guard's legs a piece of work is over its `deadline` milliseconds by, with what it measured: `spent`, its
 * tree's CPU since it began (`spent`, ms) at the deadline, a runaway; `stalled`, its tree's CPU moved by `moved` ms
 * over a window of `over` ms of wall time outside its declared waits on work, a whole deadline, which is less than the
 * `progress` ms that shows progress there, while no other process of its tree and no holder of a lock it waits for
 * moved at all (othersMoved), so it waited on something that did not come; `waited`, the window's wall time in declared
 * waits on work besides, which the leg counts none of;
 * or `deadlocked`, a lock it waits for held by a run that encloses the run that waits for it (Enclosing), so the wait
 * never ends.
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
	| (Readonly<{ kind: "deadlocked" }> & Enclosing)

/** Milliseconds as seconds to the tenth, as a report states them. */
const seconds = (millis: number): string => `${(millis / millisPerSecond).toFixed(1)} s`

/** An Overrun as a report states it: the leg that fired, what it measured, and the bound it measured against. */
export const overrunText = (overrun: Overrun): string => {
	switch (overrun.kind) {
		case "spent":
			return `its process tree spent ${seconds(overrun.spent)} of CPU, its bound ${seconds(overrun.deadline)}`
		case "stalled":
			return `its process tree's CPU moved ${overrun.moved.toFixed(0)} ms over ${seconds(overrun.over)} of wall time outside declared waits on work (${seconds(overrun.waited)} in them besides), under the ${overrun.progress.toFixed(0)} ms that shows progress over its bound of ${seconds(overrun.deadline)}, and no other process of its tree nor any holder of a lock it waits for ran, waited to run or did storage work`
		case "deadlocked":
			return `it waits for the lock on ${overrun.file}, which process ${String(overrun.waiter)} takes for it, and process ${String(overrun.holder)} holds it for process ${String(overrun.run)}, whose run encloses the one that waits, so it lets the lock go only after the wait has ended: the wait never ends`
	}
}

/**
 * How much a tree's CPU must move over a window of `deadline` wall milliseconds to be progress: stalledShareOfCpu of one CPU
 * over it, and never less than one clock tick, the smallest change Linux states of a child's CPU (and more than a timer's
 * wake-up and a reading cost a process that waits).
 */
const progressOver = (deadline: number): number =>
	Math.max(deadline * stalledShareOfCpu, TICK_MILLIS)

/** Whether two readings' lock holders are the same runs. */
const sameRuns = Arr.makeEquivalence(Equivalence.Number)

/** Whether a tree stirred between two readings: it waited to run or did storage work, by any amount. */
const stirred = (before: Stir, after: Stir): boolean =>
	after.queued > before.queued || after.stored > before.stored

/**
 * Whether the processes a case's work counts beside the guard's own moved at all between two readings: a holder of a
 * lock it waits for let go or another took hold, or the holders' runs ran, waited to run or did storage work, or a
 * process of its tree but the guard's own did. Any move counts, however small: each is work of a process the guard does
 * not run in, which a process blocked on something that does not come never does, so no threshold stands between them;
 * the guard's own process, whose own wake-ups to read its work wait to run and spend CPU, is judged by its CPU alone,
 * against progressOver.
 */
const othersMoved = (before: Reading, after: Reading): boolean =>
	!sameRuns(before.held.runs, after.held.runs) ||
	after.held.cpu > before.held.cpu ||
	stirred(before.held.stir, after.held.stir) ||
	stirred(before.stir, after.stir)

/**
 * A case's standing at `now`, having begun at `began`, its current window begun at `window`, under `deadline`
 * milliseconds. A window is whole once a deadline of its wall time lies outside declared waits on work; its work moves
 * by its tree's CPU, or by any move of the processes it counts beside the guard's own (othersMoved): a holder or a
 * child the machine keeps waiting to run, or one blocked on storage or swap, is working. A working case is read again when its window could next be
 * whole, or sooner when its remaining CPU, spent at one CPU, would reach the deadline first. A case whose lock is held
 * by a run that encloses its own is deadlocked at the reading that finds it so.
 */
export const standingOf = (
	input: Readonly<{ began: Reading; window: Reading; now: Reading; deadline: number }>
): Standing => {
	const { began, window, now, deadline } = input
	const spent = now.cpu - began.cpu
	if (spent >= deadline) {
		return { kind: "spent", spent, deadline }
	}
	if (Option.isSome(now.held.enclosing)) {
		return { kind: "deadlocked", ...now.held.enclosing.value }
	}
	const waited = now.waited - window.waited
	const over = now.wall - window.wall - waited
	const progress = progressOver(deadline)
	const moved = now.cpu - window.cpu
	const whole = over >= deadline
	if (whole && moved < progress && !othersMoved(window, now)) {
		return { kind: "stalled", moved, over, waited, progress, deadline }
	}
	return {
		kind: "working",
		window: whole ? now : window,
		readAgainAt: now.wall + Math.min(whole ? deadline : deadline - over, deadline - spent)
	}
}
