import * as NodeServices from "@effect/platform-node/NodeServices"
import { regex } from "arkregex"
import {
	Array as Arr,
	Clock,
	Console,
	Duration,
	Effect,
	Exit,
	Option,
	Stream,
	String as Str
} from "effect"
import { ChildProcess } from "effect/process"
import { array, element, finite, type Gen, int } from "#gen.ts"
import { liveSleep, type Silence, watchdogGraceMillis, watchdogWakes } from "#live.ts"
import type { CheckoutDir } from "#mutate/checkout.ts"
import { type Property, property } from "#property.ts"
import { HARDENED_FLAGS } from "#runner/config.ts"
import { searchInline } from "#runner/inline.ts"
import { needStallMillis, runnerLimits } from "#runner/limits.ts"

/**
 * The watchdog's property (live.ts) runs planted searches in programs of their own, since a runaway ends its process:
 * this module is that program when run, and the support of the property that runs it.
 */

/**
 * What a planted property does on its cases from its threshold up, below which it returns at once: hold the main thread
 * forever, in a loop or in a regular expression that backtracks without end, spending a CPU, or waiting a second at a
 * time in Atomics.wait, spending none (`waits`), so its guard reads it stalled where the others spent; return at once; hold the thread for a
 * pause, past its case deadline and short of the watchdog's grace; sleep, yielding, past its case deadline; or, on its
 * threshold's case alone, block the thread in the kernel past its moment and two of the watchdog's graces, silent and
 * spending no CPU of its own while a child it waits for works (stores to disk), as a thread the machine pages out or
 * starves is silent while its process's work moves.
 */
const BODIES = ["loop", "backtrack", "waits", "returns", "pauses", "sleeps", "blocks"] as const

export type Body = (typeof BODIES)[number]

/** Whether a body holds the main thread without ever yielding: a runaway, which only the watchdog ends. */
export const runsAway = (body: Body): boolean => {
	switch (body) {
		case "loop":
		case "backtrack":
		case "waits":
			return true
		case "returns":
		case "pauses":
		case "sleeps":
		case "blocks":
			return false
	}
}

/**
 * Whether a body runs in a program of its own: a runaway, which ends its process, and a body that blocks its thread past
 * the watchdog's graces, which a watchdog that judged a silent thread by the grace alone would end.
 */
export const inProgram = (body: Body): boolean => runsAway(body) || body === "blocks"

/**
 * A planted search, as its program takes it: the body, the least value it acts on, its cases' deadline, and how long a
 * pause holds the thread.
 */
export type Planted = Readonly<{
	body: Body
	threshold: number
	deadlineMillis: number
	pauseMillis: number
}>

/** The values a planted search enumerates: 0 to 9, in that order, so its first case at its threshold is the threshold. */
export const values = int(0, 9)

/** The identity of a planted search. */
export const idOf = (planted: Planted): string =>
	`a planted ${planted.body} from ${planted.threshold}`

/**
 * The case deadline of a planted search whose thread blocks (BODIES' "blocks"): a second, past what its child spends of
 * CPU while it stores to disk for the block, so the case's work stays within its deadline and is judged by its result.
 * It is no limit: any deadline its child's CPU stays under separates the two.
 */
const BLOCKED_DEADLINE_MILLIS = 1000

/**
 * How long the child a blocked thread waits for rests between the pages it syncs, in milliseconds: so its CPU over a
 * block stays a small share of BLOCKED_DEADLINE_MILLIS (200 ms over an 11 s block, measured on cassowary under load 60)
 * and past what shows progress over the block (work.ts progressOver: 11 ms), and its storage work moves throughout.
 */
const PAGE_PAUSE_MILLIS = 10

/**
 * The child a blocked thread waits for: it writes and syncs a page to a file of its own under the temporary directory,
 * resting PAGE_PAUSE_MILLIS after each, until `pauseMillis` have passed, then removes the file.
 */
const storingFor = (pauseMillis: number): string =>
	`const fs = require("node:fs"); const file = require("node:path").join(require("node:os").tmpdir(), "watchdog-blocks-" + process.pid); const fd = fs.openSync(file, "w"); const page = Buffer.alloc(4096, 1); const rest = new Int32Array(new SharedArrayBuffer(4)); const until = Date.now() + ${String(pauseMillis)}; while (Date.now() < until) { fs.writeSync(fd, page); fs.fsyncSync(fd); Atomics.wait(rest, 0, 0, ${String(PAGE_PAUSE_MILLIS)}) } fs.closeSync(fd); fs.unlinkSync(file)`

/**
 * The least case deadline of a planted search (but one that blocks), in milliseconds: its case's CPU budget, which the
 * planted program's own work beside the case must never spend, so a runaway that only waits reads as stalled, never as
 * having spent its deadline.
 *
 * @limitKind measured
 * @owner the watchdog's property (blocking.test.ts watchdog, plantedOf)
 * @unit milliseconds of a planted case's deadline, its CPU budget and its stall window
 * @scope each planted search but one that blocks, run in a program of its own
 * @evidence ~/.cache/metis/SLOP-FIXER-2-scratch/watchdog/measure: the planted waits program (threshold 0, a deadline of
 *   a second so no reading spends it, seed 2400084417) run 48 at a time, four rounds, by measure.sh there, each reading
 *   of its case's judge printed (spent since the case began, moved over the window) by a print in judgeOf that the run
 *   alone held; and /tmp/sf2-insp/cost.mjs, a worker's inspector session and Runtime.evaluate against a main thread that
 *   waits a second at a time, 24 at once
 * @observed 2026-11-22 21:02 to 21:06 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB, load average 296 to 416; Node 26.13.1;
 *   the testing library with the watchdog's own CPU left out of a case's (work.ts ownCpu)
 * @workload a held case that only waits in Atomics.wait, the watchdog answering through the inspector every grace,
 *   192 programs
 * @result its first window, from the case's start to the first answer, spent 2.6 ms of CPU at the median, 4.5 at the
 *   90th percentile, 174.8 at the 99th and 190.9 at most, the program's own warm-up beside its case (a first window
 *   holding 24 to 191 ms also waited 13 to 201 ms to run, the process busy as the case began); each later window
 *   moved 1.1 ms at the median and 2.0 at most (38 windows), under the 10 ms that shows progress; an inspector session
 *   and its evaluate cost the main thread 0.3 to 1.6 ms. Under a 71 ms deadline the warm-up spent the deadline once in
 *   192 runs (probe6's r2-2, 2026-11-22: its first answer read spent, the leg a waiting body is never judged by)
 * @decision twice the largest first window, 400 ms rounded up: a warm-up twice any seen still reads stalled at its
 *   second answer; the later windows' CPU, a fifth of progress, keeps a waiting case stalled at every answer past it
 * @revalidate a planted case judged spent or answered running past its second answer; a Node or V8 upgrade; another
 *   machine
 */
const PLANTED_DEADLINE_MILLIS = 400

/**
 * A planted search of `body`: a threshold, a case deadline from PLANTED_DEADLINE_MILLIS, and a pause past it by far less
 * than the watchdog's grace. A pause holds the thread on every case from the threshold up, so it is kept short.
 */
const plantedOf =
	(body: Body): Gen<Planted> =>
	(source) => {
		if (body === "blocks") {
			return {
				body,
				threshold: source.draw(int(0, 9)),
				deadlineMillis: BLOCKED_DEADLINE_MILLIS,
				pauseMillis: BLOCKED_DEADLINE_MILLIS + 2 * watchdogGraceMillis + source.draw(int(1, 100))
			}
		}
		const deadlineMillis = source.draw(int(PLANTED_DEADLINE_MILLIS, PLANTED_DEADLINE_MILLIS + 80))
		return {
			body,
			threshold: source.draw(int(0, 9)),
			deadlineMillis,
			pauseMillis: deadlineMillis + source.draw(int(1, 100))
		}
	}

/** A regular expression that backtracks without end on a run of a's that ends in another letter. */
const BACKTRACKS = regex("^(a+)+$")

/** The subject BACKTRACKS backtracks on: 2^40 ways to split its a's, none of which matches. */
const BACKTRACKED = `${Str.repeat(40)("a")}!`

/**
 * How long one wait of a body that waits holds the main thread: the longest the watchdog's thread waits for the main
 * thread's answer, which an interrupt asks between two waits, against the watchdog's grace of 5 s; long enough that the
 * thread's wake-ups cost under a clock tick of CPU over a whole window of the grace, so its guard reads it stalled.
 */
const WAIT_MILLIS = 1000

/**
 * Holds the main thread as `body` says: a loop that never ends, a match that never ends, waits that never end, or a wait
 * that blocks the thread for `pauseMillis`.
 */
const hold = (
	body: "loop" | "backtrack" | "waits" | "pauses" | "blocks",
	pauseMillis: number
): void => {
	const cell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
	switch (body) {
		case "blocks":
			process
				.getBuiltinModule("node:child_process")
				.spawnSync(process.execPath, ["-e", storingFor(pauseMillis)], { stdio: "ignore" })
			return
		case "loop":
			while (Atomics.load(cell, 0) === 0) {
				Atomics.add(cell, 0, 0)
			}
			return
		case "backtrack":
			Atomics.store(cell, 0, BACKTRACKS.test(BACKTRACKED) ? 1 : 0)
			return
		case "waits":
			while (Atomics.load(cell, 0) === 0) {
				Atomics.wait(cell, 0, 0, WAIT_MILLIS)
			}
			return
		case "pauses":
			Atomics.wait(cell, 0, 0, pauseMillis)
	}
}

/** What the planted property does on a case of `value`. */
const bodyOf =
	(planted: Planted) =>
	(value: number): Effect.Effect<void> => {
		if (value < planted.threshold) {
			return Effect.void
		}
		switch (planted.body) {
			case "returns":
				return Effect.void
			case "sleeps":
				return Effect.sleep(Duration.millis(planted.deadlineMillis * 4))
			case "blocks":
				return value === planted.threshold
					? Effect.sync(() => hold("blocks", planted.pauseMillis))
					: Effect.void
			case "loop":
			case "backtrack":
			case "waits":
			case "pauses": {
				const body = planted.body
				return Effect.sync(() => hold(body, planted.pauseMillis))
			}
		}
	}

/** A planted search: an exhaustion of 0..9 whose property does what its body says from its threshold up. */
const plantedSearch = (planted: Planted): Property =>
	property.exhaust(finite(values), {
		box: "every value from 0 to 9",
		needs: {},
		situations: [],
		check: () => bodyOf(planted),
		oracle: { kind: "specification", name: "a property planted to hold its process's main thread" },
		kept: [],
		kills: []
	})

/**
 * How a planted search of a settling body ends in this process: its verdict, or the kind of its failure. A settling body
 * yields or ends, so it runs beside the case that runs it, where a runaway would end the process.
 */
export const settledHere = (planted: Planted, seed: number) =>
	Effect.map(
		searchInline(plantedSearch(planted), {
			id: idOf(planted),
			seed,
			reach: "full",
			limits: { ...runnerLimits, deadline: planted.deadlineMillis },
			stall: needStallMillis
		}),
		(verdict) => (verdict.kind === "failed" ? verdict.finding.kind : verdict.kind)
	)

/**
 * The case deadline of the search that puts the watchdog's thread to sleep before a planted runaway (watchdogAsleep):
 * four of the watchdog's graces, so the thread sleeps until four graces past that search's first case's start. The
 * property requires that moment to come past the runaway's moment and grace, counted from when the planted search
 * began (dueBeforeTheThreadWakes), which holds while the search waits less than three graces less the runaway's
 * deadline (at most 480 ms, plantedOf) for the thread; a thread left asleep that long, waiting its grace once it wakes,
 * then ends the process past the property's bound. It is no limit: any multiple of the grace from three up separates
 * the two, and four leaves the wait a grace.
 */
const asleepDeadlineMillis = 4 * watchdogGraceMillis

/**
 * The live clock's time, in milliseconds since the epoch, the scale the watchdog states its wake moments in
 * (watchdogWakes): what the watchdog's own property measures its lateness by, the one verdict whose oracle is a span of
 * wall time, since the watchdog ends a main thread that holds without yielding past a grace of it (live.ts
 * watchdogGraceMillis). No other test reads the clock (oxlint.config.ts).
 */
const wallNow = Clock.currentTimeMillis.pipe(
	Effect.provideService(Clock.Clock, Clock.Clock.defaultValue())
)

/**
 * Waits, yielding a millisecond at a time, until the process's watchdog thread has said when it will next wake of
 * itself. Run as a case, the thread's first, the moment it says is that case's own: it reads the earliest moment of the
 * cases in flight when it starts.
 */
const untilTheWatchdogSleeps: Effect.Effect<void> = Effect.suspend(() =>
	Effect.flatMap(watchdogWakes, (wakes) =>
		Option.isSome(wakes)
			? Effect.void
			: Effect.andThen(liveSleep(Duration.millis(1)), untilTheWatchdogSleeps)
	)
)

/**
 * A search under asleepDeadlineMillis whose cases wait until the watchdog's thread sleeps until a moment of its own. Its
 * first case starts the process's watchdog and waits until the thread sleeps until that case's moment; its end, and
 * every later case's start and end, each coming later than that moment or never, wake no thread: the thread sleeps on
 * until the first case's moment, so a planted runaway after the search comes due before the thread would wake of
 * itself, and the thread must be woken for it. Without the wait the thread may start only once the runaway holds the
 * main thread and read the runaway's moment as its first, which needs no wake-up.
 */
const watchdogAsleep: Property = property.exhaust(finite(values), {
	box: "every value from 0 to 9",
	needs: {},
	situations: [],
	check: () => () => untilTheWatchdogSleeps,
	oracle: { kind: "specification", name: "cases that wait until the watchdog's thread sleeps" },
	kept: [],
	kills: []
})

/**
 * The program this module is when run: it puts the watchdog's thread to sleep until a later moment of its own
 * (watchdogAsleep), then prints the moment its planted search begins and the moment the thread then said it would wake,
 * exhausts the planted search inline under its case deadline and the given run seed, and prints how the search ended. A
 * runaway ends the process instead, by its watchdog, which prints its report.
 */
const searchedAsProgram = (planted: Planted, seed: number) =>
	Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* searchInline(watchdogAsleep, {
					id: `${idOf(planted)} after the watchdog sleeps`,
					seed,
					reach: "full",
					limits: { ...runnerLimits, deadline: asleepDeadlineMillis },
					stall: needStallMillis
				})
				const began = yield* wallNow
				const wakes = yield* watchdogWakes
				yield* Console.log(`began: ${began}`)
				yield* Console.log(
					`wakes: ${Option.match(wakes, { onNone: () => "none", onSome: String })}`
				)
				const verdict = yield* searchInline(plantedSearch(planted), {
					id: idOf(planted),
					seed,
					reach: "full",
					limits: { ...runnerLimits, deadline: planted.deadlineMillis },
					stall: needStallMillis
				})
				yield* Console.log(
					`ended: ${verdict.kind === "failed" ? verdict.finding.kind : verdict.kind}`
				)
			})
		).pipe(Effect.provide(NodeServices.layer))
	)

/** A whole number written in decimal, or none. */
const wholeOf = (text: string | undefined): Option.Option<number> =>
	Option.filter(
		Option.fromUndefinedOr(text),
		(written) => written !== "" && Number.isSafeInteger(Number(written))
	).pipe(Option.map(Number))

/** The planted search and the seed a command line names, read strictly: `<body> <threshold> <deadline> <pause> <seed>`. */
const commandOf = (args: ReadonlyArray<string>): Option.Option<readonly [Planted, number]> => {
	const [bodyText, threshold, deadline, pause, seed] = args
	return Option.all([
		Arr.findFirst(BODIES, (known) => known === bodyText),
		wholeOf(threshold),
		wholeOf(deadline),
		wholeOf(pause),
		wholeOf(seed)
	]).pipe(
		Option.map(([body, drawnThreshold, deadlineMillis, pauseMillis, drawnSeed]) => [
			{ body, threshold: drawnThreshold, deadlineMillis, pauseMillis },
			drawnSeed
		])
	)
}

/** This module, the program a planted search runs in, from the package's directory in the checkout. */
export const programIn = (checkout: CheckoutDir): string => `${checkout}/src/blocking.fixtures.ts`

/** The replay token of the watchdog's report, on the report's replay line. */
const REPLAY_LINE = regex(
	"held its worker's event loop past its deadline(?:.*\n)*?replay: toolchain-test replay '(?<token>[^']*)'"
)

/**
 * The leg the watchdog's report says its guard read (live.ts answerOf, runner/work.ts overrunText): its process tree
 * spent its deadline's CPU, or its CPU did not move over a whole window.
 */
const LEG_LINE = regex("^its guard read: its process tree(?<leg> spent|'s CPU moved)", "m")

/** The leg of the report's line, as an Overrun names it. */
const legOf = (line: string): "spent" | "stalled" => (line === " spent" ? "spent" : "stalled")

/** The line the program prints when its search ends: how it ended. */
const ENDED_LINE = regex("^ended: (?<ending>\\S+)$", "m")

/** How long the watchdog's thread waited to run before it ended the process, as its report states it (live.ts end). */
const WAITED_LINE = regex("^its watchdog waited (?<millis>\\d+) ms to run$", "m")

/** The line the program prints as its search begins: the moment, in milliseconds since the epoch. */
const BEGAN_LINE = regex("^began: (?<moment>\\d+)$", "m")

/** The line the program prints as its search begins: when the watchdog's thread said it would next wake, if it did. */
const WAKES_LINE = regex("^wakes: (?<moment>\\d+)$", "m")

/**
 * A planted program's run under a seed, from the program at `program`, to its end: what it printed (when its planted
 * search began, when the watchdog's thread then said it would wake, how the search ended), its exit code, and when it
 * ended. The program runs in its worker's process group, not one of its own, so a worker ended before the
 * program (a mutant's runaway its watchdog no longer ends, in a kill trial) ends it too (pool.ts endGroup).
 */
export const programRun = (program: string, planted: Planted, seed: number) =>
	Effect.scoped(
		Effect.gen(function* () {
			const handle = yield* ChildProcess.make(
				process.execPath,
				[
					...HARDENED_FLAGS,
					program,
					planted.body,
					String(planted.threshold),
					String(planted.deadlineMillis),
					String(planted.pauseMillis),
					String(seed)
				],
				{ stdin: "ignore", detached: false }
			)
			const [stdout, stderr, exit] = yield* Effect.all(
				[
					Stream.mkString(Stream.decodeText(handle.stdout)),
					Stream.mkString(Stream.decodeText(handle.stderr)),
					Effect.exit(handle.exitCode)
				],
				{ concurrency: "unbounded" }
			)
			const ended = yield* wallNow
			return {
				began: Option.map(Option.fromNullishOr(BEGAN_LINE.exec(stdout)?.groups.moment), Number),
				wakes: Option.map(Option.fromNullishOr(WAKES_LINE.exec(stdout)?.groups.moment), Number),
				ended,
				ending: Option.fromNullishOr(ENDED_LINE.exec(stdout)?.groups.ending),
				replay: Option.fromNullishOr(REPLAY_LINE.exec(stderr)?.groups.token),
				leg: Option.map(Option.fromNullishOr(LEG_LINE.exec(stderr)?.groups.leg), legOf),
				watchdogWaited: Option.getOrElse(
					Option.map(Option.fromNullishOr(WAITED_LINE.exec(stderr)?.groups.millis), Number),
					() => 0
				),
				exitCode: Exit.isSuccess(exit) ? Option.some(Number(exit.value)) : Option.none()
			}
		})
	)

/** How a well-behaved planted search ends in its program: its verdict, or none for a runaway, whose process is ended. */
export const endingOf = (planted: Planted): Option.Option<string> => {
	switch (planted.body) {
		case "returns":
		case "pauses":
		case "blocks":
			return Option.some("exhausted")
		case "sleeps":
			return Option.some("hung")
		case "loop":
		case "backtrack":
		case "waits":
			return Option.none()
	}
}

if (import.meta.main) {
	await Option.match(commandOf(process.argv.slice(2)), {
		onNone: () =>
			Effect.runPromise(
				Effect.andThen(
					Console.error(
						"usage: node blocking.fixtures.ts <loop|backtrack|returns|pauses|sleeps|blocks> <threshold> <deadline ms> <pause ms> <seed>"
					),
					Effect.sync(() => {
						process.exitCode = 2
					})
				)
			),
		onSome: ([planted, seed]) => searchedAsProgram(planted, seed)
	})
}

/** A planted search's case and the run seed its program searches under. */
export type PlantedRun = Readonly<{ planted: Planted; seed: number }>

/** A planted search of `body`, under a drawn run seed. */
const runOf =
	(body: Body): Gen<PlantedRun> =>
	(source) => ({ planted: source.draw(plantedOf(body)), seed: source.draw(int(0, 2 ** 32 - 1)) })

/** A body that yields or ends: returns, pauses or sleeps. */
const settling: Gen<Body> = (source) =>
	source.draw(element(["returns", "pauses", "sleeps"] as const))

/** Planted searches whose bodies end by the guard's verdict: what a case draws unless an aim draws a runaway. */
export const settlingRuns: Gen<PlantedRun> = (source) => source.draw(runOf(source.draw(settling)))

/** The situation of each body. */
export type BodySituation = `a body that ${Body}`

/** Each body's situation, aimed at by a planted search of that body. */
export const bodyAims: ReadonlyArray<readonly [BodySituation, Gen<PlantedRun>]> = Arr.map(
	BODIES,
	(body) => [`a body that ${body}`, runOf(body)] as const
)

/** Every body's situation. */
export const BODY_SITUATIONS: ReadonlyArray<BodySituation> = Arr.map(
	bodyAims,
	([situation]) => situation
)

/**
 * A case in flight as the main thread holds it when the watchdog asks: whether it has passed the moment its guard would
 * first judge it, and by how far, either way, in milliseconds; and whether its work is over its deadline (spent, or
 * stalled over a whole window) or still within it, as the machine slows it.
 */
export type InFlight = Readonly<{ past: boolean; by: number; over: boolean }>

/** The cases a main thread holds in flight when the watchdog asks it: none to four, each past its moment or not, its
 * work over its deadline or not. */
export const inFlights: Gen<ReadonlyArray<InFlight>> = array(
	(source) => ({
		past: source.draw(element([false, true] as const)),
		by: source.draw(int(0, 10_000)),
		over: source.draw(element([false, true] as const))
	}),
	{ min: 0, max: 4 }
)

/** The report of the case in flight at `index`, as its watch carries it. */
export const reportAt = (index: number): string => `<the report of case ${index}>`

/** The leg the guard of the case in flight at `index` read, as its watch gives it. */
export const legAt = (index: number): string => `<the leg of case ${index}>`

/** The leg a runaway's guard reads: its CPU spent, a body that spends one; its CPU unmoving, one that waits. */
export const legOfBody = (body: Body): "spent" | "stalled" =>
	body === "waits" ? "stalled" : "spent"

/**
 * How many of the watchdog's graces a runaway's thread may hold past its moment before its process ends: one for a
 * body the inspector interrupts at once (a loop, a match), whose thread answers it within a grace; none for the body
 * that waits, held in Atomics.wait outside JavaScript, whose thread answers the inspector only as one of its waits ends
 * and the machine runs it, so its process ends with that answer, however late the machine makes it (live.ts: a silent
 * thread that spends nothing is waited for, never ended; trunk@toolchain at 7d78e06c, its full run's load: past two
 * graces).
 */
export const gracesOfBody = (body: Body): Option.Option<number> =>
	body === "waits" ? Option.none() : Option.some(1)

/**
 * The cases in flight as the watchdog watches them at `now`: one past its moment passed it `by` milliseconds before
 * (at `now` itself when `by` is 0), one not yet past it reaches it `by` and one more milliseconds after; each reports
 * its index, and its work is over its deadline as drawn, its guard reading its leg then.
 */
export const watchedAt = (inFlight: ReadonlyArray<InFlight>, now: number) =>
	Arr.map(inFlight, (one, index) => ({
		hangsAt: one.past ? now - one.by : now + one.by + 1,
		graceMillis: watchdogGraceMillis,
		report: () => reportAt(index),
		judged: () => (one.over ? Option.some(legAt(index)) : Option.none<string>())
	}))

/** A main thread's silence over one grace, by what kept it: each a few times the progress mark of 10 ms, or none. */
const SILENCES = [
	"a loop that runs JavaScript",
	"a loop that runs JavaScript under memory pressure",
	"a thread memory.high throttles",
	"a loop in the kernel with no memory stall",
	"a thread that spends nothing"
] as const

/** What each silence spent and its cgroup stalled, in milliseconds, against a progress mark of 10. */
export const silenceOf = (shape: (typeof SILENCES)[number]): Silence => {
	switch (shape) {
		case "a loop that runs JavaScript":
			return { cpu: 40, user: 38, stall: 0 }
		case "a loop that runs JavaScript under memory pressure":
			return { cpu: 40, user: 30, stall: 400 }
		case "a thread memory.high throttles":
			return { cpu: 40, user: 0, stall: 400 }
		case "a loop in the kernel with no memory stall":
			return { cpu: 40, user: 2, stall: 0 }
		case "a thread that spends nothing":
			return { cpu: 0, user: 0, stall: 400 }
	}
}

/** Every silence, one at a time. */
export const silences: Gen<(typeof SILENCES)[number]> = (source) => source.draw(element(SILENCES))
