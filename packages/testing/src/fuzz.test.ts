/**
 * A fuzz time (fuzz.ts budgetOf) reads as Go's -fuzztime does: a whole count of cases, milliseconds, seconds, minutes
 * or hours, each span of the run's CPU, every count of 1 to 3 in each unit. Oracle: the specification, Go's grammar.
 */
import { Effect } from "effect"
import { assert } from "#assert.ts"
import { DURATIONS, fuzzTimes } from "#fuzz.fixtures.ts"
import { budgetOf } from "#fuzz.ts"
import { finite } from "#gen.ts"
import { property } from "#property.ts"

export const goFuzzTime = property.exhaust(finite(fuzzTimes), {
	box: "every count of 1 to 3 in each unit",
	needs: {},
	situations: [],
	check:
		() =>
		([count, unit]) =>
			Effect.sync(() =>
				assert.deepEqual(
					budgetOf(`${count}${unit}`),
					unit === "x"
						? { kind: "cases", cases: count }
						: { kind: "cpu", duration: DURATIONS[unit](count) }
				)
			),
	oracle: {
		kind: "specification",
		name: "Go's -fuzztime grammar: a whole count of cases, milliseconds, seconds, minutes or hours"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/fuzz.ts",
			original:
				'\tconst duration = Str.endsWith("ms")(fuzzTime)\n\t\t? Duration.millis(count)\n\t\t: Str.endsWith("s")(fuzzTime)\n\t\t\t? Duration.seconds(count)\n\t\t\t: Str.endsWith("m")(fuzzTime)\n\t\t\t\t? Duration.minutes(count)\n\t\t\t\t: Duration.hours(count)',
			replacement: "\tconst duration = Duration.seconds(count)",
			why: "Every unit of a fuzz time is read as seconds; the third property fails."
		}
	]
})
