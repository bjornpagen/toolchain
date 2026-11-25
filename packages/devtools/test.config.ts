import { defineRunner, noMutation } from "@bjornpagen/testing/runner"
import { Layer } from "effect"

/**
 * The dev tools' runner config: the test modules toolchain-test runs, every property module of the package; no export
 * conditions; no services beyond the runner's own; and the library's operators alone for mutation.
 */
export default defineRunner({
	include: [
		"src/land.test.ts",
		"src/threads.test.ts",
		"src/compile-cache.test.ts",
		"src/typecheck.test.ts",
		"src/preset.test.ts",
		"src/preset-types.test.ts",
		"src/oxlint/environment.test.ts",
		"src/workspace/tsconfigs.test.ts",
		"src/oxlint/rules/bearer-owners.test.ts",
		"src/oxlint/rules/side-effect-free.test.ts",
		"src/oxlint/rules/no-case-list.test.ts",
		"src/oxlint/rules/no-variadic-callback.test.ts",
		"src/oxlint/rules/no-plant.test.ts",
		"src/oxlint/rules/single-permit-owners.test.ts",
		"src/shared/git.test.ts",
		"src/workspace/banned-packages.test.ts",
		"src/workspace/compile-cache.test.ts",
		"src/workspace/dead-paths.test.ts",
		"src/workspace/quarantine.test.ts",
		"src/workspace/root-files.test.ts",
		"src/workspace/root-tasks.test.ts",
		"src/workspace/test-system.test.ts"
	],
	smallStack: [],
	conditions: [],
	environment: [],
	layer: Layer.empty,
	mutation: noMutation
})
