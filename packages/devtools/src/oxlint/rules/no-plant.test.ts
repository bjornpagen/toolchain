/**
 * The no-plant rule (src/oxlint/rules/no-plant.ts), searched over programs of one comment or several, drawn from a
 * grammar of its contract: a comment that cites a plant (the tag as a word anywhere on a line, a line that begins past
 * its lead with a prose header), written as a JSDoc block, a block or a line comment, beside comments that cite none
 * (a word that begins with the tag or a header and goes on with word characters, a header in the middle of a line, a
 * plant spoken of in prose). Every comment carries the reports the contract gives it, one for a citation and none
 * else, and oxlint's RuleTester, run in the case, must find exactly that many.
 *
 * Oracle: the specification, the rule's JSDoc read over the tag and headers its module exports (PLANT_TAG,
 * PLANT_HEADERS). Features: a tag cited, a prose header cited, a comment that cites none, a program of several comments.
 */
import { assert } from "@bjornpagen/testing/assert"
import { property } from "@bjornpagen/testing/property"
import { Effect, Option } from "effect"
import { featuresOf, judged, programs } from "#oxlint/rules/no-plant.fixtures.ts"

/** Reports exactly the comments that cite a plant. */
export const plantCitations = property.explore(programs, {
	needs: {},
	situations: [
		"a tag cited",
		"a prose header cited",
		"a comment that cites none",
		"a program of several comments"
	],
	check: (_resources, c) => (program) =>
		Effect.sync(() => {
			c.noteAll(featuresOf(program))
			assert.deepEqual(judged(program), Option.none())
		}),
	oracle: {
		kind: "specification",
		name: "the rule's stated contract over the tag and prose headers its module exports"
	},
	kept: [],
	kills: []
})
