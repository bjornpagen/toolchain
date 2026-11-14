import { defineTestConfig } from "@bjornpagen/testing/vitest/config"

export default defineTestConfig({
	include: ["src/**/*.test.ts"],
	guided: [],
	setup: [],
	conditions: [],
	timeouts: {
		test: { kind: "bounded", millis: 60_000 },
		hook: { kind: "bounded", millis: 60_000 }
	},
	smallStack: [],
	examples: { kind: "banned", exempt: [] }
})
