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
	childSeen,
	deadlockedCase,
	deadlocks,
	INNER_SEED,
	innerRun,
	runawayCase,
	runaways,
	SLOW_DEADLINE,
	slowCase,
	slowShapes,
	STATED_CPU_SHORTFALL_MILLIS,
	waitingCase
} from "#runner/work.fixtures.ts"

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
			original: "\tif (whole && moved < progress) {",
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
			original: '\t\t\t\t\t\tonSome: (at) => descendantsSince("self", at)',
			replacement: "\t\t\t\t\t\tonSome: () => 0",
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
			original: "\tif (whole && moved < progress) {",
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
				"\t\tEffect.flatMap(liveMillis, (wall) => Effect.sync(() => enterWait(wall))),\n\t\t() => effect,\n\t\t() => Effect.flatMap(liveMillis, (wall) => Effect.sync(() => leaveWait(wall)))",
			replacement: "\t\tEffect.void,\n\t\t() => effect,\n\t\t() => Effect.void",
			why: "waitingOn declares nothing, so a declared wait's wall time is a stall after all; the property fails."
		}
	]
})
