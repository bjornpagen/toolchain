/**
 * The interleaving engine (interleave.ts) and property.interleave over a lock manager its fixtures plant
 * (interleave.fixtures.ts), against what they promise. Oracles are stated per property.
 */
import { Array as Arr, Effect, Option, Order, String as Str, Struct } from "effect"
import { assertTrue, deepStrictEqual, strictEqual } from "#assert.ts"
import { aimed, finite } from "#gen.ts"
import {
	aftersGen,
	afterSessions,
	caseChooser,
	crossingSessions,
	decidedBy,
	drawnScheduling,
	disjointSessions,
	followedOf,
	isAfterCycle,
	lockingSessions,
	lockManager,
	loopsOf,
	multinomialOf,
	type Named,
	natureOf,
	onLocks,
	oneDrawnRun,
	releaseCases,
	resultsOf,
	sameMembers,
	scriptedCases,
	sessionSets,
	walkScript
} from "#interleave.fixtures.ts"
import { interleave, type Strategy } from "#interleave.ts"
import { property } from "#property.ts"
import { forcedChooser, recording } from "#source.ts"

/** Every order with sleep sets reaches every result every order without them reaches, running no more orders. */
export const sleepSetsSound = property.explore(sessionSets, {
	needs: {},
	situations: [],
	check: () => (sessions) =>
		Effect.gen(function* () {
			const reduced = yield* resultsOf(sessions, "sleep-sets")
			const full = yield* resultsOf(sessions, "none")
			deepStrictEqual(Arr.sort(reduced.results, Order.String), Arr.sort(full.results, Order.String))
			assertTrue(
				reduced.report.interleavings <= full.report.interleavings,
				`sleep sets ran ${reduced.report.interleavings} orders, no more than the ${full.report.interleavings} without them`
			)
		}),
	oracle: { kind: "second-implementation", name: "the same search with no sleep-set reduction" },
	kept: [],
	kills: [
		{
			file: "packages/testing/src/interleave.ts",
			original:
				"\t\t\t\t\t\t\t\t\t\t\tstartable(session) &&\n\t\t\t\t\t\t\t\t\t\t\tdriver.commute(nextMoveOf(session), nextMoveOf(choice))",
			replacement: "\t\t\t\t\t\t\t\t\t\t\tstartable(session)",
			why: "Every session put to sleep, commuting or not: orders that reach other results are pruned."
		}
	]
})

/**
 * Sessions whose every move commutes with every other's run one order under sleep sets, and every order without
 * them, the multinomial of their lengths.
 */
export const commutingSessions = property.exhaust(finite(disjointSessions), {
	box: "three sessions, each writing its own resource once, at either value, or twice",
	needs: {},
	situations: [],
	check: () => (sessions) =>
		Effect.gen(function* () {
			const reduced = yield* resultsOf(sessions, "sleep-sets")
			const full = yield* resultsOf(sessions, "none")
			deepStrictEqual(
				{
					reduced: reduced.report.interleavings,
					full: full.report.interleavings,
					pruned: full.report.pruned,
					results: [reduced.results.size, full.results.size]
				},
				{
					reduced: 1,
					full: multinomialOf(
						Arr.map(Struct.keys(sessions), (name) => sessions[name].moves.length)
					),
					pruned: 0,
					results: [1, 1]
				}
			)
		}),
	oracle: {
		kind: "specification",
		name: "sleep sets run one order of moves that all commute; without them every order, the multinomial of the sessions' moves"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/interleave.ts",
			original:
				"\t\t\t\t\tconst asleep = new Set(Arr.filter([...resolved.sleep], (session) => !woken.has(session)))",
			replacement: "\t\t\t\t\tconst asleep = new Set<S>()",
			why: "Sleep sets off, no session ever asleep: commuting sessions run every order."
		}
	]
})

/**
 * Two sessions that lock two resources in opposite orders reach their deadlock and its victim under every order with
 * sleep sets, whichever resources and values they write.
 */
export const crossingDeadlock = property.exhaust(finite(crossingSessions), {
	box: "two sessions writing two distinct resources in opposite orders, each at either value",
	needs: {},
	situations: [],
	check: () => (sessions) =>
		Effect.gen(function* () {
			const { results, report } = yield* resultsOf(sessions, "sleep-sets")
			assertTrue(report.blocked > 0, "some order made a session wait")
			assertTrue(
				Arr.some([...results], Str.includes("deadlock")),
				`some order ended a session as the deadlock's victim, among ${Arr.join(results, " | ")}`
			)
		}),
	oracle: {
		kind: "specification",
		name: "two transactions locking in opposite orders can deadlock, and the lock manager aborts one"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/interleave.ts",
			original:
				"\t\t\t\t\t\t\t\t\t\t\tstartable(session) &&\n\t\t\t\t\t\t\t\t\t\t\tdriver.commute(nextMoveOf(session), nextMoveOf(choice))",
			replacement: "\t\t\t\t\t\t\t\t\t\t\tstartable(session)",
			why: "Every session put to sleep, commuting or not: the order that deadlocks is pruned."
		}
	]
})

/**
 * A run records every deadlock the lock manager breaks, whose detector runs while the engine settles its waits, as
 * PostgreSQL's deadlock check does: the victims a run's deadlocks name are exactly the sessions the lock manager
 * aborted, over sessions that each write two resources, two of them in the same order or the opposite one. A property
 * of property.interleave: the engine notes the deadlocks its runs broke.
 */
export const deadlocksRecorded = property.interleave(lockingSessions, {
	needs: {},
	sessions: onLocks,
	driver: () => () => Effect.sync(() => lockManager<Named>()),
	strategy: () => ({ kind: "every", reduction: "sleep-sets" }),
	judge: (_resources, c) => () => (run) =>
		Effect.sync(() => {
			const aborted = Arr.flatMap([...run.sessions], ([session, end]) =>
				end.kind === "ended" && end.key === "deadlock" ? [session] : []
			)
			const recorded = Arr.flatMap(run.deadlocks, (deadlock) => Option.toArray(deadlock.victim))
			deepStrictEqual(Arr.sort(recorded, Order.String), Arr.sort(aborted, Order.String))
			if (Arr.isReadonlyArrayNonEmpty(recorded)) {
				c.note("a victim recorded")
			}
		}),
	situations: ["a deadlock broken", "a victim recorded", "a move waited", "an order pruned"],
	oracle: {
		kind: "specification",
		name: "the lock manager's own verdict: the sessions a run ended as a deadlock's victim"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/interleave.ts",
			original: "\t\t\t\t\t\t\t\tif (Arr.isReadonlyArrayNonEmpty(broken)) {",
			replacement:
				"\t\t\t\t\t\t\t\tif (Arr.isReadonlyArrayNonEmpty(broken) && broken.length < 0) {",
			why: "A deadlock the lock manager breaks while the engine settles goes unrecorded."
		},
		{
			file: "packages/testing/src/interleave.ts",
			original:
				"\tArr.flatMap(Struct.keys(INTERLEAVED), (count) => (report[count] > 0 ? [INTERLEAVED[count]] : []))",
			replacement:
				"\tArr.flatMap(Struct.keys(INTERLEAVED), (count) => (report[count] < 0 ? [INTERLEAVED[count]] : []))",
			why: "property.interleave notes nothing its runs reached, so no case reaches a deadlock broken."
		}
	]
})

/**
 * Sessions whose afters form a cycle are refused before any runs, naming one of the afters' loops, and every other
 * after relation runs.
 */
export const afterCycles = property.exhaust(finite(aftersGen), {
	box: "every choice of an after, none or a session, for each of three sessions",
	needs: {},
	situations: ["a cycle", "a self-loop", "no cycle", "a chain"],
	check: (_resources, c) => (afters) =>
		Effect.gen(function* () {
			const loops = loopsOf(afters)
			let ran = 0
			const outcome = yield* Effect.result(
				interleave(
					lockManager<Named>(),
					{ sessions: afterSessions(afters), exclusive: [], state: Option.none() },
					{ kind: "every", reduction: "sleep-sets" },
					() =>
						Effect.sync(() => {
							ran += 1
						})
				)
			)
			if (Arr.some(loops, (loop) => loop.length === 1)) {
				c.note("a self-loop")
			}
			if (Arr.isReadonlyArrayEmpty(loops)) {
				c.note("no cycle")
				if (Arr.some(Struct.keys(afters), (name) => Option.isSome(afters[name]))) {
					c.note("a chain")
				}
				strictEqual(outcome._tag, "Success")
				return
			}
			c.note("a cycle")
			const refused = outcome._tag === "Failure" ? outcome.failure : undefined
			assertTrue(isAfterCycle(refused), "the afters' cycle is refused")
			deepStrictEqual(
				{
					ran,
					named: Arr.some(loops, (loop) =>
						sameMembers(loop, isAfterCycle(refused) ? refused.cycle : [])
					)
				},
				{ ran: 0, named: true }
			)
		}),
	oracle: {
		kind: "specification",
		name: "sessions start after their afters: refused exactly when the afters form a cycle, which it names"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/interleave.ts",
			original: "\t\t\t\t(name) => [name, Option.toArray(sessions[name].after)] as const",
			replacement:
				"\t\t\t\t(name) =>\n\t\t\t\t\t[name, Option.toArray(Option.filter(sessions[name].after, (after) => after !== name))] as const",
			why: "A self-loop among the afters unseen, so a session that starts after itself is run rather than refused."
		}
	]
})

/**
 * A script is followed, and stops at the first decision it cannot make: a move of a session that is done or whose
 * move waits, or a join of a session whose move waits, by its decision and choice, never its prose. A property of
 * property.interleave under a script.
 */
export const scriptFollowed = property.interleave(scriptedCases, {
	needs: {},
	sessions: (scripted) => onLocks(scripted.sessions),
	driver: () => () => Effect.sync(() => lockManager<"a" | "b">()),
	strategy: (scripted) => ({ kind: "script", choices: scripted.script }),
	judge: (_resources, c) => (scripted) => (run) =>
		Effect.sync(() => {
			const walked = walkScript(scripted)
			deepStrictEqual(followedOf(run), walked.followed)
			c.note(walked.situation)
		}),
	situations: [
		"the script ran out",
		"stopped at a move of a done session",
		"stopped at a move of a session in flight",
		"stopped at a join of a move in flight"
	],
	oracle: {
		kind: "second-implementation",
		name: "the script walked by hand over one lock: a write waits on the other session's until it commits"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/interleave.ts",
			original: `\t\t\t\t\t\t\t\t: pending.has(choice.session)\n\t\t\t\t\t\t\t\t\t? Option.some(\`\${choice.session} has a move in flight\`)\n\t\t\t\t\t\t\t\t\t: !startable(choice.session) || !laneFree(choice.session)`,
			replacement: "\t\t\t\t\t\t\t\t: !startable(choice.session) || !laneFree(choice.session)",
			why: "A script's move of a session with a move in flight made rather than refused."
		}
	]
})

/**
 * A schedule drawn from a case's tape (a drawn or a PCT one, as property.interleave draws them) reaches only results
 * every order reaches.
 */
export const drawnSchedulesSound = property.interleave(
	(source) => ({
		sessions: source.draw(lockingSessions),
		scheduling: source.draw(drawnScheduling)
	}),
	{
		needs: {},
		sessions: (drawn) => onLocks(drawn.sessions),
		driver: () => () => Effect.sync(() => lockManager<Named>()),
		strategy: (drawn) => drawn.scheduling,
		judge: () => (drawn) => (run) =>
			Effect.gen(function* () {
				const every = yield* resultsOf(drawn.sessions, "none")
				assertTrue(
					every.results.has(decidedBy(run)),
					"a drawn schedule's result is one every order reaches"
				)
			}),
		situations: ["a move waited", "a deadlock broken"],
		oracle: { kind: "second-implementation", name: "every order, with no sleep-set reduction" },
		kept: [],
		kills: []
	}
)

/** A schedule drawn from a case's tape replays exactly from that tape, and every session it starts ends. */
export const drawnReplay = property.explore(sessionSets, {
	needs: {},
	situations: [],
	check: (_resources, c) => (sessions) =>
		Effect.gen(function* () {
			const drawnOn = recording(caseChooser(c))
			const once = yield* oneDrawnRun(sessions, natureOf(drawnOn))
			const taped = drawnOn.tape()
			const again = yield* oneDrawnRun(
				sessions,
				natureOf(recording(forcedChooser(taped.values, taped.length)))
			)
			deepStrictEqual(
				{ replay: again.replay.kind, schedule: Arr.map(again.tape, (decision) => decision.choice) },
				{ replay: "as-taped", schedule: Arr.map(once.tape, (decision) => decision.choice) }
			)
			strictEqual(once.replay.kind, "as-taped")
			strictEqual(
				Struct.keys(sessions).length,
				Arr.filter([...once.sessions.values()], (end) => end.kind !== "unfinished").length
			)
		}),
	oracle: {
		kind: "universal",
		name: "round trip: a schedule drawn from a case's tape replays exactly from it"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/interleave.ts",
			original:
				"\t\t\t\t\t\t\t\tArr.getUnsafe(runnable, searching.nature.draw(int(0, runnable.length - 1)))",
			replacement:
				"\t\t\t\t\t\t\t\tArr.getUnsafe(runnable, Math.floor(Math.random() * runnable.length))",
			why: "A drawn decision left off the tape, so a replay of the tape makes other decisions."
		}
	]
})

/** Every session a run started is released, however the run ends, so no reset meets one left open. */
export const everyStartedSessionReleased = property.explore(
	aimed(releaseCases(Option.none()), [
		["a run pruned", releaseCases(Option.some("every order"))],
		["a run refused", releaseCases(Option.some("every order, the second refused"))],
		["a judged run left a session part-way", releaseCases(Option.some("a script"))]
	]),
	{
		needs: {},
		situations: ["a run pruned", "a run refused", "a judged run left a session part-way"],
		check: (_resources, c) => (released) =>
			Effect.gen(function* () {
				const driver = lockManager<Named>()
				let judged = 0
				const strategy: Strategy<Named, "state"> =
					released.ending === "a script"
						? {
								kind: "script",
								choices: Arr.map(released.script, (session) => ({ kind: "move", session }))
							}
						: released.ending === "drawn decisions"
							? { kind: "drawn", nature: c }
							: { kind: "every", reduction: "sleep-sets" }
				const report = yield* interleave(driver, onLocks(released.sessions), strategy, (run) =>
					Effect.suspend(() => {
						judged += 1
						if (
							Arr.some(run.order, (move) => run.sessions.get(move.session)?.kind === "unfinished")
						) {
							c.note("a judged run left a session part-way")
						}
						if (released.ending === "every order, the second refused" && judged === 2) {
							c.note("a run refused")
							return Effect.fail("refused" as const)
						}
						return Effect.void
					})
				).pipe(
					Effect.asSome,
					Effect.catch(() => Effect.succeedNone)
				)
				if (Option.exists(report, (ran) => ran.pruned > 0)) {
					c.note("a run pruned")
				}
				yield* driver.reset
			}),
		oracle: {
			kind: "specification",
			name: "every session a run started is released, however the run ends"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/interleave.ts",
				original:
					"\t\t\t\t\t\tArr.filter([...live.started], (session) => !live.released.has(session)),",
				replacement:
					"\t\t\t\t\t\tArr.filter([...live.started], (session) => live.released.has(session)),",
				why: "No session released when its run ends, so the next reset meets its locks."
			}
		]
	}
)
