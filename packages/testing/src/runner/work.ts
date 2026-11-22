import { Array as Arr, Effect, Option, Result, String as Str } from "effect"
import { stalledShareOfCpu, waitedWindows } from "#runner/limits.ts"

/**
 * What a case's deadline measures: the work the case does, not the time the machine takes to let it. A case is hung when
 * its process tree (the process that runs it, the children it waits for, and every live descendant) has spent its
 * deadline in CPU, a runaway; or when, over a whole deadline of wall time, that CPU has not moved, a case blocked on
 * something that will not come. A case the machine merely slows (CPU it waits for, pages it waits on, IO behind other
 * work) keeps moving and is never hung for it: on cassowary at load 260 to 880, one of the toolchain's gate cases took
 * 1.0 to 92.1 s of wall time for the same 0.8 to 4.3 s of its own CPU (CHECK-ROOT, 2026-11-17), so a deadline on the live
 * clock judged the machine, not the case. Nor is a case hung for a declared wait on work other processes do (Waits): a
 * template's build lock, PostgreSQL's work behind a need's open, spends no CPU of its tree, and its wall time is no
 * stall. Linux states a process tree's CPU in /proc; a system without it states only the process's own CPU
 * (process.cpuUsage), and a case that waits on a child there is judged by the stall alone, which is the live clock's
 * old deadline.
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

const { readFileSync, readdirSync } = process.getBuiltinModule("node:fs")

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
 * only grow, a tree's as its ledger keeps them (StirLedger); a process blocked on something that does not come (a lock, a pipe, a stop) moves `stored` not at all and
 * `queued` by its wake-ups' little waits alone (queuedBetween).
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
const effortOfFields = (pid: string, field: (field: number) => number): Effort => {
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
				return name === SCHEDSTAT.read || name === SCHEDSTAT.written ? total + Number(value) : total
			})
	})
	const ticks = (at: number) => (field(at) * millisPerSecond) / PROC.ticksPerSecond
	return {
		cpu:
			ticks(PROC.user) + ticks(PROC.system) + ticks(PROC.childrenUser) + ticks(PROC.childrenSystem),
		stir: { queued, stored: io + field(PROC.majorFaults) }
	}
}

/** A process's effort read from its stat (effortOfFields); none for a process gone or a system without /proc. */
const effortOfProcess = (pid: string): Effort =>
	Option.match(fieldsOf(pid), {
		onNone: () => noEffort,
		onSome: (field) => effortOfFields(pid, field)
	})

/** Two stirs summed. */
const stirPlus = (one: Stir, other: Stir): Stir => ({
	queued: one.queued + other.queued,
	stored: one.stored + other.stored
})

/**
 * A tree's stir as its processes end: `last`, each live process's latest stir by its pid and its start (a pid the kernel
 * hands out again is another process), and `gone`, the stir its ended processes had at their last reading. A process's
 * runqueue wait and storage work leave /proc with it, so a tree summed over its live processes alone read less once a
 * child ended, and a window in which a busy child ended read a negative wait that cancelled its tree's CPU: metis's
 * level-template opens, whose `grizzle generate` and `grizzle migrate` children end inside a window, were judged stalled
 * having moved 40 and 68 s of CPU in it, their other processes having "waited -416238.3 ms" and "-216388.2 ms"
 * (trunk@metis at a53810cd, 2026-11-22).
 */
export type StirLedger = Readonly<{ last: ReadonlyMap<string, Stir>; gone: Stir }>

/** A tree's ledger before its first reading. */
export const noStirLedger: StirLedger = { last: new Map(), gone: noStir }

/** The ledger after a reading of a tree's live processes, by key: an ended process's last stir passes into `gone`. */
export const stirLedgerAfter = (
	ledger: StirLedger,
	live: ReadonlyArray<readonly [string, Stir]>
): StirLedger => {
	const now = new Map(live)
	return {
		last: now,
		gone: Arr.reduce(
			Arr.filter(Arr.fromIterable(ledger.last), ([key]) => !now.has(key)),
			ledger.gone,
			(total, [, stir]) => stirPlus(total, stir)
		)
	}
}

/** A tree's stir as its ledger keeps it: its live processes' and its ended ones' last, so it only grows. */
export const stirOfLedger = (ledger: StirLedger): Stir =>
	Arr.reduce(Arr.fromIterable(ledger.last.values()), ledger.gone, stirPlus)

/**
 * The effort of a tree's processes as a work reads them again and again (ownWork, processWork): their CPU summed, and
 * their stir kept by a ledger (StirLedger), so an ended process's stays in it.
 */
const keptEffort = (): ((pids: ReadonlyArray<string>) => Effort) => {
	let ledger = noStirLedger
	return (pids) => {
		const read = Arr.flatMap(pids, (pid) =>
			Option.match(fieldsOf(pid), {
				onNone: () => [],
				onSome: (field) => [
					[`${pid}@${String(field(PROC.started))}`, effortOfFields(pid, field)] as const
				]
			})
		)
		ledger = stirLedgerAfter(
			ledger,
			Arr.map(read, ([key, effort]) => [key, effort.stir] as const)
		)
		return {
			cpu: Arr.reduce(read, 0, (total, [, effort]) => total + effort.cpu),
			stir: stirOfLedger(ledger)
		}
	}
}

/**
 * This process's own CPU so far, every thread's but what it spent observing its cases, in milliseconds:
 * process.cpuUsage, a system call and no file, less the observer's (live.ts Watchdog's observed: the watchdog thread's
 * CPU, and the main thread's in each reading of a case's work, its walk of /proc for descendants among it), which no
 * case spends. A worker runs its units one at a time and a search its cases one at a time (runner/worker.ts
 * evaluating, explore.ts windowOf), so with the observer left out a case's window holds only its own work.
 * Counted as a case's, the observer's work read as the case's progress and spent its budget: of 192 planted threads
 * that only wait, under a 71 ms deadline, one read as working at its first answer and one spent its 71 ms by its
 * second, neither doing anything (~/.cache/metis/SLOP-FIXER-2-scratch/watchdog/probe4, r4-11 and r2-32, 2026-11-22). A
 * case's own worker threads and V8's helpers count: a held case's near none, a running one's real work.
 */
export const ownCpu = (): number => {
	const own = process.cpuUsage()
	const observed = Option.match(Option.fromUndefinedOr(globalThis.bjornpagenTestingWatchdog), {
		onNone: () => 0,
		onSome: (watchdog) => watchdog.observed()
	})
	return (own.user + own.system - observed) / microsPerMilli
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
 * A change of a process's declared waits that its pool is told of (runner/protocol.ts FromWorker): its first wait on
 * work opened (`waiting`), or its last one closed (`waited`).
 */
export type WaitChange = Readonly<{ kind: "waiting" }> | Readonly<{ kind: "waited" }>

/**
 * What a declared wait claims of the work it waits on: nothing a guard can check (`trusted`: a template's build, a lock
 * another process holds), or that a server works on it, which `working` asks the server (`checked`: a statement, whose
 * backend the member says is working or not, pg/session.ts backendWorking).
 */
export type Claim =
	| Readonly<{ kind: "trusted" }>
	| Readonly<{ kind: "checked"; working: Effect.Effect<boolean> }>

/** An open declared wait: its own id, what it waits on (`on`, its name), and what it claims (Claim). */
type OpenWait = Readonly<{ id: number; on: string; claim: Claim }>

/**
 * A process's declared waits, each open one (its name: the statement a member runs for it, a template's build; and its
 * claim), the next wait's id, and where it reports each change of them: to its pool, in a worker (runner/worker.ts),
 * since the pool watches the worker from outside it; nowhere in a process no pool watches.
 */
type ProcessWaits = {
	waits: Waits
	open: ReadonlyArray<OpenWait>
	idle: Map<number, number>
	asking: Map<number, { answer: Option.Option<boolean> }>
	next: number
	report: Option.Option<(change: WaitChange) => void>
}

declare global {
	var bjornpagenTestingWaits: ProcessWaits | undefined
}

/** This process's declared waits: one ledger a process, as its waits are its own whatever run or case opened them. */
const processWaits = (): ProcessWaits => {
	globalThis.bjornpagenTestingWaits ??= {
		waits: noWaits,
		open: [],
		idle: new Map(),
		asking: new Map(),
		next: 0,
		report: Option.none()
	}
	return globalThis.bjornpagenTestingWaits
}

/** This process's declared waits are reported to `report` from now on, at each change. */
export const reportWaitsTo = (report: (change: WaitChange) => void): void => {
	processWaits().report = Option.some(report)
}

/**
 * One of this process's declared waits opens at `wall`, waiting on `on` and claiming `claim` (live.ts waitingOn,
 * waitingOnWork), reported when it is the first open: its id, which closes it.
 */
export const enterWait = (wall: number, on: string, claim: Claim): number => {
	const ledger = processWaits()
	const id = ledger.next
	ledger.next = id + 1
	ledger.waits = waitEntered(ledger.waits, wall)
	ledger.open = [...ledger.open, { id, on, claim }]
	if (ledger.waits.open === 1) {
		Option.map(ledger.report, (report) => report({ kind: "waiting" }))
	}
	return id
}

/**
 * The declared wait `id` closes at `wall`, reported when it was the last open; a wait already closed (its claim found
 * false, lapsedWait) closes nothing again.
 */
export const leaveWait = (wall: number, id: number): void => {
	const ledger = processWaits()
	Option.map(
		Arr.findFirstIndex(ledger.open, (open) => open.id === id),
		(at) => {
			ledger.open = Arr.remove(ledger.open, at)
			ledger.idle.delete(id)
			ledger.asking.delete(id)
			ledger.waits = waitLeft(ledger.waits, wall)
			if (ledger.waits.open === 0) {
				Option.map(ledger.report, (report) => report({ kind: "waited" }))
			}
		}
	)
}

/**
 * Each open checked wait's claim asked again at `wall` (a guard's reading, live.ts overrun), never waited for: a reading
 * takes the answer the last ask gave, if it has come, and only then asks again, in a fiber of its own, so no guard
 * blocks on its own claim check (trunk@toolchain at e8b7ecec, 2026-11-22: a kill trial's guard waited 69 minutes on a
 * check whose connect a busy member never answered, and judged nothing). A wait whose server has answered that it is not
 * working on it at two readings in a row, a whole window apart, closes at the first of them, as if its work had ended
 * then, so the guard counts the wall time after it as the stall it is: the client awaits an answer no server is working
 * on (a promise that never settles, a backend gone). One answer alone closes nothing: a backend between two pipelined
 * statements of its session is idle for an instant. An ask not answered yet says nothing either way, as one that cannot
 * be made holds: a slow member's answer, past a 150 ms window under trunk's load, closed waits whose backends worked
 * (cloneDropWaitIsDeclared and sessionStatementIsDeclared at da272aeb, 2026-11-22), and a member that takes the ask and
 * never answers leaves its wait to the waited leg, which judges it.
 */
export const checkedClaims = (wall: number): Effect.Effect<void> => {
	const ledger = processWaits()
	const checked = Arr.flatMap(ledger.open, (open) =>
		open.claim.kind === "checked" ? [{ id: open.id, working: open.claim.working }] : []
	)
	return Effect.forEach(
		checked,
		({ id, working }) =>
			Effect.gen(function* () {
				const asked = ledger.asking.get(id)
				if (asked === undefined || Option.isSome(asked.answer)) {
					const slot: { answer: Option.Option<boolean> } = { answer: Option.none() }
					ledger.asking.set(id, slot)
					yield* Effect.forkDetach(
						Effect.map(working, (works) => {
							slot.answer = Option.some(works)
						})
					)
				}
				if (asked === undefined || Option.isNone(asked.answer)) {
					return
				}
				const since = ledger.idle.get(id)
				if (asked.answer.value) {
					ledger.idle.delete(id)
				} else if (since === undefined) {
					ledger.idle.set(id, wall)
				} else {
					leaveWait(since, id)
				}
			}),
		{ discard: true }
	)
}

/** What this process's open declared waits on work wait on, in the order they opened: what a verdict's report names. */
export const waitedOnNow = (): ReadonlyArray<string> =>
	Arr.map(processWaits().open, (open) => open.on)

/** The wall milliseconds this process has spent in declared waits by `wall`. */
const ownWaited = (wall: number): number => waitedBy(processWaits().waits, wall)

/**
 * A process tree's work as a guard reads it: where it began, the CPU (ms) it has spent by now, on the same scale, and
 * the wall milliseconds it has spent in declared waits on work by a moment on the live clock (Waits). Its live
 * descendants count only when started since it began; a descendant started earlier (a helper a need left running) is
 * no part of this work.
 */
export type TreeWork = Readonly<{
	began: Reading
	waited: (wall: number) => number
	effort: () => Effort
}>

/** A reading of `work` at `wall` on the live clock. */
export const readingOf = (work: TreeWork, wall: number): Reading => {
	const effort = work.effort()
	return { wall, cpu: effort.cpu, waited: work.waited(wall), stir: effort.stir }
}

/**
 * This process's work, begun at `wall` on the live clock with `own` CPU (ownCpu, read before the work started), as its
 * guards read it, the case's guard and its watchdog alike (live.ts watchedCase), one work set for both: its own CPU,
 * every thread's, its waited-for children's (a synchronous spawn reaps them, the only reaping a held main thread does),
 * and its live descendants'; and the stir of the process itself beside its descendants', so a main thread the machine
 * keeps from running, held or between cases, takes that time out of its windows (standingOf) and is never stalled for
 * it, while one that waits by its own choice is. Read when a guard first needs it, once the work has yielded, so work
 * that runs to its end synchronously reads no file; it reads /proc/self/stat once to begin, and no descendant, since
 * none the work started is counted until its first reading, all of whose CPU is the work's. Without /proc its own CPU
 * counts alone.
 */
export const ownWork = (wall: number, own: number): TreeWork => {
	const stirOwn = () => effortOfProcess("self").stir
	const self = statOf("self")
	const since = sinceBootAt(self, wall)
	const reaped = (stat: Option.Option<(field: number) => number>) =>
		Option.match(stat, { onNone: () => 0, onSome: reapedOf })
	const kept = keptEffort()
	return {
		began: {
			wall,
			cpu: own + reaped(self),
			waited: ownWaited(wall),
			stir: stirOwn()
		},
		waited: ownWaited,
		effort: () => {
			const reading = process.threadCpuUsage()
			const cpu = ownCpu() + reaped(statOf("self"))
			const descendants = kept(
				Option.match(since, { onNone: () => [], onSome: (at) => descendantsOf("self", at) })
			)
			const stir = stirPlus(stirOwn(), descendants.stir)
			const spent = process.threadCpuUsage(reading)
			Option.map(Option.fromUndefinedOr(globalThis.bjornpagenTestingWatchdog), (watchdog) =>
				watchdog.observing(spent.user + spent.system)
			)
			return { cpu: cpu + descendants.cpu, stir }
		}
	}
}

/**
 * Another process's work, begun at `wall` on the live clock (the pool's watch of a worker): its own CPU, its waited-for
 * children's, and its live descendants' started since, the wall time `waited` says it spent in declared waits on work,
 * and the stir of the worker itself beside its descendants', the work set its own guards read (ownWork). A process this one
 * cannot read (none started, gone, or no /proc) reads as spending nothing, so its work never moves and a guard ends it
 * after one deadline of wall time outside its waits, as the live clock did.
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
	const kept = keptEffort()
	const descendants = (): Effort =>
		kept(
			Option.getOrElse(
				Option.zipWith(pid, since, (id, at) => descendantsOf(String(id), at)),
				(): ReadonlyArray<string> => []
			)
		)
	const effort = (): Effort => {
		const theirs = descendants()
		const its = Option.match(pid, {
			onNone: () => noStir,
			onSome: (id) => effortOfProcess(String(id)).stir
		})
		return { cpu: own() + theirs.cpu, stir: stirPlus(its, theirs.stir) }
	}
	const began = effort()
	return {
		began: { wall, cpu: began.cpu, waited: waited(wall), stir: began.stir },
		waited,
		effort
	}
}

/**
 * How much work a piece of work may do, in milliseconds, one number for each of a guard's legs: `cpu`, the CPU its
 * process tree may spend, its budget; and `stall`, the wall time outside declared waits on work over which that CPU must
 * move, its window; and `waited`, the wall time its declared waits on work may hold it in all (boundOver). A case's
 * deadline is the first two (deadlineBound); a need's open is judged by its owner's budget and the runner's stall
 * window (runner/limits.ts needStallMillis), which are different numbers with different evidence.
 */
export type Bound = Readonly<{ cpu: number; stall: number; waited: number }>

/**
 * The bound of `cpu` milliseconds of CPU and a stall window of `stall`: its declared waits on work may hold it
 * waitedWindows of those windows of wall time in all (runner/limits.ts).
 */
export const boundOver = (cpu: number, stall: number): Bound => ({
	cpu,
	stall,
	waited: stall * waitedWindows
})

/** A case's deadline as a guard judges it: `deadline` milliseconds of CPU, and as the window its CPU must move over. */
export const deadlineBound = (deadline: number): Bound => boundOver(deadline, deadline)

/**
 * A judge of `work` under `bound` that keeps its window between readings: at each reading, at `wall` on the live clock,
 * it gives the leg the work is over its bound by, with what it measured (Overrun: spent, or stalled over a whole
 * window), or none, carrying a working window forward.
 */
export const judgeOf = (
	work: TreeWork,
	bound: Bound
): ((wall: number) => Option.Option<Overrun>) => {
	let window = work.began
	return (wall) => {
		const standing = standingOf({
			began: work.began,
			window,
			now: readingOf(work, wall),
			bound
		})
		if (standing.kind !== "working") {
			return Option.some(standing)
		}
		window = standing.window
		return Option.none()
	}
}

/**
 * A reading of a case's work: the live clock, the CPU its process tree has spent, and the wall time it has spent in
 * declared waits on work (Waits), all in milliseconds; and the stir of the processes of its tree but the guard's own
 * (Stir).
 */
export type Reading = Readonly<{
	wall: number
	cpu: number
	waited: number
	stir: Stir
}>

/**
 * Where a piece of work stands against its bound at a reading: working, with the window it is judged over next (the
 * reading its current window began at, or this one once a whole stall window of wall time outside declared waits has
 * passed) and when to read it again; or over its bound (Overrun).
 */
export type Standing = Readonly<{ kind: "working"; window: Reading; readAgainAt: number }> | Overrun

/**
 * Which of a guard's legs a piece of work is over its bound by, with what it measured: `spent`, its tree's CPU since it
 * began (`spent`, ms) at its CPU budget (`budget`, ms), a runaway; `stalled`, its tree's CPU moved by `moved` ms over a
 * window of `over` ms of wall time outside its declared waits on work, a whole stall window (`window`, ms), which is
 * less than the `progress` ms that shows progress there even with the `queued` ms the tree's other processes waited on
 * a runqueue for more (queuedBetween), while none of them did storage work (storedBetween), so it waited on something
 * that did not come; `waited`, the window's wall time in declared waits on work besides, which the leg counts none of.
 * `waited`, the wall time its declared waits on work held it since it began (`waited`, ms) at its bound (`bound`, ms):
 * waits answered one after another, a window never whole between them.
 */
export type Overrun =
	| Readonly<{ kind: "spent"; spent: number; budget: number }>
	| Readonly<{ kind: "waited"; waited: number; bound: number }>
	| Readonly<{
			kind: "stalled"
			moved: number
			queued: number
			over: number
			waited: number
			progress: number
			window: number
	  }>

/** Milliseconds as seconds to the tenth, as a report states them. */
const seconds = (millis: number): string => `${(millis / millisPerSecond).toFixed(1)} s`

/** An Overrun as a report states it: the leg that fired, what it measured, and the bound it measured against. */
export const overrunText = (overrun: Overrun): string => {
	switch (overrun.kind) {
		case "spent":
			return `its process tree spent ${seconds(overrun.spent)} of CPU, its budget ${seconds(overrun.budget)}`
		case "waited":
			return `its declared waits on work held it ${seconds(overrun.waited)} of wall time in all, its bound ${seconds(overrun.bound)}, each wait answered and the next begun`
		case "stalled":
			return `its process tree's CPU moved ${overrun.moved.toFixed(0)} ms over ${seconds(overrun.over)} it could have run (its wall time outside declared waits on work, ${seconds(overrun.waited)} in them besides, less ${overrun.queued.toFixed(1)} ms its processes waited to run), under the ${overrun.progress.toFixed(0)} ms that shows progress over its stall window of ${seconds(overrun.window)}, and no process of its tree did storage work`
	}
}

/**
 * How much a tree's CPU must move over a window of `window` wall milliseconds to be progress: stalledShareOfCpu of one
 * CPU over it, and never less than one clock tick, the smallest change Linux states of a child's CPU (and more than a
 * timer's wake-up and a reading cost a process that waits).
 */
export const progressOver = (window: number): number =>
	Math.max(window * stalledShareOfCpu, TICK_MILLIS)

/**
 * How long a work's processes waited on a runqueue between two readings, in milliseconds: time they were runnable and
 * the machine gave them no CPU, which is time the work could not run, so standingOf takes it out of the window's wall
 * time and never counts it as progress. A tree the machine starves for a whole window has no time it could have run,
 * however long the window, and is never stalled; a thread that only waits wakes now and then and waits a little to run
 * each time (a timer, a heartbeat, a wait of a second at a time in Atomics.wait), so nearly all its window is time it
 * could have run, and it spends none of it. Counted as progress, as it was, those little waits added up under load:
 * the watchdog's planted thread that waits a second at a time in Atomics.wait read as working at every answer under
 * trunk@toolchain's load and was never ended (blocking.test.ts#watchdog, floor case 2 of seed 0xa5b59f36, its worker
 * lost to the pool's stall window at e7f90259 and 86060d1d, 2026-11-22; 192 such runs 48 at a time on cassowary ended
 * after one to four extra watchdog cycles, ~/.cache/metis/SLOP-FIXER-2-scratch/watchdog/probe3.log).
 */
const queuedBetween = (before: Reading, after: Reading): number =>
	after.stir.queued - before.stir.queued

/**
 * Whether a work's processes did storage work between two readings, by any amount: a process blocked on storage or swap
 * spends neither CPU nor runqueue wait, its bytes and the pages it faults in its only sign of work, and none of the idle
 * trees measured moved them (an idle nested pool's worker, whose bytes and faults stood still over 133 s under load 150
 * to 250, TOOLCHAIN6, 2026-11-21). A tree that faults pages in on each idle wake-up under swap would read as working;
 * that is this rule's revalidation.
 */
const storedBetween = (before: Reading, after: Reading): boolean =>
	after.stir.stored > before.stir.stored

/**
 * A piece of work's standing at `now`, having begun at `began`, its current window begun at `window`, under `bound`: its
 * CPU budget and its stall window. A window is whole once a stall window of time the work could have run lies in it:
 * its wall time outside declared waits on work, less the time its processes waited on a runqueue (queuedBetween), so a
 * tree the machine starves is never whole. Its work moves by its tree's CPU, at least progressOver, or by any storage
 * work of its processes (storedBetween): one blocked on storage or swap is working, and a tree that only wakes now and
 * then, or a held thread that waits by its own choice, is not.
 * Work whose declared waits have held it its bound's `waited` in all is over it, whatever its windows. Working work is
 * read again when its window could next be whole, or sooner when its remaining CPU, spent at one CPU, or its remaining
 * waits, held without a break, would reach their bounds first.
 */
export const standingOf = (
	input: Readonly<{ began: Reading; window: Reading; now: Reading; bound: Bound }>
): Standing => {
	const { began, window, now, bound } = input
	const spent = now.cpu - began.cpu
	if (spent >= bound.cpu) {
		return { kind: "spent", spent, budget: bound.cpu }
	}
	const waitedAll = now.waited - began.waited
	if (waitedAll >= bound.waited) {
		return { kind: "waited", waited: waitedAll, bound: bound.waited }
	}
	const waited = now.waited - window.waited
	const queued = queuedBetween(window, now)
	const over = now.wall - window.wall - waited - queued
	const progress = progressOver(bound.stall)
	const moved = now.cpu - window.cpu
	const whole = over >= bound.stall
	if (whole && moved < progress && !storedBetween(window, now)) {
		return { kind: "stalled", moved, queued, over, waited, progress, window: bound.stall }
	}
	return {
		kind: "working",
		window: whole ? now : window,
		readAgainAt:
			now.wall +
			Math.min(
				whole ? bound.stall : bound.stall - over,
				bound.cpu - spent,
				bound.waited - waitedAll
			)
	}
}
