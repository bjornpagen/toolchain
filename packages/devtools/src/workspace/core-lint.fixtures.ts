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
 * the same two, one that names the plugin and the core rules by hand as they stood before the newest, and one the
 * preset's standard builds. */
export type CoreConfiguration = "bare" | "partial" | "aliased" | "hand-wired" | "preset"

const CONFIGURATIONS = [
	"bare",
	"partial",
	"aliased",
	"hand-wired",
	"preset"
] as const satisfies ReadonlyArray<CoreConfiguration>

export const coreConfigurations = finite((source) => source.draw(element(CONFIGURATIONS)))

/** The configuration's file, relative to the dev tools' package. */
export const fileOf = (configuration: CoreConfiguration): string =>
	`src/workspace/fixtures/core-lint/${configuration}.config.ts`

/** The core rules a configuration holds at error, by its text: none, two, two, every one but no-variadic-callback, all. */
const heldOf = (configuration: CoreConfiguration): ReadonlyArray<string> => {
	switch (configuration) {
		case "bare":
			return []
		case "partial":
		case "aliased":
			return ["devtools/no-comment", "devtools/no-raw-regexp"]
		case "hand-wired":
			return Arr.filter(CORE_RULES, (rule) => rule !== "devtools/no-variadic-callback")
		case "preset":
			return CORE_RULES
	}
}

/** What the contract finds a configuration lacks: the plugin where it loads none, and every core rule it does not hold
 * at error, in the set's order. */
export const expectedOf = (configuration: CoreConfiguration): CoreFaults => ({
	noPlugin: configuration === "bare",
	missing: Arr.filter(CORE_RULES, (rule) => !Arr.contains(heldOf(configuration), rule))
})
