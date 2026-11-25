/**
 * A search's case (explore.ts, the engine `searched` runs a Vitest suite's searches on) is judged by its work under
 * `caseHang`, as the runner judges a case (runner/case.ts guarded, runner/work.ts), never by the live clock, which judged
 * the machine: qti-pie's pantry suite test/inclusion-cycles was reported hung at its first case under load 290 (FORM-AUDIO,
 * 2026-11-25), its 1.5 s of CPU, the suite's one-time costs among it, past its 30 s hang limit in wall time, and again at
 * a CPU quota of 3 % with its CPU moving every second (QP-GATE). Held over searches of one case run in this process
 * (explore.fixtures.ts searchedOnce), each the runner's planted work (runner/work.fixtures.ts):
 *
 * - A case the machine slows is not hung: its CPU comes in bursts between stalls on the live clock, its wall time runs
 *   past its hang limit, its CPU stays a tenth of it and moves in every window, and its search explores.
 * - A CPU runaway is hung, its report naming the CPU leg: it yields as it spends many limits of CPU, so only the CPU
 *   budget stops it.
 * - A deadlocked case is hung, its report naming the stall leg: it waits on the live clock for many limits, spending
 *   nothing.
 *
 * Budget: each property's space is two or three shapes, exhausted, each one search of one case; the slow shapes take
 * four to five seconds of wall time apiece, almost none of it CPU.
 *
 * Oracles are stated per property.
 */
import { Effect, String as Str } from "effect"
import { assert } from "#assert.ts"
import { searchedOnce } from "#explore.fixtures.ts"
import { finite } from "#gen.ts"
import { property } from "#property.ts"
import {
	deadlockedWork,
	deadlocks,
	runaways,
	runawayWork,
	SLOW_DEADLINE,
	slowShapes,
	slowWork
} from "#runner/work.fixtures.ts"

export const searchSlowIsNotHung = property.exhaust(finite(slowShapes), {
	box: "a slow case's bursts of CPU and stalls on the live clock, three shapes past a 3,000 ms hang limit in wall time",
	needs: {},
	situations: [],
	check: () => (shape) =>
		Effect.gen(function* () {
			const ended = yield* searchedOnce(slowWork(shape), SLOW_DEADLINE)
			assert.equal(ended, "explored")
		}),
	oracle: {
		kind: "specification",
		name: "a search's case whose CPU moves in every window of its hang limit and stays within it is never hung, however long the machine stretches its wall time"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/explore.ts",
			original: "overrun(work, deadlineBound(",
			replacement: "overrun({ ...work, effort: () => work.began }, deadlineBound(",
			why: "A search's case is judged by work that never moves, so it is hung once a hang limit of wall time passes, as the live clock judged it (pantry's test/inclusion-cycles at load 290): the slow case, whose CPU moves and stays a tenth of its limit, is hung; the slow-search property fails."
		}
	]
})

export const searchRunawayIsHung = property.exhaust(finite(runaways), {
	box: "a runaway's hang limit and how many limits of CPU it would spend, two shapes",
	needs: {},
	situations: [],
	check: () => (shape) =>
		Effect.gen(function* () {
			const ended = yield* searchedOnce(runawayWork(shape), shape.deadline)
			assert.ok(
				Str.startsWith("hung: ")(ended) && Str.includes(": its process tree spent ")(ended),
				`the runaway is hung by the CPU leg its guard read: ${ended}`
			)
		}),
	oracle: {
		kind: "specification",
		name: "a search's case whose process tree spends its hang limit in CPU is hung, however much it yields, and its report names the CPU it spent"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/explore.ts",
			original: `\t\`\${overrunText(hung.overrun)}\${waitedOnText(hung.waitedOn)}\`\n`,
			replacement: '\t""\n',
			why: 'A hung case is reported without the leg its guard read, as it was ("ran past 30s"), so a hang says neither whether the case spent its CPU nor whether it waited on something; the runaway property fails.'
		}
	]
})

export const searchDeadlockIsHung = property.exhaust(finite(deadlocks), {
	box: "a deadlocked case's hang limit and how many limits it waits, two shapes",
	needs: {},
	situations: [],
	check: () => (shape) =>
		Effect.gen(function* () {
			const ended = yield* searchedOnce(deadlockedWork(shape), shape.deadline)
			assert.ok(
				Str.startsWith("hung: ")(ended) && Str.includes(": its process tree's CPU moved ")(ended),
				`the deadlocked case is hung by the stall leg its guard read: ${ended}`
			)
		}),
	oracle: {
		kind: "specification",
		name: "a search's case whose process tree's CPU does not move over a whole hang limit of the time it could have run is hung, and its report names the stall"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/explore.ts",
			original: "deadlineBound(Duration.toMillis(Duration.fromInputUnsafe(caseHang)))),",
			replacement:
				"{ ...deadlineBound(Duration.toMillis(Duration.fromInputUnsafe(caseHang))), stall: Infinity }),",
			why: "No window of a search's case is ever whole, so a case that waits spends nothing, never reaches its CPU budget, and waits to its end; the deadlock property fails."
		}
	]
})
