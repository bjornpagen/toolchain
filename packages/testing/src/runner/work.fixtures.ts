import { Duration, Effect, String as Str } from "effect"
import { element, type Gen, int, map } from "#gen.ts"
import { liveMillis, liveSleep, waitingOn } from "#live.ts"
import { type Property, property } from "#property.ts"
import { type Limits, runnerLimits } from "#runner/limits.ts"
import { fullRun, type InnerRun } from "#runner/search.fixtures.ts"
import { ownCpu, ownWork, type Reading, type Stir } from "#runner/work.ts"

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

/** The seed every inner search runs at: its cases' values decide nothing of what they do. */
export const INNER_SEED = 1

/** One run of an inner search under `deadline`, its streams cut to a case each. */
export const innerRun = (id: string, seed: number, deadline: number): InnerRun => {
	const limits: Limits = { ...runnerLimits, deadline, runs: 1, floor: 1, steered: 0 }
	return { ...fullRun(id, seed), limits }
}

/**
 * Which of the processes a guard counts beside its own moved in a window (runner/work.ts othersMoved): none, so the
 * window is stalled; or one of them, the window then working: a child of the work's process waited to run or did
 * storage work.
 */
export type OtherMove = "none" | "a child waited to run" | "a child stored"

/** Every move, one case each. */
export const otherMoves: Gen<OtherMove> = (source) =>
	source.draw(element(["none", "a child waited to run", "a child stored"] as const))

/** The deadline of the drawn windows, in milliseconds, and the amount each move moves by: one, the least a counter moves. */
const WINDOW_DEADLINE = 1000

/**
 * A whole window of a work whose own process spent no CPU, its two readings, `move` the one thing that moved between
 * them: what standingOf judges at its second reading.
 */
export const windowOf = (
	move: OtherMove
): Readonly<{ window: Reading; now: Reading; deadline: number }> => {
	const quiet: Stir = { queued: 10, stored: 10 }
	const window: Reading = { wall: 0, cpu: 5, waited: 0, stir: quiet }
	const moved = (stir: Stir, by: "queued" | "stored"): Stir =>
		by === "queued" ? { ...stir, queued: stir.queued + 1 } : { ...stir, stored: stir.stored + 1 }
	const later: Reading = { ...window, wall: WINDOW_DEADLINE }
	switch (move) {
		case "none":
			return { window, now: later, deadline: WINDOW_DEADLINE }
		case "a child waited to run":
			return { window, now: { ...later, stir: moved(quiet, "queued") }, deadline: WINDOW_DEADLINE }
		case "a child stored":
			return { window, now: { ...later, stir: moved(quiet, "stored") }, deadline: WINDOW_DEADLINE }
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
