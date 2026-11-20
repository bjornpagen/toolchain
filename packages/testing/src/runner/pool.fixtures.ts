import { Array as Arr, Config, Duration, Effect, FileSystem } from "effect"
import { ChildProcess } from "effect/process"
import { boolean, finite, type Gen, int, map } from "#gen.ts"
import { liveSleep, waitingOn } from "#live.ts"
import { type Need, property } from "#property.ts"
import { Scratch } from "#resources/scratch.ts"
import type { Batch } from "#runner/protocol.ts"
import { WorkerIndex } from "#runner/services.ts"
import { ownCpu } from "#runner/work.ts"

/**
 * The pool's teardown property (pool.test.ts) runs a planted property on a pool of its own: this module is that
 * property, and the support of the property that runs it.
 */

/** Node's child processes, as the process holds them: the planted case starts its children outside any scope. */
const childProcesses = process.getBuiltinModule("node:child_process")

/** The variable of a worker's environment naming the file the planted property writes its child's process id to. */
export const CHILD_FILE = "TOOLCHAIN_TEST_CHILD_FILE"

/** The planted property's identity, as its pool's workers load it from the testing package's root. */
const PLANTED = "src/runner/pool.fixtures.ts#leavesChildren"

/**
 * What the planted property's case does: how many children it starts, one to three, and whether it then ends its
 * worker, or passes and leaves its worker running.
 */
export type Leaving = Readonly<{ children: number; endsItsWorker: boolean }>

/** The planted property's cases, as its space and the teardown property's draw them. */
export const leavings: Gen<Leaving> = (source) => ({
	children: source.draw(int(1, 3)),
	endsItsWorker: source.draw(boolean)
})

/**
 * A property planted to leave children behind its worker: its case starts as many children as its value says, each
 * running until it is ended, in its worker's process group as a property's own program is (blocking.fixtures.ts
 * programRun), and unreferenced, so its worker may still exit on its own, and writes their process ids, a line each, to
 * the file CHILD_FILE names. Then it ends its worker with SIGKILL, as its watchdog ends it (or the pool, past a phase's
 * bound and grace), so nothing of the worker's own ends a child, or passes, leaving its worker running with them.
 */
export const leavesChildren = property.exhaust(finite(leavings), {
	box: "one to three children, the worker ended or left running",
	needs: {},
	situations: [],
	check: () => (leaving) =>
		Effect.gen(function* () {
			const file = yield* Config.String(CHILD_FILE)
			const fs = yield* FileSystem.FileSystem
			const pids = Array.from({ length: leaving.children }, () => {
				const child = childProcesses.spawn(
					process.execPath,
					["-e", "setInterval(() => undefined, 2 ** 30)"],
					{ stdio: "ignore" }
				)
				child.unref()
				return String(child.pid)
			})
			yield* fs.writeFileString(file, Arr.join(pids, "\n"))
			if (leaving.endsItsWorker) {
				process.kill(process.pid, "SIGKILL")
			}
		}),
	oracle: { kind: "specification", name: "a property planted to leave children behind its worker" },
	kept: [],
	kills: []
})

/** The identity of runsAwayWithAChild, as a pool's workers load it from the testing package's root. */
export const RUNAWAY = "src/runner/pool.fixtures.ts#runsAwayWithAChild"

/** The cell a runaway case's loop reads, which nothing writes. */
const runawayCell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))

/**
 * A property planted to run away with a child of its own (pool.test.ts workersEndWithTheirParent): its case starts one
 * child in its worker's process group, running until it is ended, as a property's program is (blocking.fixtures.ts
 * programRun), writes the child's process id to the file CHILD_FILE names, then holds its worker's main thread for
 * ever, as a mutant's runaway does, so nothing of the worker's own can end either.
 */
export const runsAwayWithAChild = property.exhaust(finite(int(0, 1)), {
	box: "two values",
	needs: {},
	situations: [],
	check: () => () =>
		Effect.gen(function* () {
			const file = yield* Config.String(CHILD_FILE)
			const fs = yield* FileSystem.FileSystem
			const child = childProcesses.spawn(
				process.execPath,
				["-e", "setInterval(() => undefined, 2 ** 30)"],
				{
					stdio: "ignore"
				}
			)
			child.unref()
			yield* fs.writeFileString(file, String(child.pid))
			while (Atomics.load(runawayCell, 0) === 0) {
				Atomics.add(runawayCell, 0, 0)
			}
		}),
	oracle: { kind: "specification", name: "a property planted to run away with a child of its own" },
	kept: [],
	kills: []
})

/**
 * The planted property's case that does what `leaving` says, as a search orders it: its decisions, the count's offset
 * from one, then whether it ends its worker.
 */
export const plantedCase = (leaving: Leaving, deadline: number, open: number): Batch => [
	{
		property: PLANTED,
		chooser: {
			kind: "forced",
			values: Float64Array.of(leaving.children - 1, leaving.endsItsWorker ? 1 : 0)
		},
		drawn: { kind: "unsteered" },
		keep: "nothing",
		sense: { kind: "notes" },
		deadline,
		open,
		print: "failing"
	}
]

/** Whether the process `pid` is alive: a signal 0 to it reaches a process. */
const alive = (pid: number): boolean => {
	try {
		return process.kill(pid, 0)
	} catch {
		return false
	}
}

/**
 * Waits for the process `pid` to end, on the kernel's own notice, never on a clock: pidwait (procps-ng) waits on the
 * process's pidfd, which is readable once the process exits, so a zombie nothing has reaped yet has ended, and answers
 * at once, its status 1, for a process already gone. Its pid is handed over in a file of `directory`, its --pidfile. A
 * signal 0, which reaches a zombie, read a killed child as running until init reaped it, which under load took longer
 * than any grace a property gave it. A process that never ends holds its case, whose guard reports it hung.
 */
export const exitOf = (pid: number, directory: string) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const file = `${directory}/exit-${pid}`
			yield* fs.writeFileString(file, String(pid))
			const waiting = yield* ChildProcess.make("pidwait", ["--pidfile", file], {
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore"
			})
			const status = yield* waiting.exitCode
			if (status !== 0 && status !== 1) {
				return yield* Effect.die(`pidwait --pidfile ${file} exited ${status}`)
			}
		})
	)

/** Ends the process `pid` should it still run, as the property's cleanup does for a child its worker left behind. */
export const ended = (pid: number) =>
	Effect.sync(() => {
		if (alive(pid)) {
			process.kill(pid, "SIGKILL")
		}
	})

/** The identity of a property of loops.fixtures.ts, whose module's load never ends: one with needs, or one without. */
export const loopingProperty = (needs: boolean): string =>
	needs ? "src/runner/loops.fixtures.ts#withNeeds" : "src/runner/loops.fixtures.ts#withoutNeeds"

/**
 * The one case of a property `id` ordered at a short case deadline and open bound, so a worker that never reports on it
 * is ended within those and the silence grace.
 */
export const shortCase = (id: string, deadline: number, open: number): Batch => [
	{
		property: id,
		chooser: { kind: "simplest" },
		drawn: { kind: "unsteered" },
		keep: "nothing",
		sense: { kind: "notes" },
		deadline,
		open,
		print: "failing"
	}
]

/** The identities of the planted properties of a worker silenced between two units: the one that silences it, then the next. */
export const silencing = (nextNeeds: boolean) =>
	({
		silences: "src/runner/pool.fixtures.ts#silencesItsWorker",
		next: nextNeeds
			? "src/runner/pool.fixtures.ts#passesWithANeed"
			: "src/runner/pool.fixtures.ts#passesAtOnce"
	}) as const

/**
 * How a planted property silences its worker once it retires: `spins`, its main thread held in a loop that spends CPU
 * (silencesItsWorker), which the pool's CPU leg ends; or `blocks`, held in a wait that spends none (blocksItsWorker),
 * which its stall leg ends.
 */
export type Silence = "spins" | "blocks"

/** Both silences, a worker blocked or spinning. */
export const silenceSpace: Gen<Silence> = map(boolean, (blocks): Silence =>
	blocks ? "blocks" : "spins"
)

/** The identity of the planted property that silences its worker as `silence` says. */
export const silencerOf = (silence: Silence): string => {
	switch (silence) {
		case "spins":
			return "src/runner/pool.fixtures.ts#silencesItsWorker"
		case "blocks":
			return "src/runner/pool.fixtures.ts#blocksItsWorker"
	}
}

/** What a lost unit's report says of the leg of the pool's watch that ended its worker, by silence (runner/work.ts overrunText). */
export const legSaid = (silence: Silence): string => {
	switch (silence) {
		case "spins":
			return "by the pool, past its bound and the grace: its process tree spent "
		case "blocks":
			return "by the pool, past its bound and the grace: its process tree's CPU moved "
	}
}

/**
 * A need whose release holds its worker's main thread forever in a wait that spends no CPU, outside any case: a futex
 * wait on a cell nothing ever wakes, as a worker blocked on a lock or a pipe is held.
 */
const waitsOnRelease: Need<void> = {
	key: "pool.fixtures.ts waits on release",
	open: Effect.as(
		Effect.addFinalizer(() =>
			Effect.sync(() => {
				const cell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
				Atomics.wait(cell, 0, 0)
			})
		),
		Effect.void
	)
}

/** A property planted to block its worker once it retires: its cases pass, holding a need whose release never wakes. */
export const blocksItsWorker = property.exhaust(finite(int(0, 1)), {
	box: "two values",
	needs: { blocker: waitsOnRelease },
	situations: [],
	check: () => () => Effect.void,
	oracle: {
		kind: "specification",
		name: "a property planted to block its worker in a wait that spends nothing once it retires"
	},
	kept: [],
	kills: []
})

/** The identity of the planted property whose case waits, declared, past its deadline and the pool's silence grace. */
export const WAITS_DECLARED = "src/runner/pool.fixtures.ts#waitsDeclared"

/** The deadlines its case runs under, in milliseconds, each with the pool's bound and grace well within its wait. */
export const declaredWaitDeadlines: Gen<number> = map(boolean, (longer) => (longer ? 2000 : 1000))

/**
 * Two of the pool's whole windows (the longer of declaredWaitDeadlines and the silence grace) and more: the case's own
 * CPU before its wait may carry the first window, so only a wait past two of them would stall in the second.
 */
const DECLARED_WAIT = Duration.millis(40_000)

/**
 * A property planted to wait on a resource other processes hold, as a case's lease or lock wait does: its case spends
 * nothing for DECLARED_WAIT, past its deadline and the pool's bound and grace, inside a declared wait (live.ts
 * waitingOn), then passes.
 */
export const waitsDeclared = property.exhaust(finite(int(0, 1)), {
	box: "two values",
	needs: {},
	situations: [],
	check: () => () => DECLARED_WAIT.pipe(liveSleep, waitingOn),
	oracle: {
		kind: "specification",
		name: "a property planted to wait, declared, past its deadline and its pool's bound and grace"
	},
	kept: [],
	kills: []
})

/**
 * A need whose release holds its worker's main thread forever, outside any case (so no watchdog sees it), as a load
 * that never ends holds it: once its property retires, the worker never gets a word out about the next unit it is sent.
 */
const blocksOnRelease: Need<void> = {
	key: "pool.fixtures.ts blocks on release",
	open: Effect.as(
		Effect.addFinalizer(() =>
			Effect.sync(() => {
				const cell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
				while (Atomics.load(cell, 0) === 0) {
					Atomics.add(cell, 0, 0)
				}
			})
		),
		Effect.void
	)
}

/** A property planted to silence its worker once it retires: its cases pass, holding a need whose release never ends. */
export const silencesItsWorker = property.exhaust(finite(int(0, 1)), {
	box: "two values",
	needs: { blocker: blocksOnRelease },
	situations: [],
	check: () => () => Effect.void,
	oracle: {
		kind: "specification",
		name: "a property planted to silence its worker once it retires"
	},
	kept: [],
	kills: []
})

/** The case deadline the slow planted properties run under, in milliseconds. */
export const SLOW_WORKER_DEADLINE = 2000

/** How many bursts of CPU a slow planted case spends, one every SLOW_STALL_MILLIS, each SLOW_BURST_MILLIS long. */
const SLOW_BURSTS = 38

const SLOW_BURST_MILLIS = 20

const SLOW_STALL_MILLIS = 500

/** The program a slow planted case's child runs: the bursts and stalls of the case itself, then it exits. */
const SLOW_CHILD_PROGRAM = `const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000 }
const burst = () => { const until = cpu() + ${SLOW_BURST_MILLIS}; while (cpu() < until) {} }
const step = (left) => { if (left === 0) { return } burst(); setTimeout(() => step(left - 1), ${SLOW_STALL_MILLIS}) }
step(${SLOW_BURSTS})`

/** One burst of a slow planted case's own CPU. */
const slowBurst = Effect.sync(() => {
	const until = ownCpu() + SLOW_BURST_MILLIS
	let spins = 0
	while (ownCpu() < until) {
		spins += 1
	}
	return spins
})

/** A slow planted case's work in its worker: its bursts, each followed by its stall on the live clock. */
const slowInWorker = Effect.forEach(
	Array.from({ length: SLOW_BURSTS }, (_, at) => at),
	() => Effect.andThen(slowBurst, liveSleep(Duration.millis(SLOW_STALL_MILLIS))),
	{ discard: true }
)

/** A slow planted case's work in a child of its worker, which waits for it to exit. */
const slowInChild = Effect.callback<void>((resume) => {
	const child = process
		.getBuiltinModule("node:child_process")
		.spawn(process.execPath, ["-e", SLOW_CHILD_PROGRAM], { stdio: "ignore" })
	child.on("exit", () => resume(Effect.void))
	return Effect.sync(() => {
		child.kill("SIGKILL")
	})
})

/**
 * Properties planted to keep their worker silent and working past their unit's bound and the silence grace: the one
 * case spends 20 ms of CPU every 500 ms of the live clock for 19 s, in the worker or in a child it waits on, so its work
 * moves in every window of its 2 s deadline (three bursts or more, past the 10 ms progress takes) and spends about
 * 760 ms in all, under the deadline; its worker sends nothing until the case ends, past the 2 s bound and the 15 s
 * grace in wall time. Then it passes.
 */
export const slowlyWorking = property.exhaust(finite(int(0, 1)), {
	box: "two values",
	needs: {},
	situations: [],
	check: () => () => slowInWorker,
	oracle: {
		kind: "specification",
		name: "a property planted to keep its worker silent and working"
	},
	kept: [],
	kills: []
})

export const slowlyWorkingChild = property.exhaust(finite(int(0, 1)), {
	box: "two values",
	needs: {},
	situations: [],
	check: () => () => slowInChild,
	oracle: {
		kind: "specification",
		name: "a property planted to keep its worker silent while its child works"
	},
	kept: [],
	kills: []
})

/** The identity of a slow planted property, as a pool's workers load it: its work in its worker, or in a child. */
export const slowlyWorkingProperty = (inChild: boolean): string =>
	inChild
		? "src/runner/pool.fixtures.ts#slowlyWorkingChild"
		: "src/runner/pool.fixtures.ts#slowlyWorking"

/**
 * What a worker that no longer speaks the pool's protocol says, as one whose own modules a mutant changed can (a "done"
 * whose results its schema refuses): a message of no kind the pool reads.
 */
export const UNREAD_MESSAGE = { kind: "a message of no kind the pool reads" } as const

/**
 * The case deadline the property planted to speak out of the protocol runs under, in milliseconds: short, so a pool
 * that drops its message, as it once did, ends the case as hung within it rather than reporting the worker lost.
 */
export const UNREAD_DEADLINE = 2000

/**
 * The planted properties of the pool's protocol: one whose case sends its parent a message the protocol does not read
 * (UNREAD_MESSAGE) and then waits for nothing, so only the pool ends it; or one that passes at once.
 */
export const speakerOf = (unread: boolean): string =>
	unread
		? "src/runner/pool.fixtures.ts#sendsAnUnreadMessage"
		: "src/runner/pool.fixtures.ts#passesAtOnce"

/** A property planted to send its parent a message the pool's protocol does not read, then wait for nothing. */
export const sendsAnUnreadMessage = property.exhaust(finite(int(0, 1)), {
	box: "two values",
	needs: {},
	situations: [],
	check: () => () =>
		Effect.andThen(
			Effect.sync(() => process.send?.(UNREAD_MESSAGE)),
			Effect.never
		),
	oracle: {
		kind: "specification",
		name: "a property planted to send its parent a message the pool's protocol does not read"
	},
	kept: [],
	kills: []
})

/** A property planted to pass at once, with no need: the next unit a silenced worker is sent. */
export const passesAtOnce = property.exhaust(finite(int(0, 1)), {
	box: "two values",
	needs: {},
	situations: [],
	check: () => () => Effect.void,
	oracle: { kind: "specification", name: "a property planted to pass at once" },
	kept: [],
	kills: []
})

/** A property planted to pass at once, with a need: the next unit a silenced worker is sent. */
export const passesWithANeed = property.exhaust(finite(int(0, 1)), {
	box: "two values",
	needs: { directory: Scratch.dir },
	situations: [],
	check: () => () => Effect.void,
	oracle: { kind: "specification", name: "a property planted to pass at once, with a need" },
	kept: [],
	kills: []
})

/**
 * Writes into `directory` a runner config whose load never ends, and gives the directory, a package root no worker
 * started over it becomes ready in: its test.config.ts imports a module whose top level loops forever
 * (loops.fixtures.ts), as a mutant's loop in a module a repository's runner config imports does. It is written where a
 * case runs, never kept in the checkout, since every directory holding a test.config.ts is a package a gate runs. Each
 * import is the file URL this module resolves (a file URL holds no quote), so the config loads the same modules a worker
 * does.
 */
export const unreadyRoot = (directory: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		yield* fs.writeFileString(
			`${directory}/test.config.ts`,
			Arr.join(
				[
					`import { Layer } from "${import.meta.resolve("effect")}"`,
					`import { defineRunner, noMutation } from "${import.meta.resolve("#runner/config.ts")}"`,
					`import { withNeeds } from "${import.meta.resolve("#runner/loops.fixtures.ts")}"`,
					"export default defineRunner({ include: [], smallStack: [], conditions: [], layer: Layer.empty, mutation: noMutation })",
					"export const looping = withNeeds",
					""
				],
				"\n"
			)
		)
		return directory
	})

/** The identity of the planted property whose space a count draws. */
export const COUNTED = "src/runner/pool.fixtures.ts#countedSpace"

/**
 * Every how many cases the count property asks a worker for the branch of, over the planted space's 64 cases: four
 * steps from each case (1) to more than the space holds (70), so one worker process serves each.
 */
export const countsEvery: Gen<number> = map(int(0, 3), (step) => 1 + 23 * step)

/** The planted space: two values from 0 to 7, every pair once. */
export const countedValues: Gen<readonly [number, number]> = (source) => [
	source.draw(int(0, 7)),
	source.draw(int(0, 7))
]

/** A property planted to be counted: an exhaustion of countedValues whose cases pass. */
export const countedSpace = property.exhaust(finite(countedValues), {
	box: "every pair of values from 0 to 7",
	needs: {},
	situations: [],
	check: () => () => Effect.void,
	oracle: { kind: "specification", name: "a property planted to be counted" },
	kept: [],
	kills: []
})

/** What a planted need's open says as it dies, which the case it refuses must carry. */
export const DIED_OPENING = "the planted need's open died"

/** A need whose open dies, by a thrown error (`thrown`) or by Effect.die, as an unexpected defect opening a need does. */
const diesOpening = (thrown: boolean): Need<void> => ({
	key: `pool.fixtures.ts dies opening ${thrown ? "by a throw" : "by Effect.die"}`,
	open: thrown
		? Effect.sync(() => {
				throw new Error(DIED_OPENING)
			})
		: Effect.die(DIED_OPENING)
})

/** A property planted to need what dies opening by a throw: its cases pass, should they ever run. */
export const throwsOpening = property.exhaust(finite(int(0, 1)), {
	box: "two values",
	needs: { dying: diesOpening(true) },
	situations: [],
	check: () => () => Effect.void,
	oracle: { kind: "specification", name: "a property planted to need what throws opening" },
	kept: [],
	kills: []
})

/** A property planted to need what dies opening by Effect.die: its cases pass, should they ever run. */
export const diesOpeningNeed = property.exhaust(finite(int(0, 1)), {
	box: "two values",
	needs: { dying: diesOpening(false) },
	situations: [],
	check: () => () => Effect.void,
	oracle: { kind: "specification", name: "a property planted to need what dies opening" },
	kept: [],
	kills: []
})

/** The identity of the planted property whose need dies opening, by a throw or by Effect.die. */
export const dyingProperty = (thrown: boolean): string =>
	thrown
		? "src/runner/pool.fixtures.ts#throwsOpening"
		: "src/runner/pool.fixtures.ts#diesOpeningNeed"

/** The prefix of the file a planted runner config's services write in their package root as they are released. */
export const RELEASED = "released-"

/**
 * Writes into `directory` a package a run can load (a runner config and one test module) and gives the directory: its
 * runner config's services, which a worker builds the first time a need of its opens, write a file named RELEASED and
 * the worker's process id into the root when the worker's scope closes, as the lease a repository's services draw is
 * released only when its worker ends; its one property needs a need, so every worker that runs a case builds them.
 * Each import is the file URL this module resolves, as unreadyRoot's are.
 */
export const releasingRoot = (directory: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		yield* fs.writeFileString(
			`${directory}/test.config.ts`,
			Arr.join(
				[
					`import { Effect, Layer } from "${import.meta.resolve("effect")}"`,
					`import { defineRunner, noMutation } from "${import.meta.resolve("#runner/config.ts")}"`,
					'const { writeFileSync } = process.getBuiltinModule("node:fs")',
					"export default defineRunner({",
					'\tinclude: ["held.test.ts"],',
					"\tsmallStack: [],",
					"\tconditions: [],",
					`\tlayer: Layer.effectDiscard(Effect.addFinalizer(() => Effect.sync(() => writeFileSync(\`\${import.meta.dirname}/${RELEASED}\${process.pid}\`, "")))),`,
					"\tmutation: noMutation",
					"})",
					""
				],
				"\n"
			)
		)
		yield* fs.writeFileString(
			`${directory}/held.test.ts`,
			Arr.join(
				[
					`import { Effect } from "${import.meta.resolve("effect")}"`,
					`import { finite, int } from "${import.meta.resolve("#gen.ts")}"`,
					`import { property } from "${import.meta.resolve("#property.ts")}"`,
					"export const holds = property.exhaust(finite(int(0, 1)), {",
					'\tbox: "two values",',
					'\tneeds: { held: { key: "held.test.ts held", open: Effect.succeed(Effect.void) } },',
					"\tsituations: [],",
					"\tcheck: () => () => Effect.void,",
					'\toracle: { kind: "specification", name: "a property planted to build its worker\'s services" },',
					"\tkept: [],",
					"\tkills: []",
					"})",
					""
				],
				"\n"
			)
		)
		return directory
	})

/** The identity of the planted property whose case checks the place its worker reports. */
const PLACED = "src/runner/pool.fixtures.ts#reportsItsPlace"

/** A need that gives its case the place its worker reports (WorkerIndex), read as the worker opens it. */
const placeOf: Need<Readonly<{ index: number; workers: number }>> = {
	key: "pool.fixtures.ts place",
	open: Effect.map(Effect.service(WorkerIndex), (place) => Effect.succeed(place))
}

/**
 * A property planted to check its worker's place: its case's value is the place and the count of places its worker
 * should report, and it fails when the worker reports another.
 */
export const reportsItsPlace = property.exhaust(
	finite((source) => ({ index: source.draw(int(0, 7)), workers: source.draw(int(1, 8)) })),
	{
		box: "a place among up to eight",
		needs: { place: placeOf },
		situations: [],
		check:
			({ place }) =>
			(expected) =>
				Effect.gen(function* () {
					const reported = yield* place
					if (reported.index !== expected.index || reported.workers !== expected.workers) {
						return yield* Effect.fail(
							`its worker reported place ${reported.index} of ${reported.workers}, not ${expected.index} of ${expected.workers}`
						)
					}
				}),
		oracle: { kind: "specification", name: "a property planted to check its worker's place" },
		kept: [],
		kills: []
	}
)

/** The case of the planted place property that expects place `index` of `workers`, at a deadline and open bound. */
export const placedCase = (
	index: number,
	workers: number,
	deadline: number,
	open: number
): Batch => [
	{
		property: PLACED,
		chooser: { kind: "forced", values: Float64Array.of(index, workers - 1) },
		drawn: { kind: "unsteered" },
		keep: "nothing",
		sense: { kind: "notes" },
		deadline,
		open,
		print: "failing"
	}
]
