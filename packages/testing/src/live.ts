import { isMainThread, Worker } from "node:worker_threads"
import { Array as Arr, Clock, Duration, Effect, Fiber, Option, Record as Rec } from "effect"

/**
 * How long the main thread may go without answering the watchdog once a case in flight has passed the moment its
 * guard would have stopped it (live.ts's watchdog). A live thread answers a ping as soon as the synchronous work it is
 * in yields, so this bounds how long a live case may hold the thread past that moment, not the case's hang limit. A
 * Node 26 thread cannot be stopped inside synchronous JavaScript without aborting the process, so a case that never
 * yields ends its process here, and this grace is what separates it from one that is merely slow.
 *
 * @limitKind measured
 * @owner the choice-stream testing library (live.ts's watchdog)
 * @unit milliseconds
 * @scope every case a search runs on a process's main thread, once it is past its hang limit or its search's deadline
 * @evidence packages/testing/out/watchdog-grace/20261116T064618/ in the toolchain's checkout on cassowary
 *   (/Users/bjorn/Documents/toolchain), the uncommitted record of `sh run.sh` there: probe.mjs, whose worker pings the
 *   main thread as the watchdog does (postMessage, the answer through shared memory) while the main thread runs
 *   synchronous segments that allocate, between yields; alone-1.json to alone-3.json and together-1.json to
 *   together-4.json, every ping's latency; runs.log and environment.txt. packages/testing/src/blocking.test.ts
 *   re-verifies the grace's use: its well-behaved bodies hold the main thread past their hang limit and are never
 *   ended, and its runaways end within their limit and this grace
 * @observed 2026-11-16 06:46:22 to 06:47:27 UTC
 * @environment cassowary, Ubuntu 26.04.1 (Linux 7.0.0-1016-aws) on an AWS Graviton3 (Neoverse-V1, arm64) instance with
 *   64 logical CPUs and 247 GiB, Node 26.13.1; load average 105 to 155 from other sessions throughout
 * @workload seven runs, three of 15 s one after another and four of 20 s at once; in each the main thread runs
 *   synchronous segments of 1, 5, 20, 50, 100 and 200 ms in turn, allocating throughout, and the worker sends its next
 *   ping after a random wait of 0 to 20 ms once the last is answered: 1,436 pings
 * @result per run p50 46 to 49 ms, p99 197 to 200 ms, slowest 198.7 to 201.0 ms; the slowest answer of all 201.0 ms. A
 *   ping waits for the segment in flight, so every answer came within the longest segment, 200 ms, and the machine's
 *   scheduling delay. No errors; the watchdog's own cost per case was not measured again
 * @decision 5 s is 24 times the slowest answer seen and allows a live case a synchronous segment of seconds past its
 *   moment; a case past its moment is a hang whichever way it ends, so the grace only decides whether its verdict is
 *   the guard's typed one or the watchdog's report. Kept at the old record's value, whose slowest answer, 386 ms on a
 *   macOS VM loaded four to six times over its ten cores, shows the machine sets the latency
 * @revalidate a Node or V8 upgrade; a different machine; a suite whose property holds the thread in one synchronous
 *   segment for seconds; a process the watchdog ended whose report shows a case that yields
 */
const watchdogGraceMillis = 5000

/**
 * How long a search waits on a hung case's cleanup, on the live clock, before it reports the hang or goes on to its next
 * case (live.ts's awaitWithinGrace). The case stays among the fibers its search awaits before it returns, so a cleanup
 * past the grace delays the search's end and never outlives it.
 *
 * @limitKind provisional
 * @owner the choice-stream testing library (live.ts, a hung case's cleanup)
 * @unit seconds
 * @scope the cleanup of each case a search stops as hung, before the search reports or runs its next case
 * @guards without it a search waits on a hung case's cleanup for as long as the cleanup takes, so a cleanup that
 *   itself hangs holds the hang's report, and the next case, until the test's own timeout
 * @measure time the cleanup of every case the library's and the consumers' suites stop as hung (their releases: a
 *   fiber's finalizers, a database schema's drop), on cassowary, with the suites running at their usual width; the
 *   grace is the slowest cleanup seen, with its headroom stated, and never shorter than the slowest release the report
 *   margin is measured against
 * @origin written with no evidence before the testing library came into this repository as one package in 20b4112
 *   (2026-11-13), from grizzle's, superstarter's and edullm's copies
 * @recorded 2026-11-16
 */
const hungCleanupGraceSeconds = 5

/** A sleep on the live clock, whatever clock the caller runs under: a hang guard must not wait on a TestClock. */
export const liveSleep = (duration: Duration.Input) =>
	Effect.sleep(duration).pipe(Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()))

/** The live clock's time, whatever clock the caller runs under: a budget of wall time reads it. */
export const liveMillis = Clock.currentTimeMillis.pipe(
	Effect.provideService(Clock.Clock, Clock.Clock.defaultValue())
)

/**
 * A sleep on the live clock until it reads `moment`, in milliseconds since the epoch, or later. A timer may fire a
 * millisecond before the clock reads its moment, so the sleep sleeps again until it does, and whatever reads the clock
 * once it has ended finds the moment passed.
 */
export const liveSleepUntil = (moment: number): Effect.Effect<void> =>
	Effect.flatMap(liveMillis, (now) =>
		now >= moment
			? Effect.void
			: Effect.andThen(liveSleep(Duration.millis(moment - now)), liveSleepUntil(moment))
	)

/**
 * How long a search waits on a hung case's cleanup, on the live clock, before it reports the hang or goes on to its next
 * case: hungCleanupGraceSeconds. The case stays among the fibers its search awaits before it
 * returns (explore.ts withCaseLives), so a cleanup past the grace delays the search's end and never outlives it.
 */
export const HUNG_CLEANUP_GRACE = Duration.seconds(hungCleanupGraceSeconds)

/** Interrupts a fiber without waiting for its cleanup: its caller keeps the fiber and awaits it later. */
export const abandon = <A, E>(running: Fiber.Fiber<A, E>): Effect.Effect<void> =>
	Effect.asVoid(Effect.forkDetach(Fiber.interrupt(running)))

/** Waits for an interrupted fiber's cleanup for HUNG_CLEANUP_GRACE at most: the fiber's keeper awaits the rest. */
export const awaitWithinGrace = <A, E>(running: Fiber.Fiber<A, E>): Effect.Effect<void> =>
	Effect.raceFirst(Effect.asVoid(Fiber.await(running)), liveSleep(HUNG_CLEANUP_GRACE))

/**
 * Interrupts a hung fiber and waits until its cleanup has ended, however long that takes: no cleanup outlives the guard
 * that stopped it, and one that never ends holds the guard, which its caller's own timeout then names.
 */
export const stopHung = <A, E>(running: Fiber.Fiber<A, E>): Effect.Effect<void> =>
	Effect.asVoid(Fiber.interrupt(running))

/**
 * @formatConstant the watchdog's shared memory, its slots and their offsets
 *
 * Where the watchdog's two threads meet in their shared memory: four Int32 counters (bumped when the earliest moment
 * moves earlier; the last ping the main thread answered; one nothing writes, for the watchdog's thread to time a wait
 * on; the last ping the watchdog's thread sent), then, at the first 8-byte boundary past them, two Float64 moments (the earliest moment a case in flight passes
 * the moment its guard would stop it, in milliseconds since the epoch, and how long that case's thread then has to
 * answer, in milliseconds).
 */
const LAYOUT = {
	generation: 0,
	pong: 1,
	timer: 2,
	ping: 3,
	counters: 4,
	earliest: 0,
	grace: 1,
	moments: 2,
	momentsOffset: 16,
	bytes: 32
} as const

type Layout = typeof LAYOUT

/**
 * The watchdog's thread, evaluated from its source text in a worker of its own, so it reads no module of the library
 * and none a transform could rewrite, only Node's built-ins. It sleeps until the earliest moment a case in flight
 * passes the moment its guard would stop it; then it pings the main thread, in shared memory and by a message, and waits
 * that case's grace for the answer. The main thread answers at its next case boundary, a case's start or end, which a
 * run of synchronous cases reaches without returning to its event loop, or on its event loop, by the message. A main
 * thread that answers is alive, so the case's own guard reports it, and the thread sleeps on. One that does not answer
 * is running JavaScript that never yields, a synchronous loop its guard cannot interrupt, since the guard's timer runs
 * on the thread the loop holds: the thread asks it, through the inspector, which interrupts even a synchronous loop, for
 * its watchdog's report, writes the report to the process's stderr, and ends the process with SIGKILL, the one signal a
 * blocked thread cannot hold. A main thread whose inspector does not answer either is ended after the grace once more,
 * with a report that says only that. Its open port keeps it alive; the main thread unrefs it. Its layout is its
 * argument, written into its source text, since the thread shares no module with the main thread.
 */
const watchdogThread = (layout: Layout): void => {
	const threads = process.getBuiltinModule("node:worker_threads")
	const { Session } = process.getBuiltinModule("node:inspector")
	const { writeSync } = process.getBuiltinModule("node:fs")
	const port = threads.parentPort
	if (port === null || !(threads.workerData instanceof SharedArrayBuffer)) {
		return
	}
	const shared: SharedArrayBuffer = threads.workerData
	const counters = new Int32Array(shared, 0, layout.counters)
	const moments = new Float64Array(shared, layout.momentsOffset, layout.moments)
	const nowMillis = () => performance.timeOrigin + performance.now()
	const after = (waited: ReturnType<typeof Atomics.waitAsync>, then: () => void): void => {
		if (waited.async) {
			void waited.value.then(then)
		} else {
			void Promise.resolve().then(then)
		}
	}
	const end = (report: string): void => {
		writeSync(2, `\n${report}\n`)
		process.kill(process.pid, "SIGKILL")
	}
	const blocked = (graceMillis: number): void => {
		const unanswered =
			"@bjornpagen/testing: a case held its process's main thread without yielding past the moment its guard would stop it, and the thread's inspector did not answer for its report; the watchdog ended the process: a hang"
		const session = new Session()
		session.connectToMainThread()
		session.post(
			"Runtime.evaluate",
			{ expression: "globalThis.bjornpagenTestingWatchdog?.blocked()", returnByValue: true },
			(error, evaluated) => {
				const report: unknown = error === null ? evaluated.result.value : undefined
				end(typeof report === "string" ? report : unanswered)
			}
		)
		after(Atomics.waitAsync(counters, layout.timer, 0, graceMillis), () => end(unanswered))
	}
	let pinged = 0
	const watch = (): void => {
		const generation = Atomics.load(counters, layout.generation)
		const hangsAt = moments[layout.earliest] ?? Number.POSITIVE_INFINITY
		const graceMillis = moments[layout.grace] ?? 0
		const waitMillis = hangsAt - nowMillis()
		if (waitMillis > 0) {
			after(Atomics.waitAsync(counters, layout.generation, generation, waitMillis), watch)
			return
		}
		pinged += 1
		const ping = pinged
		const answered = Atomics.load(counters, layout.pong)
		Atomics.store(counters, layout.ping, ping)
		port.postMessage(ping)
		after(Atomics.waitAsync(counters, layout.pong, answered, graceMillis), () => {
			if (Atomics.load(counters, layout.pong) === ping) {
				after(
					Atomics.waitAsync(
						counters,
						layout.generation,
						Atomics.load(counters, layout.generation),
						graceMillis
					),
					watch
				)
			} else {
				blocked(graceMillis)
			}
		})
	}
	port.on("message", () => undefined)
	watch()
}

/** A case the watchdog watches: when it passes the moment its guard would stop it, how long the thread then has to
 * answer, and its report should it block. */
type Watched = Readonly<{ hangsAt: number; graceMillis: number; report: () => string }>

/**
 * This process's watchdog of its main thread, for the hangs a case's own guard cannot stop: a case that loops
 * synchronously holds the thread its guard's timer would run on. `watch` registers a case in flight and returns its
 * release; `blocked` is what the watchdog's thread prints when the main thread has stopped answering, every case in
 * flight, since it cannot tell which one holds the thread. A process whose tests run off its main thread, in a worker,
 * has none: its watch does nothing, and only the guard's timer stops a case.
 */
type Watchdog = Readonly<{
	watch: (watched: Watched) => () => void
	blocked: () => string
}>

declare global {
	var bjornpagenTestingWatchdog: Watchdog | undefined
}

/** The watchdog of a process whose tests do not run on its main thread: it watches nothing. */
const offMainThread: Watchdog = {
	watch: () => () => undefined,
	blocked: () => ""
}

/** Starts this process's watchdog: its thread, its shared memory, and the cases it watches. */
const startedWatchdog = (): Watchdog => {
	const shared = new SharedArrayBuffer(LAYOUT.bytes)
	const counters = new Int32Array(shared, 0, LAYOUT.counters)
	const moments = new Float64Array(shared, LAYOUT.momentsOffset, LAYOUT.moments)
	moments[LAYOUT.earliest] = Number.POSITIVE_INFINITY
	const layout = `{ ${Arr.join(
		Arr.map(Rec.toEntries(LAYOUT), ([name, at]) => `${name}: ${at}`),
		", "
	)} }`
	const worker = new Worker(`(${watchdogThread.toString()})(${layout})`, {
		eval: true,
		workerData: shared
	})
	worker.on("message", (ping: unknown) => {
		if (typeof ping === "number") {
			Atomics.store(counters, LAYOUT.pong, ping)
			Atomics.notify(counters, LAYOUT.pong)
		}
	})
	worker.unref()
	const answer = () => {
		const ping = Atomics.load(counters, LAYOUT.ping)
		if (ping !== Atomics.load(counters, LAYOUT.pong)) {
			Atomics.store(counters, LAYOUT.pong, ping)
			Atomics.notify(counters, LAYOUT.pong)
		}
	}
	const inFlight = new Map<number, Watched>()
	let watched = 0
	const publish = () => {
		const earliest = Arr.reduce(
			Arr.fromIterable(inFlight.values()),
			{ hangsAt: Number.POSITIVE_INFINITY, graceMillis: 0 },
			(first, watch) => (watch.hangsAt < first.hangsAt ? watch : first)
		)
		const earlier = earliest.hangsAt < (moments[LAYOUT.earliest] ?? Number.POSITIVE_INFINITY)
		moments[LAYOUT.earliest] = earliest.hangsAt
		moments[LAYOUT.grace] = earliest.graceMillis
		if (earlier) {
			Atomics.add(counters, LAYOUT.generation, 1)
			Atomics.notify(counters, LAYOUT.generation)
		}
	}
	return {
		watch: (watch) => {
			answer()
			watched += 1
			const id = watched
			inFlight.set(id, watch)
			publish()
			return () => {
				answer()
				inFlight.delete(id)
				publish()
			}
		},
		blocked: () => {
			const reports = Arr.map(Arr.fromIterable(inFlight.values()), (watch) => watch.report())
			return reports.length === 1
				? Arr.join(reports, "")
				: Arr.join(
						[
							`one of these ${reports.length} cases in flight blocked the process, and the watchdog cannot tell which:`,
							...reports
						],
						"\n\n"
					)
		}
	}
}

/** This process's watchdog, started the first time a case asks for it. */
const watchdogOfProcess = (): Watchdog => {
	globalThis.bjornpagenTestingWatchdog ??= isMainThread ? startedWatchdog() : offMainThread
	return globalThis.bjornpagenTestingWatchdog
}

/**
 * How long the main thread may go without answering the watchdog once a case in flight has passed the moment its
 * guard would have stopped it: watchdogGraceMillis, measured, whose evidence says why a case that
 * never yields ends its process here.
 */
export const WATCHDOG_GRACE_MILLIS = watchdogGraceMillis

/**
 * When a case's guard would stop it: its hang limit after it began, or its search's cut, the moment its deadline
 * leaves for reporting, whichever comes first.
 */
export type CaseLimits = Readonly<{ caseHang: Duration.Input; cut: Option.Option<number> }>

/**
 * `effect`, a case, watched by the process's watchdog for as long as it runs: should it hold the main thread without
 * yielding past the moment its guard would stop it (CaseLimits) and WATCHDOG_GRACE_MILLIS more, the process ends with
 * `report`, the case's hang verdict, on its stderr, since nothing on that thread can stop it. A case that yields is the
 * guard's to stop, and the watchdog never acts on it.
 */
export const watchedCase = <A, E, R>(
	limits: CaseLimits,
	report: () => string,
	effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> => {
	const hangMillis = Duration.toMillis(Duration.fromInputUnsafe(limits.caseHang))
	return Effect.acquireUseRelease(
		Effect.flatMap(liveMillis, (now) =>
			Effect.sync(() =>
				watchdogOfProcess().watch({
					hangsAt: Option.match(limits.cut, {
						onNone: () => now + hangMillis,
						onSome: (cut) => Math.min(now + hangMillis, cut)
					}),
					graceMillis: WATCHDOG_GRACE_MILLIS,
					report
				})
			)
		),
		() => effect,
		(release) => Effect.sync(release)
	)
}

/** The live clock's time in nanoseconds, whatever clock the caller runs under: a case's measured time reads it. */
export const liveNanos = Clock.currentTimeNanos.pipe(
	Effect.provideService(Clock.Clock, Clock.Clock.defaultValue())
)
