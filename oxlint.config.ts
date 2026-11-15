import { standard } from "@bjornpagen/devtools/preset"
import { CLOCK_RULES, EVERY_FILE_RULES, TEST_RULES } from "@bjornpagen/testing/oxlint"
import { defineConfig } from "oxlint"
import toolchain from "#toolchain.config.ts"

const { active, lintConfig } = standard(toolchain)

const ZOD = {
	name: "zod",
	message:
		"Zod is banned. Effect Schema admits a foreign value once at its boundary, into a type that carries the proof."
} as const

/** The toolchain repository's lists for the shared standard; everything else comes from the dev tools' preset. */
export default defineConfig(
	lintConfig({
		ignorePatterns: ["packages/devtools/src/*/fixtures/**", "out/**"],
		restrictedImports: { paths: [ZOD], patterns: [] },
		restrictedGlobals: [],
		restrictedProperties: [],
		unassignedImports: [],
		environment: { library: [], readers: [] },
		ceremony: ["packages/devtools/**"],
		plugin: {
			"bearer-owners": { owners: [] },
			"brands-sole-mint": {
				mints: [
					{ doors: ["packages/testing/src/random.ts"], brands: ["LabelStream", "RunStream"] },
					{ doors: ["packages/testing/src/vitest/mutated-file.ts"], brands: ["RealPath"] }
				]
			},
			"import-doors": { doors: [] },
			"no-case-list": {
				searches: [
					{ module: "@bjornpagen/testing/explore", name: "exhaust", space: "generator" },
					{ module: "@bjornpagen/testing/explore", name: "explore", space: "draw" },
					{ module: "#explore.ts", name: "exhaust", space: "generator" },
					{ module: "#explore.ts", name: "explore", space: "draw" }
				],
				generators: [
					{ module: "@bjornpagen/testing/gen", names: ["element"], draws: "list" },
					{ module: "@bjornpagen/testing/gen", names: ["constant"], draws: "value" },
					{ module: "@bjornpagen/testing/gen", names: ["map", "span"], draws: "each" },
					{
						module: "@bjornpagen/testing/gen",
						names: ["oneOf", "weighted", "proportional"],
						draws: "union"
					},
					{
						module: "@bjornpagen/testing/explore",
						names: ["drawn", "sketched", "aimed"],
						draws: "each"
					},
					{ module: "#gen.ts", names: ["element"], draws: "list" },
					{ module: "#gen.ts", names: ["constant"], draws: "value" },
					{ module: "#gen.ts", names: ["map", "span"], draws: "each" },
					{ module: "#gen.ts", names: ["oneOf", "weighted", "proportional"], draws: "union" },
					{ module: "#explore.ts", names: ["drawn", "sketched", "aimed"], draws: "each" }
				],
				cases: []
			},
			"no-dynamic-imports": { allowed: [] },
			"no-raw-sql": { sources: ["packages/testing/src"], writers: [] },
			"no-spread-argument": { tuples: [] },
			"side-effect-free": { modules: [] },
			"test-no-prose-search": {
				fields: ["capability", "what"],
				textHelpers: ["containsText", "lacksText", "contains", "lacks"],
				searchHelpers: ["contains", "containsText"]
			},
			"test-no-spelled-names": { markers: [] }
		},
		ownPlugins: [],
		tests: {
			library: "installed",
			jsPlugin: "@bjornpagen/testing/oxlint",
			rules: TEST_RULES,
			everyFile: EVERY_FILE_RULES,
			clock: { files: ["packages/testing/src/**"], rules: CLOCK_RULES }
		},
		overrides: [
			{
				files: ["packages/devtools/src/shared/config.ts"],
				rules: active({
					/** The one load of a repository's toolchain.config.ts, whose path is known only at run time (owner, D1,
					 * 2026-11-14). */
					"devtools/no-dynamic-imports": "off"
				})
			},
			{
				files: ["packages/testing/src/witness.fixtures.ts"],
				rules: active({
					/** A type test's refusal is a `@ts-expect-error` that names what it refuses. */
					"typescript/ban-ts-comment": [
						"error",
						{
							"ts-check": true,
							"ts-expect-error": "allow-with-description",
							"ts-ignore": true,
							"ts-nocheck": true
						}
					]
				})
			},
			{
				files: ["packages/testing/src/live.ts"],
				rules: active({
					/** The live clock a case's hang guard and a fuzz run's time budget read: its job is the clock. */
					"testing/no-wall-clock-verdict": "off"
				})
			}
		]
	})
)
