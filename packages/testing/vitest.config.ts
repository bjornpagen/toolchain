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
		"!src/runner/**"
	],
	guided: ["src/sense.test.ts"],
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
