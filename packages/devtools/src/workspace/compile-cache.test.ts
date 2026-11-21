/**
 * The workspace gate's turbo-compile-cache rule (src/workspace/compile-cache.ts), exhausted over the turbo.json shapes
 * its contract tells apart (compile-cache.fixtures.ts): none, one with no globalPassThroughEnv, and one whose
 * globalPassThroughEnv names any subset of the toolchain's own (TMPDIR, NODE_OPTIONS, NODE_COMPILE_CACHE). The rule must
 * report exactly a turbo.json that passes no NODE_COMPILE_CACHE, at its globalPassThroughEnv key where it has one and
 * its first line where it has none, and nothing else. Oracle: the specification, the rule's JSDoc read over the names
 * its module exports (COMPILE_CACHE, PASS_THROUGH).
 */
import { assert } from "@bjornpagen/testing/assert"
import { property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { expectedOf, textOf, turbos } from "#workspace/compile-cache.fixtures.ts"
import { compileCacheFindings } from "#workspace/compile-cache.ts"

export const compileCachePassed = property.exhaust(turbos, {
	box: "no turbo.json, and turbo.json with no pass-through or a pass-through of each subset of the toolchain's own",
	needs: {},
	situations: [],
	check: () => (turbo) =>
		Effect.gen(function* () {
			const findings = yield* compileCacheFindings({ root: "/repo", turbo: textOf(turbo) })
			assert.deepEqual<ReadonlyArray<Readonly<{ file: string; line: number; rule: string }>>>(
				Arr.map(findings, ({ file, line, rule }) => ({ file, line, rule })),
				expectedOf(turbo)
			)
		}),
	oracle: {
		kind: "specification",
		name: "the rule's stated contract over the names its module exports"
	},
	kept: [],
	kills: [
		{
			file: "packages/devtools/src/workspace/compile-cache.ts",
			original: "\t\t\t\t\t\tArr.contains(config.globalPassThroughEnv ?? [], COMPILE_CACHE)\n",
			replacement: "\t\t\t\t\t\ttrue\n",
			why: "A turbo.json that drops NODE_COMPILE_CACHE passes the gate, so a tool its tasks run keeps Node's compile cache under os.tmpdir(), the tmpfs whose inodes ran out on cassowary (main, 2026-11-20); the property fails for every turbo.json without it."
		}
	]
})
