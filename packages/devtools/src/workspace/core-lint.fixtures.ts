/**
 * What core-lint.test.ts reads: the configurations of src/workspace/fixtures/core-lint, each with what it lacks of the
 * core set by the rule's contract.
 */
import { element, finite } from "@bjornpagen/testing/gen"
import { Array as Arr } from "effect"
import { CORE_RULES } from "#preset.ts"
import type { CoreFaults } from "#workspace/core-lint.ts"

/** A configuration of the box: one on another preset, one that loads the plugin and holds two core rules, one that
 * loads it under a name of its own beside a plugin named by its package (each form of oxlint's plugin entry) and holds
 * the same two, one that names the plugin and the core rules by hand as they stood before the newest, one that holds
 * the same two and turns on rules of built-in plugins it does not load, and one the preset's standard builds. */
export type CoreConfiguration = "bare" | "partial" | "aliased" | "hand-wired" | "silent" | "preset"

const CONFIGURATIONS = [
	"bare",
	"partial",
	"aliased",
	"hand-wired",
	"silent",
	"preset"
] as const satisfies ReadonlyArray<CoreConfiguration>

export const coreConfigurations = finite((source) => source.draw(element(CONFIGURATIONS)))

/** The configuration's file, relative to the dev tools' package. */
export const fileOf = (configuration: CoreConfiguration): string =>
	`src/workspace/fixtures/core-lint/${configuration}.config.ts`

/** The core rules the toolchain added after the hand-wired configuration was written, which it therefore lacks. */
const ADDED_SINCE_HAND_WIRING: ReadonlyArray<string> = [
	"devtools/no-variadic-callback",
	"devtools/grizzle-star-imports"
]

/** The core rules a configuration holds at error, by its text: none, two, two, every one but those added since the
 * hand-wired one was written, all. */
const heldOf = (configuration: CoreConfiguration): ReadonlyArray<string> => {
	switch (configuration) {
		case "bare":
			return []
		case "partial":
		case "aliased":
		case "silent":
			return ["devtools/no-comment", "devtools/no-raw-regexp"]
		case "hand-wired":
			return Arr.filter(CORE_RULES, (rule) => !Arr.contains(ADDED_SINCE_HAND_WIRING, rule))
		case "preset":
			return CORE_RULES
	}
}

/**
 * The rules a configuration turns on that no plugin it loads runs, in name order: the silent one's jsdoc and promise
 * rules at its top and react's in its override, never its react rule turned off or its override's vitest rule, which
 * the override loads; none for any other.
 */
const silentOf = (configuration: CoreConfiguration): ReadonlyArray<string> =>
	configuration === "silent"
		? ["jsdoc/check-tag-names", "promise/prefer-await-to-then", "react/no-danger"]
		: []

/** What the contract finds a configuration lacks: the plugin where it loads none, every core rule it does not hold at
 * error, in the set's order, and every rule it turns on that no plugin it loads runs. */
export const expectedOf = (configuration: CoreConfiguration): CoreFaults => ({
	noPlugin: configuration === "bare",
	missing: Arr.filter(CORE_RULES, (rule) => !Arr.contains(heldOf(configuration), rule)),
	silent: silentOf(configuration)
})
