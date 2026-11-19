import { fixtureServices } from "#resources/resources.fixtures.ts"
import { defineRunner, noMutation } from "#runner/config.ts"

/**
 * The testing library's runner config: the test modules toolchain-test runs, every property module of the package; no
 * export conditions; the package's own local cluster (pg.config.ts, resources.fixtures.ts; CONTRIBUTING.md,
 * "Properties that need a database"), built only when a case first opens a need; and the library's operators alone
 * for mutation.
 */
export default defineRunner({
	include: [
		"src/fact.test.ts",
		"src/oracle.test.ts",
		"src/seeds.test.ts",
		"src/interleave.test.ts",
		"src/commands.test.ts",
		"src/runner/closure.test.ts",
		"src/runner/keep.test.ts",
		"src/runner/cache.test.ts",
		"src/runner/consumer.test.ts",
		"src/resources/scratch.test.ts",
		"src/resources/resources.test.ts",
		"src/pg/make.test.ts",
		"src/pg/reached.test.ts",
		"src/pg/lease.test.ts",
		"src/core.test.ts",
		"src/recorded.test.ts",
		"src/idioms.test.ts",
		"src/shrink.test.ts",
		"src/features.test.ts",
		"src/agree.test.ts",
		"src/fuzz.test.ts",
		"src/sense.test.ts",
		"src/blocking.test.ts",
		"src/runner/work.test.ts",
		"src/runner/search.test.ts",
		"src/runner/case.test.ts",
		"src/runner/pool.test.ts",
		"src/runner/launcher.test.ts",
		"src/runner/resolutions.test.ts",
		"src/runner/schedule.test.ts",
		"src/runner/steer.test.ts",
		"src/mutate/*.test.ts",
		"src/oxlint/rules.test.ts",
		"src/mutants.test.ts",
		"src/mutate.test.ts"
	],
	smallStack: [],
	conditions: [],
	layer: fixtureServices,
	mutation: noMutation
})
