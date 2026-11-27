import { Effect, String as Str } from "effect"
import { element, finite } from "#gen.ts"
import { UNRUN_BUDGET } from "#runner/budgets.fixtures.ts"
import {
	type ConsumerFiles,
	consumerIn,
	type Layout,
	manifestOf,
	ran
} from "#runner/consumer.fixtures.ts"
import { noTestRan } from "#vitest/reporter.ts"

/**
 * What the no-test property (norun.test.ts) runs: a consumer package holding the library as a workspace link, whose
 * tests are run once, by Vitest under the library's config (vitest/config.ts defineTestConfig) or by toolchain-test,
 * each way a run can execute no test, and the one way it executes its test.
 */

/**
 * How a case's run goes: Vitest executing its one test; Vitest with a filter that matches no test case, an include that
 * matches no file, or VITEST_MAX_WORKERS=0 in its environment, under the library's config, or under a config of the
 * package's own that names the library's reporter alone (as a package that allows examples may), which no config of the
 * library refuses the variable for, so Vitest starts no worker; toolchain-test's `run` of a runner config whose include
 * holds no property.
 */
const RUNS = [
	"a Vitest run executing its test",
	"a Vitest run whose filter matches no test case",
	"a Vitest run whose include matches no file",
	"a Vitest run told VITEST_MAX_WORKERS=0",
	"a Vitest run of the reporter alone told VITEST_MAX_WORKERS=0",
	"a toolchain-test run of an include holding no property"
] as const

export type Run = (typeof RUNS)[number]

/** Every case: each run. */
export const runs = finite((source): Run => source.draw(element(RUNS)))

/** The consumer's layout: the library linked, outside git, with no lockfile, TypeScript installed. */
const layout: Layout = { library: "link", git: false, lockfile: false, typescript: true }

/** The consumer's one test, which passes. */
const ONE_TEST = 'import { test } from "vitest"\n\ntest("one", () => undefined)\n'

/** The consumer's Vitest config, the library's (defineTestConfig), its include `include`. */
const vitestConfigOf = (include: string): string =>
	`import { defineTestConfig } from "@bjornpagen/testing/vitest/config"\n\nexport default defineTestConfig({ include: ["${include}"], guided: [], setup: [], conditions: [], smallStack: [], examples: { kind: "allowed" } })\n`

/** A Vitest config of the consumer's own, naming the library's reporter by its export, as a package allowing examples may. */
const REPORTER_ALONE =
	'import { defineConfig } from "vitest/config"\n\nexport default defineConfig({ test: { pool: "forks", include: ["test/*.test.ts"], reporters: ["default", ["@bjornpagen/testing/vitest/reporter", { examples: { kind: "allowed" } }]] } })\n'

/** The consumer's runner config, whose include matches no module. */
const EMPTY_RUNNER = `import { defineRunner, noMutation } from "@bjornpagen/testing/runner"\nimport { Layer } from "effect"\n\nexport default defineRunner({ budget: { kind: "cpu", run: ${String(UNRUN_BUDGET)}, import: ${String(UNRUN_BUDGET)} }, include: ["test/*.test.ts"], smallStack: [], conditions: [], environment: [], layer: Layer.empty, mutation: noMutation })\n`

/** A case's consumer files, the command it runs (a program and its arguments) and the environment it adds. */
type Invocation = Readonly<{
	files: ConsumerFiles
	args: ReadonlyArray<string>
	env: Readonly<Record<string, string>>
}>

/** Vitest's entry, run in the consumer, `run` and `extra` after it. */
const vitestArgs = (extra: ReadonlyArray<string>): ReadonlyArray<string> => [
	"node_modules/vitest/vitest.mjs",
	"run",
	...extra
]

/** What `run` writes and runs. */
const invocationOf = (run: Run): Invocation => {
	const tested: ConsumerFiles = [
		["package.json", manifestOf(layout)],
		["test/one.test.ts", ONE_TEST]
	]
	switch (run) {
		case "a Vitest run executing its test":
			return {
				files: [...tested, ["vitest.config.ts", vitestConfigOf("test/*.test.ts")]],
				args: vitestArgs([]),
				env: {}
			}
		case "a Vitest run whose filter matches no test case":
			return {
				files: [...tested, ["vitest.config.ts", vitestConfigOf("test/*.test.ts")]],
				args: vitestArgs(["-t", "no test is named this"]),
				env: {}
			}
		case "a Vitest run whose include matches no file":
			return {
				files: [...tested, ["vitest.config.ts", vitestConfigOf("none/*.test.ts")]],
				args: vitestArgs([]),
				env: {}
			}
		case "a Vitest run told VITEST_MAX_WORKERS=0":
			return {
				files: [...tested, ["vitest.config.ts", vitestConfigOf("test/*.test.ts")]],
				args: vitestArgs([]),
				env: { VITEST_MAX_WORKERS: "0" }
			}
		case "a Vitest run of the reporter alone told VITEST_MAX_WORKERS=0":
			return {
				files: [...tested, ["vitest.config.ts", REPORTER_ALONE]],
				args: vitestArgs([]),
				env: { VITEST_MAX_WORKERS: "0" }
			}
		case "a toolchain-test run of an include holding no property":
			return {
				files: [
					["package.json", manifestOf(layout)],
					["test.config.ts", EMPTY_RUNNER]
				],
				args: [
					"--disable-warning=ExperimentalWarning",
					"vendor/testing/src/runner/cli-entry.ts",
					"run"
				],
				env: {}
			}
	}
}

/** How a run ended, as the check compares it: whether it exited 0, and whether it said why, as its case expects. */
export type Ended = Readonly<{ passed: boolean; saidWhy: boolean }>

/**
 * What a run of `run` must say, by the specification: its test's pass, Vitest's refusal of a run that found no file
 * (passWithNoTests false), the library's refusal of a VITEST_MAX_WORKERS of 0, the reporter's of a run that ended
 * with no test case executed or never ended, and toolchain-test's of a load of no property.
 */
const reasonOf = (run: Run): string => {
	switch (run) {
		case "a Vitest run executing its test":
			return "1 passed"
		case "a Vitest run whose filter matches no test case":
			return noTestRan.ended
		case "a Vitest run whose include matches no file":
			return "No test files found, exiting with code 1"
		case "a Vitest run told VITEST_MAX_WORKERS=0":
			return "VITEST_MAX_WORKERS=0 is no count of workers"
		case "a Vitest run of the reporter alone told VITEST_MAX_WORKERS=0":
			return noTestRan.unended
		case "a toolchain-test run of an include holding no property":
			return "holds no property"
	}
}

/** How a run of `run` must end: it passes exactly when it executes its test, and says why either way (reasonOf). */
export const expectedOf = (run: Run): Ended => ({
	passed: run === "a Vitest run executing its test",
	saidWhy: true
})

/**
 * Writes the consumer for `run` into `directory` from the checkout whose testing package is at `library` (Checkout.dir,
 * so a kill's mutant is in it), runs its command there to its end, its caches under the scratch directory and git
 * looking no higher, and gives how it ended.
 */
export const endedOf = (directory: string, library: string, run: Run) =>
	Effect.gen(function* () {
		const consumer = `${directory}/consumer`
		const invocation = invocationOf(run)
		yield* consumerIn(consumer, layout, library, invocation.files)
		const [exitCode, stdout, stderr] = yield* ran(consumer, process.execPath, invocation.args, {
			...invocation.env,
			XDG_CACHE_HOME: `${directory}/cache`,
			GIT_CEILING_DIRECTORIES: directory,
			NO_COLOR: "1"
		})
		return {
			passed: exitCode === 0,
			saidWhy: Str.includes(reasonOf(run))(`${stdout}${stderr}`)
		} satisfies Ended
	})
