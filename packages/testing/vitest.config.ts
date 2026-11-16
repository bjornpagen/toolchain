import { suiteTimeoutMillis } from "@bjornpagen/limits"
import { defineTestConfig } from "#vitest/config.ts"

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
		test: { kind: "bounded", millis: suiteTimeoutMillis.value },
		hook: { kind: "bounded", millis: suiteTimeoutMillis.value }
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
