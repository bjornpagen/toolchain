import { fixtureServices } from "#resources/resources.fixtures.ts"
import { defineRunner } from "#runner/config.ts"

/**
 * The testing library's runner config: the test modules toolchain-test runs, which Vitest's config leaves to it as
 * they are converted to properties; no export conditions; the PostgreSQL cluster libpq's environment names
 * (resources.fixtures.ts), built only when a case first opens a need, for the database resource properties
 * (src/resources/resources.test.ts), which join the include once the push gate's run has a cluster to reach; and the
 * library's operators alone for mutation.
 */
export default defineRunner({
	include: [
		"src/fact.test.ts",
		"src/oracle.test.ts",
		"src/seeds.test.ts",
		"src/interleave.test.ts",
		"src/commands.test.ts",
		"src/runner/closure.test.ts",
		"src/runner/cache.test.ts",
		"src/runner/consumer.test.ts",
		"src/resources/scratch.test.ts",
		"src/core.test.ts",
		"src/idioms.test.ts",
		"src/shrink.test.ts",
		"src/features.test.ts",
		"src/agree.test.ts",
		"src/fuzz.test.ts",
		"src/sense.test.ts",
		"src/blocking.test.ts",
		"src/runner/search.test.ts",
		"src/runner/case.test.ts",
		"src/runner/steer.test.ts",
		"src/mutate/*.test.ts",
		"src/oxlint/rules.test.ts",
		"src/mutants.test.ts",
		"src/mutate.test.ts"
	],
	smallStack: [],
	conditions: [],
	layer: fixtureServices,
	families: []
})
