import { array, type Gen, int, subarray } from "#gen.ts"
import { wordsOf } from "#random.ts"
import { TRACE_CLASSES } from "#sense.ts"
import { generate, randomChooser, recorder } from "#source.ts"
import type { Tape } from "#tape.ts"

/** The notes a passing case may have noted. */
const NOTES = ["a", "b", "c", "d"] as const

/** One passing case as the seed corpus is handed it: the notes it noted, and the class it perceived at each range. */
export type Perceived = Readonly<{ notes: ReadonlyArray<string>; trace: ReadonlyArray<number> }>

/** A passing case's notes and trace. */
export const perceived: Gen<Perceived> = (source) => ({
	notes: source.draw(subarray(NOTES)),
	trace: source.draw(array(int(0, TRACE_CLASSES), { min: 0, max: 4 }))
})

/** A tape for the corpus to hold: what it holds does not matter to what it is kept for. */
export const tapeOf = (index: number): Tape =>
	generate(recorder(), int(0, 9), randomChooser(wordsOf(index))).tape
