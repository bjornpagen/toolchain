import { defineRunner } from "@bjornpagen/testing/runner"
import { Layer } from "effect"

/**
 * The dev tools' runner config: the test modules toolchain-test runs, which Vitest's config leaves to it as they are
 * converted to properties; no export conditions; no services beyond the runner's own; and the library's operators
 * alone for mutation.
 */
export default defineRunner({
	include: [
		"src/workspace/tsconfigs.test.ts",
		"src/oxlint/rules/bearer-owners.test.ts",
		"src/oxlint/rules/side-effect-free.test.ts",
		"src/oxlint/rules/no-case-list.test.ts",
		"src/oxlint/rules/no-plant.test.ts",
		"src/oxlint/rules/single-permit-owners.test.ts",
		"src/workspace/dead-paths.test.ts",
		"src/workspace/quarantine.test.ts",
		"src/workspace/test-system.test.ts"
	],
	smallStack: [],
	conditions: [],
	layer: Layer.empty,
	families: []
})
