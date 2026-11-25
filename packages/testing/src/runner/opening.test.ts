/**
 * How a process judges the needs it opens at once (runner/opening.ts judgedGroup, runner/case.ts NeedCache): as one
 * piece of work, since a process states its CPU and not a fiber's. A group whose opens spend under their budgets summed
 * opens, however its members share the spending, and one that spends over them fails, unopened, naming the bound: a need
 * that opens alone is judged by its own budget, never the runner's. A need's open that waits past the stall window in a
 * declared wait on another process's work (live.ts waitingOn) opens, and one that waits as long undeclared stalls and
 * fails. Oracles are stated per property.
 */
import { Effect } from "effect"
import { assert } from "#assert.ts"
import { boolean, finite } from "#gen.ts"
import { property } from "#property.ts"
import {
	cacheOf,
	endingOf,
	groupOf,
	groups,
	RUNNER_STALL,
	WAIT_STALL,
	waitingNeed
} from "#runner/opening.fixtures.ts"

export const groupsByTheirBudgets = property.exhaust(groups, {
	box: "one to three needs opened at once, spending three fifths of their budgets summed or twice them, evenly or by one alone",
	needs: {},
	situations: [],
	check: () => (group) =>
		Effect.scoped(
			Effect.gen(function* () {
				const cache = yield* cacheOf(RUNNER_STALL)
				const opened = yield* Effect.result(cache.opened(groupOf(group)))
				assert.equal(endingOf(opened), group.spends === "under" ? "opened" : "over its budget")
			})
		),
	oracle: {
		kind: "specification",
		name: "a group of needs opened at once opens when it spends under their budgets summed and fails, unopened, over them; a need alone is held to its own"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/opening.ts",
			original: "\t\tconst bound = boundOver(budgetOf(members), stall)\n",
			replacement: "\t\tconst bound = boundOver(300_000, stall)\n",
			why: "Every open is held to the runner-wide open bound, 300 s of CPU (needOpenMillis), as before each need stated its budget: a group spending twice its budgets opens; the property fails."
		},
		{
			file: "packages/testing/src/runner/opening.ts",
			original: "\tArr.reduce(members, 0, (total, member) => total + member.budget)\n",
			replacement: "\tArr.reduce(members, 0, (most, member) => Math.max(most, member.budget))\n",
			why: "A group opened at once is held to its largest member's budget, not to their sum: a group of two or three spending three fifths of its budgets summed, more than any one of them, fails; the property fails."
		}
	]
})

export const declaredWaitsDoNotStall = property.exhaust(finite(boolean), {
	box: "a need's open that waits three stall windows, declared or not",
	needs: {},
	situations: [],
	check: () => (declared) =>
		Effect.scoped(
			Effect.gen(function* () {
				const cache = yield* cacheOf(WAIT_STALL)
				const opened = yield* Effect.result(cache.opened([waitingNeed(declared)]))
				assert.equal(endingOf(opened), declared ? "opened" : "stalled")
			})
		),
	oracle: {
		kind: "specification",
		name: "a need's open that waits past its stall window in a declared wait opens, and one that waits as long undeclared stalls and fails"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/live.ts",
			original:
				"\t\t\tEffect.flatMap(liveMillis, (wall) => Effect.sync(() => enterWait(wall, on))),\n\t\t\t() => effect,\n\t\t\t(id) => Effect.flatMap(liveMillis, (wall) => Effect.sync(() => leaveWait(wall, id)))",
			replacement: "\t\t\tEffect.succeed(0),\n\t\t\t() => effect,\n\t\t\t() => Effect.void",
			why: "waitingOn declares nothing, so a need's open that waits on another process's work stalls past the stall window and fails, unopened; the property fails."
		}
	]
})
