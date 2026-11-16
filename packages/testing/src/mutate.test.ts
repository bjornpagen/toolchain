/**
 * Tape mutation (mutate.ts): the same mutant from the same words, of a length its edits allow, replaying within every
 * decision's range. Oracle: stated in the property.
 */
import { Array as Arr, Effect, Option } from "effect"
import { assertTrue, deepStrictEqual } from "#assert.ts"
import { lengthsOf, seeds, structured, tapeOf, withinRanges } from "#mutate.fixtures.ts"
import { mutate } from "#mutate.ts"
import { property } from "#property.ts"
import { wordsOf } from "#random.ts"
import { generate, prefixChooser, randomChooser, recorder } from "#source.ts"

/**
 * The tape mutator makes the same mutant from the same words, of a length its edits allow, that replays within every
 * decision's range.
 */
export const tapeMutation = property.explore(seeds, {
	needs: {},
	situations: [],
	check:
		() =>
		({ seed, donor, words }) =>
			Effect.sync(() => {
				const seedTape = tapeOf(seed)
				const donorTape = tapeOf(donor)
				const mutant = mutate(seedTape, Option.some(donorTape), wordsOf(words))
				const again = mutate(seedTape, Option.some(donorTape), wordsOf(words))
				deepStrictEqual(
					Arr.fromIterable(again.values.subarray(0, again.length)),
					Arr.fromIterable(mutant.values.subarray(0, mutant.length))
				)
				assertTrue(
					lengthsOf(seedTape, donorTape).has(mutant.length),
					`a mutant of ${mutant.length} decisions, of a seed of ${seedTape.length}`
				)
				const replayed = generate(
					recorder(),
					structured,
					prefixChooser(mutant.values, mutant.length, randomChooser(wordsOf(words)))
				).tape
				assertTrue(withinRanges(replayed), "every replayed decision within its range")
			}),
	oracle: { kind: "specification", name: "the mutator's edits and every decision's range" },
	kept: [],
	kills: [
		{
			file: "packages/testing/src/source.ts",
			original: "\t\tconst fits = offered >= lo && offered <= hi",
			replacement: "\t\tconst fits = offered >= lo",
			why: "A replayed value past its decision's highest value is kept, not replayed as the decision's simplest, so a mutant replays outside its decision's range; the property fails."
		}
	]
})
