import { Array as Arr, Config, Effect, FileSystem, Option } from "effect"
import { boolean, finite, type Gen, int } from "#gen.ts"
import { liveMillis, liveSleep } from "#live.ts"
import { type Need, property } from "#property.ts"
import { Scratch } from "#resources/scratch.ts"
import type { Batch } from "#runner/protocol.ts"

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
 * When the process `pid` was gone, polling it until `within` milliseconds have passed: the milliseconds it took, or
 * none if it is still alive then.
 */
export const goneWithin = (pid: number, within: number) =>
	Effect.gen(function* () {
		const began = yield* liveMillis
		for (;;) {
			const now = yield* liveMillis
			if (!alive(pid)) {
				return Option.some(now - began)
			}
			if (now - began >= within) {
				return Option.none<number>()
			}
			yield* liveSleep("20 millis")
		}
	})

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
