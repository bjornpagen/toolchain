import { Array as Arr, Config, Duration, Effect, FileSystem, String as Str } from "effect"
import { array, element, type Gen, int, map } from "#gen.ts"
import { liveMillis, liveSleep, waitingOn } from "#live.ts"
import { type Property, property } from "#property.ts"
import { type Limits, runnerLimits } from "#runner/limits.ts"
import { fullRun, type InnerRun } from "#runner/search.fixtures.ts"
import {
	type Bound,
	deadlineBound,
	ownCpu,
	ownWork,
	progressOver,
	type Reading,
	type Stir
} from "#runner/work.ts"

/**
 * What the meta-tests of a case's deadline as a budget of its work (runner/work.ts, case.ts guarded) share: inner
 * properties whose one case is slow but working (its CPU in bursts between stalls of the live clock), a CPU runaway,
 * or deadlocked (waiting on the live clock and spending nothing), each ending of itself well past the deadline, so a
 * guard that misjudges it lets it pass.
 */

/** The oracle of an inner search: a property planted to exercise a case's deadline. */
const planted = {
	kind: "specification",
	name: "a property planted to exercise a case's deadline"
} as const

/** Spends `millis` of this process's CPU, measured as CPU, not as the live clock, so a loaded machine stretches its wall
 * time and never shrinks its work. */
const burn = (millis: number): Effect.Effect<void> =>
	Effect.sync(() => {
		const until = ownCpu() + millis
		let spins = 0
		while (ownCpu() < until) {
			spins += 1
		}
		return spins
	})

/** A slow case's shape: how many bursts of CPU, each how long, with how long a stall on the live clock after each. */
export type Slow = Readonly<{ bursts: number; burstMillis: number; stallMillis: number }>

/** The deadline the slow shapes run under, in milliseconds. */
export const SLOW_DEADLINE = 3000

/**
 * Slow shapes under SLOW_DEADLINE: five to seven bursts of 20 ms of CPU, each followed by a stall of 700 ms on the live
 * clock, so every one takes 3.6 to 5.0 s of wall time, past the deadline, spends 100 to 140 ms of CPU, under a tenth of
 * it, and moves its CPU by four bursts in every deadline's window, past what progress takes (runner/work.ts
 * progressOver: 10 ms at this deadline). The deadline is seconds long so a stall the machine itself imposes (a child's
 * start paged in from swap) spans no whole window.
 */

export const slowShapes: Gen<Slow> = map(int(0, 2), (step) => ({
	bursts: 5 + step,
	burstMillis: 20,
	stallMillis: 700
}))

/** An inner search whose case, whatever its value, is slow: bursts of CPU between stalls on the live clock, then it passes. */
export const slowCase = (shape: Slow): Property =>
	property.explore(int(0, 9), {
		needs: {},
		situations: [],
		check: () => () =>
			Effect.forEach(
				Array.from({ length: shape.bursts }, (_, at) => at),
				() =>
					Effect.andThen(burn(shape.burstMillis), liveSleep(Duration.millis(shape.stallMillis))),
				{ discard: true }
			),
		oracle: planted,
		kept: [],
		kills: []
	})

/** How much CPU a working child spends before it says so, in milliseconds: three amounts. */
export const childBurns: Gen<number> = map(int(0, 2), (step) => 40 + 40 * step)

/**
 * The program a working child runs: it spends `burnMillis` of its own CPU, writes its CPU so far (ms) on a line, and
 * waits, alive, until its stdin closes.
 */
const childProgram = (burnMillis: number): string =>
	`const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000 }
const until = cpu() + ${burnMillis}
while (cpu() < until) {}
process.stdout.write(String(cpu()) + "\\n")
process.stdin.resume()
process.stdin.on("end", () => process.exit(0))`

/** What a reading of this process's tree saw while its working child was alive: the child's CPU as the child stated it,
 * and the tree's CPU since the work began, both in milliseconds. */
export type ChildSeen = Readonly<{ childCpu: number; treeCpu: number }>

/**
 * Begins a case's work, starts a working child that spends `burnMillis` of CPU, and once the child says how much it
 * spent, while it is still alive and unreaped, reads the tree's CPU since the work began; then ends the child.
 */
export const childSeen = (burnMillis: number): Effect.Effect<ChildSeen> =>
	Effect.flatMap(liveMillis, (wall) =>
		Effect.callback<ChildSeen>((resume) => {
			const work = ownWork(wall, ownCpu())
			const child = process
				.getBuiltinModule("node:child_process")
				.spawn(process.execPath, ["-e", childProgram(burnMillis)], {
					stdio: ["pipe", "pipe", "ignore"]
				})
			let said = ""
			child.stdout.on("data", (chunk: Buffer) => {
				said += chunk.toString("utf8")
				if (!Str.includes("\n")(said)) {
					return
				}
				const treeCpu = work.effort().cpu - work.began.cpu
				child.stdin.end()
				resume(Effect.succeed({ childCpu: Number(Str.trim(said)), treeCpu }))
			})
			return Effect.sync(() => {
				child.kill("SIGKILL")
			})
		})
	)

/**
 * How far below a child's own reading of its CPU the tree's can read, in milliseconds: Linux states a process's user and
 * system CPU (/proc/<pid>/stat utime and stime) as two counts of clock ticks of USER_HZ (runner/work.ts), each rounded
 * down, so their sum can fall short of the CPU the process spent, which it reads to the microsecond, by up to a tick
 * each. One tick, as this was, failed childWorkCounts at 40 ms on toolchain c400d74's push gate (a child whose system
 * time had a part tick of its own), while the same case passed alone four times in four.
 */
export const STATED_CPU_SHORTFALL_MILLIS = 2 * 10

/** A runaway's deadline and how many deadlines of CPU it spends, yielding between short bursts, before it passes. */
export type Runaway = Readonly<{ deadline: number; deadlines: number }>

/** Runaways under a deadline of a second or one and a half, each spending four deadlines of CPU if nothing stops it:
 * windows long enough that a stall the machine imposes spans none, so the runaway moves in every one. */
export const runaways: Gen<Runaway> = map(int(0, 1), (step) => ({
	deadline: 1000 + 500 * step,
	deadlines: 4
}))

/** How long one burst of a runaway lasts before it yields, in CPU milliseconds. */
const RUNAWAY_BURST_MILLIS = 5

/** An inner search whose one case is a runaway: it spends its deadline's CPU many times over, yielding as it goes, so
 * only the budget stops it; then it passes. */
export const runawayCase = (shape: Runaway): Property =>
	property.explore(int(0, 9), {
		needs: {},
		situations: [],
		check: () => () =>
			Effect.forEach(
				Array.from(
					{ length: (shape.deadline * shape.deadlines) / RUNAWAY_BURST_MILLIS },
					(_, at) => at
				),
				() => Effect.andThen(burn(RUNAWAY_BURST_MILLIS), Effect.yieldNow),
				{ discard: true }
			),
		oracle: planted,
		kept: [],
		kills: []
	})

/** A deadlocked case's deadline and how many deadlines it waits, spending nothing, before it passes. */
export type Deadlock = Readonly<{ deadline: number; deadlines: number }>

export const deadlocks: Gen<Deadlock> = map(int(0, 1), (step) => ({
	deadline: 150 + 150 * step,
	deadlines: 6
}))

/** An inner search whose one case waits on the live clock for many deadlines, spending nothing, then passes. */
export const deadlockedCase = (shape: Deadlock): Property =>
	property.explore(int(0, 9), {
		needs: {},
		situations: [],
		check: () => () => liveSleep(Duration.millis(shape.deadline * shape.deadlines)),
		oracle: planted,
		kept: [],
		kills: []
	})

/**
 * An inner search whose one case waits on the live clock for many deadlines, spending nothing, inside a declared wait
 * (live.ts waitingOn), as a case waits on a lease another run holds, then passes.
 */
export const waitingCase = (shape: Deadlock): Property =>
	property.explore(int(0, 9), {
		needs: {},
		situations: [],
		check: () => () =>
			Duration.millis(shape.deadline * shape.deadlines).pipe(
				liveSleep,
				waitingOn("work.fixtures.ts waitingCase's sleep")
			),
		oracle: planted,
		kept: [],
		kills: []
	})

/**
 * The program of a child that wakes on a timer and does nothing else, as an idle worker or a server does: it says so on
 * its stdout once its timer is set, then each wake-up spends a little CPU and waits a little to run, until its stdin
 * closes.
 */
const WAKING_PROGRAM = `const timer = setInterval(() => undefined, 50)
process.stdout.write("waking\\n")
process.stdin.resume()
process.stdin.on("end", () => clearInterval(timer))`

/** The waking child's process, its stdin and stdout piped. */
const spawnWaking = () =>
	process
		.getBuiltinModule("node:child_process")
		.spawn(process.execPath, ["-e", WAKING_PROGRAM], { stdio: ["pipe", "pipe", "ignore"] })

/**
 * A child that wakes on a timer (WAKING_PROGRAM), started and waited on until it says it is waking, so its start's CPU
 * is spent before the wait that follows; it is ended with SIGKILL as the enclosing scope closes, however the case ends.
 */
const wakingChild = Effect.acquireRelease(
	Effect.callback<ReturnType<typeof spawnWaking>>((resume) => {
		const child = spawnWaking()
		let said = ""
		child.stdout.on("data", (chunk: Buffer) => {
			said += chunk.toString("utf8")
			if (Str.includes("\n")(said)) {
				resume(Effect.succeed(child))
			}
		})
		return Effect.sync(() => {
			child.kill("SIGKILL")
		})
	}),
	(child) =>
		Effect.sync(() => {
			child.kill("SIGKILL")
		})
)

/**
 * An inner search whose one case starts a child that wakes on a timer (wakingChild), then waits on the live clock for
 * many deadlines, spending nothing itself, and passes.
 */
export const wakingCase = (shape: Deadlock): Property =>
	property.explore(int(0, 9), {
		needs: {},
		situations: [],
		check: () => () =>
			Effect.scoped(
				Effect.andThen(wakingChild, liveSleep(Duration.millis(shape.deadline * shape.deadlines)))
			),
		oracle: planted,
		kept: [],
		kills: []
	})

/** The seed every inner search runs at: its cases' values decide nothing of what they do. */
export const INNER_SEED = 1

/** One run of an inner search under `deadline`, its streams cut to a case each. */
export const innerRun = (id: string, seed: number, deadline: number): InnerRun => {
	const limits: Limits = { ...runnerLimits, deadline, runs: 1, floor: 1, steered: 0 }
	return { ...fullRun(id, seed), limits }
}

/**
 * What a work's processes did in a window beside its CPU, which spent nothing (runner/work.ts queuedBetween,
 * storedBetween): nothing, so the window is stalled; a child woke and waited to run a little, by the least a counter
 * moves, a stall still; a thread waited to run for the window's whole progress and slept the rest, the waits of its
 * wake-ups under load, a stall still, since a wait to run is time it could not run and never a move; a child waited to
 * run for all the window's wall time, the machine starving it, so the window holds no time it could have run and is
 * working; or a child did the least storage work, working too.
 */
export type OtherMove =
	| "none"
	| "a child woke and waited a little"
	| "a thread waited to run for progress and slept the rest"
	| "a child waited to run all the window"
	| "a child stored"

/** Every move, one case each. */
export const otherMoves: Gen<OtherMove> = (source) =>
	source.draw(
		element([
			"none",
			"a child woke and waited a little",
			"a thread waited to run for progress and slept the rest",
			"a child waited to run all the window",
			"a child stored"
		] as const)
	)

/**
 * The deadline of the drawn windows, in milliseconds, and its progress (work.ts progressOver: a clock tick, which is more
 * than a thousandth of the deadline); the least a counter moves is one.
 */
const WINDOW_DEADLINE = 1000
const WINDOW_PROGRESS = 10

/** A drawn window's wall time: two deadlines, so a window that waited to run a little still holds a whole deadline. */
const WINDOW_WALL = 2 * WINDOW_DEADLINE

/**
 * A window of a work whose own process spent no CPU, two deadlines of wall time, its two readings, `move` the one thing
 * that moved between them: what standingOf judges at its second reading.
 */
export const windowOf = (
	move: OtherMove
): Readonly<{ window: Reading; now: Reading; bound: Bound }> => {
	const quiet: Stir = { queued: 10, stored: 10 }
	const window: Reading = { wall: 0, cpu: 5, waited: 0, stir: quiet }
	const later: Reading = { ...window, wall: WINDOW_WALL }
	const stirred = (stir: Stir): Readonly<{ window: Reading; now: Reading; bound: Bound }> => ({
		window,
		now: { ...later, stir },
		bound: deadlineBound(WINDOW_DEADLINE)
	})
	switch (move) {
		case "none":
			return stirred(quiet)
		case "a child woke and waited a little":
			return stirred({ ...quiet, queued: quiet.queued + 1 })
		case "a thread waited to run for progress and slept the rest":
			return stirred({ ...quiet, queued: quiet.queued + WINDOW_PROGRESS })
		case "a child waited to run all the window":
			return stirred({ ...quiet, queued: quiet.queued + WINDOW_WALL })
		case "a child stored":
			return stirred({ ...quiet, stored: quiet.stored + 1 })
	}
}

/**
 * A thread that only waits, as a stall window's readings hold it: its deadline, the wall time of its window and the part
 * of it in declared waits on work, the CPU it moved, short of progress, and how long it waited to run, under a run-queue
 * delay the machine forces on its wake-ups, never more than leaves a whole deadline it could have run; or, `starved`,
 * runnable and kept from running for all its window outside its declared waits.
 */
export type WaitingThread = Readonly<{
	deadline: number
	wall: number
	waited: number
	moved: number
	queued: number
	starved: boolean
}>

/**
 * A thread that only waits under a run-queue delay, or one the machine starves: a deadline of 150 ms, a second or a
 * minute, a window of one to three deadlines with up to a deadline of it in declared waits, CPU short of progress, and a
 * wait to run from none to all the time the window leaves (its progress among the draws), or past it for a starved one.
 */
export const waitingThreads: Gen<WaitingThread> = (source) => {
	const deadline = source.draw(element([150, 1000, 60_000] as const))
	const progress = progressOver(deadline)
	const waited = source.draw(int(0, deadline))
	const wall = waited + source.draw(int(deadline, 3 * deadline))
	const moved = source.draw(int(0, Math.ceil(progress) - 1))
	const starved = source.draw(int(0, 3)) === 0
	const room = wall - waited - deadline
	const queued = starved
		? source.draw(int(room + 1, wall - waited))
		: source.draw(element([0, Math.min(Math.ceil(progress), room), room] as const))
	return { deadline, wall, waited, moved, queued, starved }
}

/** A waiting thread's window, its two readings, as standingOf judges it at its second. */
export const waitingWindowOf = (
	thread: WaitingThread
): Readonly<{ window: Reading; now: Reading; bound: Bound }> => {
	const window: Reading = { wall: 0, cpu: 7, waited: 0, stir: { queued: 3, stored: 4 } }
	return {
		window,
		now: {
			wall: thread.wall,
			cpu: window.cpu + thread.moved,
			waited: thread.waited,
			stir: { queued: window.stir.queued + thread.queued, stored: window.stir.stored }
		},
		bound: deadlineBound(thread.deadline)
	}
}

/**
 * The program of a child that writes as many bytes as its second argument says to the file its first argument names
 * and syncs it to storage, then waits, alive, for its stdin to close.
 */
const STORING_PROGRAM = `const fs = process.getBuiltinModule("node:fs")
const descriptor = fs.openSync(process.argv[1], "w")
fs.writeSync(descriptor, Buffer.alloc(Number(process.argv[2]), 1))
fs.fsyncSync(descriptor)
fs.closeSync(descriptor)
process.stdout.write("stored\\n")
process.stdin.resume()
process.stdin.on("end", () => process.exit(0))`

/** How many bytes the storing child writes and syncs: a quarter of a mebibyte or a whole one. */
export const storedSizes: Gen<number> = map(int(0, 1), (step) => (1 << 18) << (2 * step))

/**
 * A directory of its own on storage, removed as the enclosing scope closes: under the account's cache
 * (`$XDG_CACHE_HOME`, else ~/.cache), never the system's temporary directory, which is a tmpfs on Ubuntu 26.04
 * (cassowary's /tmp, where the scratch resource makes its directories): what a child writes and syncs there reaches no
 * storage, and /proc/<pid>/io counts none of it, so othersStirRead read no storage work of a child that did its part.
 */
export const storageDirectory = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const home = yield* Effect.orDie(Config.String("HOME"))
	const cache = yield* Effect.orDie(
		Config.withDefault(Config.String("XDG_CACHE_HOME"), `${home}/.cache`)
	)
	const parent = `${cache}/toolchain-test`
	yield* Effect.orDie(fs.makeDirectory(parent, { recursive: true }))
	return yield* Effect.orDie(fs.makeTempDirectoryScoped({ directory: parent, prefix: "stir-" }))
})

/**
 * Starts a child that stores `bytes` in a file under `directory` and syncs them, and once it says so, while it is alive,
 * reads its stir as this process's guard reads a child of its work (ownWork); then ends it.
 */
export const childStir = (directory: string, bytes: number): Effect.Effect<Stir> =>
	Effect.flatMap(liveMillis, (wall) =>
		Effect.callback<Stir>((resume) => {
			const work = ownWork(wall, ownCpu())
			const child = process
				.getBuiltinModule("node:child_process")
				.spawn(
					process.execPath,
					["-e", STORING_PROGRAM, `${directory}/stored.bin`, String(bytes)],
					{
						stdio: ["pipe", "pipe", "ignore"]
					}
				)
			let said = ""
			child.stdout.on("data", (chunk: Buffer) => {
				said += chunk.toString("utf8")
				if (!Str.includes("\n")(said)) {
					return
				}
				const { stir } = work.effort()
				child.stdin.end()
				resume(Effect.succeed(stir))
			})
			return Effect.sync(() => {
				child.kill("SIGKILL")
			})
		})
	)

/**
 * A tree's processes over a few readings of it: each its own key, the reading it is first seen at (`start`), the reading
 * it is gone by (`end`, past the last for one alive at it), and what its stir gains at each reading it is alive for.
 */
export type Lives = Readonly<{
	readings: number
	processes: ReadonlyArray<Readonly<{ start: number; end: number; gains: ReadonlyArray<Stir> }>>
}>

/** A process's gain at one reading: a few milliseconds of runqueue wait and a little storage work, or none. */
const gainGen: Gen<Stir> = (source) => ({
	queued: source.draw(int(0, 3)),
	stored: source.draw(int(0, 2))
})

/** Two to five readings of one to four processes, each seen from some reading and gone by a later one or never. */
export const livesGen: Gen<Lives> = (source) => {
	const readings = source.draw(int(2, 5))
	return {
		readings,
		processes: source.draw(
			array(
				(each) => {
					const start = each.draw(int(0, readings - 1))
					return {
						start,
						end: each.draw(int(start + 1, readings)),
						gains: each.draw(array(gainGen, { min: readings, max: readings }))
					}
				},
				{ min: 1, max: 4 }
			)
		)
	}
}

/** A process's stir at reading `at`, its gains summed from its start: what /proc shows of it while it lives. */
const stirAt = (process: Lives["processes"][number], at: number): Stir =>
	Arr.reduce(
		Arr.take(Arr.drop(process.gains, process.start), at - process.start + 1),
		{ queued: 0, stored: 0 },
		(total, gain) => ({
			queued: total.queued + gain.queued,
			stored: total.stored + gain.stored
		})
	)

/** The processes alive at reading `at`, each by its key with its stir then: what a reading of the tree reads. */
export const liveAt = (lives: Lives, at: number): ReadonlyArray<readonly [string, Stir]> =>
	Arr.flatMap(lives.processes, (process, index) =>
		process.start <= at && at < process.end
			? [[`p${String(index)}`, stirAt(process, at)] as const]
			: []
	)

/** Every process seen by reading `at`, its stir at the last reading it was alive for, summed: the tree's whole stir. */
export const lastSeenAt = (lives: Lives, at: number): Stir =>
	Arr.reduce(
		Arr.filter(lives.processes, (process) => process.start <= at),
		{ queued: 0, stored: 0 },
		(total, process) => {
			const last = stirAt(process, Math.min(at, process.end - 1))
			return { queued: total.queued + last.queued, stored: total.stored + last.stored }
		}
	)
