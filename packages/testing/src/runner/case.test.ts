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
 * - A property's needs open before its first case on a process, once there, and outside every case's deadline: a need
 *   slower to open than the case deadline hangs no case.
 * - A need that does not open on a process (its open fails, or runs past the open bound) fails its property once, with
 *   the need and why, and no case of the property runs there.
 * - A process holds a need open while a property readied there that uses it has not retired: a retirement releases
 *   exactly the keys no other live property uses, and a released need's scope is closed (what it acquired released)
 *   and opens again when asked.
 *
 * Oracles are stated per property.
 */
import { Array as Arr, Clock, Effect, Option, Order } from "effect"
import { TestClock } from "effect/testing"
import { deepStrictEqual, strictEqual } from "#assert.ts"
import { aimed, int } from "#gen.ts"
import { property } from "#property.ts"
import {
	cycledReleases,
	FAILED_OPEN,
	hanging,
	holdingHistories,
	LATE_USES,
	lateUses,
	graceMillis,
	lifetimes,
	lifetimesOf,
	needing,
	pastTheGrace,
	releasedAt,
	shortReleases,
	SYNC_PROPERTIES,
	scheduledBy,
	slowOpens,
	syncExhaustion,
	syncProperties,
	UNOPENED_ENDINGS,
	unopenedEndings,
	usingLate
} from "#runner/case.fixtures.ts"
import { holdingsOf } from "#runner/case.ts"
import { runnerLimits } from "#runner/limits.ts"
import {
	findingOf,
	fullRun,
	searchedAt,
	searchedInline,
	seeds,
	verdictKind
} from "#runner/search.fixtures.ts"

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
						deadline: shape.deadline,
						open: runnerLimits.open
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

export const opensOutsideTheCase = property.explore(slowOpens, {
	needs: {},
	situations: [],
	check:
		() =>
		({ deadline, openMillis }) =>
			Effect.gen(function* () {
				const inner = needing(openMillis, "opens", 0)
				const verdict = yield* searchedAt(inner.property, {
					...fullRun("opens outside the case/inner", 0),
					limits: { ...runnerLimits, deadline }
				})
				deepStrictEqual(
					{ verdict: verdictKind(verdict), opens: inner.counts.opens },
					{ verdict: "explored", opens: 1 }
				)
			}),
	oracle: {
		kind: "specification",
		name: "a need opens once a process, before the property's first case there and outside every case's deadline"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/case.ts",
			original: "\t\t\topenAll(needs, bound),",
			replacement: "\t\t\tEffect.void,",
			why: "A property's needs are no longer opened when it is readied, so the first case that takes one opens it inside its own deadline (need-open-in-case, GZ-FOUNDATION's template forms killed at 60 s on their first cases); a need slower to open than the case deadline hangs that case, and the property fails."
		}
	]
})

export const unopenedOnce = property.explore(
	(source) => ({
		ending: source.draw(unopenedEndings),
		bound: source.draw(int(200, 500)),
		others: source.draw(int(0, 2))
	}),
	{
		needs: {},
		situations: UNOPENED_ENDINGS,
		check:
			(_resources, c) =>
			({ ending, bound, others }) =>
				Effect.gen(function* () {
					c.note(ending)
					const inner = needing(ending === "fails" ? 0 : 4 * bound, ending, others)
					const verdict = yield* searchedAt(inner.property, {
						...fullRun("unopened once/inner", 0),
						limits: { ...runnerLimits, open: bound }
					})
					const found = findingOf(verdict)
					deepStrictEqual(
						{
							finding: Option.map(found, (finding) =>
								finding.kind === "unopened"
									? {
											kind: finding.kind,
											need: finding.need,
											failed: finding.message === FAILED_OPEN
										}
									: { kind: finding.kind, need: "", failed: false }
							),
							checks: inner.counts.checks
						},
						{
							finding: Option.some({ kind: "unopened", need: "drawn", failed: ending === "fails" }),
							checks: 0
						}
					)
				}),
		oracle: {
			kind: "specification",
			name: "a need that does not open fails its property once, naming it and why, and no case of it runs"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/runner/case.ts",
				original: "\t\t\topenAll(needs, bound),",
				replacement: "\t\t\tEffect.ignore(openAll(needs, bound)),",
				why: "A need that did not open is left to the cases, as 3714090 left it: each case takes it and fails on its failure, so the property is falsified case by case instead of failing once as unopened, and its cases run; the property fails."
			},
			{
				file: "packages/testing/src/runner/case.ts",
				original: "\t\t\t\t\t\t\t\tliveSleep(Duration.millis(bound)),",
				replacement: "\t\t\t\t\t\t\t\tEffect.never,",
				why: "A need's open has no bound, so one that never ends holds its process forever, and one past the bound opens late instead of failing its property; the outrunning need's property passes, and this property fails."
			}
		]
	}
)

export const heldUntilRetired = property.explore(holdingHistories, {
	needs: {},
	situations: ["a key another live property shares", "a key its last user releases"],
	check: (_resources, c) => (history) =>
		Effect.sync(() => {
			const holdings = holdingsOf()
			const released = Arr.map(history, (step) => {
				switch (step.kind) {
					case "readied":
						holdings.readied(step.property, step.keys)
						return []
					case "retired":
						return holdings.retired(step.property)
				}
			})
			const expected = Arr.map(history, (_, at) => releasedAt(history, at))
			for (const [at, step] of history.entries()) {
				if (step.kind === "retired") {
					c.note(
						(expected[at]?.length ?? 0) > 0
							? "a key its last user releases"
							: "a key another live property shares"
					)
				}
			}
			deepStrictEqual(
				Arr.map(released, (keys) => Arr.sort(keys, Order.String)),
				Arr.map(expected, (keys) => Arr.sort(keys, Order.String))
			)
		}),
	oracle: {
		kind: "second-implementation",
		name: "a retirement releases the keys no property readied before it and not retired still uses, recounted from the history"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/case.ts",
			original: "\t\t\t\tif (using.size > 0) {",
			replacement: "\t\t\t\tif (false) {",
			why: "A retirement releases every key of the retired property, whatever other property readied on the worker still uses it, so a need another property's next case takes is closed under it; this property fails."
		}
	]
})

export const releasedNeedsClose = property.explore(
	(source) => ({ cycles: source.draw(int(1, 4)), kept: source.draw(int(0, 2)) }),
	{
		needs: {},
		situations: [],
		check: () => (shape) =>
			Effect.gen(function* () {
				const cycled = yield* cycledReleases(shape.cycles, shape.kept)
				deepStrictEqual(cycled, {
					after: Array.from({ length: shape.cycles }, (_, at) => ({
						opens: at + 1,
						releases: at + 1,
						others: 0
					})),
					kept: Option.some(shape.kept)
				})
			}),
		oracle: {
			kind: "specification",
			name: "a released need's scope is closed, what its open acquired released, and it opens again when asked; other needs are untouched"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/runner/case.ts",
				original: "\t\t\t\t\t\t\tonSome: (open) => Scope.close(open, Exit.void)",
				replacement: "\t\t\t\t\t\t\tonSome: () => Effect.void",
				why: "A released need is forgotten but its scope is never closed, so the clones, sessions and lease permits its open acquired stay held for the worker's life (GZ-FOUNDATION: LeaseBudgetExhausted over a full run); this property fails."
			}
		]
	}
)
