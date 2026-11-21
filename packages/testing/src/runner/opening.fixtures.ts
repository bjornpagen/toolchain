import type { NodeServices } from "@effect/platform-node/NodeServices"
import {
	Array as Arr,
	Context,
	Duration,
	Effect,
	Option,
	Result,
	Scope,
	String as Str
} from "effect"
import { element, finite, int } from "#gen.ts"
import { liveSleep, waitingOn } from "#live.ts"
import type { Need } from "#property.ts"
import { needCacheOf } from "#runner/case.ts"
import { needStallMillis } from "#runner/limits.ts"
import { moduleClosureAt } from "#runner/module-closure.ts"
import { runValuesOf } from "#runner/runs.ts"
import { ModuleClosure, type NeedFailed, RunValues, WorkerIndex } from "#runner/services.ts"
import { ownCpu } from "#runner/work.ts"

/** How much CPU (ms) one burst of a spending open spends before it yields, so its group's judge can read it. */
const BURST_MILLIS = 5

/** Spends `millis` of this process's CPU in bursts, yielding after each, so a live-clock timer runs between them. */
const spending = (millis: number): Effect.Effect<void> =>
	Effect.forEach(
		Array.from({ length: Math.ceil(millis / BURST_MILLIS) }, (_, at) => at),
		() =>
			Effect.andThen(
				Effect.sync(() => {
					const until = ownCpu() + BURST_MILLIS
					let spins = 0
					while (ownCpu() < until) {
						spins += 1
					}
					return spins
				}),
				Effect.yieldNow
			),
		{ discard: true }
	)

/** A need of key `key` and budget `budget` (ms of CPU) whose open spends `spend` ms of its process's CPU. */
const spendingNeed = (key: string, budget: number, spend: number): Need<void> => ({
	key,
	budget,
	runNeeds: [],
	open: Effect.as(spending(spend), Effect.void)
})

/** The budget (ms of CPU) every member of a planted group states: long enough that a burst's noise is a fraction of it. */
const MEMBER_BUDGET = 200

/** Whether a planted group spends under its members' budgets summed, or over them. */
const SPENDS = ["under", "over"] as const

type Spends = (typeof SPENDS)[number]

/** How a planted group's members share what it spends: evenly, or one member spends all of it. */
const SHARES = ["evenly", "one spends all"] as const

type Share = (typeof SHARES)[number]

/** A planted group of needs opened at once: how many, whether it spends under or over its budgets summed, and how. */
type Group = Readonly<{ members: number; spends: Spends; share: Share }>

/**
 * What a group spends in all, in ms of CPU, of its members' budgets summed: under, three fifths of it, which is more
 * than any one member's budget for a group of two or more (so judging the group by its largest budget fails it); over,
 * twice it.
 */
const spentOf = (group: Group): number =>
	(group.spends === "under" ? 0.6 : 2) * group.members * MEMBER_BUDGET

/** The group's needs: each MEMBER_BUDGET, spending its share of what the group spends. */
export const groupOf = (group: Group): Arr.NonEmptyReadonlyArray<Need<void>> => {
	const spent = spentOf(group)
	const shareOf = (at: number): number => {
		switch (group.share) {
			case "evenly":
				return spent / group.members
			case "one spends all":
				return at === 0 ? spent : 0
		}
	}
	return Arr.prepend(
		Array.from({ length: group.members - 1 }, (_, at) =>
			spendingNeed(`opening.fixtures.ts member ${at + 1}`, MEMBER_BUDGET, shareOf(at + 1))
		),
		spendingNeed("opening.fixtures.ts member 0", MEMBER_BUDGET, shareOf(0))
	)
}

/** How long a waiting need's open waits, in stall windows of WAIT_STALL. */
const WAIT_WINDOWS = 3

/** The stall window a waiting need's open is judged under, in milliseconds: a meta-test's own, short. */
export const WAIT_STALL = 200

/**
 * A need whose open waits WAIT_WINDOWS stall windows of wall time spending nothing: as a declared wait on another
 * process's work (live.ts waitingOn) when `declared`, else as a plain sleep, a stall.
 */
export const waitingNeed = (declared: boolean): Need<void> => {
	const wait = liveSleep(Duration.millis(WAIT_WINDOWS * WAIT_STALL))
	return {
		key: `opening.fixtures.ts waits ${declared ? "declared" : "undeclared"}`,
		budget: MEMBER_BUDGET,
		runNeeds: [],
		open: Effect.as(declared ? waitingOn("opening.fixtures.ts's wait")(wait) : wait, Effect.void)
	}
}

/**
 * A need cache of this process, as a worker keeps one, its groups judged under `stall`, its needs opening in the
 * caller's scope with the platform, worker 0 of 1, this package's module closures and no run need values.
 */
export const cacheOf = (stall: number) =>
	Effect.gen(function* () {
		const scope = yield* Scope.Scope
		const platform = yield* Effect.context<NodeServices>()
		const closures = yield* moduleClosureAt(process.cwd(), Option.none())
		const context = Context.add(
			Context.add(
				Context.add(
					Context.add(platform, WorkerIndex, { index: 0, workers: 1 }),
					ModuleClosure,
					closures
				),
				RunValues,
				runValuesOf([])
			),
			Scope.Scope,
			scope
		)
		return needCacheOf(Effect.succeed(context), stall)
	})

/** Every planted group: one to three needs, spending under or over their budgets summed, evenly or by one alone. */
export const groups = finite((source): Group => ({
	members: source.draw(int(1, 3)),
	spends: source.draw(element(SPENDS)),
	share: source.draw(element(SHARES))
}))

/** How a group's open ended, as its property judges it: opened, or failed naming the leg that fired, or otherwise. */
export const endingOf = (opened: Result.Result<void, NeedFailed>): string =>
	Result.match(opened, {
		onSuccess: () => "opened",
		onFailure: (failed) =>
			Str.includes("of CPU, its budget")(failed.message)
				? "over its budget"
				: Str.includes("under the")(failed.message) &&
					  Str.includes("that shows progress over its stall window")(failed.message)
					? "stalled"
					: failed.message
	})

/** The runner's stall window, which a group of spending needs never comes near. */
export const RUNNER_STALL = needStallMillis
