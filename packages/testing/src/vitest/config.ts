import { Array as Arr, Config, Effect, Option, Result, String as Str } from "effect"
import { defineConfig } from "vitest/config"
import { HARDENED_FLAGS, SMALL_STACK } from "#runner/config.ts"
import { type Examples, residualReporter } from "#vitest/reporter.ts"
import { testWorkers } from "#workers.ts"

export { HARDENED_FLAGS, testWorkers }

/**
 * How long a test or a hook may take: without bound, or a number of milliseconds. A long search that keeps making
 * progress must never fail on wall time; each case's hang guard is what catches a case that stops.
 */
export type Timeout =
	| Readonly<{ kind: "unbounded" }>
	| Readonly<{ kind: "bounded"; millis: number }>

/** The setup every project's test processes run, which leaves on each test whether it ran a search, for the reporter
 * that fails an example where the package bans them. */
const SEARCHES_SETUP = `${import.meta.dirname}/searches-setup.ts`

/** The setup that keeps a test process's compiled code in Node's compile cache (compile-cache.ts). */
const COMPILE_CACHE_SETUP = `${import.meta.dirname}/compile-cache.ts`

/** Vitest's form of a timeout, where zero means none. */
const millisOf = (timeout: Timeout) => (timeout.kind === "unbounded" ? 0 : timeout.millis)

/**
 * What a package states about its tests: which files they are; which of them steer by V8's block coverage, so their
 * processes count blocks from the start, before the code under test loads; its own global setup files, which run after
 * the library's, beside the run seed; the export conditions its code resolves with; how long a test and a hook may
 * take; and `smallStack`, the files whose suites run under SMALL_STACK, about a sixth of Node's default stack, instead
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
	timeouts: Readonly<{ test: Timeout; hook: Timeout }>
	smallStack: ReadonlyArray<string>
	examples: Examples
}>

/**
 * A package's Vitest config. Tests run as Node runs the code: native ESM by type stripping, never through Vite's
 * module runner or loader, so no transform changes what a module means; one process per file, as many at once as
 * testWorkers holds (half the cores); the
 * hardened flags; Node's compile cache in every process whose coverage is never read (compile-cache.ts: not the guided
 * project's, and none of a run under NODE_V8_COVERAGE); the run seed chosen once by global setup; and the residual table
 * at the end, whose reporter fails
 * the run for every passing test case that ran no search where the package bans examples, as each project's setup
 * records the searches every test ran. A fuzz run lifts every
 * timeout: its budget is its own, and each case's hang guard still catches a case that stops.
 */
export const defineTestConfig = (config: TestConfig) => {
	const fuzzing = Option.isSome(Effect.runSync(Config.option(Config.String("TEST_FUZZ"))))
	const covered = Option.isSome(Effect.runSync(Config.option(Config.String("NODE_V8_COVERAGE"))))
	const uncoveredSetup = covered ? [SEARCHES_SETUP] : [COMPILE_CACHE_SETUP, SEARCHES_SETUP]
	const timeoutOf = (timeout: Timeout) => millisOf(fuzzing ? { kind: "unbounded" } : timeout)
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
			reporters: ["default", residualReporter(config.examples)],
			testTimeout: timeoutOf(config.timeouts.test),
			hookTimeout: timeoutOf(config.timeouts.hook)
		}
	})
}
