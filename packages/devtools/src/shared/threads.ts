import { processors, threadsPerTask } from "@bjornpagen/testing/workers"
import { Array as Arr, Config, Effect, Option, Schema, String as Str } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { DevtoolFailure, failureFrom } from "#shared/devtool.ts"

/**
 * How many threads each tool of the gate takes (GATETHREADS, 2026-11-20): a task's share of the machine, the logical
 * CPUs over the tasks its run executes at once (testing's workers.ts threadsPerTask, beside testWorkers), where each
 * tool sized its pool to the whole machine under a turbo of many tasks (oxlint's "using 64 threads" in each of 32
 * tasks; one live gate's oxlint ran at about 5,400% CPU). A tool learns its run's width from where it runs (Place): a
 * repository's scripts run turbo through toolchain-turbo, which sets TURBO_CONCURRENCY to the tasks the run executes
 * at once (runWidth: the fewer of turbo's concurrency and the tasks its dry run plans), and turbo, which passes every
 * TURBO_ variable to its tasks and strips every other in its strict environment mode, hands it to each task; a task of
 * a turbo run started without it reads turbo's configured concurrency; a tool run alone is a run of one task. No script
 * names a thread count (the workspace gate's no-worker-flags).
 */

/**
 * The tasks turbo executes at once when its configuration names no concurrency: turbo's default.
 *
 * @limitKind published
 * @owner turbo 2.11.13 (the catalog's)
 * @unit tasks at once
 * @scope a turbo run whose turbo.json, environment and command line name no concurrency, as `turbo config` reports it
 *   (`"concurrency": null`)
 * @constraint configurable default
 * @source https://github.com/vercel/turborepo/blob/v2.11.13/docs/site/content/docs/reference/configuration.mdx#concurrency
 * @quote Default: `"10"`
 * @verified 2026-11-20
 */
const TURBO_DEFAULT_CONCURRENCY = 10

/** The decimal digits, the only characters of a count turbo reads. */
const DIGITS = "0123456789"

/** Whether `text` is a whole number of decimal digits, or, with a point admitted, a decimal one. */
const isNumeral = (text: string, point: boolean): boolean => {
	const characters = Str.split("")(text)
	return (
		Arr.isReadonlyArrayNonEmpty(characters) &&
		Arr.every(characters, (character) => Str.includes(character)(point ? `${DIGITS}.` : DIGITS)) &&
		Arr.filter(characters, (character) => character === ".").length <= (point ? 1 : 0)
	)
}

/**
 * How many tasks a run executes at once on `processors` logical CPUs under turbo's concurrency `concurrency`, as turbo
 * reads it (its --concurrency, TURBO_CONCURRENCY or turbo.json's `concurrency`): `N%`, that share of the processors
 * rounded down, one at least; or `N`, a whole number of at least one; none for any other text, which turbo refuses too.
 */
const tasksAtOnceOf = (concurrency: string, processors: number): Option.Option<number> => {
	if (Str.endsWith("%")(concurrency)) {
		const share = Str.slice(0, -1)(concurrency)
		return isNumeral(share, true) && Number(share) > 0
			? Option.some(Math.max(1, Math.floor((processors * Number(share)) / 100)))
			: Option.none()
	}
	return isNumeral(concurrency, false) && Number(concurrency) >= 1
		? Option.some(Number(concurrency))
		: Option.none()
}

/**
 * Where a tool of the gate runs, as its environment says: a task of a run whose width toolchain-turbo set (`told`,
 * its TURBO_CONCURRENCY); a task of a turbo run started without it (`turbo`, TURBO_HASH alone, which turbo sets for
 * every task), whose width is turbo's configuration's; or alone, a run of one task.
 */
type Place =
	| Readonly<{ kind: "told"; concurrency: string }>
	| Readonly<{ kind: "turbo" }>
	| Readonly<{ kind: "alone" }>

/** Where a tool runs, from its TURBO_CONCURRENCY and TURBO_HASH. */
const placeOf = (concurrency: Option.Option<string>, hash: Option.Option<string>): Place =>
	Option.match(concurrency, {
		onSome: (told): Place => ({ kind: "told", concurrency: told }),
		onNone: (): Place => (Option.isSome(hash) ? { kind: "turbo" } : { kind: "alone" })
	})

/**
 * The concurrency a turbo run's configuration resolves to, as `turbo config` reports it: its text, or turbo's default
 * when it names none.
 */
const configuredConcurrency = (reported: Option.Option<string>): string =>
	Option.getOrElse(reported, () => `${TURBO_DEFAULT_CONCURRENCY}`)

/** What `turbo config` reports that this reads: the concurrency its configuration resolves to, null for none. */
const TurboConfig = Schema.fromJsonString(
	Schema.Struct({ concurrency: Schema.NullOr(Schema.String) })
)

/** The concurrency turbo's configuration resolves to in this directory, as `turbo config` reports it. */
const turboConcurrency = Effect.gen(function* () {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const reported = yield* spawner
		.string(ChildProcess.make("turbo", ["config"], { stderr: "ignore" }))
		.pipe(Effect.mapError(failureFrom("turbo config could not be run")))
	const config = yield* Schema.decodeEffect(TurboConfig)(reported).pipe(
		Effect.mapError(failureFrom("turbo config reported no concurrency this reads"))
	)
	return configuredConcurrency(Option.fromNullishOr(config.concurrency))
})

/** The tasks a run executes at once under `concurrency`, or the failure that turbo's concurrency is no count. */
const tasksAtOnce = (concurrency: string) =>
	Effect.mapError(Effect.fromOption(tasksAtOnceOf(concurrency, processors)), () =>
		DevtoolFailure.make({
			detail: `turbo's concurrency ${concurrency} is no count of tasks: a whole number of at least 1 or a share of the processors, N%`
		})
	)

/** Where this process runs, from its TURBO_CONCURRENCY and TURBO_HASH (Place). */
const placeHere = Effect.map(
	Effect.all([
		Config.option(Config.String("TURBO_CONCURRENCY")),
		Config.option(Config.String("TURBO_HASH"))
	]),
	([concurrency, hash]) => placeOf(concurrency, hash)
)

/** The width of the run this process is a task of: its told width, its turbo run's configured one, or one alone. */
const widthHere = Effect.flatMap(placeHere, (place) => {
	switch (place.kind) {
		case "told":
			return tasksAtOnce(place.concurrency)
		case "turbo":
			return Effect.flatMap(turboConcurrency, tasksAtOnce)
		case "alone":
			return Effect.succeed(1)
	}
})

/**
 * The command turbo's dry run names for a task whose package has no script of its name, which it plans and never
 * runs.
 *
 * @formatConstant turbo 2.11.13's `turbo run --dry=json`: each task's `command`, this text for a package without the
 *   script
 */
const NONEXISTENT = "<NONEXISTENT>"

/** What a dry run of `turbo run` reports that this reads: each task it plans, by the command it runs. */
const DryRun = Schema.fromJsonString(
	Schema.Struct({ tasks: Schema.Array(Schema.Struct({ command: Schema.String })) })
)

/**
 * The tasks `turbo <args>` runs, as its dry run plans them (`--dry=json` among the arguments before any `--`, which the
 * tasks are passed; a task whose package has no such script runs nothing and is none of them).
 */
const tasksOfRun = (args: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const passed = Arr.findFirstIndex(args, (arg) => arg === "--")
		const own = Option.match(passed, { onNone: () => args, onSome: (at) => Arr.take(args, at) })
		const planned = yield* spawner
			.string(ChildProcess.make("turbo", [...own, "--dry=json"], { stderr: "ignore" }))
			.pipe(Effect.mapError(failureFrom("turbo's dry run could not be run")))
		const plan = yield* Schema.decodeEffect(DryRun)(planned).pipe(
			Effect.mapError(failureFrom("turbo's dry run reported no tasks this reads"))
		)
		return Arr.filter(plan.tasks, (task) => task.command !== NONEXISTENT).length
	})

/**
 * The tasks `turbo <args>` executes at once (toolchain-turbo): the fewer of its width (the TURBO_CONCURRENCY it is
 * started under, else turbo's configured concurrency in this directory) and the tasks the run has, one at least, so a
 * run of a few tasks at a wide concurrency hands each tool a share of the machine its tasks can use, and a run of many
 * never holds more than the machine.
 */
export const runWidth = (args: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const told = yield* Config.option(Config.String("TURBO_CONCURRENCY"))
		const width = yield* Option.match(told, {
			onSome: tasksAtOnce,
			onNone: () => Effect.flatMap(turboConcurrency, tasksAtOnce)
		})
		const tasks = yield* tasksOfRun(args)
		return Math.max(1, Math.min(width, tasks))
	})

/**
 * A tool of the gate as its wrapper runs it: the program and the arguments that name the tool, and the arguments that
 * hand it a count of threads, which go before the caller's; every tool is handed the count as RAYON_NUM_THREADS too,
 * the variable each one's thread pool reads when no flag sizes it (tsrs's checker, which reads no flag; oxlint's
 * `tsrs-lint`, the child its type-aware rules run in; the pools of fallow's that its flag leaves to Rayon).
 */
export type Tool = Readonly<{
	program: string
	leading: ReadonlyArray<string>
	threadArguments: (threads: number) => ReadonlyArray<string>
}>

/**
 * The gate's tools, each as its wrapper runs it: toolchain-oxlint's oxlint (`--threads`), toolchain-oxfmt's oxfmt
 * (`--threads`), toolchain-fallow's fallow (`--threads`, its parser's), and toolchain-typecheck's tsrs, Effect-patched
 * by @effect/tsgo (`effect-tsgo tsrs`, RAYON_NUM_THREADS alone: tsrs 7.1.0-beta.tsrs3 reads no thread flag and no
 * GOMAXPROCS, which typecheck.sh set to no effect: 38 threads at GOMAXPROCS=2 as at none, 8 at RAYON_NUM_THREADS=2).
 */
export const TOOLS = {
	oxlint: {
		program: "oxlint",
		leading: [],
		threadArguments: (threads) => [`--threads=${threads}`]
	},
	oxfmt: { program: "oxfmt", leading: [], threadArguments: (threads) => [`--threads=${threads}`] },
	fallow: {
		program: "fallow",
		leading: [],
		threadArguments: (threads) => ["--threads", `${threads}`]
	},
	tsrs: { program: "effect-tsgo", leading: ["tsrs"], threadArguments: () => [] }
} as const satisfies Readonly<Record<string, Tool>>

/**
 * `tool` run with `args` in `cwd` (this process's own working directory when none) and handed the threads of this task
 * (threadsPerTask over its run's CPU allowance, testing's processors, and the width of the run it is a task of), its output this
 * process's, its exit status the answer.
 */
export const toolRun = (tool: Tool, args: ReadonlyArray<string>, cwd: Option.Option<string>) =>
	Effect.gen(function* () {
		const width = yield* widthHere
		const threads = threadsPerTask(processors, width)
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		return yield* spawner
			.exitCode(
				ChildProcess.make(
					tool.program,
					[...tool.leading, ...tool.threadArguments(threads), ...args],
					{
						...Option.match(cwd, {
							onNone: () => ({}),
							onSome: (directory) => ({ cwd: directory })
						}),
						env: { RAYON_NUM_THREADS: `${threads}` },
						extendEnv: true,
						stdin: "inherit",
						stdout: "inherit",
						stderr: "inherit"
					}
				)
			)
			.pipe(Effect.mapError(failureFrom(`${tool.program} could not be run`)))
	})
