import { Layer } from "effect"
import { defineRunner } from "#runner/config.ts"

/**
 * The testing library's runner config: the test modules toolchain-test runs, which Vitest's config leaves to it as
 * they are converted to properties; no export conditions; and no services beyond the runner's own.
 */
export default defineRunner({
	include: [
		"src/fact.test.ts",
		"src/oracle.test.ts",
		"src/seeds.test.ts",
		"src/interleave.test.ts",
		"src/commands.test.ts"
	],
	conditions: [],
	layer: Layer.empty
})
