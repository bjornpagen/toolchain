import { Layer } from "effect"
import { defineRunner } from "#runner/config.ts"

/**
 * The testing library's runner config: the test modules toolchain-test runs, which Vitest's config leaves to it as
 * they are converted to properties; no export conditions; no services beyond the runner's own; and the library's
 * operators alone for mutation.
 */
export default defineRunner({
	include: [
		"src/fact.test.ts",
		"src/oracle.test.ts",
		"src/seeds.test.ts",
		"src/interleave.test.ts",
		"src/commands.test.ts",
		"src/runner/closure.test.ts",
		"src/runner/cache.test.ts"
	],
	smallStack: [],
	conditions: [],
	layer: Layer.empty,
	families: []
})
