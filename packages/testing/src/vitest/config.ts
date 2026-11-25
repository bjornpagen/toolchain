import { regex } from "arkregex"
import { Array as Arr, Config, Effect, Option, Result, String as Str } from "effect"
import { defineConfig } from "vitest/config"
import { HARDENED_FLAGS, SMALL_STACK } from "#runner/config.ts"
import { type Examples, residualReporter } from "#vitest/reporter.ts"
import { allowanceVariable, processors, testWorkers } from "#workers.ts"

export { HARDENED_FLAGS, testWorkers }

/** The setup every project's test processes run, which leaves on each test whether it ran a search, for the reporter
 * that fails an example where the package bans them. */
const SEARCHES_SETUP = `${import.meta.dirname}/searches-setup.ts`

/** The setup that keeps a test process's compiled code in Node's compile cache (compile-cache.ts). */
const COMPILE_CACHE_SETUP = `${import.meta.dirname}/compile-cache.ts`

/** A count of workers as VITEST_MAX_WORKERS may hold one: a whole number, one at least, in decimal. */
const workersText = regex("^[1-9][0-9]*$")

/**
 * The variable Vitest reads its maxWorkers from past any config (Number.parseInt of its text, Vitest 5.1.1's
 * resolveConfig), refused unless it holds a whole number of workers, one at least: a 0 starts no worker, so a run
 * executes no test and Node exits 0 as its event loop drains (edullm's gate, 2026-11-24: a unit pinned to 8 CPUs derived
 * nproc/16 = 0), and parseInt reads "50%" as 50 and "1.5" as 1. Refused as the config loads, so Vitest never starts.
 */
const MAX_WORKERS_VARIABLE = "VITEST_MAX_WORKERS"

/** Refuses a VITEST_MAX_WORKERS that is no whole number of workers, one at least (MAX_WORKERS_VARIABLE). */
const refuseWorkerlessOverride = (given: Option.Option<string>): void =>
	Option.match(given, {
		onNone: () => undefined,
		onSome: (text) => {
			if (!workersText.test(text)) {
				throw new Error(
					`${MAX_WORKERS_VARIABLE}=${text} is no count of workers: a whole number, one at least, it must be, or unset (a run takes testWorkers)`
				)
			}
		}
	})

/**
 * What a package states about its tests: which files they are; which of them steer by V8's block coverage, so their
 * processes count blocks from the start, before the code under test loads; its own global setup files, which run after
 * the library's, beside the run seed; the export conditions its code resolves with; and `smallStack`, the files whose suites run under SMALL_STACK, about a sixth of Node's default stack, instead
 * of on the default stack, so a per-element use of the stack (a spread argument, a recursion over a list) fails at the
 * widths ordinary generators reach (a case that passes on the small stack passes on the default one, and both draw the
 * same cases, so a second run on the default stack would only repeat it); and `examples`, whether every test case must run a search, and the files exempt from it, each set
 * with its reason, relative to the Vitest root (the config's directory). A package with none of a list states it empty.
 * The guided and small-stack lists are projects of their own, so each names its files outright: a glob there reaches
 * every file it matches, inside `include` or not.
 */
export type TestConfig = Readonly<{
	include: ReadonlyArray<string>
	guided: ReadonlyArray<string>
	setup: ReadonlyArray<string>
	conditions: ReadonlyArray<string>
	smallStack: ReadonlyArray<string>
	examples: Examples
}>

/**
 * A package's Vitest config. Tests run as Node runs the code: native ESM by type stripping, never through Vite's
 * module runner or loader, so no transform changes what a module means; one process per file, as many at once as
 * testWorkers holds (half the CPUs this process may use), each given this process's CPU allowance (workers.ts
 * allowanceVariable), so every width a test process derives is the run's; the
 * hardened flags; Node's compile cache in every process whose coverage is never read (compile-cache.ts: not the guided
 * project's, and none of a run under NODE_V8_COVERAGE); the run seed chosen once by global setup; and the residual table
 * at the end, whose reporter fails
 * the run for every passing test case that ran no search where the package bans examples, as each project's setup
 * records the searches every test ran, and fails a run that executed no test case (reporter.ts noTestRan), as Vitest's
 * own passWithNoTests, false here, fails a run that found no test file; a VITEST_MAX_WORKERS that is no whole number of
 * workers, one at least, is refused before Vitest starts (MAX_WORKERS_VARIABLE). No test and no hook has a timeout
 * (testTimeout and hookTimeout 0, Vitest's none): a timer's verdict is the wall clock's, which a slower machine changes,
 * so a search ends by its case count under each case's hang guard (a bound on the case's own work) and a hang is the
 * gate's progress watch to see; testing/no-wall-clock-verdict refuses a finite one in any Vitest configuration.
 */
export const defineTestConfig = (config: TestConfig) => {
	refuseWorkerlessOverride(Effect.runSync(Config.option(Config.String(MAX_WORKERS_VARIABLE))))
	const covered = Option.isSome(Effect.runSync(Config.option(Config.String("NODE_V8_COVERAGE"))))
	const uncoveredSetup = covered ? [SEARCHES_SETUP] : [COMPILE_CACHE_SETUP, SEARCHES_SETUP]
	/** The default project leaves out every file the small-stack project runs: a file runs on exactly one stack. */
	const smallStackOnly = Arr.filterMap(config.smallStack, (glob) =>
		Str.startsWith("!")(glob) ? Result.failVoid : Result.succeed(`!${glob}`)
	)
	const execArgv = [
		...HARDENED_FLAGS,
		...Arr.map(config.conditions, (condition) => `--conditions=${condition}`)
	]
	return defineConfig({
		test: {
			pool: "forks",
			isolate: true,
			execArgv,
			experimental: { viteModuleRunner: false, nodeLoader: false },
			globalSetup: [`${import.meta.dirname}/global-setup.ts`, ...config.setup],
			projects: [
				{
					extends: true,
					test: {
						name: "parallel",
						include: [...config.include, ...smallStackOnly],
						exclude: Arr.copy(config.guided),
						setupFiles: uncoveredSetup
					}
				},
				...(Arr.isReadonlyArrayNonEmpty(config.guided)
					? [
							{
								extends: true,
								test: {
									name: "guided",
									include: Arr.copy(config.guided),
									setupFiles: [`${import.meta.dirname}/coverage.ts`, SEARCHES_SETUP]
								}
							}
						]
					: []),
				...(Arr.isReadonlyArrayNonEmpty(config.smallStack)
					? [
							{
								extends: true,
								test: {
									name: "small-stack",
									include: Arr.copy(config.smallStack),
									execArgv: Arr.append(execArgv, SMALL_STACK),
									setupFiles: uncoveredSetup
								}
							}
						]
					: [])
			],
			maxWorkers: testWorkers,
			passWithNoTests: false,
			env: { [allowanceVariable]: `${processors}` },
			reporters: ["default", residualReporter(config.examples)],
			testTimeout: 0,
			hookTimeout: 0
		}
	})
}
