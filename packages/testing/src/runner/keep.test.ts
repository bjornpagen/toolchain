/**
 * The kept-value search (runner/keep.ts keptOf): every text a drawn space draws has a tape keep finds, which draws it
 * again exactly. The spaces spell integers inside a text, which no length or character code of it pins, and offer
 * arms whose simplest draws a target cannot tell apart, so only an arm's greedy completion shows which one draws it.
 */
import { Effect, Formatter } from "effect"
import { assertTrue } from "#assert.ts"
import { property } from "#property.ts"
import { featuresOf, type KeepFeature, shapes, spaceOf } from "#runner/keep.fixtures.ts"
import { keptOf } from "#runner/keep.ts"

export const everyDrawnValueHasATapeKeepFinds = property.explore(shapes, {
	needs: {},
	situations: [
		"an integer spelled past a digit",
		"an arm only its completion tells apart"
	] satisfies ReadonlyArray<KeepFeature>,
	check: (_resources, c) => (parts) =>
		Effect.sync(() => {
			const space = spaceOf(parts)
			const target = c.draw(space)
			c.noteAll(featuresOf(parts, target))
			const kept = keptOf(space, target)
			assertTrue(
				kept.kind === "found",
				`keep finds a tape of ${Formatter.format(target)}: ${kept.kind === "unfound" ? kept.why : "found"}`
			)
		}),
	oracle: {
		kind: "universal",
		name: "a value the space draws: keep finds a tape the space draws it from, and the tape draws it again"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/keep.ts",
			original:
				"\t\t\tfor (const spelled of spelledIntegersOf(value)) {\n\t\t\t\tfound.add(spelled)\n\t\t\t}\n",
			replacement: "",
			why: "A string's literals are its length and character codes alone, so an integer it spells past a digit is pinned by no candidate of its decision."
		},
		{
			file: "packages/testing/src/runner/keep.ts",
			original:
				"\t\tconst [befores, afters, wanteds] = [spelled(before), spelled(after), spelled(wanted)]",
			replacement: "\t\tconst [befores, afters, wanteds] = [[], spelled(after), spelled(wanted)]",
			why: "A probe reads a leaf as a number alone, so an int of a range above zero spelled in a text, whose decision is its value less its range's least, is reached by no probe."
		},
		{
			file: "packages/testing/src/runner/keep.ts",
			original: "\t\tconst tried = greedyFrom(space, target, [...fixed, c.candidate])",
			replacement: "\t\tconst tried = triedOn(space, target, [...fixed, c.candidate])",
			why: "A candidate is judged by its simplest draw alone, so two arms that print alike until a digit is drawn tie, the first is taken, and a text of the second is never found."
		}
	]
})
