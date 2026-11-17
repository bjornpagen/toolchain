import { standard } from "@bjornpagen/devtools/preset"
import {
	CASE_LISTS,
	CLOCK_RULES,
	EVERY_FILE_RULES,
	MODULE_RULES,
	PROPERTY_SEARCHES,
	TEST_RULES
} from "@bjornpagen/testing/oxlint"
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
					{ doors: ["packages/testing/src/mutate/mutated.ts"], brands: ["RealPath"] },
					{ doors: ["packages/testing/src/mutate/checkout.ts"], brands: ["CheckoutDir"] }
				]
			},
			"import-doors": { doors: [] },
			"no-case-list": {
				searches: [
					...CASE_LISTS.searches,
					...PROPERTY_SEARCHES("#property.ts"),
					{ module: "#explore.ts", name: "exhaust", space: { field: "generator" } },
					{ module: "#explore.ts", name: "explore", space: { field: "draw" } }
				],
				generators: [
					...CASE_LISTS.generators,
					{ module: "#gen.ts", names: ["element"], draws: "list" },
					{ module: "#gen.ts", names: ["constant"], draws: "value" },
					{ module: "#gen.ts", names: ["int"], draws: "range" },
					{ module: "#gen.ts", names: ["map", "span", "aimed", "finite"], draws: "each" },
					{ module: "#gen.ts", names: ["oneOf", "weighted", "proportional"], draws: "union" },
					{ module: "#explore.ts", names: ["drawn", "sketched", "aimed"], draws: "each" }
				],
				mints: [...CASE_LISTS.mints, { module: "#dictionary.ts", names: ["dictionary"] }],
				cases: [],
				dictionaries: []
			},
			"no-dynamic-imports": { allowed: [] },
			"no-raw-sql": { sources: ["packages/testing/src"], writers: [] },
			"no-spread-argument": { tuples: [] },
			"side-effect-free": {
				modules: []
			},
			"single-permit-owners": { owners: [] },
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
			modules: MODULE_RULES,
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
					/** The type tier's refusals: a literal handed where a stream goes is the type error each entry proves. */
					"testing/no-fixed-seed": "off",
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
				rules: active({})
			},
			{
				files: ["packages/testing/src/blocking.fixtures.ts"],
				rules: active({
					/** A planted property that sleeps past its hang limit: the hang guard's case is the wait itself. */
					"testing/no-sleep-wait": "off"
				})
			},
			{
				files: [
					"packages/testing/src/runner/cli.ts",
					"packages/testing/src/runner/module-closure.ts"
				],
				rules: active({
					/** The modules that load TypeScript's native compiler, an optional peer of the library (closure.ts, mutants.ts),
					 * loaded only by the commands and the service that use them, so a consumer runs `toolchain-test run` without
					 * TypeScript installed (TESTSYS, 2026-11-16). */
					"devtools/no-dynamic-imports": "off"
				})
			},
			{
				files: [
					"packages/testing/src/runner/cli-entry.ts",
					"packages/testing/src/runner/worker-entry.ts"
				],
				rules: active({
					/** A runner process's entries, which load the process's own modules only once the resolutions their loads
					 * read are installed (runner/resolutions.ts): a static import would resolve them first (CORE-3, 2026-11-17). */
					"devtools/no-dynamic-imports": "off"
				})
			},
			{
				files: ["packages/testing/src/runner/resolutions.fixtures.ts"],
				rules: active({
					/** The resolutions property's program, which loads a module graph the property writes at run time, after it
					 * installs the resolutions it was handed (CORE-3, 2026-11-17). */
					"devtools/no-dynamic-imports": "off"
				})
			},
			{
				files: ["packages/testing/src/runner/resolutions.ts"],
				rules: active({
					/** A process's resolutions, which Node's resolve hook reads for every module the process loads: the
					 * process's own by Node's design, as its module cache is, and filled before any runtime exists to hold a Ref
					 * (CORE-3, 2026-11-17). */
					"devtools/no-module-state": "off"
				})
			},
			{
				files: ["packages/testing/src/runner/load.ts"],
				rules: active({
					/** The runner's one load of a package's test.config.ts and test modules, whose paths it learns only at run
					 * time (TESTSYS lane CORE, 2026-11-16). */
					"devtools/no-dynamic-imports": "off"
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
