import { suiteTimeoutMillis } from "@bjornpagen/limits"
import { defineTestConfig } from "@bjornpagen/testing/vitest/config"

export default defineTestConfig({
	include: ["src/**/*.test.ts", "!src/workspace/tsconfigs.test.ts", "!src/gate.test.ts"],
	guided: [],
	setup: [],
	conditions: [],
	timeouts: {
		test: { kind: "bounded", millis: suiteTimeoutMillis.value },
		hook: { kind: "bounded", millis: suiteTimeoutMillis.value }
	},
	smallStack: [],
	examples: { kind: "banned", exempt: [] }
})
