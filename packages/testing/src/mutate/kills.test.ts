/**
 * The kill gate (mutate/kills.ts), on real worker images: each kill is applied to its file in a checkout and its
 * property's check runs on a process started from the kill's image, the module hook for a property that loads the code
 * in process, a worker tree for one that needs Checkout.dir; a kill whose original stands anywhere but once is stale; a
 * kill of a check that goes red with no mutant is unjudged, whatever its own trial would show; a kill the check catches
 * is killed, whether the check runs the file in its own process or, from a tree, in a child; a
 * kill it misses survives, its probe saying whether the property's process loaded the mutant at all, which a check
 * that runs the file in a child without a tree never does. The check starts processes that load the hook (hook.ts),
 * so the property needs Checkout.dir.
 */
import { Array as Arr, Effect } from "effect"
import { assert } from "#assert.ts"
import { array, element } from "#gen.ts"
import { Checkout } from "#mutate/checkout.ts"
import { imagesOf } from "#mutate/image.ts"
import {
	CHECKS,
	checkoutOf,
	expectedOf,
	type Gate,
	KILL_NAMES,
	KILLS,
	reportOf
} from "#mutate/kills.fixtures.ts"
import { killsOf } from "#mutate/kills.ts"
import { checkProperty, processPool } from "#mutate/processes.fixtures.ts"
import type { Subject } from "#mutate/schedule.ts"
import { treesOf } from "#mutate/tree.ts"
import { property, PropertyId } from "#property.ts"
import { runnerLimits } from "#runner/limits.ts"

export const killGate = property.explore(
	(source): Gate => ({
		check: source.draw(element(CHECKS)),
		loading: source.draw(element(["in-process", "tree"])),
		kills: Arr.prepend(
			source.draw(array(element(KILL_NAMES), { min: 0, max: 2 })),
			source.draw(element(KILL_NAMES))
		)
	}),
	{
		needs: { checkout: Checkout.dir },
		situations: [...KILL_NAMES, ...CHECKS, "in-process", "tree"],
		check: (_resources, c) => (gate) =>
			Effect.gen(function* () {
				c.noteAll([...gate.kills, gate.check, gate.loading])
				const checkout = yield* checkoutOf
				const trees = yield* treesOf(checkout)
				const images = yield* imagesOf(checkout, trees)
				const pool = yield* processPool
				const subject: Subject = {
					id: PropertyId(gate.check),
					property: checkProperty(Arr.map(gate.kills, (name) => KILLS[name])),
					loading: gate.loading
				}
				const judged = yield* killsOf(pool, { seed: 1, limits: runnerLimits }, checkout, images, [
					subject
				])
				assert.deepEqual(
					Arr.map(judged, reportOf),
					Arr.map(gate.kills, (name) => expectedOf(gate, name))
				)
			}),
		oracle: {
			kind: "specification",
			name: "stale unless the original stands once; unjudged when the check goes red with no mutant; killed when the check catches it where it runs the file; a survivor loaded exactly when the check runs the file in its process or from a tree"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/mutate/kills.ts",
				original: "return red === undefined ? Result.succeed(one) : Result.fail({ ...one, red })",
				replacement: "return Result.succeed(one)",
				why: "A property red with no mutant has its kills tried anyway, so any red it shows reads as the kill's, and a kill of nothing is killed."
			},
			{
				file: "packages/testing/src/mutate/kills.ts",
				original: 'return { kind: "survived", loaded: true }',
				replacement: 'return { kind: "survived", loaded: false }',
				why: "A survivor whose probe went red is reported as never loaded."
			},
			{
				file: "packages/testing/src/mutate/kills.ts",
				original: "image: images.open(subject.loading, Option.some(probe)),",
				replacement: "image: images.open(subject.loading, Option.some(mutated)),",
				why: "The probe stage runs the kill again instead of the probe."
			},
			{
				file: "packages/testing/src/mutants.ts",
				original: "return places.length === 1 && at !== undefined",
				replacement: "return places.length >= 1 && at !== undefined",
				why: "A kill whose original stands in several places applies at the first of them, never stale."
			}
		]
	}
)
