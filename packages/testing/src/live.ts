import { isMainThread, Worker } from "node:worker_threads"
import { Array as Arr, Clock, Duration, Effect, Fiber, Option, Record as Rec } from "effect"
import { stalledShareOfCpu } from "#runner/limits.ts"
import {
	type Bound,
	type Claim,
	checkedClaims,
	deadlineBound,
	enterWait,
	judgeOf,
	leaveWait,
	type Overrun,
	overrunText,
	ownCpu,
	ownWork,
	type Reading,
	readingOf,
	standingOf,
	TICK_MILLIS,
	type TreeWork
} from "#runner/work.ts"

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
export const watchdogGraceMillis = 5000

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

/** The live clock's time, read where no effect runs: a tracer's span as it opens (runner/case.ts spansOpenOver). */
export const liveMillisNow = (): number => Clock.Clock.defaultValue().currentTimeMillisUnsafe()

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
 * Where the watchdog's two threads meet in their shared memory: three Int32 counters (bumped when a case's moment comes
 * before the one the watchdog's thread will wake at; bumped at every sign of life of the main thread, a case's start or
 * end or an answer to a ping; one nothing writes, for the watchdog's thread to time a wait on), then, at the first
 * 8-byte boundary past them, two BigInt64 moments, whole milliseconds since the epoch, each read and written atomically
 * (the earliest moment a case in flight passes the moment its guard would stop it, and the moment the watchdog's thread
 * will next wake of itself; `never`, Number.MAX_SAFE_INTEGER, for none), and a BigInt64 count (the watchdog thread's own
 * CPU so far, in microseconds, as it states it after each turn: work.ts observer), then one Float64 (how long the
 * earliest case's thread then has to answer, in milliseconds).
 */
const LAYOUT = {
	generation: 0,
	progress: 1,
	timer: 2,
	counters: 3,
	earliest: 0,
	wakes: 1,
	observed: 2,
	stamps: 3,
	stampsOffset: 16,
	grace: 0,
	moments: 1,
	momentsOffset: 40,
	bytes: 48,
	never: Number.MAX_SAFE_INTEGER,
	stalledShare: stalledShareOfCpu,
	tickMillis: TICK_MILLIS
} as const

type Layout = typeof LAYOUT

/**
 * What the main thread answers the watchdog's thread when it asks through the inspector, which interrupts even a
 * synchronous loop: that a case in flight has passed the moment its guard would stop it, with the report of every case
 * in flight, since the watchdog cannot tell which one holds the thread; or that none has, so the thread watches on.
 */
type Answer = Readonly<{ kind: "blocked"; report: string }> | Readonly<{ kind: "running" }>

/**
 * What a main thread did over one grace of the watchdog's while it answered nothing: the CPU it spent, user and system
 * (`cpu`), its user CPU alone (`user`), and how long its cgroup's tasks stalled on memory meanwhile (`stall`, its
 * memory.pressure's `some` total, the share of the window in which at least one of them waited on memory), each in
 * milliseconds.
 */
export type Silence = Readonly<{ cpu: number; user: number; stall: number }>

/**
 * Whether a main thread that answered nothing over a window spent past `progress` in it, a hang (the watchdog's
 * `burned`): its CPU, where its cgroup did not stall on memory for `progress` of the window; its user CPU alone where it
 * did, since a task memory.high throttles, or makes reclaim in place, spends system time while it runs no JavaScript and
 * cannot answer, which read as a thread running without yielding. trunk@metis at d07c3409 (2026-11-22) lost two workers
 * so, ended as hangs 71 and 76 s into their cases with metis.slice at 78.7 of its 80 GiB memory.high, 192,570 times
 * throttled; both cases pass by their seeds once the slice was under its line. Its source is the watchdog's thread's
 * argument (watchdogThread), so it reads nothing but its arguments.
 */
export const hangOver = (silence: Silence, progress: number): boolean =>
	(silence.stall >= progress ? silence.user : silence.cpu) >= progress

/**
 * The watchdog's thread, evaluated from its source text in a worker of its own, so it reads no module of the library
 * and none a transform could rewrite, only Node's built-ins. It sleeps until the earliest moment a case in flight
 * passes the moment its guard would stop it; then it notes the main thread's progress, pings it by a message, and waits
 * that case's grace. The main thread makes progress at every case boundary, a case's start or end, which a run of
 * synchronous cases reaches without returning to its event loop, and on its event loop, where it answers the ping. A
 * main thread that made progress is alive, so the case's own guard reports it, and the thread sleeps on; so does one
 * that, though silent, no longer has a case in flight past its moment. Otherwise the main thread is running JavaScript
 * that never yields, a synchronous loop its guard cannot interrupt, since the guard's timer runs on the thread the loop
 * holds: the thread asks it, through the inspector, which interrupts even a synchronous loop, for its Answer, judged on
 * the main thread itself, whose cases cannot change while it is interrupted. A blocked answer is written to the
 * process's stderr, and the process is ended with SIGKILL, the one signal a blocked thread cannot hold; a running one
 * sends the thread back to sleep. A main thread whose inspector does not answer either, which still has made no progress
 * and has a case in flight past its moment, is judged by its own CPU over each grace more, as a guard judges a work
 * (runner/work.ts progressOver), never by the grace alone: one that spent past progress in it runs without answering, a
 * hang, and is ended with a report that says only that; one that spent nothing is waiting (a machine that pages it out
 * or starves it, a call that blocks it in the kernel) and is never ended for its silence, the pool judging its
 * process's tree by its work (pool.ts), so a live case under memory pressure is never killed for not answering (the
 * REDFIX2 deaths, 2026-11-20 21:10 to 21:20 UTC, memory pressure 63 to 74%).
 * Its open port keeps it alive; the main thread unrefs it. Its layout is its argument, written into its source text,
 * since the thread shares no module with the main thread.
 */
const watchdogThread = (layout: Layout, judge: typeof hangOver): void => {
	const threads = process.getBuiltinModule("node:worker_threads")
	const { Session } = process.getBuiltinModule("node:inspector")
	const { existsSync, readFileSync, writeSync } = process.getBuiltinModule("node:fs")
	const port = threads.parentPort
	if (port === null || !(threads.workerData instanceof SharedArrayBuffer)) {
		return
	}
	const shared: SharedArrayBuffer = threads.workerData
	const counters = new Int32Array(shared, 0, layout.counters)
	const stamps = new BigInt64Array(shared, layout.stampsOffset, layout.stamps)
	const moments = new Float64Array(shared, layout.momentsOffset, layout.moments)
	const nowMillis = () => performance.timeOrigin + performance.now()
	const earliestMoment = (): number => Number(Atomics.load(stamps, layout.earliest))
	/**
	 * Says when this thread will next wake of itself, `moment`, so a case whose moment comes sooner wakes it and any
	 * other lets it sleep: the main thread writes a case's moment and then reads this one, and this thread writes this
	 * one and then reads the earliest moment again, so of a case published as it says so one of the two sees the other.
	 * Gives the earliest moment as it stands once said.
	 */
	const wakesAt = (moment: number): number => {
		Atomics.store(stamps, layout.wakes, BigInt(Math.min(Math.ceil(moment), layout.never)))
		return earliestMoment()
	}
	/**
	 * States this thread's CPU so far, in microseconds, for the main thread to leave out of its cases' (work.ts ownCpu),
	 * each time the thread goes to sleep: whatever it spent since, its start among it, is stated before any case can read
	 * it, so no case's window opens on CPU of this thread's that a later reading leaves out (stated only after a turn,
	 * a planted case's windows read the thread's start, about 17 to 22 ms, as negative progress).
	 */
	const stateOwnCpu = (): void => {
		const spent = process.threadCpuUsage()
		Atomics.store(stamps, layout.observed, BigInt(spent.user + spent.system))
	}
	const after = (waited: ReturnType<typeof Atomics.waitAsync>, then: () => void): void => {
		stateOwnCpu()
		if (waited.async) {
			void waited.value.then(then)
		} else {
			void Promise.resolve().then(then)
		}
	}
	/**
	 * How long this thread has waited to run, in milliseconds: the second number of its /proc/thread-self/schedstat
	 * (the time it was runnable on a runqueue, in nanoseconds; work.ts SCHEDSTAT); none without /proc. A report states it,
	 * so a late end under load can be told from a watchdog that waited too long of itself.
	 */
	const waitedToRun = (): number => {
		const file = "/proc/thread-self/schedstat"
		if (!existsSync(file)) {
			return 0
		}
		const stat = readFileSync(file)
		const first = stat.indexOf(0x20)
		let nanos = 0
		for (let at = first + 1; at < stat.length; at += 1) {
			const byte = stat[at] ?? 0x20
			if (byte < 0x30 || byte > 0x39) {
				break
			}
			nanos = nanos * 10 + (byte - 0x30)
		}
		return nanos / 1_000_000
	}
	const end = (report: string): void => {
		writeSync(2, `\n${report}\nits watchdog waited ${waitedToRun().toFixed(0)} ms to run\n`)
		process.kill(process.pid, "SIGKILL")
	}
	const stillBlocked = (looked: number): boolean =>
		Atomics.load(counters, layout.progress) === looked && earliestMoment() <= nowMillis()
	/**
	 * The CPU the main thread has spent, in milliseconds, by its own /proc stat (its task's utime and stime, the 12th
	 * and 13th fields after its command's closing parenthesis, in clock ticks), and its user CPU alone; none without
	 * /proc.
	 */
	const mainTimes = (): Readonly<{ cpu: number; user: number }> => {
		const file = `/proc/self/task/${process.pid}/stat`
		if (!existsSync(file)) {
			return { cpu: Number.NaN, user: Number.NaN }
		}
		const stat = readFileSync(file)
		const fields: Array<number> = []
		let field = 0
		for (let at = stat.lastIndexOf(0x29) + 2; at <= stat.length; at += 1) {
			const byte = stat[at] ?? 0x20
			if (byte === 0x20) {
				fields.push(field)
				field = 0
			} else {
				field = field * 10 + (byte - 0x30)
			}
		}
		const user = (fields[11] ?? 0) * layout.tickMillis
		return { cpu: user + (fields[12] ?? 0) * layout.tickMillis, user }
	}
	/**
	 * How long this process's cgroup's tasks have stalled on memory, in milliseconds: the `some` line's total (in
	 * microseconds) of the memory.pressure file of the cgroup /proc/self/cgroup names (cgroup v2's one line, `0::<path>`);
	 * none read as no stall, where the cgroup or pressure stall information is absent.
	 */
	const memoryStall = (): number => {
		const membership = "/proc/self/cgroup"
		if (!existsSync(membership)) {
			return 0
		}
		const cgroups = readFileSync(membership)
		const at = cgroups.indexOf("0::")
		if (at < 0) {
			return 0
		}
		const lineEnd = cgroups.indexOf(0x0a, at)
		const pressure = `/sys/fs/cgroup${cgroups.toString("utf8", at + 3, lineEnd < 0 ? cgroups.length : lineEnd)}/memory.pressure`
		if (!existsSync(pressure)) {
			return 0
		}
		const stalls = readFileSync(pressure)
		const some = stalls.indexOf("some ")
		const total = some < 0 ? -1 : stalls.indexOf("total=", some)
		if (total < 0) {
			return 0
		}
		let micros = 0
		for (let index = total + 6; index < stalls.length; index += 1) {
			const byte = stalls[index] ?? 0x20
			if (byte < 0x30 || byte > 0x39) {
				break
			}
			micros = micros * 10 + (byte - 0x30)
		}
		return micros / 1000
	}
	/** The main thread's CPU and its cgroup's memory stall now, a silence's start. */
	const reading = (): Silence => ({ ...mainTimes(), stall: memoryStall() })
	/**
	 * Whether the main thread spent past progress over a window of `windowMillis` since `since` (work.ts progressOver),
	 * as hangOver judges it beside its cgroup's memory stall.
	 */
	const burned = (since: Silence, windowMillis: number): boolean => {
		const now = reading()
		return judge(
			{ cpu: now.cpu - since.cpu, user: now.user - since.user, stall: now.stall - since.stall },
			Math.max(windowMillis * layout.stalledShare, layout.tickMillis)
		)
	}
	const unanswered =
		"@bjornpagen/testing: a case held its process's main thread without yielding past the moment its guard would stop it, and the thread's inspector did not answer for its report; the watchdog ended the process: a hang"
	const blocked = (looked: number, graceMillis: number): void => {
		const session = new Session()
		session.connectToMainThread()
		let pending = true
		const settle = (then: () => void): void => {
			if (pending) {
				pending = false
				then()
			}
		}
		session.post(
			"Runtime.evaluate",
			{ expression: "globalThis.bjornpagenTestingWatchdog?.answer()", returnByValue: true },
			(error, evaluated) => {
				const answer: unknown = error === null ? evaluated.result.value : undefined
				settle(() => {
					if (typeof answer === "object" && answer !== null && "kind" in answer) {
						if (answer.kind === "running") {
							session.disconnect()
							rest(graceMillis)
							return
						}
						if ("report" in answer && typeof answer.report === "string") {
							end(answer.report)
							return
						}
					}
					end(unanswered)
				})
			}
		)
		const silent = (since: Silence): void =>
			after(Atomics.waitAsync(counters, layout.timer, 0, graceMillis), () => {
				if (!pending) {
					return
				}
				if (!stillBlocked(looked)) {
					settle(() => {
						session.disconnect()
						rest(graceMillis)
					})
					return
				}
				if (burned(since, graceMillis)) {
					settle(() => end(unanswered))
					return
				}
				silent(reading())
			})
		silent(reading())
	}
	const watch = (): void => {
		const looked = Atomics.load(counters, layout.progress)
		const generation = Atomics.load(counters, layout.generation)
		const hangsAt = earliestMoment()
		if (wakesAt(hangsAt) !== hangsAt) {
			watch()
			return
		}
		const graceMillis = moments[layout.grace] ?? 0
		const waitMillis = hangsAt >= layout.never ? Number.POSITIVE_INFINITY : hangsAt - nowMillis()
		if (waitMillis > 0) {
			after(Atomics.waitAsync(counters, layout.generation, generation, waitMillis), watch)
			return
		}
		port.postMessage(looked)
		after(Atomics.waitAsync(counters, layout.timer, 0, graceMillis), () => {
			if (stillBlocked(looked)) {
				blocked(looked, graceMillis)
				return
			}
			rest(graceMillis)
		})
	}
	const rest = (graceMillis: number): void => {
		const generation = Atomics.load(counters, layout.generation)
		wakesAt(nowMillis() + graceMillis)
		after(Atomics.waitAsync(counters, layout.generation, generation, graceMillis), watch)
	}
	port.on("message", () => undefined)
	watch()
}

/** A case the watchdog watches: when it passes the moment its guard would first judge it, how long the thread then has
 * to answer, its report should it block, and whether, read at a moment, its work is over its deadline (runner/work.ts:
 * spent in CPU, or stalled over a whole deadline of wall time), so a case the machine slows is never ended for it. */
type Watched = Readonly<{
	hangsAt: number
	graceMillis: number
	report: () => string
	judged: (now: number) => Option.Option<string>
}>

/**
 * What the main thread answers the watchdog at `now`, with `inFlight` its cases in flight: blocked, with the report of
 * every case in flight, when one of them has passed the moment its guard would first judge it and its work is over its
 * deadline, each such case's report naming the leg its guard read and what it measured (its CPU spent, or its CPU and
 * its stir over a whole window: runner/work.ts overrunText), so a hang under load says whether the case spent its
 * deadline or stood still (UNITREDS, 2026-11-21: bound-identity ended under trunk's load with neither said); running
 * when none is, so a thread that was merely slow to answer (a machine that pages it out or starves
 * it), between cases, or in a case whose work still moves within its deadline, is never ended.
 */
export const answerOf = (inFlight: ReadonlyArray<Watched>, now: number): Answer => {
	const judged = Arr.map(inFlight, (watched) => ({
		watched,
		over: watched.hangsAt <= now ? watched.judged(now) : Option.none<string>()
	}))
	if (!Arr.some(judged, (one) => Option.isSome(one.over))) {
		return { kind: "running" }
	}
	const reports = Arr.map(judged, ({ watched, over }) =>
		Option.match(over, {
			onNone: () => watched.report(),
			onSome: (leg) => `${watched.report()}\nits guard read: ${leg}`
		})
	)
	return {
		kind: "blocked",
		report:
			reports.length === 1
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

/**
 * This process's watchdog of its main thread, for the hangs a case's own guard cannot stop: a case that loops
 * synchronously holds the thread its guard's timer would run on. `watch` registers a case in flight and returns its
 * release; `answer` is what the main thread tells the watchdog's thread that asks it, interrupted, whether it is
 * blocked; `wakes` is when the watchdog's thread will next wake of itself, as it last said, none until it first says and
 * while it waits for a case to wake it; `observed` is the CPU this process has spent observing its cases, in
 * microseconds, the watchdog thread's as it states it before each sleep and the main thread's in every reading of a
 * case's work (work.ts ownWork, whether a guard's timer or the watchdog's answer reads it), which `observing` adds and
 * work.ts ownCpu leaves out of every case's. A process whose tests run off its main thread, in a worker, has none: its watch does nothing, and only
 * the guard's timer stops a case.
 */
type Watchdog = Readonly<{
	watch: (watched: Watched) => () => void
	answer: () => Answer
	wakes: () => Option.Option<number>
	observed: () => number
	observing: (micros: number) => void
}>

declare global {
	var bjornpagenTestingWatchdog: Watchdog | undefined
}

/** The watchdog of a process whose tests do not run on its main thread: it watches nothing. */
const offMainThread: Watchdog = {
	watch: () => () => undefined,
	answer: () => ({ kind: "running" }),
	wakes: () => Option.none(),
	observed: () => 0,
	observing: () => undefined
}

/**
 * Starts this process's watchdog: its thread, its shared memory, and the cases it watches. The main thread publishes
 * its cases' earliest moment before it counts the boundary as progress, so a thread that saw the progress before a
 * case's end also sees the moment that end left.
 */
const startedWatchdog = (): Watchdog => {
	const shared = new SharedArrayBuffer(LAYOUT.bytes)
	const counters = new Int32Array(shared, 0, LAYOUT.counters)
	const stamps = new BigInt64Array(shared, LAYOUT.stampsOffset, LAYOUT.stamps)
	const moments = new Float64Array(shared, LAYOUT.momentsOffset, LAYOUT.moments)
	Atomics.store(stamps, LAYOUT.earliest, BigInt(LAYOUT.never))
	Atomics.store(stamps, LAYOUT.wakes, BigInt(LAYOUT.never))
	const layout = `{ ${Arr.join(
		Arr.map(Rec.toEntries(LAYOUT), ([name, at]) => `${name}: ${at}`),
		", "
	)} }`
	const worker = new Worker(`(${watchdogThread.toString()})(${layout}, ${hangOver.toString()})`, {
		eval: true,
		workerData: shared
	})
	const progressed = () => {
		Atomics.add(counters, LAYOUT.progress, 1)
	}
	worker.on("message", progressed)
	worker.unref()
	let reading = 0
	const inFlight = new Map<number, Watched>()
	let watched = 0
	const publish = () => {
		const earliest = Arr.reduce(
			Arr.fromIterable(inFlight.values()),
			{ hangsAt: Number.POSITIVE_INFINITY, graceMillis: 0 },
			(first, watch) => (watch.hangsAt < first.hangsAt ? watch : first)
		)
		const moment = Math.min(Math.ceil(earliest.hangsAt), LAYOUT.never)
		moments[LAYOUT.grace] = earliest.graceMillis
		Atomics.store(stamps, LAYOUT.earliest, BigInt(moment))
		if (moment < Number(Atomics.load(stamps, LAYOUT.wakes))) {
			Atomics.add(counters, LAYOUT.generation, 1)
			Atomics.notify(counters, LAYOUT.generation)
		}
		progressed()
	}
	return {
		watch: (watch) => {
			watched += 1
			const id = watched
			inFlight.set(id, watch)
			publish()
			return () => {
				inFlight.delete(id)
				publish()
			}
		},
		answer: () =>
			answerOf(Arr.fromIterable(inFlight.values()), performance.timeOrigin + performance.now()),
		observed: () => Number(Atomics.load(stamps, LAYOUT.observed)) + reading,
		observing: (micros) => {
			reading += micros
		},
		wakes: () =>
			Option.filter(
				Option.some(Number(Atomics.load(stamps, LAYOUT.wakes))),
				(moment) => moment < LAYOUT.never
			)
	}
}

/** This process's watchdog, started the first time a case asks for it. */
const watchdogOfProcess = (): Watchdog => {
	globalThis.bjornpagenTestingWatchdog ??= isMainThread ? startedWatchdog() : offMainThread
	return globalThis.bjornpagenTestingWatchdog
}

/**
 * When this process's watchdog thread will next wake of itself, in milliseconds since the epoch, as it last said: none
 * before a case started the watchdog or before its thread first said, and none while the thread waits for a case to
 * wake it. A case whose moment comes before it wakes the thread; any other leaves it asleep. Reading it starts no
 * watchdog. The watchdog's property (blocking.test.ts) reads it to start its runaway only once the thread sleeps until a
 * later moment of its own, the situation in which only that wake-up ends the runaway in time.
 */
export const watchdogWakes: Effect.Effect<Option.Option<number>> = Effect.sync(() =>
	Option.flatMap(Option.fromUndefinedOr(globalThis.bjornpagenTestingWatchdog), (watchdog) =>
		watchdog.wakes()
	)
)

/**
 * When a case's guard would stop it: its hang limit after it began, or its search's cut, the moment its deadline
 * leaves for reporting, whichever comes first.
 */
export type CaseLimits = Readonly<{ caseHang: Duration.Input; cut: Option.Option<number> }>

/**
 * `effect`, a case, watched by the process's watchdog for as long as it runs: should it hold the main thread without
 * yielding past the moment its guard would first judge it (CaseLimits) and watchdogGraceMillis more, with its work
 * over its hang limit (its CPU spent, or not moving over a whole hang limit of wall time: runner/work.ts) or its
 * search's cut reached, the process ends with `report`, the case's hang verdict, on its stderr, since nothing on that
 * thread can stop it. A case that yields is the guard's to stop, and the watchdog never acts on it.
 */
export const watchedCase = <A, E, R>(
	limits: CaseLimits,
	report: () => string,
	effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> => {
	const hangMillis = Duration.toMillis(Duration.fromInputUnsafe(limits.caseHang))
	return Effect.acquireUseRelease(
		Effect.flatMap(liveMillis, (now) =>
			Effect.sync(() => {
				const judge = judgeOf(ownWork(now, ownCpu()), deadlineBound(hangMillis))
				const cutText = (cut: number) =>
					`its search's cut, the moment its deadline leaves for reporting, came ${Math.round(Math.max(0, cut - now))} ms after it began`
				return watchdogOfProcess().watch({
					hangsAt: Option.match(limits.cut, {
						onNone: () => now + hangMillis,
						onSome: (cut) => Math.min(now + hangMillis, cut)
					}),
					graceMillis: watchdogGraceMillis,
					report,
					judged: (at) =>
						Option.match(
							Option.filter(limits.cut, (cut) => at >= cut),
							{
								onSome: (cut) => Option.some(cutText(cut)),
								onNone: () => Option.map(judge(at), overrunText)
							}
						)
				})
			})
		),
		() => effect,
		(release) => Effect.sync(release)
	)
}

/** The live clock's time in nanoseconds, whatever clock the caller runs under: a case's measured time reads it. */
export const liveNanos = Clock.currentTimeNanos.pipe(
	Effect.provideService(Clock.Clock, Clock.Clock.defaultValue())
)

/**
 * `effect` as a declared wait of this process on work other processes do, named by what it waits on, `on` (runner/work.ts
 * Waits): a wait whose doers name no holder this process can read (a template's build lock, PostgreSQL's work behind a
 * statement), and whose wall time no guard's stall leg counts, from before it starts to after it ends, however it ends;
 * a verdict on the case while it is open names it (runner/work.ts waitedOnNow).
 */
export const waitingOn = (on: string) => declared(on, { kind: "trusted" })

/**
 * `effect` as a declared wait on a server's work, whose claim a guard checks (runner/work.ts Claim, checkedClaims): at
 * each reading of a guard's while it is open, `working` asks the server whether it works on it, and a wait it answers
 * no for closes then, so the wall time after it counts toward the stall as the silence it is. A statement waits so
 * (pg/session.ts): its backend working (active, behind a lock or an LWLock, in I/O, behind a checkpoint) is the member's
 * work, and a backend idle while its client still awaits the answer (a promise that never settles, a backend gone) is
 * not, which a claim alone would hide from every guard of the process for good.
 */
export const waitingOnWork = (on: string, working: Effect.Effect<boolean>) =>
	declared(on, { kind: "checked", working })

/** `effect` as a declared wait on `on`, claiming `claim`, open from before it starts to after it ends, however it ends. */
const declared =
	(on: string, claim: Claim) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
		Effect.acquireUseRelease(
			Effect.flatMap(liveMillis, (wall) => Effect.sync(() => enterWait(wall, on, claim))),
			() => effect,
			(id) => Effect.flatMap(liveMillis, (wall) => Effect.sync(() => leaveWait(wall, id)))
		)

/**
 * Ends once `work` has spent its bound's CPU or its CPU has not moved over a whole stall window of wall time outside its
 * declared waits (runner/work.ts standingOf), with the leg that fired and what it measured (Overrun). It reads the work
 * only when its live-clock timer fires, at a window's end or when the CPU left could run out sooner, so work that ends
 * in time pays one timer and no reading.
 */
export const overrun = (work: TreeWork, bound: Bound): Effect.Effect<Overrun> => {
	const watch = (window: Reading, readAt: number): Effect.Effect<Overrun> =>
		Effect.flatMap(
			Effect.andThen(liveSleepUntil(readAt), Effect.tap(liveMillis, checkedClaims)),
			(wall) => {
				const standing = standingOf({
					began: work.began,
					window,
					now: readingOf(work, wall),
					bound
				})
				return standing.kind === "working"
					? watch(standing.window, standing.readAgainAt)
					: Effect.succeed(standing)
			}
		)
	return watch(work.began, work.began.wall + Math.min(bound.cpu, bound.stall))
}
