import { createHook } from "node:async_hooks"
import { Duration, Effect, Record as Rec } from "effect"
import { element, finite, type Gen, int, map } from "#gen.ts"
import { HUNG_CLEANUP_GRACE, liveSleep } from "#live.ts"
import { type Case, type Need, NeedFailed, type Property, property } from "#property.ts"
import { widths } from "#runner/search.fixtures.ts"

/**
 * What the meta-tests of a case's evaluation (runner/case.ts) share: inner properties that hang, that use their case
 * after it ended, that run synchronously, whose cases hold a resource with a cleanup of a drawn length, and whose needs
 * take a drawn time to open and end as drawn.
 */

/** The oracle of an inner search: a property planted to exercise a case's evaluation. */
const planted = {
	kind: "specification",
	name: "a property planted to exercise a case's evaluation"
} as const

/** An inner search over 0..9 whose every case hangs. */
export const hanging: Property = property.explore(int(0, 9), {
	needs: {},
	situations: [],
	check: () => () => Effect.never,
	oracle: planted,
	kept: [],
	kills: []
})

/** How a property uses its case after the case ended: by a note, a draw, an observation or a measure. */
export const LATE_USES = ["a note", "a draw", "an observation", "a measure"] as const

export type LateUse = (typeof LATE_USES)[number]

export const lateUses: Gen<LateUse> = (source) => source.draw(element(LATE_USES))

/** Uses an ended case as `use` says. */
const useLate = (use: LateUse, ended: Case<"late">): void => {
	switch (use) {
		case "a note":
			ended.note("late")
			return
		case "a draw":
			ended.draw(int(0, 9))
			return
		case "an observation":
			ended.observe("decided late")
			return
		case "a measure":
			ended.measure("late", 1)
			return
	}
}

/** An inner search over 0..9 whose property uses every earlier case, each ended by now, as `use` says. */
export const usingLate = (use: LateUse): Property => {
	const ended: Array<Case<"late">> = []
	return property.explore(int(0, 9), {
		needs: {},
		situations: [],
		check: (_resources, c: Case<"late">) => () =>
			Effect.sync(() => {
				for (const earlier of ended) {
					useLate(use, earlier)
				}
				ended.push(c)
			}),
		oracle: planted,
		kept: [],
		kills: []
	})
}

/** The kinds of synchronous property the inline gate runs: none of them ever yields to the event loop. */
export const SYNC_PROPERTIES = ["void", "sync", "steps"] as const

export type SyncProperty = (typeof SYNC_PROPERTIES)[number]

export const syncProperties: Gen<SyncProperty> = (source) => source.draw(element(SYNC_PROPERTIES))

/** A property of each kind, every one synchronous. */
const syncCheck = (kind: SyncProperty) => (value: number) => {
	switch (kind) {
		case "void":
			return Effect.void
		case "sync":
			return Effect.asVoid(Effect.sync(() => value * 2))
		case "steps":
			return Effect.gen(function* () {
				const doubled = yield* Effect.succeed(value * 2)
				yield* Effect.sync(() => doubled + 1)
			})
	}
}

/** An exhaustion of `cases` values whose property is synchronous. */
export const syncExhaustion = (kind: SyncProperty, cases: number): Property =>
	property.exhaust(finite(int(0, cases - 1)), {
		box: "every value below the drawn count",
		needs: {},
		situations: [],
		check: () => syncCheck(kind),
		oracle: planted,
		kept: [],
		kills: []
	})

/**
 * The timers and the event-loop hops a run of `effect` makes: the Timeout and Immediate resources Node creates while it
 * runs, read through an async hook, which sees every one whatever schedules it.
 */
export const scheduledBy = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const made = { timers: 0, hops: 0 }
		const hook = createHook({
			init: (_id, type) => {
				if (type === "Timeout") {
					made.timers += 1
				}
				if (type === "Immediate") {
					made.hops += 1
				}
			}
		})
		yield* Effect.acquireUseRelease(
			Effect.sync(() => hook.enable()),
			() => effect,
			() => Effect.sync(() => hook.disable())
		)
		return made
	})

/** The hung-cleanup grace, in milliseconds: how long a hung case's cleanup is waited for before its case is reported. */
export const graceMillis = Duration.toMillis(HUNG_CLEANUP_GRACE)

/** A cleanup the grace waits for: a short release. */
export const shortReleases: Gen<number> = int(0, 200)

/** A cleanup past the hung-cleanup grace, which the grace does not wait for and the process's keeper does. */
export const pastTheGrace: Gen<number> = map(int(500, 1500), (past) => graceMillis + past)

/** A drawn inner search whose cases hold a resource: how many it runs, which one blocks, its cleanup, its deadline. */
export type Lifetimes = Readonly<{
	cases: number
	blocksAt: number
	releaseMillis: number
	deadline: number
	width: number
}>

/** A drawn lifetimes search whose cleanups take what `releases` draws. */
export const lifetimes =
	(releases: Gen<number>): Gen<Lifetimes> =>
	(source) => {
		const cases = source.draw(int(1, 4))
		return {
			cases,
			blocksAt: source.draw(int(0, cases)),
			releaseMillis: source.draw(releases),
			deadline: source.draw(int(20, 200)),
			width: source.draw(widths)
		}
	}

/** What a lifetimes search did: the cases it started, the resources they acquired, and the ones released. */
export type Counts = { started: number; acquired: number; released: number }

/**
 * An inner search whose every case acquires a resource whose release takes `releaseMillis` on the live clock, and whose
 * case at `blocksAt` then never ends, so it is hung at its deadline; and the counts it keeps.
 */
export const lifetimesOf = (shape: Lifetimes): Readonly<{ counts: Counts; property: Property }> => {
	const counts: Counts = { started: 0, acquired: 0, released: 0 }
	return {
		counts,
		property: property.explore(int(0, 2 ** 31 - 1), {
			needs: {},
			situations: [],
			check: () => () =>
				Effect.suspend(() => {
					const index = counts.started
					counts.started += 1
					return Effect.scoped(
						Effect.gen(function* () {
							yield* Effect.acquireRelease(
								Effect.sync(() => {
									counts.acquired += 1
								}),
								() =>
									Effect.andThen(
										liveSleep(Duration.millis(shape.releaseMillis)),
										Effect.sync(() => {
											counts.released += 1
										})
									)
							)
							if (index === shape.blocksAt) {
								return yield* Effect.never
							}
						})
					)
				}),
			oracle: planted,
			kept: [],
			kills: []
		})
	}
}

/** How a drawn need's open ends: it opens, its open fails, or it runs past the open bound. */
const OPEN_ENDINGS = ["opens", "fails", "outruns the open bound"] as const

export type OpenEnding = (typeof OPEN_ENDINGS)[number]

/** The ways a need may fail to open. */
export const UNOPENED_ENDINGS = ["fails", "outruns the open bound"] as const

export type UnopenedEnding = (typeof UNOPENED_ENDINGS)[number]

export const unopenedEndings: Gen<UnopenedEnding> = (source) =>
	source.draw(element(UNOPENED_ENDINGS))

/** The message a drawn need's failing open fails with. */
export const FAILED_OPEN = "the drawn need's open failed"

/** What a needing search counted: the opens its needs started, and the checks its cases started. */
export type OpenCounts = { opens: number; checks: number }

/**
 * A need of key `key` whose open counts itself in `counts`, takes `millis` on the live clock (none at once), then ends
 * as `ending` says: opens (its resource the count of opens so far), or fails with FAILED_OPEN; an open meant to outrun
 * its bound opens, late.
 */
const drawnNeed = (
	key: string,
	millis: number,
	ending: OpenEnding,
	counts: OpenCounts
): Need<number> => ({
	key,
	open: Effect.andThen(
		Effect.sync(() => {
			counts.opens += 1
		}),
		Effect.andThen(
			millis > 0 ? liveSleep(Duration.millis(millis)) : Effect.void,
			ending === "fails"
				? Effect.fail(NeedFailed.make({ need: key, message: FAILED_OPEN }))
				: Effect.sync(() => Effect.succeed(counts.opens))
		)
	)
})

/**
 * An inner search over 0..9 whose property needs one drawn need, `drawn` (its open `millis` long, ending as `ending`
 * says), beside `others` needs that open at once, and whose every case takes each of them; and its counts.
 */
export const needing = (
	millis: number,
	ending: OpenEnding,
	others: number
): Readonly<{ counts: OpenCounts; property: Property }> => {
	const counts: OpenCounts = { opens: 0, checks: 0 }
	const needs: Readonly<Record<string, Need<number>>> = {
		drawn: drawnNeed("drawn", millis, ending, counts),
		...Rec.fromEntries(
			Array.from(
				{ length: others },
				(_, at) => [`other${at}`, drawnNeed(`other${at}`, 0, "opens", counts)] as const
			)
		)
	}
	return {
		counts,
		property: property.explore(int(0, 9), {
			needs,
			situations: [],
			check: (resources) => () =>
				Effect.gen(function* () {
					counts.checks += 1
					for (const resource of Rec.values(resources)) {
						yield* resource
					}
				}),
			oracle: planted,
			kept: [],
			kills: []
		})
	}
}

/** A need slower to open than the case deadline: the deadline, and the open, three to eight deadlines long. */
export type SlowOpen = Readonly<{ deadline: number; openMillis: number }>

export const slowOpens: Gen<SlowOpen> = (source) => {
	const deadline = source.draw(int(10, 50))
	return { deadline, openMillis: source.draw(int(3 * deadline, 8 * deadline)) }
}
