import type { CoreOptions, GrizzleOptions } from "#lint/options.ts"
import { noCaseList } from "#lint/rules/no-case-list.ts"
import { noEnvironment } from "#lint/rules/no-environment.ts"
import { noModuleState } from "#lint/rules/no-module-state.ts"
import { noSpreadArgument } from "#lint/rules/no-spread-argument.ts"
import { noNullUndefinedUnion } from "#lint/rules/null-undefined-union.ts"
import type { Rule } from "#lint/types.ts"

/**
 * superlint's rules, by pack. Every repository runs the core, and a repository runs the grizzle pack when its toolchain
 * names it, each with the repository's names for it; the drizzle pack's rules are the oxlint plugin's (src/oxlint). A
 * rule whose options name nothing to guard in a repository is inert there. Every rule visits every owned file, test
 * files included.
 */

/** The rules every repository runs. */
export const CORE_RULES: ReadonlyArray<Rule<CoreOptions>> = [
	{ id: "no-module-state", starting: { reads: "file", visit: noModuleState }, gate: "on" },
	{
		id: "no-null-undefined-union",
		starting: { reads: "file", visit: noNullUndefinedUnion },
		gate: "on"
	},
	{ id: "no-spread-argument", starting: { reads: "file", visit: noSpreadArgument }, gate: "on" }
]

/** grizzle's rules: a search's space that is never a list of cases, and a library that reads no environment; whether
 * a test case runs a search is the testing library's reporter's to judge, at run time. */
export const GRIZZLE_RULES: ReadonlyArray<Rule<GrizzleOptions>> = [
	{ id: "no-case-list", starting: { reads: "program", start: noCaseList }, gate: "on" },
	{ id: "no-environment", starting: { reads: "file", visit: noEnvironment }, gate: "on" }
]
