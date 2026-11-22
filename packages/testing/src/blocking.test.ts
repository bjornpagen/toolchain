/**
 * The watchdog (live.ts), over planted searches (blocking.fixtures.ts), a runaway's in a program of its own, since it
 * ends its process, once the watchdog's thread sleeps until a later moment of its own, past the runaway's moment and
 * grace (a situation every runaway's case requires, from the moment the thread said, so the thread must be woken for
 * it), started from the checkout (Checkout.dir, so a mutant of live.ts reaches it on disk), every other one
 * in the case's own process: a body that loops or backtracks forever from a drawn threshold must end its process with
 * the hang report, naming the first case at the threshold in a replay token, once its case deadline and the watchdog's
 * grace have passed and before a grace more of the time the watchdog's thread could run (its waits to run, which its
 * report states, taken out), the latest bound that still tells a watchdog waiting twice its grace
 * apart (measured on cassowary, 2026-11-16, load average 300 to 400 on 64 cores: 64 runaways ended 41 to 5,248 ms past
 * their moment, median 156, 90th percentile 249), and a body that waits in Atomics.wait ends with its thread's answer
 * to the inspector, which no grace bounds (blocking.fixtures.ts gracesOfBody), judged by the CPU its case spent, the
 * watchdog's own observing left out (work.ts ownCpu): of 192 such programs under a 71 ms deadline one read running at
 * its first answer, its own warm-up past progress, and one spent its deadline on it (probe4's r2-32 and r4-11 and probe6's r2-2,
 * 2026-11-22, load 285 to 335), so planted deadlines start above the warm-up (PLANTED_DEADLINE_MILLIS); a body that returns, pauses past its
 * deadline short of the grace, or
 * sleeps past it, yielding, must end its search in the program by the guard's verdict. A runaway costs its deadline and
 * the grace, so the space draws settling bodies and an aim draws each body once its situation is pending. Oracle:
 * stated in the property.
 */
import { Array as Arr, Effect, Option, String as Str } from "effect"
import { assert } from "#assert.ts"
import {
	BODY_SITUATIONS,
	bodyAims,
	endingOf,
	idOf,
	inFlights,
	legAt,
	gracesOfBody,
	legOfBody,
	programIn,
	programRun,
	reportAt,
	inProgram,
	runsAway,
	settledHere,
	settlingRuns,
	values,
	silenceOf,
	silences,
	watchedAt
} from "#blocking.fixtures.ts"
import { aimed, finite } from "#gen.ts"
import { answerOf, hangOver, watchdogGraceMillis } from "#live.ts"
import { Checkout } from "#mutate/checkout.ts"
import { property, ReplayToken } from "#property.ts"
import { replayOf } from "#replay.ts"
import { forcedChooser, generate, recorder } from "#source.ts"

export const watchdog = property.explore(aimed(settlingRuns, bodyAims), {
	needs: { checkout: Checkout.dir },
	situations: BODY_SITUATIONS,
	check:
		({ checkout }, c) =>
		({ planted, seed }) =>
			Effect.gen(function* () {
				c.note(`a body that ${planted.body}`)
				if (!inProgram(planted.body)) {
					const ending = yield* settledHere(planted, seed)
					assert.deepEqual<Option.Option<string>>(Option.some(ending), endingOf(planted))
					return
				}
				const dir = yield* checkout
				if (!runsAway(planted.body)) {
					const blocked = yield* programRun(programIn(dir), planted, seed)
					assert.deepEqual(
						{ ending: blocked.ending, exitCode: blocked.exitCode },
						{ ending: endingOf(planted), exitCode: Option.some(0) }
					)
					return
				}
				const ran = yield* programRun(programIn(dir), planted, seed)
				const token = yield* Option.match(ran.replay, {
					onNone: () => Effect.die("the watchdog's report names no case to replay"),
					onSome: (found) => replayOf(found)
				})
				const moment = planted.deadlineMillis + watchdogGraceMillis
				assert.deepEqual(
					{
						ending: ran.ending,
						exitCode: ran.exitCode,
						leg: ran.leg,
						id: token.suite,
						replayed: generate(
							recorder(),
							values,
							forcedChooser(Float64Array.from(token.replayed.values), token.replayed.values.length)
						).value,
						dueBeforeTheThreadWakes: Option.map(
							Option.all([ran.began, ran.wakes]),
							([began, wakes]) => wakes > began + moment
						),
						pastItsMoment: Option.map(ran.began, (began) => ran.ended - began >= moment),
						withinItsGraces: Option.map(ran.began, (began) =>
							Option.match(gracesOfBody(planted.body), {
								onNone: () => true,
								onSome: (graces) =>
									ran.ended - began - ran.watchdogWaited <= moment + graces * watchdogGraceMillis
							})
						)
					},
					{
						ending: Option.none<string>(),
						exitCode: Option.none<number>(),
						leg: Option.some(legOfBody(planted.body)),
						id: idOf(planted),
						replayed: planted.threshold,
						dueBeforeTheThreadWakes: Option.some(true),
						pastItsMoment: Option.some(true),
						withinItsGraces: Option.some(true)
					}
				)
			}),
	oracle: {
		kind: "specification",
		name: "a runaway ends its process past its deadline and the watchdog's grace, naming its case and the leg its guard read (spent for one that spends a CPU, stalled for one that waits); any other body ends its search by the guard's verdict, one whose thread is silent past the graces while spending no CPU of its own among them"
	},
	kept: [
		{
			token: ReplayToken("src/blocking.test.ts#watchdog:4.2:1f.0.15.13oy4zl"),
			reason:
				"a planted thread that waits a second at a time in Atomics.wait (threshold 0, seed 2400084417; drawn with a deadline of 71 ms, pause 113 ms, before planted deadlines started at 400), whose wake-ups' waits to run under trunk@toolchain's load read as progress, so its watchdog answered running at every ask and the pool's stall window took its worker (floor case 2 of seed 0xa5b59f36, at e7f90259 and 86060d1d, 2026-11-22)",
			since: "2026-11-22"
		},
		{
			token: ReplayToken("src/blocking.test.ts#watchdog:-:2.0.9.0.3clv2e"),
			reason:
				"a planted body that sleeps past its deadline, yielding, drawn with a deadline of 20 ms before planted deadlines started at 400: its case's 20 ms windows, less its main thread's waits to run under trunk@toolchain's load, never came whole before its 80 ms sleep ended, so it was exhausted where it is hung (rotating seed 0x344cae69, case 2, at e8b7ecec, 2026-11-22)",
			since: "2026-11-22"
		},
		{
			token: ReplayToken("src/blocking.test.ts#watchdog:7f.1:c.4.5.y3veec"),
			reason:
				"a planted backtracking runaway (threshold 4, deadline 412 ms, seed 2062353828) that ended past its moment and a grace of wall time at load 380, its watchdog's own waits to run counted as the watchdog's lateness, where a grace is judged in the time the watchdog could run (floor case 15 of seed 0xa5b59f36, 2026-11-22)",
			since: "2026-11-22"
		}
	],
	kills: [
		{
			file: "packages/testing/src/live.ts",
			original: "\t\t\t\tif (burned(since, graceMillis)) {\n",
			replacement: "\t\t\t\tif (true) {\n",
			why: "A main thread that does not answer the inspector within the grace is ended, whatever its CPU, as it was: a live case whose thread the machine pages out or starves is killed for its silence (REDFIX2's two @small-stack deaths under 63 to 74% memory pressure, 2026-11-20); the property fails on the body that blocks."
		},
		{
			file: "packages/testing/src/live.ts",
			original: "\t\tif (moment < Number(Atomics.load(stamps, LAYOUT.wakes))) {",
			replacement: "\t\tif (false) {",
			why: "A case whose moment comes before the moment the watchdog's thread will wake of itself never wakes it, so a runaway after cases under a longer deadline runs on past its moment and a grace; the property fails."
		},
		{
			file: "packages/testing/src/live.ts",
			original: "\t\t\t\t\tgraceMillis: watchdogGraceMillis,",
			replacement: "\t\t\t\t\tgraceMillis: watchdogGraceMillis * 2,",
			why: "The watchdog waits a grace twice the one it states before it ends a runaway's process; the property fails."
		},
		{
			file: "packages/testing/src/live.ts",
			original: `\t\t\tonSome: (leg) => \`\${watched.report()}\\nits guard read: \${leg}\`\n`,
			replacement: "\t\t\tonSome: () => watched.report()\n",
			why: "A runaway's report names no leg, as it did: a hang under load says neither whether its case spent its deadline nor whether it stood still (UNITREDS' bound-identity, 2026-11-21); the property fails on every runaway."
		},
		{
			file: "packages/testing/src/runner/work.ts",
			original:
				'\t\treturn { kind: "stalled", moved, queued, over, waited, progress, window: bound.stall }\n',
			replacement: '\t\treturn { kind: "spent", spent: moved, budget: bound.cpu } as const\n',
			why: "A case that stood still is reported as one that spent its deadline, so a wait the stir misses reads as a CPU blow-up; the property fails on the body that waits."
		}
	]
})

/**
 * What the main thread answers the watchdog's thread that asks it, interrupted, whether it is blocked (live.ts
 * answerOf), over drawn cases in flight, each past the moment its guard would first judge it or not, its work over its
 * deadline or not: blocked exactly when one is past its moment with its work over, naming every case in flight, since
 * the watchdog cannot tell which holds the thread; running otherwise, so a main thread that was merely slow to answer
 * the thread's ping, idle between cases under load, is never ended (MIGRATE-TC met workers ended so, "one of these 0
 * cases in flight blocked the process"), and neither is one whose case the machine slows while its work moves within
 * its deadline (EDULLM-REPIN met waiting.test.ts ended so at load 410 to 540, 1.1 s alone). Oracle: stated in the
 * property, from the drawn cases.
 */
export const answersBlockedPastAMoment = property.explore(inFlights, {
	needs: {},
	situations: [
		"nothing in flight",
		"cases in flight, none past its moment with its work over",
		"a case past its moment whose work still moves within its deadline",
		"one case in flight, past its moment with its work over",
		"a case past its moment with its work over among several in flight"
	],
	check: (_resources, c) => (inFlight) =>
		Effect.sync(() => {
			const past = Arr.some(inFlight, (one) => one.past && one.over)
			if (Arr.some(inFlight, (one) => one.past && !one.over)) {
				c.note("a case past its moment whose work still moves within its deadline")
			}
			if (Arr.isReadonlyArrayEmpty(inFlight)) {
				c.note("nothing in flight")
			} else if (!past) {
				c.note("cases in flight, none past its moment with its work over")
			} else if (inFlight.length === 1) {
				c.note("one case in flight, past its moment with its work over")
			} else {
				c.note("a case past its moment with its work over among several in flight")
			}
			const now = 1_800_000_000_000
			const answer = answerOf(watchedAt(inFlight, now), now)
			const indices = Arr.map(inFlight, (_one, index) => index)
			assert.deepEqual(
				{
					kind: answer.kind,
					named:
						answer.kind === "blocked"
							? Arr.filter(indices, (index) => Str.includes(reportAt(index))(answer.report))
							: Arr.empty<number>(),
					legs:
						answer.kind === "blocked"
							? Arr.filter(indices, (index) => Str.includes(legAt(index))(answer.report))
							: Arr.empty<number>(),
					alone:
						answer.kind === "blocked" && inFlight.length === 1
							? Option.some(answer.report)
							: Option.none<string>()
				},
				{
					kind: past ? "blocked" : "running",
					named: past ? indices : [],
					legs: past
						? Arr.flatMap(inFlight, (one, index) => (one.past && one.over ? [index] : []))
						: [],
					alone:
						past && inFlight.length === 1
							? Option.some(`${reportAt(0)}\nits guard read: ${legAt(0)}`)
							: Option.none<string>()
				}
			)
		}),
	oracle: {
		kind: "specification",
		name: "the main thread answers blocked exactly when a case in flight is past its moment with its work over its deadline, naming every case in flight and the leg the guard of each such case read"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/live.ts",
			original: "\tif (!Arr.some(judged, (one) => Option.isSome(one.over))) {",
			replacement: "\tif (false) {",
			why: "The main thread answers blocked whatever it holds in flight, as the watchdog ended a process before: a worker asked while idle between cases, or with none past its moment, is ended with a report of no case; the property fails."
		},
		{
			file: "packages/testing/src/live.ts",
			original: "\t\tover: watched.hangsAt <= now ? watched.judged(now) : Option.none<string>()\n",
			replacement: '\t\tover: watched.hangsAt <= now ? Option.some("") : Option.none<string>()\n',
			why: "The main thread answers blocked once a case in flight passes its moment on the live clock, whatever its work, as the watchdog judged before: a case the machine slows while its work moves within its deadline is ended as a hang; the property fails."
		},
		{
			file: "packages/testing/src/live.ts",
			original: `\t\t\tonSome: (leg) => \`\${watched.report()}\\nits guard read: \${leg}\`\n`,
			replacement: "\t\t\tonSome: () => watched.report()\n",
			why: "A blocked answer names no leg, as it did: a hang under load says neither whether its case spent its deadline nor whether it stood still (UNITREDS' bound-identity, 2026-11-21); the property fails, the legs unnamed."
		}
	]
})

export const throttledThreadIsNoHang = property.exhaust(finite(silences), {
	box: "a main thread's silence over one grace: a loop running JavaScript with and without its cgroup stalling on memory, a thread memory.high throttles, a loop in the kernel with no memory stall, and one that spends nothing",
	needs: {},
	situations: [],
	check: () => (shape) =>
		Effect.sync(() => {
			assert.equal(
				hangOver(silenceOf(shape), 10),
				shape !== "a thread memory.high throttles" && shape !== "a thread that spends nothing",
				shape
			)
		}),
	oracle: {
		kind: "specification",
		name: "a silent main thread is a hang when it spent past progress running: its user CPU where its cgroup stalled on memory, since a task memory.high throttles or makes reclaim in place spends system time running no JavaScript (trunk@metis at d07c3409, 2026-11-22: two workers ended as hangs under metis.slice's memory.high, whose cases pass by their seeds below it), its whole CPU where it did not"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/live.ts",
			original: "(silence.stall >= progress ? silence.user : silence.cpu) >= progress",
			replacement: "silence.cpu >= progress",
			why: "A silent thread's system time counts as running whatever its cgroup's memory stall, as it did: a thread memory.high throttles reads as a hang, and the watchdog ends a case that was only waiting on the machine; the property fails."
		}
	]
})
