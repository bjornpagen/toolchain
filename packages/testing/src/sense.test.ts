/**
 * Block coverage as the runner perceives it (runner/perceive.ts, what a guided search's steered phase reads): each
 * case's trace is what its own case ran, whatever cases the process perceived before it, so two cases that take a
 * branch alike perceive alike and a take and a skip perceive differently. Oracle: universal, stated in the property.
 * Its guide names the file it perceives, so the worker that runs it counts that file's blocks from before it loads, as
 * a guided search needs.
 */
import { Array as Arr, Effect, Equal, Option } from "effect"
import { assert } from "#assert.ts"
import { array, boolean } from "#gen.ts"
import { property } from "#property.ts"
import { BRANCH_FILE, perceivedEach } from "#sense.fixtures.ts"

export const senseIndependence = property.explore(array(boolean, { min: 2, max: 5 }), {
	needs: {},
	situations: ["a skip after a take", "a take after a skip", "two skips in a row"],
	guide: { blocks: [BRANCH_FILE] },
	check: (_resources, c) => (takes) =>
		Effect.gen(function* () {
			Arr.forEach(Arr.zip(takes, Arr.drop(takes, 1)), ([before, after]) => {
				if (before && !after) {
					c.note("a skip after a take")
				}
				if (!before && after) {
					c.note("a take after a skip")
				}
				if (!before && !after) {
					c.note("two skips in a row")
				}
			})
			const traces = yield* perceivedEach(takes)
			const firstOf = (taken: boolean) =>
				Arr.findFirst(traces, (_trace, at) => Arr.getUnsafe(takes, at) === taken)
			const taken = firstOf(true)
			const skipped = firstOf(false)
			assert.deepEqual(
				{
					traces: Arr.map(traces, (trace) => Option.some(trace)),
					apart:
						Option.isSome(taken) && Option.isSome(skipped)
							? Option.some(!Equal.equals(taken.value, skipped.value))
							: Option.none()
				},
				{
					traces: Arr.map(takes, (take) => firstOf(take)),
					apart: Option.isSome(taken) && Option.isSome(skipped) ? Option.some(true) : Option.none()
				}
			)
		}),
	oracle: {
		kind: "universal",
		name: "a trace is a function of its case alone, and a take and a skip of one branch perceive differently"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/perceive.ts",
			original: "\t\t\t\t\t\treturn [value, traceOf(after, sense.files)] as const",
			replacement: "\t\t\t\t\t\treturn [value, []] as const",
			why: "A case perceived by blocks gives back an empty trace, so a guided search perceives nothing of the code it runs (sense-v8-blind, re-anchored from sense.ts's v8Coverage to runner/perceive.ts, the sense a guided search reads); the sense independence property fails."
		}
	]
})
