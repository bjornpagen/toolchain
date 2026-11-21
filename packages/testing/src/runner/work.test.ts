/**
 * A case's deadline is a budget of its own work (runner/work.ts, case.ts guarded), held over inner searches run in this
 * process (search.fixtures.ts, work.fixtures.ts):
 *
 * - A case the machine slows is not hung: its CPU comes in bursts between stalls on the live clock, its wall time runs
 *   past its deadline, its CPU stays a tenth of it and moves in every deadline's window, and it passes.
 * - A case's work counts its live children's CPU: while a working child is alive and unreaped, the tree's CPU since the
 *   work began holds what the child says it spent, to Linux's clock tick.
 * - A CPU runaway is hung at its deadline: it yields as it spends many deadlines of CPU, so only the CPU budget stops
 *   it, and it is hung, never passed.
 * - A deadlocked case is hung after one deadline of wall time: it waits on the live clock for many deadlines, spending
 *   nothing, and it is hung, never passed.
 * - A case whose wait is a declared one (live.ts waitingOn), a wait on a resource other processes hold, is never hung
 *   for it: the same wait as the deadlocked case's, declared, passes.
 * - A deadlocked case is hung though its tree holds a child that wakes on a timer: the child's wake-ups spend a little
 *   CPU and wait a little to run, short of progress, so the wait is a stall still.
 *
 * Each inner case ends of itself well past its deadline (its search explores), so a guard that misjudges it lets it
 * pass.
 *
 * Budget: each property's space is a few shapes, exhausted, each one inner search of a case or two; the slow shapes
 * take four to five seconds of wall time apiece, almost none of it CPU.
 *
 * Oracles are stated per property.
 */
import { Effect } from "effect"
import { assert } from "#assert.ts"
import { finite } from "#gen.ts"
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
	otherMoves,
	runawayCase,
	runaways,
	SLOW_DEADLINE,
	slowCase,
	slowShapes,
	STATED_CPU_SHORTFALL_MILLIS,
	storageDirectory,
	waitingCase,
	wakingCase,
	windowOf
} from "#runner/work.fixtures.ts"
import { standingOf } from "#runner/work.ts"

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
			original: "\tif (whole && moved + queued < progress && !storedBetween(window, now)) {",
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
			original: '\t\t\t\tcpu: ownCpu() + reaped(statOf("self")) + descendants.cpu,\n',
			replacement: '\t\t\t\tcpu: ownCpu() + reaped(statOf("self")),\n',
			why: "A live child's CPU is left out until the child is reaped, so a case that waits on a working child spends nothing of its own and is stalled after a window; the child-work property fails."
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
			original: "\tif (spent >= deadline) {",
			replacement: "\tif (spent >= deadline * 1000) {",
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
			original: "\tif (whole && moved + queued < progress && !storedBetween(window, now)) {",
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
				"\t\t\tEffect.flatMap(liveMillis, (wall) => Effect.sync(() => enterWait(wall, on))),\n\t\t\t() => effect,\n\t\t\t() => Effect.flatMap(liveMillis, (wall) => Effect.sync(() => leaveWait(wall, on)))",
			replacement: "\t\t\tEffect.void,\n\t\t\t() => effect,\n\t\t\t() => Effect.void",
			why: "waitingOn declares nothing, so a declared wait's wall time is a stall after all; the property fails."
		}
	]
})

export const othersMoveTheWork = property.exhaust(finite(otherMoves), {
	box: "a whole window of a work whose own process spent no CPU, in which nothing else moved, a child woke and waited to run a little, a child waited to run for progress, or a child did the least storage work",
	needs: {},
	situations: [],
	check: () => (move) =>
		Effect.sync(() => {
			const standing = standingOf({ began: windowOf(move).window, ...windowOf(move) })
			assert.equal(
				standing.kind,
				move === "none" || move === "a child woke and waited a little" ? "stalled" : "working"
			)
		}),
	oracle: {
		kind: "specification",
		name: "a window is stalled when the work's CPU and its other processes' runqueue wait together fall short of progress and none of them did storage work: a child kept from running for progress, or one that did any storage work, keeps it working; a child that only woke and waited a little does not"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/work.ts",
			original: "\tif (whole && moved + queued < progress && !storedBetween(window, now)) {",
			replacement: "\tif (whole && moved < progress) {",
			why: "The guard reads CPU alone in its window, as it did: a child the machine keeps waiting to run, or one blocked on storage or swap, is no move, so a wait behind it is stalled (land #4's contended red, 2026-11-20, load 230 to 330, memory pressure full near 20%); the property fails."
		},
		{
			file: "packages/testing/src/runner/work.ts",
			original: "\tif (whole && moved + queued < progress && !storedBetween(window, now)) {",
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
			original: "\tif (whole && moved + queued < progress && !storedBetween(window, now)) {",
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
			original: "\t\t\t\t\t\treturn name === SCHEDSTAT.read || name === SCHEDSTAT.written\n",
			replacement: "\t\t\t\t\t\treturn false\n",
			why: "A process's storage work is read as none, so a child or holder blocked on storage or swap is no move, and a wait behind it is stalled; the property fails."
		}
	]
})
