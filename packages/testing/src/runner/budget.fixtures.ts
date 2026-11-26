import { Array as Arr, Effect, FileSystem, Schema, String as Str } from "effect"
import { element, finite } from "#gen.ts"
import {
	CONSUMER_BUDGET,
	consumerIn,
	type Layout,
	ran,
	runnerConfigOf,
	runnerFilesOf
} from "#runner/consumer.fixtures.ts"

/**
 * What the budget property (budget.test.ts) runs: the consumer's `toolchain-test run` under its runner config's measured
 * CPU budget, and under a budget of none, 0 ms, which every run spends past.
 */
const BUDGETS = ["its measured budget", "a budget of none"] as const

/** A budget of BUDGETS. */
export type Budgeted = (typeof BUDGETS)[number]

/** Every case: each budget. */
export const budgets = finite((source): Budgeted => source.draw(element(BUDGETS)))

/** The consumer's layout: the library linked, outside git, with no lockfile, TypeScript installed. */
const layout: Layout = { library: "link", git: false, lockfile: false, typescript: true }

/** The run's CPU as the budget meter read it, as its JSON record holds it (runner/usage.ts UsageRecord), in ms. */
const Recorded = Schema.fromJsonString(
	Schema.Struct({ report: Schema.Struct({ metered: Schema.Finite }) })
)

/** The budget `budgeted` names, in ms. */
const millisOf = (budgeted: Budgeted): number => {
	switch (budgeted) {
		case "its measured budget":
			return CONSUMER_BUDGET
		case "a budget of none":
			return 0
	}
}

/** Seconds from milliseconds, as the run prints them. */
const seconds = (millis: number) => `${(millis / 1000).toFixed(1)} s`

/** The line a run past its budget of `millis` ends with, having spent `spent` with its backends' (ms). */
export const overLineOf = (spent: number, millis: number): string =>
	`over its CPU budget: the run spent ${seconds(spent)} of CPU, its backends' among it, its test.config.ts's budget ${seconds(millis)}`

/** The lines of what a run printed that name its budget. */
export const budgetLinesOf = (printed: string): ReadonlyArray<string> =>
	Arr.filter(Str.split("\n")(printed), (line) => Str.includes("CPU budget")(line))

/** How a run ended: its exit status, and the lines it printed that name a budget. */
export type Ended = Readonly<{ exitCode: number; budgetLines: ReadonlyArray<string> }>

/**
 * What a run under `budgeted` must end with, by the specification, given the CPU its own record says it spent: within
 * its budget, exit 0 and no budget line; past it, exit 1 and one line naming what it spent and its budget.
 */
export const budgetEndOf = (budgeted: Budgeted, spent: number): Ended => {
	const millis = millisOf(budgeted)
	return spent > millis
		? {
				exitCode: 1,
				budgetLines: [overLineOf(spent, millis)]
			}
		: { exitCode: 0, budgetLines: [] }
}

/**
 * Writes the consumer into `directory` from the library at `library`, its runner config at the budget `budgeted` names,
 * runs `toolchain-test run` in a child process, and answers how it ended and the CPU its JSON record says it spent.
 */
export const budgetedRun = (directory: string, library: string, budgeted: Budgeted) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const consumer = `${directory}/consumer`
		const files = Arr.map(runnerFilesOf(layout), ([path, text]) =>
			path === "test.config.ts"
				? ([path, runnerConfigOf(millisOf(budgeted))] as const)
				: ([path, text] as const)
		)
		yield* consumerIn(consumer, layout, library, files)
		const [exitCode, stdout, stderr] = yield* ran(
			consumer,
			process.execPath,
			["--disable-warning=ExperimentalWarning", "vendor/testing/src/runner/cli-entry.ts", "run"],
			{ XDG_CACHE_HOME: `${directory}/cache`, GIT_CEILING_DIRECTORIES: directory, NO_COLOR: "1" }
		)
		const recorded = yield* Effect.flatMap(
			fs.readFileString(`${directory}/cache/toolchain-test/runs/last.json`),
			Schema.decodeEffect(Recorded)
		)
		const ended: Ended = { exitCode, budgetLines: budgetLinesOf(`${stdout}${stderr}`) }
		return { ended, spent: recorded.report.metered }
	})
