import { Context, Effect, Fiber } from "effect"
import type { Collected } from "#runner/observe.ts"

/**
 * The collection the running fiber's acts go to beside its window (runner/observe.ts Collected): a database template's
 * build's (resources/template.ts), none outside one. The guard reads it of the fiber running at each act
 * (collectingNow), so what a build reads is the build's whatever module reads it, as the runner's own work is told from
 * a property's (runner/infrastructure.ts).
 */
const Collecting = Context.Reference<Collected | undefined>(
	"@bjornpagen/testing/runner/collected/Collecting",
	{ defaultValue: () => undefined }
)

/**
 * `effect`'s value with what it read and observed (Collected), every fiber it forks included. A collection inside
 * another is the other's too: what the inner work read, the outer work read through it, so its reads join the outer
 * collection, and its observation is the outer one's where that has none.
 */
export const collectedOf = <A, E, R>(
	effect: Effect.Effect<A, E, R>
): Effect.Effect<readonly [A, Collected], E, R> =>
	Effect.gen(function* () {
		const outer = yield* Collecting
		const collected: Collected = { reads: [], observed: undefined }
		const value = yield* Effect.provideService(effect, Collecting, collected)
		if (outer !== undefined) {
			for (const read of collected.reads) {
				outer.reads.push(read)
			}
			outer.observed = outer.observed ?? collected.observed
		}
		return [value, collected] as const
	})

/** The collection of the fiber running now (Collecting): what the guard asks of each act (runner/observe.ts guardCollecting). */
export const collectingNow = (): Collected | undefined => {
	const fiber = Fiber.getCurrent()
	return fiber === undefined ? undefined : Context.get(fiber.context, Collecting)
}
