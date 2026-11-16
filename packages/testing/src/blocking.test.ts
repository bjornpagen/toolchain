/**
 * The watchdog (live.ts), over planted searches (blocking.fixtures.ts), a runaway's in a program of its own, since it
 * ends its process, started from the checkout (Checkout.dir, so a mutant of live.ts reaches it on disk), every other one
 * in the case's own process: a body that loops or backtracks forever from a drawn threshold must end its process with
 * the hang report, naming the first case at the threshold in a replay token, once its case deadline and the watchdog's
 * grace have passed and before a grace more, the latest bound that still tells a watchdog waiting twice its grace
 * apart (measured on cassowary, 2026-11-16, load average 300 to 400 on 64 cores: 64 runaways ended 41 to 5,248 ms past
 * their moment, median 156, 90th percentile 249); a body that returns, pauses past its deadline short of the grace, or
 * sleeps past it, yielding, must end its search in the program by the guard's verdict. A runaway costs its deadline and
 * the grace, so the space draws settling bodies and an aim draws each body once its situation is pending. Oracle:
 * stated in the property.
 */
import { Effect, Option } from "effect"
import { deepStrictEqual } from "#assert.ts"
import {
	BODY_SITUATIONS,
	bodyAims,
	endingOf,
	idOf,
	programIn,
	programRun,
	runsAway,
	settledHere,
	settlingRuns,
	values
} from "#blocking.fixtures.ts"
import { aimed } from "#gen.ts"
import { WATCHDOG_GRACE_MILLIS } from "#live.ts"
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
					deepStrictEqual(Option.some(ending), endingOf(planted))
					return
				}
				const dir = yield* checkout
				const ran = yield* programRun(programIn(dir), planted, seed)
				const token = yield* Option.match(ran.replay, {
					onNone: () => Effect.die("the watchdog's report names no case to replay"),
					onSome: (found) => replayOf(found)
				})
				const moment = planted.deadlineMillis + WATCHDOG_GRACE_MILLIS
				deepStrictEqual(
					{
						ending: ran.ending,
						exitCode: ran.exitCode,
						id: token.suite,
						replayed: generate(
							recorder(),
							values,
							forcedChooser(Float64Array.from(token.replayed.values), token.replayed.values.length)
						).value,
						pastItsMoment: Option.map(ran.began, (began) => ran.ended - began >= moment),
						withinAGraceMore: Option.map(
							ran.began,
							(began) => ran.ended - began <= moment + WATCHDOG_GRACE_MILLIS
						)
					},
					{
						ending: Option.none<string>(),
						exitCode: Option.none<number>(),
						id: idOf(planted),
						replayed: planted.threshold,
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
			original: "\t\t\t\t\tgraceMillis: WATCHDOG_GRACE_MILLIS,",
			replacement: "\t\t\t\t\tgraceMillis: WATCHDOG_GRACE_MILLIS * 2,",
			why: "The watchdog waits a grace twice the one it states before it ends a runaway's process; the property fails."
		}
	]
})
