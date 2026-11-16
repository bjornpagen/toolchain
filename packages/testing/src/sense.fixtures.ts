import { Effect } from "effect"
import { perceptionOf } from "#runner/perceive.ts"
import type { Trace } from "#runner/protocol.ts"

/**
 * What block coverage's property (runner/perceive.ts, the sense a guided search's steered phase perceives through)
 * senses: this module's branch, which a case takes or skips, perceived as the runner perceives a case.
 */

/** This module, as a guide names the file whose blocks it perceives. */
export const BRANCH_FILE = "/sense.fixtures.ts"

/** Takes its branch only when told to. */
const branch = (taken: boolean): number => {
	if (taken) {
		return 1
	}
	return 0
}

/**
 * What the process's perception of this file's blocks perceives of each case, one after another, as each takes the
 * branch or not.
 */
export const perceivedEach = (takes: ReadonlyArray<boolean>) =>
	Effect.gen(function* () {
		const perception = yield* perceptionOf
		return yield* Effect.forEach(takes, (taken) =>
			Effect.map(
				perception.perceive(
					{ kind: "blocks", files: [BRANCH_FILE] },
					Effect.sync(() => branch(taken))
				),
				([, trace]): Trace => trace
			)
		)
	})
