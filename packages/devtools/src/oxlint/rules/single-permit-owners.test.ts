/**
 * The single-permit-owners rule (src/oxlint/rules/single-permit-owners.ts), searched over programs of one statement or
 * several, drawn from a grammar of its contract: a semaphore made with one permit by each constructor its module
 * exports, an effect run under one permit (a semaphore's method, Semaphore's function), beside what is no single-permit
 * lock (more permits, a width held by a name, one permit taken by `withPermit`, a near name), in a file the rule's
 * owners name and in one they do not. Every statement carries the reports the contract gives it, one for a lock outside
 * the owners and none else, and oxlint's RuleTester, run in the case, must find exactly that many.
 *
 * Oracle: the specification, the rule's JSDoc read over the constructors and the call its module exports (SEMAPHORES,
 * WITH_PERMITS). Features: a lock made, a lock taken, a statement that is no lock, a lock in an owner, a program of
 * several statements.
 */
import { deepStrictEqual } from "@bjornpagen/testing/assert"
import { property } from "@bjornpagen/testing/property"
import { Effect, Option } from "effect"
import { featuresOf, judged, programs } from "#oxlint/rules/single-permit-owners.fixtures.ts"

/** Reports exactly the single-permit locks outside the owners. */
export const singlePermitLocksOutsideOwners = property.explore(programs, {
	needs: {},
	situations: [
		"a lock made",
		"a lock taken",
		"a statement that is no lock",
		"a lock in an owner",
		"a program of several statements"
	],
	check: (_resources, c) => (program) =>
		Effect.sync(() => {
			c.noteAll(featuresOf(program))
			deepStrictEqual(judged(program), Option.none())
		}),
	oracle: {
		kind: "specification",
		name: "the rule's stated contract over the constructors and the call its module exports"
	},
	kept: [],
	kills: []
})
