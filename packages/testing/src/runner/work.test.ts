/**
 * A case's deadline is a budget of its own work (runner/work.ts, case.ts guarded), held over inner searches run in this
 * process (search.fixtures.ts, work.fixtures.ts):
 *
 * - A case the machine slows is not hung: its CPU comes in bursts between stalls on the live clock, its wall time runs
 *   past its deadline, its CPU stays a tenth of it and moves in every deadline's window, and it passes.
 * - A case's work counts its live children's CPU: while a working child is alive and unreaped, the tree's CPU since the
 *   work began holds what the child says it spent, to Linux's clock tick.
 * - A child started before a work began is no part of it, however late its process's Node began after the kernel
 *   started the process: the work's beginning and a process's start are read on one clock, the boot clock.
 * - A CPU runaway is hung at its deadline: it yields as it spends many deadlines of CPU, so only the CPU budget stops
 *   it, and it is hung, never passed.
 * - A deadlocked case is hung after one deadline of wall time: it waits on the live clock for many deadlines, spending
 *   nothing, and it is hung, never passed.
 * - A case whose wait is a declared one (live.ts waitingOn), a wait on a resource other processes hold, is never hung
 *   for it: the same wait as the deadlocked case's, declared, passes.
 * - A deadlocked case is hung though its tree holds a child that wakes on a timer: the child's wake-ups spend a little
 *   CPU and wait a little to run, short of progress, so the wait is a stall still.
 * - A wait to run is never progress: it is time the work could not run, taken out of its window, so a thread that only
 *   waits is stalled however long its wake-ups wait to run, and one the machine starves for all its window never is.
 * - Work judged outside a run's cases (live.ts withinBound) is judged as a case is: a runaway is ended by its CPU
 *   budget, spent, and a deadlocked wait by its stall window, stalled, named with the step it stood in; work that ends
 *   in time gives its outcome, and the CPU it spent reads at least what it burned (live.ts spentOn).
 *
 * Each inner case ends of itself well past its deadline (its search explores), so a guard that misjudges it lets it
 * pass.
 *
 * Budget: each property's space is a few shapes, exhausted, each one inner search of a case or two; the slow shapes
 * take four to five seconds of wall time apiece, almost none of it CPU.
 *
 * Oracles are stated per property.
 */
import { Array as Arr, Effect, Option, Result } from "effect"
import { assert } from "#assert.ts"
import type { Reached } from "#features.ts"
import { finite } from "#gen.ts"
import { boundOver, spentOn, withinBound } from "#live.ts"
import { Checkout } from "#mutate/checkout.ts"
import { property } from "#property.ts"
import { searchedAt, verdictKind } from "#runner/search.fixtures.ts"
import {
	childBurns,
	childStir,
	storedSizes,
	childSeen,
	deadlockedCase,
	deadlocks,
	INNER_SEED,
	innerRun,
	lastSeenAt,
	lateSeen,
	lateStarts,
	liveAt,
	livesGen,
	OUTSIDE_STEP,
	otherMoves,
	outsides,
	outsideWork,
	runawayCase,
	runaways,
	SLOW_DEADLINE,
	slowCase,
	slowShapes,
	STATED_CPU_SHORTFALL_MILLIS,
	storageDirectory,
	waitingCase,
	waitingThreads,
	waitingWindowOf,
	wakingCase,
	windowOf
} from "#runner/work.fixtures.ts"
import {
	noStirLedger,
	progressOver,
	type StirLedger,
	standingOf,
	stirLedgerAfter,
	stirOfLedger
} from "#runner/work.ts"

export const slowIsNotHung = property.exhaust(finite(slowShapes), {
	box: "a slow case's bursts of CPU and stalls on the live clock, three shapes past a 3,000 ms deadline in wall time",
	needs: {},
	situations: [],
	check: () => (shape) =>
		Effect.gen(function* () {
			const verdict = yield* searchedAt(
				slowCase(shape),
				innerRun("work/slow", INNER_SEED, SLOW_DEADLINE)
			)
			assert.equal(verdictKind(verdict), "explored")
		}),
	oracle: {
		kind: "specification",
		name: "a case whose CPU moves in every window of its deadline and stays within it is never hung, however long the machine stretches its wall time"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/work.ts",
			original: "\tif (whole && moved < progress && !storedBetween(window, now)) {",
			replacement: "\tif (whole) {",
			why: "A case is hung once a deadline of wall time passes, as the live clock's old deadline judged it: the slow case, whose CPU moves and stays a tenth of its deadline, is hung; the slow-case property fails."
		}
	]
})

export const childWorkCounts = property.exhaust(finite(childBurns), {
	box: "a working child's CPU before it says so, three amounts from 40 to 120 ms",
	needs: {},
	situations: [],
	check: () => (burnMillis) =>
		Effect.gen(function* () {
			const seen = yield* childSeen(burnMillis)
			assert.equal(seen.treeCpu >= seen.childCpu - STATED_CPU_SHORTFALL_MILLIS, true)
		}),
	oracle: {
		kind: "specification",
		name: "a case's work counts its live children's CPU: the tree's CPU since the work began holds a live child's, to the tick Linux rounds each of its user and system CPU down to"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/work.ts",
			original:
				"\t\t\treturn { cpu: cpu + descendants.cpu + served.cpu, stir, carried: served.carried }\n",
			replacement: "\t\t\treturn { cpu: cpu + served.cpu, stir, carried: served.carried }\n",
			why: "A live child's CPU is left out until the child is reaped, so a case that waits on a working child spends nothing of its own and is stalled after a window; the child-work property fails."
		}
	]
})

export const anEarlierChildIsNoneOfTheWork = property.exhaust(finite(lateStarts), {
	box: "a child started a twentieth of a second before a work began, in a process whose Node began two or four seconds after the kernel started it",
	needs: { checkout: Checkout.dir },
	situations: [],
	check: () => (delaySeconds) =>
		Effect.gen(function* () {
			const seen = yield* lateSeen(delaySeconds)
			assert.deepEqual(
				{
					excess:
						seen.excess <= 0
							? "none of the child's CPU"
							: `${String(seen.excess)} ms of the child's ${String(seen.childCpu)} ms`
				},
				{ excess: "none of the child's CPU" }
			)
		}),
	oracle: {
		kind: "specification",
		name: "a work counts the descendants started since it began, on the boot clock a process's start is stated in: a child that slept and said so before the work began is no part of it, so the work's CPU passes the process's own by none, however late the process's Node began"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/work.ts",
			original: '\tconst self = statOf("self")\n\tconst since = bootMillisNow()\n',
			replacement:
				'\tconst self = statOf("self")\n\tconst since = Option.map(self, (field) => field(PROC.started) + (wall - performance.timeOrigin))\n',
			why: "The work's beginning placed on the boot clock through the process's time origin lands as early as its Node began late, so a child started before the work counts all of its CPU as the work's; the property fails."
		}
	]
})

export const runawayIsHung = property.exhaust(finite(runaways), {
	box: "a runaway's deadline and how many deadlines of CPU it would spend, two shapes",
	needs: {},
	situations: [],
	check: () => (shape) =>
		Effect.gen(function* () {
			const verdict = yield* searchedAt(
				runawayCase(shape),
				innerRun("work/runaway", INNER_SEED, shape.deadline)
			)
			assert.equal(verdictKind(verdict), "hung")
		}),
	oracle: {
		kind: "specification",
		name: "a case whose process tree spends its deadline in CPU is hung, however much it yields"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/work.ts",
			original: "\tif (spent >= bound.cpu) {",
			replacement: "\tif (spent >= bound.cpu * 1000) {",
			why: "The CPU budget is never reached: a runaway that yields moves its CPU in every window and is never stalled, so it runs to its end and passes; the runaway property fails."
		}
	]
})

export const deadlockIsHung = property.exhaust(finite(deadlocks), {
	box: "a deadlocked case's deadline and how many deadlines it waits, two shapes",
	needs: {},
	situations: [],
	check: () => (shape) =>
		Effect.gen(function* () {
			const verdict = yield* searchedAt(
				deadlockedCase(shape),
				innerRun("work/deadlock", INNER_SEED, shape.deadline)
			)
			assert.equal(verdictKind(verdict), "hung")
		}),
	oracle: {
		kind: "specification",
		name: "a case whose process tree's CPU does not move over a whole deadline of wall time is hung"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/work.ts",
			original: "\tif (whole && moved < progress && !storedBetween(window, now)) {",
			replacement: "\tif (whole && moved < 0) {",
			why: "No window is ever stalled: a case that waits spends nothing and never reaches its CPU budget, so it waits to its end and passes; the deadlock property fails."
		}
	]
})

export const declaredWaitIsNoStall = property.exhaust(finite(deadlocks), {
	box: "a deadlocked case's wait, declared, under each deadline",
	needs: {},
	situations: [],
	check: () => (shape) =>
		Effect.gen(function* () {
			const verdict = yield* searchedAt(
				waitingCase(shape),
				innerRun("work/waiting", INNER_SEED, shape.deadline)
			)
			assert.equal(verdictKind(verdict), "explored")
		}),
	oracle: {
		kind: "specification",
		name: "a case that spends a whole deadline of wall time and more in a declared wait, spending nothing, is not hung"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/work.ts",
			original: "\tconst waited = now.waited - window.waited\n",
			replacement: "\tconst waited = 0\n",
			why: "A declared wait counted as a stall, as every wait was before (SELECTWHOLE's thirteen: a lease wait judged stalled), so the waiting case is hung; the property fails."
		},
		{
			file: "packages/testing/src/live.ts",
			original:
				"\t\t\tEffect.flatMap(liveMillis, (wall) => Effect.sync(() => enterWait(wall, on))),\n\t\t\t() => effect,\n\t\t\t(id) => Effect.flatMap(liveMillis, (wall) => Effect.sync(() => leaveWait(wall, id)))",
			replacement: "\t\t\tEffect.succeed(0),\n\t\t\t() => effect,\n\t\t\t() => Effect.void",
			why: "waitingOn declares nothing, so a declared wait's wall time is a stall after all; the property fails."
		}
	]
})

export const othersMoveTheWork = property.exhaust(finite(otherMoves), {
	box: "a window of two deadlines of a work whose CPU did not move, in which nothing else moved, a child woke and waited to run a little, a thread waited to run for progress and slept the rest, a child waited to run all the window, a child did the least storage work, or a holder of the lock its backend waits behind spent progress of CPU, or a tick short of it",
	needs: {},
	situations: [],
	check: () => (move) =>
		Effect.sync(() => {
			const standing = standingOf({ began: windowOf(move).window, ...windowOf(move) })
			assert.equal(
				standing.kind,
				move === "a child waited to run all the window" ||
					move === "a child stored" ||
					move === "a holder of its backend's lock worked"
					? "working"
					: "stalled"
			)
		}),
	oracle: {
		kind: "specification",
		name: "a window is stalled when a whole deadline of time the work could have run (its wall time outside declared waits, less its processes' waits to run) passed with its CPU, and the CPU carrying its backends' waits (runner/backends.ts), short of progress and none of its processes doing storage work: a wait to run is never a move, so a thread that waited to run for progress and slept the rest is stalled, a child starved for all the window leaves no time it could have run, so it is working, and a backend behind a lock whose holder spent progress is working"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/work.ts",
			original: "\tif (whole && moved < progress && !storedBetween(window, now)) {",
			replacement: "\tif (whole && moved < progress) {",
			why: "The guard reads CPU alone in its window: a child blocked on storage or swap is no move, so a wait behind it is stalled (land #4's contended red, 2026-11-20, load 230 to 330, memory pressure full near 20%); the property fails on the child that stored."
		},
		{
			file: "packages/testing/src/runner/work.ts",
			original: "\tif (whole && moved < progress && !storedBetween(window, now)) {",
			replacement:
				"\tif (whole && moved < progress && !(queued > 0) && !storedBetween(window, now)) {",
			why: "A runqueue wait of any length counts as a move, as it did: a child that only woke and waited a little reads as working, so a case whose tree holds an idle process that wakes now and then is never hung (workersLeaveNoChild's kill trials ran for an hour and more, 2026-11-21); the property fails."
		},
		{
			file: "packages/testing/src/runner/work.ts",
			original:
				"const storedBetween = (before: Reading, after: Reading): boolean =>\n\tafter.stir.stored > before.stir.stored\n",
			replacement:
				"const storedBetween = (before: Reading, after: Reading): boolean =>\n\tafter.stir.stored > before.stir.stored + 1\n",
			why: "Storage work counts only past a threshold, so the least a counter moves, which a process paging in under swap may move by in a window, is none; the property fails."
		},
		{
			file: "packages/testing/src/runner/work.ts",
			original: "\tif (whole && moved < progress && !storedBetween(window, now)) {",
			replacement: "\tif (whole && moved + queued < progress && !storedBetween(window, now)) {",
			why: "A wait to run counts as progress, as it did: a thread whose wake-ups waited to run for progress reads as working, so the watchdog's planted thread that waits a second at a time was never ended under trunk@toolchain's load (floor case 2 of seed 0xa5b59f36, 2026-11-22); the property fails on that thread."
		},
		{
			file: "packages/testing/src/runner/work.ts",
			original: "\tconst moved = now.cpu + now.carried - (window.cpu + window.carried)\n",
			replacement: "\tconst moved = now.cpu - window.cpu\n",
			why: "The CPU carrying a backend's wait is no move, as a statement was its client's silence: a case whose statement waits behind a lock another session holds while it works is stalled, as RECORDS-ATTACH's live cases were judged hung behind SSI waits (2026-11-21: 25 ms of CPU over 60 s); the property fails on the holder that worked."
		},
		{
			file: "packages/testing/src/runner/work.ts",
			original: "\tconst over = now.wall - window.wall - waited - queued\n",
			replacement: "\tconst over = now.wall - window.wall - waited\n",
			why: "A wait to run is not taken out of the window's time, so a child the machine starves for all the window, which could not run at all, has a whole window that spent nothing, and is stalled; the property fails on the starved child."
		}
	]
})

type WaitingFeature =
	| "a thread that waited to run past progress"
	| "a thread that waited to run short of progress"
	| "a thread the machine starved"

export const waitingToRunIsNoProgress = property.explore(waitingThreads, {
	needs: {},
	situations: [
		"a thread that waited to run past progress",
		"a thread that waited to run short of progress",
		"a thread the machine starved"
	] satisfies ReadonlyArray<Reached<WaitingFeature>>,
	check: (_, c) => (thread) =>
		Effect.sync(() => {
			const { window, now, bound } = waitingWindowOf(thread)
			const standing = standingOf({ began: window, window, now, bound })
			if (thread.starved) {
				c.note("a thread the machine starved")
				assert.equal(
					standing.kind,
					"working",
					"a thread kept from running all its window is never stalled"
				)
				return
			}
			c.note(
				thread.queued >= progressOver(thread.deadline)
					? "a thread that waited to run past progress"
					: "a thread that waited to run short of progress"
			)
			assert.equal(standing.kind, "stalled", "a thread that only waits reads as not progressing")
		}),
	oracle: {
		kind: "specification",
		name: "a thread that only waits, its CPU short of progress, is stalled once a whole deadline of time it could have run has passed, however long its wake-ups waited to run under a run-queue delay; one the machine kept from running for all its window outside declared waits never is (grizzle, 2026-11-22: a wait to run is never progress)"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/work.ts",
			original: "\tif (whole && moved < progress && !storedBetween(window, now)) {",
			replacement: "\tif (whole && moved + queued < progress && !storedBetween(window, now)) {",
			why: "A wait to run counts as progress, as it did: a thread whose wake-ups waited to run for progress under load reads as working however long it only waits (blocking.test.ts#watchdog's floor case 2, its worker lost at e7f90259 and 86060d1d, 2026-11-22); the property fails on a thread that waited to run past progress."
		},
		{
			file: "packages/testing/src/runner/work.ts",
			original: "\tconst over = now.wall - window.wall - waited - queued\n",
			replacement: "\tconst over = now.wall - window.wall - waited\n",
			why: "A wait to run is not taken out of the window's time, so a thread the machine starved has a whole window in which it spent nothing, and is stalled though it could not run (the starved app servers of trunk@metis's browser runs, 86 to 96 s of 95 on the run queue, 2026-11-22); the property fails on the starved thread."
		}
	]
})

export const wakingTreeIsHung = property.exhaust(finite(deadlocks), {
	box: "a deadlocked case holding a child that wakes on a timer, under each deadline",
	needs: {},
	situations: [],
	check: () => (shape) =>
		Effect.gen(function* () {
			const verdict = yield* searchedAt(
				wakingCase(shape),
				innerRun("work/waking", INNER_SEED, shape.deadline)
			)
			assert.equal(verdictKind(verdict), "hung")
		}),
	oracle: {
		kind: "specification",
		name: "a case that waits on something that does not come is hung though its tree holds a process that wakes now and then, its wake-ups' CPU and runqueue waits short of progress"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/work.ts",
			original: "\tif (whole && moved < progress && !storedBetween(window, now)) {",
			replacement:
				"\tif (whole && moved < progress && !(queued > 0) && !storedBetween(window, now)) {",
			why: "A runqueue wait of any length counts as a move, as it did: the waking child's little waits keep every window working, so the case waits to its end and passes, as workersLeaveNoChild's kill trials waited for an hour and more (2026-11-21); the property fails."
		}
	]
})

export const othersStirRead = property.exhaust(finite(storedSizes), {
	box: "a child that writes a quarter of a mebibyte or a whole one and syncs it to storage, alive",
	needs: {},
	situations: [],
	check: () => (bytes) =>
		Effect.scoped(
			Effect.gen(function* () {
				const directory = yield* storageDirectory
				const stir = yield* childStir(directory, bytes)
				assert.deepEqual(
					{ stored: stir.stored >= bytes, queued: stir.queued >= 0 },
					{ stored: true, queued: true }
				)
			})
		),
	oracle: {
		kind: "specification",
		name: "a live process's stir reads its storage work and its runqueue wait from /proc: a child that synced some bytes to storage has stored them at least, and its wait to run is a count of milliseconds"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/work.ts",
			original:
				"\t\t\t\treturn name === SCHEDSTAT.read || name === SCHEDSTAT.written ? total + Number(value) : total\n",
			replacement: "\t\t\t\treturn total\n",
			why: "A process's storage work is read as none, so a child or holder blocked on storage or swap is no move, and a wait behind it is stalled; the property fails."
		}
	]
})

type LedgerFeature = "a process ended between readings" | "a process started between readings"

export const treeStirOnlyGrows = property.explore(livesGen, {
	needs: {},
	situations: [
		"a process ended between readings",
		"a process started between readings"
	] satisfies ReadonlyArray<Reached<LedgerFeature>>,
	check: (_, c) => (lives) =>
		Effect.sync(() => {
			if (Arr.some(lives.processes, (process) => process.end < lives.readings)) {
				c.note("a process ended between readings")
			}
			if (Arr.some(lives.processes, (process) => process.start > 0)) {
				c.note("a process started between readings")
			}
			Arr.reduce(
				Array.from({ length: lives.readings }, (_slot, at) => at),
				noStirLedger,
				(ledger: StirLedger, at) => {
					const after = stirLedgerAfter(ledger, liveAt(lives, at))
					assert.deepEqual(
						stirOfLedger(after),
						lastSeenAt(lives, at),
						`the tree's stir at reading ${String(at)} is every process's last seen, ended ones' included`
					)
					return after
				}
			)
		}),
	oracle: {
		kind: "specification",
		name: "a tree's runqueue wait and storage work are each process's at its last reading, summed, whether it still lives or has ended, so they only grow as /proc forgets an ended process (trunk@metis at a53810cd, 2026-11-22: level-template opens judged stalled with 40 and 68 s of CPU moved, their trees' waits read as -416 s and -216 s)"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/work.ts",
			original: "\t\t\t(total, [, stir]) => stirPlus(total, stir)\n",
			replacement: "\t\t\t(total) => total\n",
			why: "An ended process's stir leaves its tree's with it, as it did: a window in which a busy child ends reads a negative runqueue wait, which cancels its tree's CPU, so a need whose child ends inside its window is judged stalled though it worked (trunk@metis at a53810cd, 2026-11-22); the property fails."
		}
	]
})

export const boundedOutsideACase = property.exhaust(finite(outsides), {
	box: "two runaways, two deadlocked waits and work that ends, each under a bound of its deadline",
	needs: {},
	situations: [],
	check: () => (shape) =>
		Effect.gen(function* () {
			const { work, deadline } = outsideWork(shape)
			const [ended, spent] = yield* spentOn(
				withinBound(boundOver(deadline, deadline), Effect.withSpan(work, OUTSIDE_STEP))
			)
			switch (shape.kind) {
				case "runaway":
					assert.equal(Result.isFailure(ended) ? ended.failure.overrun.kind : "ended", "spent")
					return
				case "deadlock":
					assert.equal(Result.isFailure(ended) ? ended.failure.overrun.kind : "ended", "stalled")
					assert.equal(
						Result.isFailure(ended)
							? Option.getOrNull(Option.map(ended.failure.within, (span) => span.name))
							: null,
						OUTSIDE_STEP
					)
					return
				case "ends":
					assert.equal(Result.isSuccess(ended) ? "ended" : "overran", "ended")
					assert.ok(
						spent >= shape.burn - STATED_CPU_SHORTFALL_MILLIS,
						`the work burned ${String(shape.burn)} ms of CPU and its spending read ${String(spent)} ms`
					)
			}
		}),
	oracle: {
		kind: "specification",
		name: "work its caller judges under a bound is ended as a case under that deadline is: a runaway at its CPU budget, a wait that spends nothing at its first whole stall window, named with the innermost span it stood in; work that ends in time gives its outcome, and the CPU it spent reads at least what it burned, to the ticks Linux rounds it down to"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/live.ts",
			original:
				"\t\t\t\tEffect.flatMap(ownWorkNow, (work) => overrun(work, bound)),\n\t\t\t\t(ran) => Result.fail(",
			replacement: "\t\t\t\tEffect.never,\n\t\t\t\t(ran) => Result.fail(",
			why: "Work under withinBound has no guard, so a mutant's hung trial holds its caller forever, as syzkaller-browser's journeys kills did on 2026-11-22 (the refresh journey's first kill, stopped after twenty minutes); the runaway and the deadlocked wait end of themselves, and this property fails."
		},
		{
			file: "packages/testing/src/live.ts",
			original: "Effect.sync(() => work.effort().cpu - work.began.cpu)",
			replacement: "Effect.sync(() => 0)",
			why: "The work's spending reads nothing, so a caller that bounds a trial by its baseline's spending bounds it by nothing; this property fails."
		},
		{
			file: "packages/testing/src/live.ts",
			original:
				"Effect.map(Effect.withTracer(effect, spans.tracer), (outcome) => Result.succeed(outcome))",
			replacement: "Effect.map(effect, (outcome) => Result.succeed(outcome))",
			why: "Work its guard ended is reported without the step it stood in, so a kill trial hung on a page that never comes says only that its tree spent its budget, not which step waited (a clean refresh journey hung over five minutes at seed 17 on 2026-11-22, its step unknown); this property fails."
		}
	]
})
