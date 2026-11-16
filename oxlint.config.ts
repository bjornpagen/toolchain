import { LIMIT_TESTS, standard } from "@bjornpagen/devtools/preset"
import { CLOCK_RULES, EVERY_FILE_RULES, TEST_RULES } from "@bjornpagen/testing/oxlint"
import { defineConfig } from "oxlint"
import toolchain from "#toolchain.config.ts"

const { active, lintConfig } = standard(toolchain)

const ZOD = {
	name: "zod",
	message:
		"Zod is banned. Effect Schema admits a foreign value once at its boundary, into a type that carries the proof."
} as const

/** Where the toolchain's limits are minted and written, and the test files the limit rules leave alone. */
const LIMITS = { packages: ["packages/limits"], tests: LIMIT_TESTS } as const

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
			"limits-sole-mint": LIMITS,
			"no-bare-limit": LIMITS,
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
			"side-effect-free": {
				modules: [
					{
						file: "packages/limit/src/limit.ts",
						specifiers: ["@bjornpagen/limit"],
						functions: [
							{ name: "published", returns: "values", invokes: [] },
							{ name: "measured", returns: "values", invokes: [] },
							{
								name: "derived",
								returns: "values",
								invokes: [{ parameter: 0, property: "compute" }]
							},
							{ name: "provisional", returns: "values", invokes: [] }
						],
						constants: []
					}
				]
			},
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
				files: ["packages/testing/src/assert.ts"],
				rules: active({
					/** The assert door keeps @effect/vitest/utils's and chai's signatures, whose message is optional, so a
					 * test moving off Vitest renames its import's specifier and changes nothing else (TESTSYS, 2026-11-16). */
					"devtools/no-optional-parameter": "off"
				})
			},
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
				files: ["packages/testing/src/engine.bench.ts"],
				rules: active({
					/** The engine bench's generator ranges are its workload, the cases it times (a collection of up to 16 items,
					 * every list of up to three digits, 1,111 cases, a shrink from ten items): data that defines what it measures,
					 * no bound, which syntax cannot tell from one. Its cases have no hang limit, since none could hang. */
					"devtools/no-bare-limit": "off"
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
