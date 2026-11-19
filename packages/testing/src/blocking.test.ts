/**
 * The watchdog (live.ts), over planted searches (blocking.fixtures.ts), a runaway's in a program of its own, since it
 * ends its process, once the watchdog's thread sleeps until a later moment of its own, past the runaway's moment and
 * grace (a situation every runaway's case requires, from the moment the thread said, so the thread must be woken for
 * it), started from the checkout (Checkout.dir, so a mutant of live.ts reaches it on disk), every other one
 * in the case's own process: a body that loops or backtracks forever from a drawn threshold must end its process with
 * the hang report, naming the first case at the threshold in a replay token, once its case deadline and the watchdog's
 * grace have passed and before a grace more, the latest bound that still tells a watchdog waiting twice its grace
 * apart (measured on cassowary, 2026-11-16, load average 300 to 400 on 64 cores: 64 runaways ended 41 to 5,248 ms past
 * their moment, median 156, 90th percentile 249); a body that returns, pauses past its deadline short of the grace, or
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
	programIn,
	programRun,
	reportAt,
	runsAway,
	settledHere,
	settlingRuns,
	values,
	watchedAt
} from "#blocking.fixtures.ts"
import { aimed } from "#gen.ts"
import { answerOf, watchdogGraceMillis } from "#live.ts"
import { Checkout } from "#mutate/checkout.ts"
import { property } from "#property.ts"
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
				if (!runsAway(planted.body)) {
					const ending = yield* settledHere(planted, seed)
					assert.deepEqual<Option.Option<string>>(Option.some(ending), endingOf(planted))
					return
				}
				const dir = yield* checkout
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
						withinAGraceMore: Option.map(
							ran.began,
							(began) => ran.ended - began <= moment + watchdogGraceMillis
						)
					},
					{
						ending: Option.none<string>(),
						exitCode: Option.none<number>(),
						id: idOf(planted),
						replayed: planted.threshold,
						dueBeforeTheThreadWakes: Option.some(true),
						pastItsMoment: Option.some(true),
						withinAGraceMore: Option.some(true)
					}
				)
			}),
	oracle: {
		kind: "specification",
		name: "a runaway ends its process past its deadline and the watchdog's grace, naming its case; any other body ends its search by the guard's verdict"
	},
	kept: [],
	kills: [
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
					alone:
						answer.kind === "blocked" && inFlight.length === 1
							? Option.some(answer.report)
							: Option.none<string>()
				},
				{
					kind: past ? "blocked" : "running",
					named: past ? indices : [],
					alone: past && inFlight.length === 1 ? Option.some(reportAt(0)) : Option.none<string>()
				}
			)
		}),
	oracle: {
		kind: "specification",
		name: "the main thread answers blocked exactly when a case in flight is past its moment with its work over its deadline, naming every case in flight"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/live.ts",
			original:
				"\tif (!Arr.some(inFlight, (watched) => watched.hangsAt <= now && watched.over(now))) {",
			replacement: "\tif (false) {",
			why: "The main thread answers blocked whatever it holds in flight, as the watchdog ended a process before: a worker asked while idle between cases, or with none past its moment, is ended with a report of no case; the property fails."
		},
		{
			file: "packages/testing/src/live.ts",
			original:
				"\tif (!Arr.some(inFlight, (watched) => watched.hangsAt <= now && watched.over(now))) {",
			replacement: "\tif (!Arr.some(inFlight, (watched) => watched.hangsAt <= now)) {",
			why: "The main thread answers blocked once a case in flight passes its moment on the live clock, whatever its work, as the watchdog judged before: a case the machine slows while its work moves within its deadline is ended as a hang; the property fails."
		}
	]
})
