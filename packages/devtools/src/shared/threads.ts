import {
	configuredConcurrency,
	processors,
	tasksAtOnceOf,
	widthOf
} from "@bjornpagen/testing/workers"
import { Array as Arr, Config, Effect, Option, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { DevtoolFailure, failureFrom } from "#shared/devtool.ts"

/**
 * How many threads each tool of the gate takes (GATETHREADS, 2026-11-20): its task's share of the machine, testing's
 * processors, the one width source every tool and every test pool of a run derives from (workers.ts shareHere: the CPU
 * allowance over the tasks the enclosing turbo run executes at once), where each tool sized its pool to the whole
 * machine under a turbo of many tasks (oxlint's "using 64 threads" in each of 32 tasks; one live gate's oxlint ran at
 * about 5,400% CPU). A repository's scripts run turbo through toolchain-turbo, which sets TURBO_CONCURRENCY to the tasks
 * the run executes at once (runWidth: the fewer of turbo's concurrency and the tasks its dry run plans), which turbo
 * hands each task. No script names a thread count (the workspace gate's no-worker-flags).
 */

/** The tasks a run executes at once under `concurrency`, or the failure that turbo's concurrency is no count. */
const tasksAtOnce = (concurrency: string) =>
	Effect.mapError(Effect.fromOption(tasksAtOnceOf(concurrency, processors)), () =>
		DevtoolFailure.make({
			detail: `turbo's concurrency ${concurrency} is no count of tasks: a whole number of at least 1 or a share of the processors, N%`
		})
	)

/** The concurrency turbo's configuration resolves to in this directory (testing's configuredConcurrency). */
const turboConcurrency = Effect.try({
	try: configuredConcurrency,
	catch: failureFrom("turbo config could not be run, or reported no concurrency this reads")
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
		return widthOf(Math.min(width, tasks))
	})

/**
 * A tool of the gate as its wrapper runs it: the program and the arguments that name the tool, and the arguments that
 * hand it a count of threads, which go before the caller's, none for a tool whose pool reads no flag; every tool is
 * handed the count as RAYON_NUM_THREADS too, the variable each one's thread pool reads when no flag sizes it (tsrs's,
 * which reads no flag; oxlint's `tsrs-lint`, the child its type-aware rules run in; the pools of fallow's that its flag
 * leaves to Rayon).
 */
export type Tool = Readonly<{
	program: string
	leading: ReadonlyArray<string>
	threadArguments: (threads: number) => ReadonlyArray<string>
}>

/**
 * The one type checker tsrs checks a program with (`--checkers 1`, TypeScript's own option): a checker is no thread
 * but a universe of types, each built by the checker that needs it, so a program checked by several builds again, in
 * each, every type their files read across a module boundary that no declaration states, an inferred level of a schema
 * the whole of it, and with one each type the program needs is built once. qti-pie's ledger, one package, at 64
 * checkers, a checker for each thread of its share run alone, made 477 million instantiations and 15.3 GB where one
 * checker makes 45.6 million in 1.3 GB, each of the other 63 deriving pantry's and the ledger's levels again (8 million
 * instantiations a checker), and checked it no sooner (TYPECOST, 2026-11-27: 16 s of check at 4 checkers, 17 s at 64).
 * Four, TypeScript's default, would build each such type four times. The checker runs on no thread of its own beside
 * the pool (KILLFIX's census of one typecheck of the testing package at RAYON_NUM_THREADS=1, 2026-11-25: at its
 * default of four, 2.42 CPU-s on four `checker` threads and 0.66 on the rest, 1.14 cores; at one, none and 2.70 on the
 * rest, 0.94 cores), so the typecheck holds its share.
 */
const ONE_CHECKER = ["--checkers", "1"] as const

/**
 * The gate's tools, each as its wrapper runs it: toolchain-oxlint's oxlint (`--threads`), toolchain-oxfmt's oxfmt
 * (`--threads`), toolchain-fallow's fallow (`--threads`, its parser's), and toolchain-typecheck's tsrs, Effect-patched
 * by @effect/tsgo (`effect-tsgo tsrs`), whose Rayon pool RAYON_NUM_THREADS sizes and which checks its program with one
 * type checker (ONE_CHECKER).
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
	tsrs: {
		program: "effect-tsgo",
		leading: ["tsrs", ...ONE_CHECKER],
		threadArguments: () => []
	}
} as const satisfies Readonly<Record<string, Tool>>

/**
 * `tool` run with `args` in `cwd` (this process's own working directory when none) and handed the threads of this task,
 * its share of its run's CPU allowance (testing's processors: the allowance over the tasks its turbo run executes at
 * once), its output this process's, its exit status the answer.
 */
export const toolRun = (tool: Tool, args: ReadonlyArray<string>, cwd: Option.Option<string>) =>
	Effect.gen(function* () {
		const threads = processors
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
