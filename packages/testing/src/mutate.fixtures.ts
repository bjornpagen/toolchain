import { Array as Arr } from "effect"
import { array, boolean, element, type Gen, int, map, weighted } from "#gen.ts"
import { wordsOf } from "#random.ts"
import { generate, randomChooser, recorder } from "#source.ts"
import type { Tape } from "#tape.ts"

/** A generator with every structure a tape records: a dependent bound, collections, weighted arms and spans. */
export const structured: Gen<unknown> = (source) => {
	const bound = source.draw(int(0, 6))
	return {
		items: source.draw(
			array(
				weighted([
					[1, int(0, bound)],
					[2, map(array(boolean, { min: 0, max: 3 }), (flags) => flags.length)]
				]),
				{ min: 0, max: 5 }
			)
		),
		label: source.draw(element(["a", "b", "c"]))
	}
}

/** A tape drawn fresh from a seed of `structured`. */
export const tapeOf = (seed: number): Tape =>
	generate(recorder(), structured, randomChooser(wordsOf(seed))).tape

/** The lengths of a tape's spans of `label`. */
const spanLengths = (tape: Tape, label: string): ReadonlyArray<number> =>
	Arr.flatMap(Arr.fromIterable(tape.spanLabel.entries()), ([span, spanLabel]) =>
		spanLabel === label ? [(tape.spanEnd[span] ?? 0) - (tape.spanStart[span] ?? 0)] : []
	)

/**
 * The lengths a mutant of `seed` with `donor` may have, by the mutator's definition: its seed's, after point edits or
 * a span set simplest; any prefix of it, cut short; and its seed's less one span's decisions, the span deleted, plus
 * that span's again, repeated, or plus a span of the donor with the same label in its place.
 */
export const lengthsOf = (seed: Tape, donor: Tape): ReadonlySet<number> => {
	const lengths = new Set<number>(Array.from({ length: seed.length + 1 }, (_, i) => i))
	for (const [span, label] of seed.spanLabel.entries()) {
		const own = (seed.spanEnd[span] ?? 0) - (seed.spanStart[span] ?? 0)
		lengths.add(seed.length - own)
		lengths.add(seed.length + own)
		for (const donated of spanLengths(donor, label)) {
			lengths.add(seed.length - own + donated)
		}
	}
	return lengths
}

/** Whether every decision of a tape lies within its range. */
export const withinRanges = (tape: Tape): boolean =>
	Arr.every(
		Arr.fromIterable(tape.values.entries()),
		([at, value]) => value >= (tape.lo[at] ?? 0) && value <= (tape.hi[at] ?? 0)
	)

/** The seeds of one mutation: the tape mutated, its donor, and the words the mutator draws its edits from. */
type Seeds = Readonly<{ seed: number; donor: number; words: number }>

/** Three seeds, each any 32-bit word. */
export const seeds: Gen<Seeds> = (source) => ({
	seed: source.draw(int(0, 0xffff_ffff)),
	donor: source.draw(int(0, 0xffff_ffff)),
	words: source.draw(int(0, 0xffff_ffff))
})
