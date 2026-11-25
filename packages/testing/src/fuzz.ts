import { regex } from "arkregex"
import { Duration, type Effect, Schema, String as Str } from "effect"

/**
 * How long a fuzz run searches: until it finds a failure, as `go test -fuzz` does with no `-fuzztime`; for a span of
 * the CPU its process tree spends (its own, its workers' and their children's: live.ts cpuMeter); or for a number of
 * cases. A budget bounds a fuzz run's search, never a verdict: a fuzz run fails only on a failing case. A span is of CPU,
 * never of wall time, so the cases a budget reaches are the same however loaded the machine is.
 */
export type FuzzBudget =
	| Readonly<{ kind: "until-failure" }>
	| Readonly<{ kind: "cpu"; duration: Duration.Duration }>
	| Readonly<{ kind: "cases"; cases: number }>

/**
 * The cases a fuzz run keeps between runs, as tapes: every case that found something new, and every failure, shrunk.
 * It is a cache, read only by fuzz runs, never by `pnpm test`, whose regressions are kept cases in code. `load` reads
 * every case, shortest first; a fuzz run replays them in that order and `drop`s each that adds nothing the cases before
 * it did not, so the corpus never grows past what its finds need.
 */
export type Corpus = Readonly<{
	load: Effect.Effect<ReadonlyArray<Float64Array>>
	save: (values: Float64Array, length: number) => Effect.Effect<void>
	drop: (values: Float64Array, length: number) => Effect.Effect<void>
}>

/** A fuzz run of one suite: its budget and its corpus. */
export type Fuzz = Readonly<{ suite: string; budget: FuzzBudget; corpus: Corpus }>

/** A fuzz time as Go's `-fuzztime` writes it: a whole number of hours, minutes, seconds or milliseconds (of the run's
 * CPU), or of cases with `x`. */
export const FuzzTime = Schema.String.check(Schema.isPattern(regex("^[0-9]{1,9}(x|ms|s|m|h)$")))

/** The budget a fuzz time states, once `FuzzTime` admitted it: `1000x` is a thousand cases, `30s` thirty seconds of CPU. */
export const budgetOf = (fuzzTime: string): FuzzBudget => {
	const count = Number.parseInt(fuzzTime, 10)
	if (Str.endsWith("x")(fuzzTime)) {
		return { kind: "cases", cases: count }
	}
	const duration = Str.endsWith("ms")(fuzzTime)
		? Duration.millis(count)
		: Str.endsWith("s")(fuzzTime)
			? Duration.seconds(count)
			: Str.endsWith("m")(fuzzTime)
				? Duration.minutes(count)
				: Duration.hours(count)
	return { kind: "cpu", duration }
}

/** Whether a fuzz run has spent its budget, after `cases` cases and `cpu` milliseconds of its process tree's CPU. */
export const spent = (budget: FuzzBudget, cases: number, cpu: number): boolean => {
	switch (budget.kind) {
		case "until-failure":
			return false
		case "cases":
			return cases >= budget.cases
		case "cpu":
			return cpu >= Duration.toMillis(budget.duration)
	}
}

/** A fuzz run's budget as its report names it. */
export const describeBudget = (budget: FuzzBudget): string => {
	switch (budget.kind) {
		case "until-failure":
			return "until a case fails"
		case "cases":
			return `for ${budget.cases} cases`
		case "cpu":
			return `for ${Duration.format(budget.duration)} of CPU`
	}
}
