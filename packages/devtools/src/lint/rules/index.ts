import type { GrizzleOptions } from "#lint/options.ts"
import { noEnvironment } from "#lint/rules/no-environment.ts"
import type { Rule } from "#lint/types.ts"

/**
 * superlint's rules, by pack: a repository runs the grizzle pack when its toolchain names it, with the repository's
 * names for it. Every rule that reads syntax alone is the oxlint plugin's (src/oxlint-plugin.ts): the core's
 * no-module-state, no-null-undefined-union and no-spread-argument, the Effect-free imports, the drizzle pack's rules
 * and grizzle's no-case-list; whether a test case runs a search is the testing library's reporter's to judge, at run
 * time.
 */

/** grizzle's rules: a library that reads no environment. */
export const GRIZZLE_RULES: ReadonlyArray<Rule<GrizzleOptions>> = [
	{ id: "no-environment", starting: { reads: "file", visit: noEnvironment }, gate: "on" }
]
