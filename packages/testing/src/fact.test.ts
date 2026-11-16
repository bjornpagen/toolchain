import { Effect, Option, Ref } from "effect"
/**
 * Awaiting a fact (fact.ts awaitFact): the value returned holds the fact and lies within what concurrent fibers made
 * true, waiting on no timer. Oracle: the specification, stated in the search.
 */
import { deepStrictEqual } from "#assert.ts"
import { awaitFact } from "#fact.ts"
import { int } from "#gen.ts"
import { property } from "#property.ts"

/**
 * A fact a concurrent fiber makes true: `fibers` fibers each count up `steps` times, and the wait asks for a count of at
 * least `threshold`, at most what they reach together.
 */
type Counting = Readonly<{ fibers: number; steps: number; threshold: number }>

export const awaitedFact = property.explore(
	(source): Counting => {
		const fibers = source.draw(int(1, 3))
		const steps = source.draw(int(0, 100))
		return { fibers, steps, threshold: source.draw(int(0, fibers * steps)) }
	},
	{
		needs: {},
		situations: ["true from the start", "true only at the end", "several fibers"],
		check:
			(_resources, c) =>
			({ fibers, steps, threshold }) =>
				Effect.gen(function* () {
					const total = fibers * steps
					if (threshold === 0) {
						c.note("true from the start")
					}
					if (threshold === total && total > 0) {
						c.note("true only at the end")
					}
					if (fibers > 1) {
						c.note("several fibers")
					}
					const count = yield* Ref.make(0)
					const countUp = Effect.gen(function* () {
						for (let step = 0; step < steps; step += 1) {
							yield* Ref.update(count, (n) => n + 1)
						}
					})
					for (let fiber = 0; fiber < fibers; fiber += 1) {
						yield* Effect.forkChild(countUp)
					}
					const reached = yield* awaitFact(
						Effect.map(Ref.get(count), (n) => (n >= threshold ? Option.some(n) : Option.none()))
					)
					deepStrictEqual(
						{ holds: reached >= threshold, within: reached <= total },
						{ holds: true, within: true }
					)
				}),
		oracle: {
			kind: "specification",
			name: "the value returned holds the fact and lies within what the fibers counted, the clock unmoved"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/fact.ts",
				original: "\t\twhile (Option.isNone(seen)) {\n\t\t\tyield* Effect.yieldNow",
				replacement: "\t\tif (Option.isNone(seen)) {",
				why: "The fact is read twice at most, back to back with no yield to the fibers that make it true, and its value returned though it does not hold; the property fails."
			}
		]
	}
)
