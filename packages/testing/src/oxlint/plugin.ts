import { Array as Arr, Record } from "effect"
import type { DummyRuleMap } from "oxlint"
import type { Rule } from "#oxlint/rule.ts"
import { noBooleanAssert } from "#oxlint/rules/no-boolean-assert.ts"
import { noClampedCount } from "#oxlint/rules/no-clamped-count.ts"
import { noErrorProse } from "#oxlint/rules/no-error-prose.ts"
import { noExampleTable } from "#oxlint/rules/no-example-table.ts"
import { noFixedSeed } from "#oxlint/rules/no-fixed-seed.ts"
import { noImplicitWeight } from "#oxlint/rules/no-implicit-weight.ts"
import { noOrderedUnordered } from "#oxlint/rules/no-ordered-unordered.ts"
import { noRestatedConcurrency } from "#oxlint/rules/no-restated-concurrency.ts"
import { noRetryOrConcurrency } from "#oxlint/rules/no-retry-or-concurrency.ts"
import { noSerializedComparison } from "#oxlint/rules/no-serialized-comparison.ts"
import { noSleepWait } from "#oxlint/rules/no-sleep-wait.ts"
import { noVerdictTable } from "#oxlint/rules/no-verdict-table.ts"
import { noWallClockVerdict } from "#oxlint/rules/no-wall-clock-verdict.ts"
import { testModuleShape } from "#oxlint/rules/test-module-shape.ts"

/** Every rule of the plugin, by its name. */
const RULES = {
	"no-boolean-assert": noBooleanAssert,
	"no-clamped-count": noClampedCount,
	"no-error-prose": noErrorProse,
	"no-example-table": noExampleTable,
	"no-fixed-seed": noFixedSeed,
	"no-implicit-weight": noImplicitWeight,
	"no-ordered-unordered": noOrderedUnordered,
	"no-restated-concurrency": noRestatedConcurrency,
	"no-retry-or-concurrency": noRetryOrConcurrency,
	"no-serialized-comparison": noSerializedComparison,
	"no-sleep-wait": noSleepWait,
	"no-verdict-table": noVerdictTable,
	"no-wall-clock-verdict": noWallClockVerdict,
	"test-module-shape": testModuleShape
} as const satisfies Readonly<Record<string, Rule>>

/**
 * The testing library's oxlint plugin: each rule refuses a brittle test shape and names the expressive API that
 * replaces it. A consuming configuration loads it through `jsPlugins` and scopes its rules to test scope (the dev tools'
 * preset: test modules, fixtures modules, and every module under a test, integration or support directory), and the
 * test module's own shape to test modules; the rules read syntax alone and know nothing of file names.
 */
const plugin: Readonly<{ meta: Readonly<{ name: string }>; rules: typeof RULES }> = {
	meta: { name: "testing" },
	rules: RULES
}

export default plugin

const LAYERS_REPLACE_MOCKS =
	"A mock couples the test to how the code calls its dependency. Provide the dependency's test implementation as an Effect Layer and assert the outcome."
const TEST_CLOCK_REPLACES_TIMERS =
	"Fake timers patch globals behind Effect's back. Move time with TestClock under it.effect."
const SNAPSHOTS_HOLD_IRRELEVANT_DETAIL =
	"A snapshot is a golden copy of every detail, relevant or not, and fails for innocuous changes. Assert what the contract promises with agree under a named equivalence."
const CALLS_ARE_NOT_THE_CONTRACT =
	"How often and in which order a dependency was called is the implementation, not the contract. Assert the outcome the contract promises."

/**
 * oxlint's own Vitest rules as the library recommends them for test files, to spread into the block that scopes the
 * plugin's rules. They need oxlint's `vitest` plugin enabled in that block. A test runs every time, unconditionally,
 * under a title of its own; it replaces collaborators with Effect layers and moves time with TestClock instead of
 * mocking and faking timers; and it asserts the contract instead of snapshots or call counts.
 */
export const VITEST_RULES = {
	"vitest/no-conditional-tests": "error",
	"vitest/no-disabled-tests": "error",
	"vitest/no-focused-tests": "error",
	"vitest/no-identical-title": "error",
	"vitest/no-import-node-test": "error",
	"vitest/no-standalone-expect": "error",
	"vitest/valid-title": "error",
	"vitest/no-restricted-vi-methods": [
		"error",
		{
			mock: LAYERS_REPLACE_MOCKS,
			doMock: LAYERS_REPLACE_MOCKS,
			spyOn: LAYERS_REPLACE_MOCKS,
			fn: LAYERS_REPLACE_MOCKS,
			useFakeTimers: TEST_CLOCK_REPLACES_TIMERS,
			advanceTimersByTime: TEST_CLOCK_REPLACES_TIMERS,
			advanceTimersToNextTimer: TEST_CLOCK_REPLACES_TIMERS,
			runAllTimers: TEST_CLOCK_REPLACES_TIMERS
		}
	],
	"vitest/no-restricted-matchers": [
		"error",
		{
			toMatchSnapshot: SNAPSHOTS_HOLD_IRRELEVANT_DETAIL,
			toMatchInlineSnapshot: SNAPSHOTS_HOLD_IRRELEVANT_DETAIL,
			toMatchFileSnapshot: SNAPSHOTS_HOLD_IRRELEVANT_DETAIL,
			toThrowErrorMatchingSnapshot: SNAPSHOTS_HOLD_IRRELEVANT_DETAIL,
			toThrowErrorMatchingInlineSnapshot: SNAPSHOTS_HOLD_IRRELEVANT_DETAIL,
			toHaveBeenCalledTimes: CALLS_ARE_NOT_THE_CONTRACT,
			toHaveBeenLastCalledWith: CALLS_ARE_NOT_THE_CONTRACT,
			toHaveBeenNthCalledWith: CALLS_ARE_NOT_THE_CONTRACT
		}
	]
} as const satisfies DummyRuleMap

/** The plugin's rules of a test module's own shape, which hold a test module and no other module of test scope. */
const MODULE: ReadonlyArray<keyof typeof RULES> = ["test-module-shape"]

/** Rules at error, under the name the plugin loads as. */
const atError = (rules: ReadonlyArray<keyof typeof RULES>): DummyRuleMap =>
	Record.fromEntries(
		Arr.map(rules, (rule): readonly [string, "error"] => [`${plugin.meta.name}/${rule}`, "error"])
	)

/**
 * What a repository holds its test scope to: every rule of the plugin at error but a test module's own shape, under
 * the name the plugin loads as, and oxlint's own Vitest rules as the library recommends them.
 */
export const TEST_RULES: DummyRuleMap = {
	...atError(Arr.filter(Record.keys(RULES), (rule) => !Arr.contains(MODULE, rule))),
	...VITEST_RULES
}

/**
 * What a repository whose tests are properties holds its test modules to: a test module's own shape, imports, types
 * and exported properties alone. The preset applies it to test modules once the repository runs the properties pack.
 */
export const MODULE_RULES: DummyRuleMap = atError(MODULE)

/**
 * The property constructors that take a space, as no-case-list reads them from a module: each holds it in its first
 * argument (`property.explore(space, spec)`). `property.stateful` takes a machine, no space.
 */
export const PROPERTY_SEARCHES = (module: string) =>
	Arr.map(
		["property.explore", "property.exhaust", "property.batched", "property.interleave"] as const,
		(name) => ({ module, name, space: { argument: 0 } }) as const
	)

/**
 * The library's searches, generators and dictionary mint as no-case-list reads them (the dev tools' rule), by the
 * specifiers a consumer imports them with: each search with the field of its spec that holds its space, each generator
 * with what it draws. A repository's configuration gives the rule these beside its own search helpers and generators.
 */
export const CASE_LISTS = {
	searches: [
		...PROPERTY_SEARCHES("@bjornpagen/testing/property"),
		{ module: "@bjornpagen/testing/explore", name: "explore", space: { field: "draw" } },
		{ module: "@bjornpagen/testing/explore", name: "exhaust", space: { field: "generator" } }
	],
	generators: [
		{ module: "@bjornpagen/testing/gen", names: ["element"], draws: "list" },
		{ module: "@bjornpagen/testing/gen", names: ["constant"], draws: "value" },
		{ module: "@bjornpagen/testing/gen", names: ["int"], draws: "range" },
		{ module: "@bjornpagen/testing/gen", names: ["map", "span", "aimed", "finite"], draws: "each" },
		{
			module: "@bjornpagen/testing/gen",
			names: ["oneOf", "weighted", "proportional"],
			draws: "union"
		},
		{ module: "@bjornpagen/testing/explore", names: ["drawn", "sketched", "aimed"], draws: "each" }
	],
	mints: [{ module: "@bjornpagen/testing/dictionary", names: ["dictionary"] }]
} as const

/**
 * The plugin's rules whose shape is wrong wherever it is written, so every file of a repository is held to them, not
 * its tests alone: its test support, its testing library, its scripts and its product code. A clamped count builds one
 * item where a count says none in product code as in a test, and a repeated option is an unstated weight in any draw.
 */
const EVERY_FILE: ReadonlyArray<keyof typeof RULES> = ["no-clamped-count", "no-implicit-weight"]

/** What a repository holds every file to: the plugin's every-file rules at error, under the name the plugin loads as. */
export const EVERY_FILE_RULES: DummyRuleMap = atError(EVERY_FILE)

/** The plugin's rule that refuses a read of the current time. */
const CLOCK_RULE: keyof typeof RULES = "no-wall-clock-verdict"

/**
 * What a repository holds its clock-free code to beyond its test files, the testing library and the tests' support
 * modules: the plugin's clock rule, so no verdict rests on a hidden clock, an input the run's seed does not bind. A
 * module whose job is the clock (a case's hang guard, a lease's timeout) is the repository's own exception.
 */
export const CLOCK_RULES: DummyRuleMap = {
	[`${plugin.meta.name}/${CLOCK_RULE}`]: "error"
}
