import { suiteTimeoutMillis } from "@bjornpagen/limits"
import { defineTestConfig } from "@bjornpagen/testing/vitest/config"

export default defineTestConfig({
	include: [
		"src/**/*.test.ts",
		"!src/workspace/tsconfigs.test.ts",
		"!src/gate.test.ts",
		"!src/oxlint/rules/bearer-owners.test.ts",
		"!src/oxlint/rules/side-effect-free.test.ts",
		"!src/oxlint/rules/no-case-list.test.ts",
		"!src/oxlint/rules/no-plant.test.ts",
		"!src/oxlint/rules/single-permit-owners.test.ts",
		"!src/workspace/dead-paths.test.ts",
		"!src/workspace/quarantine.test.ts",
		"!src/workspace/test-system.test.ts"
	],
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
