import { createHook } from "node:async_hooks"
import { Duration, Effect } from "effect"
import { element, finite, type Gen, int, map } from "#gen.ts"
import { HUNG_CLEANUP_GRACE, liveSleep } from "#live.ts"
import { type Case, type Property, property } from "#property.ts"
import { widths } from "#runner/search.fixtures.ts"

/**
 * What the meta-tests of a case's evaluation (runner/case.ts) share: inner properties that hang, that use their case
 * after it ended, that run synchronously, and whose cases hold a resource with a cleanup of a drawn length.
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
