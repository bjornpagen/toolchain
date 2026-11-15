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
	examples: {
		kind: "banned",
		exempt: [
			{
				files: ["src/gate.test.ts"],
				reason:
					"The gate's snapshot cache is a shell script run over real git repositories, where a case costs a clone, an install and a lock: each case states one behavior of the cache layout (sharing, objects, submodules, collection) on a fixed repository, which no generator draws."
			}
		]
	}
})
