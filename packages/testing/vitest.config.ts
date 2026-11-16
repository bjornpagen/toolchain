import { defineTestConfig } from "#vitest/config.ts"

/**
 * The Vitest timeout of every test and hook of the toolchain's own suites (each package's vitest.config.ts).
 *
 * @limitKind provisional
 * @owner the toolchain's own suites (packages/devtools and packages/testing, their defineTestConfig timeouts)
 * @unit milliseconds
 * @scope each test and each hook of the dev tools' and the testing library's suites
 * @guards without a timeout a test that hangs holds its worker, and the run, until someone stops it, and the hang is
 *   never reported as the test's
 * @measure time every test and hook of both suites on cassowary over several full runs at their usual width, and
 *   choose the timeout above the slowest seen, with its headroom stated; split it per suite, or per tier, if their
 *   slowest differ by much
 * @origin written with the suites' configs: the testing library's in 20b4112 and the dev tools' in 5ebe0a1
 *   (2026-11-13), with no evidence
 * @recorded 2026-11-16
 */
export const suiteTimeoutMillis = 60_000

export default defineTestConfig({
	include: [
		"src/**/*.test.ts",
		"!src/fact.test.ts",
		"!src/idioms.test.ts",
		"!src/core.test.ts",
		"!src/shrink.test.ts",
		"!src/oracle.test.ts",
		"!src/seeds.test.ts",
		"!src/interleave.test.ts",
		"!src/commands.test.ts",
		"!src/runner/**",
		"!src/resources/**",
		"!src/features.test.ts",
		"!src/agree.test.ts",
		"!src/mutate/**",
		"!src/fuzz.test.ts",
		"!src/sense.test.ts",
		"!src/oxlint/rules.test.ts",
		"!src/mutants.test.ts",
		"!src/mutate.test.ts",
		"!src/blocking.test.ts"
	],
	guided: [],
	setup: [],
	conditions: [],
	timeouts: {
		test: { kind: "bounded", millis: suiteTimeoutMillis },
		hook: { kind: "bounded", millis: suiteTimeoutMillis }
	},
	smallStack: [],
	examples: {
		kind: "banned",
		exempt: [
			{
				files: ["src/engine.bench.ts"],
				reason:
					"The testing library's engine bench: it measures what generating, replaying, enumerating, shrinking and exploring cost, a performance measure, never a verdict a person wrote."
			}
		]
	}
})
