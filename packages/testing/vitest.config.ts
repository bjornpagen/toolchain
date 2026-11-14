import { defineTestConfig } from "#vitest/config.ts"

export default defineTestConfig({
	include: ["src/**/*.test.ts"],
	guided: ["src/sense.test.ts"],
	setup: [],
	conditions: [],
	timeouts: {
		test: { kind: "bounded", millis: 60_000 },
		hook: { kind: "bounded", millis: 60_000 }
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
