import { Array as Arr, Effect, FileSystem, Schema, String as Str } from "effect"
import { element, finite, int } from "#gen.ts"
import type { RunBudget } from "#runner/config.ts"
import {
	CONSUMER_BUDGET,
	consumerIn,
	type Layout,
	manifestOf,
	ran,
	runnerConfigOf,
	runnerFilesOf
} from "#runner/consumer.fixtures.ts"

/**
 * What the budget property (budget.test.ts) runs: the consumer's `toolchain-test run` under its runner config's measured
 * budget; under a run budget of none, 0 ms, beside its measured import budget; and under an import budget of none beside
 * its measured run budget. Every run spends past a part of none.
 */
const BUDGETS = ["its measured budget", "a run budget of none", "an import budget of none"] as const

/** A budget of BUDGETS. */
export type Budgeted = (typeof BUDGETS)[number]

/** Every case: each budget. */
export const budgets = finite((source): Budgeted => source.draw(element(BUDGETS)))

/** The consumer's layout: the library linked, outside git, with no lockfile, TypeScript installed. */
const layout: Layout = { library: "link", git: false, lockfile: false, typescript: true }

/**
 * What a run's JSON record says it spent (runner/usage.ts UsageRecord), in ms: beyond its workers' starts and readyings
 * and its run needs' opens (`run`), each worker's start, and each property's imports on its workers, its rows in the
 * record's order.
 */
const Recorded = Schema.fromJsonString(
	Schema.Struct({
		report: Schema.Struct({
			run: Schema.Finite,
			workerStarts: Schema.Array(Schema.Finite),
			rows: Schema.Array(
				Schema.Struct({ label: Schema.String, imports: Schema.Array(Schema.Finite) })
			)
		})
	})
)

/** What a run's record says it spent. */
export type Spent = (typeof Recorded.Type)["report"]

/** The budget `budgeted` names. */
const budgetOf = (budgeted: Budgeted): RunBudget => {
	switch (budgeted) {
		case "its measured budget":
			return CONSUMER_BUDGET
		case "a run budget of none":
			return { ...CONSUMER_BUDGET, run: 0 }
		case "an import budget of none":
			return { ...CONSUMER_BUDGET, import: 0 }
	}
}

/** Seconds from milliseconds, as the run prints them. */
const seconds = (millis: number) => `${(millis / 1000).toFixed(1)} s`

/** The most a property's module took to import on any worker, none for a property no worker imported. */
const mostOf = (imports: ReadonlyArray<number>): number =>
	Arr.reduce(imports, 0, (larger, one) => Math.max(larger, one))

/**
 * The lines a run that spent `spent` ends with under `budget`, by the specification: one naming its CPU beyond its
 * readyings where that passed the run part, then one for each property, in its record's order, whose most costly import
 * passed the import part.
 */
export const overLinesOf = (
	spent: Pick<Spent, "run" | "rows">,
	budget: RunBudget
): ReadonlyArray<string> => [
	...(spent.run > budget.run
		? [
				`over its run budget: the run spent ${seconds(spent.run)} of CPU beyond its workers' starts and readyings and its run needs' opens (its parent's and its cases', their children's and backends' among it), its test.config.ts's run budget ${seconds(budget.run)}`
			]
		: []),
	...Arr.flatMap(spent.rows, (row) =>
		mostOf(row.imports) > budget.import
			? [
					`over its import budget: ${row.label}'s module took ${seconds(mostOf(row.imports))} of CPU to import on a worker, its test.config.ts's import budget ${seconds(budget.import)}`
				]
			: []
	)
]

/** The lines of what a run printed that say it went past a part of its budget. */
export const budgetLinesOf = (printed: string): ReadonlyArray<string> =>
	Arr.filter(
		Str.split("\n")(printed),
		(line) =>
			Str.startsWith("over its run budget: ")(line) ||
			Str.startsWith("over its import budget: ")(line)
	)

/** How a run ended: its exit status, and the lines it printed that say it went past a part of its budget. */
export type Ended = Readonly<{ exitCode: number; budgetLines: ReadonlyArray<string> }>

/**
 * What a run under `budgeted` must end with, by the specification, given what its own record says it spent: within both
 * parts, exit 0 and no budget line; past either, exit 1 and a line for each part it went past.
 */
export const budgetEndOf = (budgeted: Budgeted, spent: Spent): Ended => {
	const lines = overLinesOf(spent, budgetOf(budgeted))
	return { exitCode: Arr.isReadonlyArrayNonEmpty(lines) ? 1 : 0, budgetLines: lines }
}

/** What `toolchain-test run` is, run from a consumer's directory: the linked library's entry, by Node. */
const runCommand = [
	process.execPath,
	"--disable-warning=ExperimentalWarning",
	"vendor/testing/src/runner/cli-entry.ts",
	"run"
] as const

/** The record a run in `directory`'s consumer left in its cache, what it says it spent. */
const recordIn = (directory: string) =>
	Effect.flatMap(
		Effect.flatMap(FileSystem.FileSystem, (fs) =>
			fs.readFileString(`${directory}/cache/toolchain-test/runs/last.json`)
		),
		Schema.decodeEffect(Recorded)
	)

/**
 * Writes the consumer into `directory` from the library at `library`, its runner config at the budget `budgeted` names,
 * runs `toolchain-test run` in a child process, and answers how it ended and what its JSON record says it spent.
 */
export const budgetedRun = (directory: string, library: string, budgeted: Budgeted) =>
	Effect.gen(function* () {
		const consumer = `${directory}/consumer`
		const files = Arr.map(runnerFilesOf(layout), ([path, text]) =>
			path === "test.config.ts"
				? ([path, runnerConfigOf(budgetOf(budgeted))] as const)
				: ([path, text] as const)
		)
		yield* consumerIn(consumer, layout, library, files)
		const [exitCode, stdout, stderr] = yield* ran(
			consumer,
			runCommand[0],
			Arr.drop(runCommand, 1),
			{
				XDG_CACHE_HOME: `${directory}/cache`,
				GIT_CEILING_DIRECTORIES: directory,
				NO_COLOR: "1"
			}
		)
		const ended: Ended = { exitCode, budgetLines: budgetLinesOf(`${stdout}${stderr}`) }
		return { ended, spent: (yield* recordIn(directory)).report }
	})

/** A program's text that spends `millis` of this process's CPU, then goes on. */
const burnText = (millis: number): string =>
	`{ const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000 }; const until = cpu() + ${String(millis)}; while (cpu() < until) {} }`

/** A consumer's runner config under budget parts of none: a property that reads what its record says, not how it ends. */
const unjudgedConfig = `import { defineRunner, noMutation } from "@bjornpagen/testing/runner"\nimport { Layer } from "effect"\n\nexport default defineRunner({ budget: { kind: "cpu", run: 0, import: 0 }, include: ["test/*.test.ts"], smallStack: [], conditions: [], environment: [], layer: Layer.empty, mutation: noMutation })\n`

/** The CPU the readying property's costly need spends opening, on each worker that opens it: two or four seconds. */
export const readyingBurns = finite((source) => 2000 * source.draw(int(1, 2)))

/**
 * The readying consumer's files: its manifest, its runner config (unjudgedConfig), a need whose open spends `burn` ms
 * of the worker's CPU (a readying's, what no run part holds), and a test module of two light properties over it.
 */
const readyingFiles = (burn: number): ReadonlyArray<readonly [string, string]> => [
	["package.json", manifestOf(layout)],
	["test.config.ts", unjudgedConfig],
	[
		"test/opened.ts",
		`import { Effect } from "effect"\n\nexport const opened = {\n\tkey: "budget readying",\n\tbudget: ${String(4 * Math.max(burn, 1000))},\n\trunNeeds: [],\n\topen: Effect.sync(() => { ${burnText(burn)}; return Effect.succeed("opened") })\n}\n`
	],
	[
		"test/light.test.ts",
		`import { Effect } from "effect"\nimport { int } from "@bjornpagen/testing/gen"\nimport { property } from "@bjornpagen/testing/property"\nimport { opened } from "./opened.ts"\n\n${Arr.join(
			Array.from(
				{ length: 2 },
				(_, at) =>
					`export const light${String(at)} = property.explore(int(0, 9), {\n\tneeds: { opened },\n\tsituations: [],\n\tcheck: ({ opened: value }) => (a) => Effect.flatMap(value, (read) => (read === "opened" && a + (9 - a) === 9 ? Effect.void : Effect.die("not nine"))),\n\toracle: { kind: "specification", name: "a + (9 - a) is 9" },\n\tkept: [],\n\tkills: []\n})\n`
			),
			"\n"
		)}`
	]
]

/** The run need's spend of the run-need property: four or eight seconds of CPU. */
export const runNeedBurns = finite((source) => 4000 * source.draw(int(1, 2)))

/**
 * The run-need consumer's files: its manifest, its runner config (unjudgedConfig), a run need whose open spends
 * `burn` ms of the run parent's CPU, and a test module of two properties over a need over it.
 */
const runNeedFiles = (burn: number): ReadonlyArray<readonly [string, string]> => [
	["package.json", manifestOf(layout)],
	["test.config.ts", unjudgedConfig],
	[
		"test/opened.ts",
		`import { Effect, Schema } from "effect"\nimport { Need, type RunNeed } from "@bjornpagen/testing/property"\n\nconst burned: RunNeed<string> = {\n\tkey: "budget burned",\n\tbudget: ${String(4 * burn)},\n\tvalue: Schema.String,\n\topen: () => Effect.sync(() => { ${burnText(burn)}; return "burned" })\n}\n\nexport const opened = Need.overRun(burned, {\n\tkey: "budget opened",\n\tbudget: ${String(4 * burn)},\n\topen: (value) => Effect.succeed(Effect.succeed(value))\n})\n`
	],
	[
		"test/light.test.ts",
		`import { Effect } from "effect"\nimport { int } from "@bjornpagen/testing/gen"\nimport { property } from "@bjornpagen/testing/property"\nimport { opened } from "./opened.ts"\n\n${Arr.join(
			Array.from(
				{ length: 2 },
				(_, at) =>
					`export const light${String(at)} = property.explore(int(0, 9), {\n\tneeds: { opened },\n\tsituations: [],\n\tcheck: ({ opened: value }) => (a) => Effect.flatMap(value, (read) => (read === "burned" && a + (9 - a) === 9 ? Effect.void : Effect.die("not nine"))),\n\toracle: { kind: "specification", name: "a + (9 - a) is 9" },\n\tkept: [],\n\tkills: []\n})\n`
			),
			"\n"
		)}`
	]
]

/**
 * Runs `toolchain-test run` in the consumer at `consumer` on `workers` workers, its cache under `directory`: in a systemd
 * scope of the account's manager whose CPU quota is two CPUs a worker, the allowance a run takes a worker of for every
 * two (runner/config.ts defineRunner), and no part of this process's own cgroup, so the run's width is the case's
 * whatever this process's own allowance is. It answers what the run's record says it spent.
 */
const recordOn = (directory: string, consumer: string, workers: number) =>
	Effect.andThen(
		ran(
			consumer,
			"systemd-run",
			[
				"--user",
				"--scope",
				"--quiet",
				"--collect",
				"-p",
				`CPUQuota=${String(200 * workers)}%`,
				"--",
				...runCommand
			],
			{ XDG_CACHE_HOME: `${directory}/cache`, GIT_CEILING_DIRECTORIES: directory, NO_COLOR: "1" }
		),
		Effect.map(recordIn(directory), (recorded) => recorded.report)
	)

/**
 * Writes the readying consumer, its need spending `burn` ms opening, into `directory` from the library at `library` and
 * runs it on one worker (recordOn), answering what its record says it spent beyond its readyings.
 */
export const readyingRun = (directory: string, library: string, burn: number) =>
	Effect.gen(function* () {
		const consumer = `${directory}/consumer`
		yield* consumerIn(consumer, layout, library, readyingFiles(burn))
		const spent = yield* recordOn(directory, consumer, 1)
		return spent.run
	})

/**
 * Writes the run-need consumer, its run need spending `burn` ms, into `directory` from the library at `library` and runs
 * it on one worker (recordOn), answering what its record says it spent beyond its readyings.
 */
export const runNeedRun = (directory: string, library: string, burn: number) =>
	Effect.gen(function* () {
		const consumer = `${directory}/consumer`
		yield* consumerIn(consumer, layout, library, runNeedFiles(burn))
		const spent = yield* recordOn(directory, consumer, 1)
		return spent.run
	})

/**
 * The CPU a worker of a run may spend starting, from its process's start to its ready message (runner/worker.ts, its
 * entry worker-entry.ts): the toolchain's own work, which no package's budget holds, since every worker of every run
 * pays it.
 * @limitKind measured
 * @owner the testing library's runner
 * @unit milliseconds of CPU, a worker's own (runner/usage.ts UsageReport workerStarts)
 * @scope each worker's start in a `toolchain-test run`
 * @evidence ~/.cache/metis/METIS-DBOPT/runs/budget/3b/dbopt-3b-measure.jsonl in lane METIS-DBOPT's tree: one line per
 *   runPackage of any runner config during a whole run of the testing package (instrument3b.patch.py over runner/run.ts,
 *   read by budget-measure3b.py, beside it), each with its config's placeholder budget and its report's parts, and the testing package's own run's report beside it
 * @observed 2026-11-27 13:30 to 14:42 UTC
 * @environment cassowary, Ubuntu 26.04 (Linux 7.0.0-1018-aws) on AWS Graviton3, 64 arm64 CPUs, 247 GiB, load 340 to
 *   480 from other sessions; Node 26.13.1; the toolchain at 24300eac with the change that states this budget
 * @workload every property of the testing package, 284, at 4 workers (CPUQuota 800%), none answered from a verdict
 *   cache (a fresh XDG_CACHE_HOME), TEST_SEED unset
 * @result 60 starts (56 of the consumers' runs, 4 of the testing package's), median 791 ms, most 990 ms
 * @decision twice the most, 1,980 ms
 * @revalidate a change to the worker's entry or to what it loads, a Node upgrade, or another machine
 */
export const WORKER_START_BUDGET = 1_980

/** The most workers of a run of the consumer the start property makes: one or two. */
export const startWorkers = finite((source) => source.draw(int(1, 2)))

/**
 * Writes the consumer into `directory` from the library at `library` and runs it on at most `workers` workers
 * (recordOn), answering what its record says each worker it started spent starting.
 */
export const startsRun = (directory: string, library: string, workers: number) =>
	Effect.gen(function* () {
		const consumer = `${directory}/consumer`
		yield* consumerIn(consumer, layout, library, runnerFilesOf(layout))
		const spent = yield* recordOn(directory, consumer, workers)
		return spent.workerStarts
	})
