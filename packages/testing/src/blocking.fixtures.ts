import * as NodeServices from "@effect/platform-node/NodeServices"
import { regex } from "arkregex"
import {
	Array as Arr,
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
import { liveMillis, liveSleep, watchdogGraceMillis, watchdogWakes } from "#live.ts"
import type { CheckoutDir } from "#mutate/checkout.ts"
import { type Property, property } from "#property.ts"
import { HARDENED_FLAGS } from "#runner/config.ts"
import { searchInline } from "#runner/inline.ts"
import { runnerLimits } from "#runner/limits.ts"

/**
 * The watchdog's property (live.ts) runs planted searches in programs of their own, since a runaway ends its process:
 * this module is that program when run, and the support of the property that runs it.
 */

/**
 * What a planted property does on its cases from its threshold up, below which it returns at once: hold the main thread
 * forever, in a loop or in a regular expression that backtracks without end; return at once; hold the thread for a
 * pause, past its case deadline and short of the watchdog's grace; or sleep, yielding, past its case deadline.
 */
const BODIES = ["loop", "backtrack", "returns", "pauses", "sleeps"] as const

export type Body = (typeof BODIES)[number]

/** Whether a body holds the main thread without ever yielding: a runaway, which only the watchdog ends. */
export const runsAway = (body: Body): boolean => {
	switch (body) {
		case "loop":
		case "backtrack":
			return true
		case "returns":
		case "pauses":
		case "sleeps":
			return false
	}
}

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
 * A planted search of `body`: a threshold, a short case deadline, and a pause past it by far less than the watchdog's
 * grace. A pause holds the thread on every case from the threshold up, so it is kept short.
 */
const plantedOf =
	(body: Body): Gen<Planted> =>
	(source) => {
		const deadlineMillis = source.draw(int(20, 100))
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
 * Holds the main thread as `body` says: a loop that never ends, a match that never ends, or a wait that blocks the
 * thread for `pauseMillis`.
 */
const hold = (body: "loop" | "backtrack" | "pauses", pauseMillis: number): void => {
	const cell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
	switch (body) {
		case "loop":
			while (Atomics.load(cell, 0) === 0) {
				Atomics.add(cell, 0, 0)
			}
			return
		case "backtrack":
			Atomics.store(cell, 0, BACKTRACKS.test(BACKTRACKED) ? 1 : 0)
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
			case "loop":
			case "backtrack":
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
			limits: { ...runnerLimits, deadline: planted.deadlineMillis }
		}),
		(verdict) => (verdict.kind === "failed" ? verdict.finding.kind : verdict.kind)
	)

/**
 * The case deadline of the search that puts the watchdog's thread to sleep before a planted runaway (watchdogAsleep):
 * four of the watchdog's graces, so the thread sleeps until four graces past that search's first case's start. The
 * property requires that moment to come past the runaway's moment and grace, counted from when the planted search
 * began (dueBeforeTheThreadWakes), which holds while the search waits less than three graces less the runaway's
 * deadline (at most 100 ms, plantedOf) for the thread; a thread left asleep that long, waiting its grace once it wakes,
 * then ends the process past the property's bound. It is no limit: any multiple of the grace from three up separates
 * the two, and four leaves the wait a grace.
 */
const asleepDeadlineMillis = 4 * watchdogGraceMillis

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
					limits: { ...runnerLimits, deadline: asleepDeadlineMillis }
				})
				const began = yield* liveMillis
				const wakes = yield* watchdogWakes
				yield* Console.log(`began: ${began}`)
				yield* Console.log(
					`wakes: ${Option.match(wakes, { onNone: () => "none", onSome: String })}`
				)
				const verdict = yield* searchInline(plantedSearch(planted), {
					id: idOf(planted),
					seed,
					reach: "full",
					limits: { ...runnerLimits, deadline: planted.deadlineMillis }
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

/** The line the program prints when its search ends: how it ended. */
const ENDED_LINE = regex("^ended: (?<ending>\\S+)$", "m")

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
			const ended = yield* liveMillis
			return {
				began: Option.map(Option.fromNullishOr(BEGAN_LINE.exec(stdout)?.groups.moment), Number),
				wakes: Option.map(Option.fromNullishOr(WAKES_LINE.exec(stdout)?.groups.moment), Number),
				ended,
				ending: Option.fromNullishOr(ENDED_LINE.exec(stdout)?.groups.ending),
				replay: Option.fromNullishOr(REPLAY_LINE.exec(stderr)?.groups.token),
				exitCode: Exit.isSuccess(exit) ? Option.some(Number(exit.value)) : Option.none()
			}
		})
	)

/** How a well-behaved planted search ends in its program: its verdict, or none for a runaway, whose process is ended. */
export const endingOf = (planted: Planted): Option.Option<string> => {
	switch (planted.body) {
		case "returns":
		case "pauses":
			return Option.some("exhausted")
		case "sleeps":
			return Option.some("hung")
		case "loop":
		case "backtrack":
			return Option.none()
	}
}

if (import.meta.main) {
	await Option.match(commandOf(process.argv.slice(2)), {
		onNone: () =>
			Effect.runPromise(
				Effect.andThen(
					Console.error(
						"usage: node blocking.fixtures.ts <loop|backtrack|returns|pauses|sleeps> <threshold> <deadline ms> <pause ms> <seed>"
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

/**
 * The cases in flight as the watchdog watches them at `now`: one past its moment passed it `by` milliseconds before
 * (at `now` itself when `by` is 0), one not yet past it reaches it `by` and one more milliseconds after; each reports
 * its index, and its work is over its deadline as drawn.
 */
export const watchedAt = (inFlight: ReadonlyArray<InFlight>, now: number) =>
	Arr.map(inFlight, (one, index) => ({
		hangsAt: one.past ? now - one.by : now + one.by + 1,
		graceMillis: watchdogGraceMillis,
		report: () => reportAt(index),
		over: () => one.over
	}))
