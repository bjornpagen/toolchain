import { Array as Arr, Duration, Effect, Fiber } from "effect"
import { overrun, ownWorkNow } from "#live.ts"
import { NeedFailed } from "#runner/services.ts"
import {
	type Bound,
	boundOver,
	helpersMark,
	helpersSince,
	helpersStated,
	type Overrun,
	overrunText
} from "#runner/work.ts"

/**
 * How a process judges the opens it begins at once (runner/case.ts NeedCache, runner/runs.ts): as one piece of work,
 * since a process states its CPU, not a fiber's, so no open of a group can be told apart from the others it runs beside.
 * The group may spend its members' budgets summed (budgetOf), each its owner's measured choice, and its CPU must move
 * over every stall window of wall time outside declared waits on work; a member still opening when the group is over
 * its bound fails, unopened. A member that opens alone is judged by its own budget, the sum of one.
 */

/** What a member of a group states for its judging: its key, which a failure names, and its budget (ms of CPU). */
export type Member = Readonly<{ key: string; budget: number }>

/** The CPU (ms) a group of opens begun at once may spend: its members' budgets, summed. */
export const budgetOf = (members: ReadonlyArray<Member>): number =>
	Arr.reduce(members, 0, (total, member) => total + member.budget)

/**
 * A group's judge, begun as its members' opens begin: `within` races one member's open against the group's verdict, so
 * a member still open when the group overruns fails with NeedFailed naming the bound and what the guard measured; `ended`
 * stops the judging once every member's open has ended.
 */
export type Judged = Readonly<{
	within: <A, R>(
		key: string,
		open: Effect.Effect<A, NeedFailed, R>
	) => Effect.Effect<A, NeedFailed, R>
	ended: Effect.Effect<void>
}>

/** Milliseconds as a report states them. */
const formatted = (millis: number): string => Duration.format(Duration.millis(millis))

/** Why a member of `members` failed when the group, judged under `bound`, overran (`ran`). */
const overranText = (
	members: Arr.NonEmptyReadonlyArray<Member>,
	key: string,
	bound: Bound,
	ran: Overrun
): string => {
	const others = Arr.filter(members, (member) => member.key !== key)
	const window = `the stall window of ${formatted(bound.stall)} (needStallMillis)`
	return Arr.isReadonlyArrayNonEmpty(others)
		? `its open ran past the bound of the ${members.length} opened at once with it (${Arr.join(
				Arr.map(others, (member) => member.key),
				", "
			)}): their budgets summed, ${formatted(bound.cpu)} of CPU, and ${window}: ${overrunText(ran)}`
		: `its open ran past its budget of ${formatted(bound.cpu)} of CPU or ${window}: ${overrunText(ran)}`
}

/**
 * `open`, whatever it leaves running once it has opened stated as its need's helpers (runner/work.ts helpersStated: this
 * process's live descendants started since it began), so the work of every case that may wait on them moves while they
 * work for it (runner/work.ts keptHelpers): a stage's server, its browser, a fake's process.
 */
const helpersNamed = <A, R>(
	open: Effect.Effect<A, NeedFailed, R>
): Effect.Effect<A, NeedFailed, R> =>
	Effect.suspend(() => {
		const mark = helpersMark()
		return Effect.tap(open, () => Effect.sync(() => mark.pipe(helpersSince, helpersStated)))
	})

/**
 * Begins judging `members`, opened at once on this process from now, under their budgets summed (budgetOf) and `stall`,
 * the stall window (runner/limits.ts needStallMillis, or a test's own): over this process's work (live.ts overrun),
 * which counts every open of the group and nothing a declared wait waits on.
 */
export const judgedGroup = (
	members: Arr.NonEmptyReadonlyArray<Member>,
	stall: number
): Effect.Effect<Judged> =>
	Effect.gen(function* () {
		const bound = boundOver(budgetOf(members), stall)
		const judge = yield* Effect.forkDetach(
			Effect.flatMap(ownWorkNow, (work) => overrun(work, bound)),
			{ startImmediately: true }
		)
		return {
			within: (key, open) =>
				Effect.raceFirst(
					helpersNamed(open),
					Effect.flatMap(Fiber.join(judge), (ran) =>
						Effect.fail(
							NeedFailed.make({ need: key, message: overranText(members, key, bound, ran) })
						)
					)
				),
			ended: Fiber.interrupt(judge)
		}
	})
