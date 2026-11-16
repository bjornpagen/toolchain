import { Effect } from "effect"
import { finite, int } from "#gen.ts"
import { property } from "#property.ts"
import { Scratch } from "#resources/scratch.ts"

/**
 * A module whose load never ends, for the pool's dispatch watch (pool.test.ts loadsNever): its top level loops forever,
 * as a mutant's top-level loop does in a module a property's module imports (CATCH: grizzle's engine, a dyadic
 * exponent's loop under a mutant of percentile.ts), so a worker that imports it never runs anything after, nor gets a
 * word out to the parent. Its two properties, one with needs and one without, are never reached. Nothing imports this
 * module; a worker loads it by a property's identity.
 */

/** The cell the loop reads, which nothing writes. */
const cell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))

while (Atomics.load(cell, 0) === 0) {
	Atomics.add(cell, 0, 0)
}

/** A property with a need, never readied: its module's load never ends. */
export const withNeeds = property.exhaust(finite(int(0, 1)), {
	box: "two values",
	needs: { directory: Scratch.dir },
	situations: [],
	check: () => () => Effect.void,
	oracle: { kind: "specification", name: "a property planted in a module whose load never ends" },
	kept: [],
	kills: []
})

/** A property with no need, never readied: its module's load never ends. */
export const withoutNeeds = property.exhaust(finite(int(0, 1)), {
	box: "two values",
	needs: {},
	situations: [],
	check: () => () => Effect.void,
	oracle: { kind: "specification", name: "a property planted in a module whose load never ends" },
	kept: [],
	kills: []
})
