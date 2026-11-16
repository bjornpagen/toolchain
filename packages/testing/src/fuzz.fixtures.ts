import { Duration } from "effect"
import { dictionary, word } from "#dictionary.ts"
import { type Gen, int } from "#gen.ts"

/** What the -fuzztime grammar's property (fuzz.ts budgetOf) shares: Go's units, and the duration each measures. */

/** Go's -fuzztime units: a count of cases (`x`), milliseconds, seconds, minutes or hours, the grammar's own words. */
const UNITS = dictionary(["x", "ms", "s", "m", "h"])

type Unit = (typeof UNITS)[number]

/** A count of 1 to 3 in a unit. */
export const fuzzTimes: Gen<readonly [count: number, unit: Unit]> = (source) => [
	source.draw(int(1, 3)),
	source.draw(word(UNITS))
]

/** Each unit of time, as the duration it measures. */
export const DURATIONS = {
	ms: Duration.millis,
	s: Duration.seconds,
	m: Duration.minutes,
	h: Duration.hours
} as const
