/**
 * The no-case-list rule (src/oxlint/rules/no-case-list.ts), searched over test modules and source modules of one
 * property or several, drawn from a grammar of the spaces its contract reads in a property's spec
 * (`property.explore(space, spec)`, the testing library's searches as its oxlint module states them, the space aimed,
 * beside recorded values or neither): a list written in
 * the module, held by a constant or handed in place; a list imported, by name or through a namespace, from a module
 * of the tests (a subpath import, a relative path, a package's test directory) or from a roster or a dictionary door;
 * one value (`constant`, a range of one value); the index of a list (`int(0, xs.length - 1)`, and mapped back to the
 * list); a list handed to the dictionary's mint; a choice whose options are all case lists or not; and a range its
 * bounds define. Every property carries the reports the contract gives it in the module it is drawn in, and oxlint's
 * RuleTester, run in the case, must find exactly that many.
 *
 * Oracle: the specification, the rule's JSDoc over the testing library's case lists (CASE_LISTS) and test scope.
 * Features: a written list, an imported list, one value, an index of a list, a space that is no case list, a module of
 * test scope, a source module, a program of several properties.
 */
import { assert } from "@bjornpagen/testing/assert"
import { property } from "@bjornpagen/testing/property"
import { Effect, Option } from "effect"
import { featuresOf, judged, programs } from "#oxlint/rules/no-case-list.fixtures.ts"

/** Reports exactly the spaces that are case lists in the module they are drawn in. */
export const caseListSpaces = property.explore(programs, {
	needs: {},
	situations: [
		"a written list",
		"an imported list",
		"one value",
		"an index of a list",
		"a space that is no case list",
		"a module of test scope",
		"a source module",
		"a program of several properties"
	],
	check: (_resources, c) => (program) =>
		Effect.sync(() => {
			c.noteAll(featuresOf(program))
			assert.deepEqual(judged(program), Option.none())
		}),
	oracle: {
		kind: "specification",
		name: "the rule's stated contract over the testing library's case lists and test scope"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/oxlint/plugin.ts",
			original: '\t\t\tnames: ["map", "span", "aimed", "finite", "recorded"],',
			replacement: '\t\t\tnames: ["map", "span", "aimed", "finite"],',
			why: "A case list beside recorded values (gen.ts recorded) is no case list the rule reads, so a property over recorded(element(list), values) is never reported."
		}
	]
})
