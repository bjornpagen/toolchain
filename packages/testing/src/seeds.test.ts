/**
 * A steered phase's seeds (seeds.ts): a case is kept exactly when it noted or perceived something no kept case had,
 * and a pick names only what was kept.
 */
import { Array as Arr, Effect, Option } from "effect"
import { assert } from "#assert.ts"
import { array } from "#gen.ts"
import { property } from "#property.ts"
import { wordsOf } from "#random.ts"
import { perceived, tapeOf } from "#seeds.fixtures.ts"
import { seedsOf } from "#seeds.ts"
import type { Tape } from "#tape.ts"

export const seedCorpus = property.explore(array(perceived, { min: 0, max: 8 }), {
	needs: {},
	situations: ["a case kept for being first", "a case new by its trace", "a case not new"],
	check: (_resources, c) => (cases) =>
		Effect.sync(() => {
			const corpus = seedsOf()
			const seenNotes = new Set<string>()
			const seenClasses = new Set<string>()
			const kept: Array<Tape> = []
			for (const [index, { notes, trace }] of cases.entries()) {
				const classes = Arr.flatMap(trace, (traced, range) =>
					traced === 0 ? [] : [`${range} ${traced}`]
				)
				const byTrace = Arr.some(classes, (key) => !seenClasses.has(key))
				const novel = Arr.some(notes, (note) => !seenNotes.has(note)) || byTrace
				const tape = tapeOf(index)
				if (novel || kept.length === 0) {
					kept.push(tape)
				}
				if (!novel) {
					c.note(
						kept.length === 1 && index === 0 ? "a case kept for being first" : "a case not new"
					)
				} else if (byTrace) {
					c.note("a case new by its trace")
				}
				const keptNow = corpus.keep(tape, new Set(notes), Uint8Array.from(trace))
				assert.ok(
					keptNow === novel,
					`case ${index} was ${keptNow ? "kept" : "not kept"}, and it ${novel ? "is" : "is not"} new`
				)
				for (const note of notes) {
					seenNotes.add(note)
				}
				for (const key of classes) {
					seenClasses.add(key)
				}
			}
			assert.ok(
				corpus.size() === kept.length,
				`the corpus holds ${corpus.size()} seeds, and ${kept.length} were kept`
			)
			const pick = corpus.picker([])(wordsOf(cases.length))
			assert.ok(
				Option.isSome(pick) === kept.length > 0,
				`a pick is ${Option.isSome(pick) ? "some" : "none"} over ${kept.length} kept seeds`
			)
			if (Option.isSome(pick)) {
				const [seed, donor] = pick.value
				assert.ok(
					Arr.contains(kept, seed) && Arr.contains(kept, donor),
					"a pick is a kept seed and a kept donor"
				)
			}
		}),
	oracle: {
		kind: "second-implementation",
		name: "a set of the notes and of the (range, class) pairs seen so far"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/seeds.ts",
			original: "novel = novel || !notes.has(note)",
			replacement: "novel = true",
			why: "Every noted case is kept, whatever it noted."
		}
	]
})
