import type { GrizzleOptions } from "#lint/options.ts"
import type { Rule } from "#lint/types.ts"

/**
 * superlint's rules, by pack: none is left. Every rule that reads syntax alone is the oxlint plugin's
 * (src/oxlint-plugin.ts): the core's no-module-state, no-null-undefined-union and no-spread-argument, the Effect-free
 * imports, the drizzle pack's rules and grizzle's no-case-list; grizzle's no-environment is the preset's environment
 * bans on a repository's library (src/oxlint/environment.ts); and whether a test case runs a search is the testing
 * library's reporter's to judge, at run time.
 */

/** grizzle's rules. */
export const GRIZZLE_RULES: ReadonlyArray<Rule<GrizzleOptions>> = []
