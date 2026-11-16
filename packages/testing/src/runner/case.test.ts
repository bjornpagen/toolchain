/**
 * A case's evaluation (runner/case.ts), held to what it promises over inner searches run in this process
 * (search.fixtures.ts, case.fixtures.ts):
 *
 * - A hanging case is stopped at the case deadline on the live clock, even when its search runs under a TestClock that
 *   never moves.
 * - A property that uses its case after the case ended (a note, a draw, an observation or a measure), here a later
 *   case of its window using an earlier one's, is reported as a misuse, never passed.
 * - A synchronous case runs inline: a search of twice the cases arms no timer and makes no event-loop hop for each case
 *   it adds (a case forked to a later turn arms its deadline's timer and hops once), for a void, a synchronous and a
 *   stepped property alike. Its wall time is no verdict.
 * - A case's cleanup has run when its search returns: every resource its cases acquired is released, the hung case's
 *   included, however long that cleanup takes, past the hung-cleanup grace too: a cleanup the grace does not wait for is
 *   awaited before the process's next case.
 *
 * Oracles are stated per property.
 */
import { Clock, Effect } from "effect"
import { TestClock } from "effect/testing"
import { deepStrictEqual, strictEqual } from "#assert.ts"
import { aimed, int } from "#gen.ts"
import { property } from "#property.ts"
import {
	hanging,
	LATE_USES,
	lateUses,
	graceMillis,
	lifetimes,
	lifetimesOf,
	pastTheGrace,
	shortReleases,
	SYNC_PROPERTIES,
	scheduledBy,
	syncExhaustion,
	syncProperties,
	usingLate
} from "#runner/case.fixtures.ts"
import { runnerLimits } from "#runner/limits.ts"
import { fullRun, searchedAt, searchedInline, seeds, verdictKind } from "#runner/search.fixtures.ts"

export const hangsOnTheLiveClock = property.explore(
	(source) => ({ deadline: source.draw(int(1, 20)), seed: source.draw(seeds) }),
	{
		needs: {},
		situations: [],
		check:
			() =>
			({ deadline, seed }) =>
				Effect.gen(function* () {
					const testClock = yield* TestClock.make()
					const verdict = yield* searchedAt(hanging, {
						...fullRun("hangs/inner", seed),
						limits: { ...runnerLimits, deadline }
					}).pipe(Effect.provideService(Clock.Clock, testClock))
					strictEqual(verdictKind(verdict), "hung")
				}),
		oracle: {
			kind: "specification",
			name: "a case past its deadline on the live clock is hung, whatever clock its search runs under"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/runner/case.ts",
				original:
					'\t\t\t\t\tEffect.as(liveSleep(Duration.millis(deadline)), { kind: "hung" } satisfies Settled)',
				replacement:
					'\t\t\t\t\tEffect.as(Effect.sleep(Duration.millis(deadline)), { kind: "hung" } satisfies Settled)',
				why: "The case deadline sleeps on the Effect clock, which a TestClock never moves, so a hanging case under one is never stopped (hang-on-test-clock, re-anchored from explore.ts's hang guard to case.ts guarded); the hanging case property fails, red by its own case deadline."
			}
		]
	}
)

export const lateUse = property.explore(
	(source) => ({ use: source.draw(lateUses), seed: source.draw(seeds) }),
	{
		needs: {},
		situations: LATE_USES,
		check:
			(_resources, c) =>
			({ use, seed }) =>
				Effect.gen(function* () {
					c.note(use)
					const verdict = yield* searchedInline(usingLate(use), fullRun("late use/inner", seed))
					strictEqual(verdictKind(verdict), "misused")
				}),
		oracle: {
			kind: "specification",
			name: "a case used after it ended is a misuse, reported as one"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/runner/case.ts",
				original:
					'\t\t\t\t\tresult.outcome.kind === "passed"\n\t\t\t\t\t\t? { ...result, outcome: { kind: "misused", printed } }',
				replacement:
					'\t\t\t\t\tfalse\n\t\t\t\t\t\t? { ...result, outcome: { kind: "misused", printed } }',
				why: "A passing case is judged by its outcome alone, never as misused, so a note, a draw, an observation or a measure after the case ended goes unreported (misuse-unjudged, re-anchored from explore.ts's judgment to case.ts withLateUses); the late use property fails."
			}
		]
	}
)

export const synchronousCases = property.explore(
	(source) => ({ kind: source.draw(syncProperties), cases: source.draw(int(128, 512)) }),
	{
		needs: {},
		situations: SYNC_PROPERTIES,
		check:
			(_resources, c) =>
			({ kind, cases }) =>
				Effect.gen(function* () {
					c.note(kind)
					const once = yield* scheduledBy(
						searchedAt(syncExhaustion(kind, cases), fullRun("inline/inner", 0))
					)
					const twice = yield* scheduledBy(
						searchedAt(syncExhaustion(kind, 2 * cases), fullRun("inline/inner", 0))
					)
					deepStrictEqual(
						{
							timersPerCase: Math.floor(Math.max(0, twice.timers - once.timers) / cases),
							hopsPerCase: Math.floor(Math.max(0, twice.hops - once.hops) / cases)
						},
						{ timersPerCase: 0, hopsPerCase: 0 }
					)
				}),
		oracle: {
			kind: "specification",
			name: "a case that runs to its end synchronously forks no fiber the event loop must run and arms no timer"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/runner/case.ts",
				original:
					"\t\t\tconst running = yield* Effect.forkDetach(Effect.exit(effect), { startImmediately: true })",
				replacement: "\t\t\tconst running = yield* Effect.forkDetach(Effect.exit(effect))",
				why: "Every case starts in a forked fiber on a later turn, arming its deadline's timer, never inline (sync-case-forked, re-anchored from explore.ts to case.ts guarded); the synchronous case property fails."
			}
		]
	}
)

export const caseLifetimes = property.explore(
	aimed(lifetimes(shortReleases), [
		["a hung case's cleanup past the grace", lifetimes(pastTheGrace)]
	]),
	{
		needs: {},
		situations: [
			"cases beside the blocking one",
			"a cleanup that takes time",
			"a hung case's cleanup past the grace"
		],
		check: (_resources, c) => (shape) =>
			Effect.gen(function* () {
				if (shape.cases > 1 && shape.width > 1) {
					c.note("cases beside the blocking one")
				}
				if (shape.releaseMillis > 0) {
					c.note("a cleanup that takes time")
				}
				if (shape.releaseMillis > graceMillis) {
					c.note("a hung case's cleanup past the grace")
				}
				const inner = lifetimesOf(shape)
				const verdict = yield* searchedAt(inner.property, {
					...fullRun("case lifetimes/inner", 0),
					limits: {
						runs: shape.cases,
						floor: 1,
						steered: 0,
						window: runnerLimits.window,
						deadline: shape.deadline
					},
					width: shape.width
				})
				deepStrictEqual(
					{ verdict: verdictKind(verdict), released: inner.counts.released },
					{ verdict: "hung", released: inner.counts.acquired }
				)
			}),
		oracle: {
			kind: "specification",
			name: "no case's cleanup outlives the search that started it: every acquisition released when it returns"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/runner/case.ts",
				original:
					"\t\t\t\tif (running.pollUnsafe() === undefined) {\n\t\t\t\t\tstopped.keep(running)\n\t\t\t\t}\n",
				replacement: "",
				why: "A hung case whose cleanup outruns the grace is reported and let go, never held for its process to drain, so its finalizers outlive the search that started it (finalizers-unawaited, re-anchored from explore.ts's case keeper to case.ts guarded's keep); the case lifetimes property fails."
			}
		]
	}
)
