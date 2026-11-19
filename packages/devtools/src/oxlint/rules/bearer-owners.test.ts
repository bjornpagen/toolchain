/**
 * The bearer-owners rule (src/oxlint/rules/bearer-owners.ts), searched over one statement each, drawn from a grammar of
 * its contract: a bearer credential built as a template (`Bearer ${token}`, the scheme in any case), as a
 * concatenation that starts with the scheme, or as a `bearerToken(...)` call, bare or on a receiver, beside what is no
 * bearer credential (a near scheme, the scheme in a template with no expression, the scheme as prose or after the
 * token, another request call), in a file the rule's owners list names and in one it does not. Every statement carries
 * the number of reports the contract gives it, one for a credential outside the owners and none anywhere else, and
 * oxlint's RuleTester, run in the case, must find exactly that many.
 *
 * Oracle: the specification, the rule's JSDoc: a bearer credential is presented only by its provider's adapter.
 * Features: a template, a concatenation, a call, a statement that is no credential, and a credential in an owner.
 */
import { assert } from "@bjornpagen/testing/assert"
import { property } from "@bjornpagen/testing/property"
import { Effect, Option } from "effect"
import { drawnStatements, judged } from "#oxlint/rules/bearer-owners.fixtures.ts"

export const bearerCredentialOutsideOwners = property.explore(drawnStatements, {
	needs: {},
	situations: [
		"a template",
		"a concatenation",
		"a call",
		"a statement that is no credential",
		"a credential in an owner"
	],
	check: (_resources, c) => (drawn) =>
		Effect.sync(() => {
			c.note(drawn.statement.kind)
			assert.deepEqual(judged(drawn), Option.none())
		}),
	oracle: {
		kind: "specification",
		name: "the rule's stated contract: a bearer credential is presented only by its provider's adapter"
	},
	kept: [],
	kills: [
		{
			file: "packages/devtools/src/oxlint/rules/bearer-owners.ts",
			original: "\t\t\t\tArr.isReadonlyArrayNonEmpty(node.expressions) &&",
			replacement: "\t\t\t\tArr.isReadonlyArrayEmpty(node.expressions) &&",
			why: "A template that starts with `Bearer ` and holds an expression is read as no credential, so one built outside the owners goes unreported; the statement property fails."
		}
	]
})
