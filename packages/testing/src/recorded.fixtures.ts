import { Array as Arr } from "effect"
import { array, type Gen, int, recorded, type Space } from "#gen.ts"

/**
 * A recorded space the properties of recorded.test.ts draw on: the whole numbers up to `top` its space draws, beside
 * `count` values a regression recorded; a run's words from `seed`.
 */
export type RecordedCase = Readonly<{ top: number; count: number; seed: number }>

export const recordedCases: Gen<RecordedCase> = (source) => ({
	top: source.draw(int(0, 6)),
	count: source.draw(int(1, 4)),
	seed: source.draw(int(0, 0xffff_ffff))
})

/** The values a regression recorded: -1 down to -count, which no space here draws, so a value says which arm drew it. */
export const recordedNumbers = (count: number): Arr.NonEmptyReadonlyArray<number> => [
	-1,
	...Array.from({ length: count - 1 }, (_, at) => -(at + 2))
]

/** A recorded space of numbers: 0 to `top`, beside -1 to -count. */
export const numbersOf = (c: RecordedCase): Space<number> =>
	recorded(int(0, c.top), recordedNumbers(c.count))

/** A recorded space of lists: up to three numbers of 0 to `top`, beside the lists [-1] to [-count]. */
export const listsOf = (c: RecordedCase): Space<ReadonlyArray<number>> =>
	recorded(
		array(int(0, c.top), { min: 0, max: 3 }),
		Arr.map(recordedNumbers(c.count), (n): ReadonlyArray<number> => [n])
	)

/** Whether a list is a recorded one: it holds a number no space here draws. */
export const isRecordedList = (list: ReadonlyArray<number>): boolean => Arr.some(list, (n) => n < 0)
