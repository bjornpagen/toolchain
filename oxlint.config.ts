import { standard } from "@bjornpagen/devtools/preset"
import { CASE_LISTS, PROPERTY_SEARCHES } from "@bjornpagen/testing/oxlint"
import { defineConfig } from "oxlint"
import toolchain from "#toolchain.config.ts"

const { active, lintConfig } = standard(toolchain)

/** The toolchain repository's lists for the shared standard; everything else comes from the dev tools' preset. */
export default defineConfig(
	lintConfig({
		ignorePatterns: ["packages/devtools/src/*/fixtures/**", "out/**"],
		restrictedImports: { paths: [], patterns: [] },
		restrictedGlobals: [],
		restrictedProperties: [],
		restrictions: [],
		unassignedImports: [],
		environment: { library: [], readers: [] },
		ceremony: ["packages/devtools/**"],
		plugin: {
			"bearer-owners": { owners: [] },
			"brands-sole-mint": {
				mints: [
					{ doors: ["packages/testing/src/random.ts"], brands: ["LabelStream", "RunStream"] },
					{ doors: ["packages/testing/src/mutate/mutated.ts"], brands: ["RealPath"] },
					{ doors: ["packages/testing/src/mutate/checkout.ts"], brands: ["CheckoutDir"] },
					{ doors: ["packages/testing/src/runner/work.ts"], brands: ["Overrun"] }
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
		/** Every package of the toolchain is clock-free, its tools' code as its testing library's: no verdict of a gate it
		 * runs rests on the machine's speed. The modules whose job is the clock are the overrides' exceptions. */
		tests: {
			library: "installed",
			clockFree: ["packages/*/src/**", "packages/*/scripts/**", "packages/*/bin/**"]
		},
		overrides: [
			{
				files: ["packages/testing/src/assert.ts"],
				rules: active({
					/** A boxed primitive is an object of its wrapper class, which no typeof check sees: `matchers.any(String)`
					 * accepts both, and a pattern compares a boxed one whole. */
					"unicorn/no-instanceof-builtins": "off"
				})
			},
			{
				files: ["packages/devtools/src/oxlint/rules/sha256-digests.ts"],
				rules: active({
					/** The rule spells the digest it refuses, to find it. */
					"devtools/sha256-digests": "off"
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
				files: ["packages/testing/src/oxlint/rules.test.ts"],
				rules: active({
					/** The rule's kills quote the phrases it refuses, to find them in its module. */
					"testing/no-trigger-switch": "off"
				})
			},
			{
				files: ["packages/testing/src/witness.fixtures.ts"],
				rules: active({
					/** The type tier's refusals: a literal handed where a stream goes is the type error each entry proves. */
					"testing/no-fixed-seed": "off"
				})
			},
			{
				files: [
					"packages/testing/src/witness.fixtures.ts",
					"packages/testing/src/resources/cluster.fixtures.ts"
				],
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
				rules: active({})
			},
			{
				files: ["packages/testing/scripts/codemod/main.ts"],
				rules: active({
					/** The codemod's one date, today's, which it writes as the `since` of each case it keeps: a record's date,
					 * which no verdict reads. */
					"testing/no-wall-clock-verdict": "off"
				})
			},
			{
				files: ["packages/testing/src/blocking.fixtures.ts"],
				rules: active({
					/** A planted property that sleeps past its hang limit: the hang guard's case is the wait itself. */
					"testing/no-sleep-wait": "off",
					/** The watchdog's own property, which measures the watchdog's lateness on the live clock against the
					 * grace of wall time it is specified by (live.ts watchdogGraceMillis). */
					"testing/no-wall-clock-verdict": "off"
				})
			},
			{
				files: [
					"packages/testing/src/runner/cli.ts",
					"packages/testing/src/runner/module-closure.ts",
					"packages/testing/src/runner/settle.ts"
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
					"packages/testing/src/runner/load-entry.ts",
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
				files: ["packages/testing/src/runner/observe.ts"],
				rules: active({
					/** A worker's guard, which wraps Node's process-wide modules once as the worker starts, before any runtime
					 * exists to hold a Ref, and whose window every unit opens: the process's own by Node's design, as its
					 * module cache is (lane TOOLTRUST, 2026-11-24). */
					"devtools/no-module-state": "off"
				})
			},
			{
				files: ["packages/testing/src/runner/recorder.ts"],
				rules: active({
					/** A Node child's recorder, which runs before any module of the child's loads: it reaches the module loader's
					 * file-system methods through Node's own require of internal/modules/helpers, their one door, and marks the
					 * thread it records on that thread's global object, the thread's own by Node's design, before any runtime
					 * exists to hold a Ref (lane TRACE, 2026-11-26). */
					"devtools/no-dynamic-imports": "off",
					"devtools/no-module-state": "off"
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
				files: ["packages/testing/src/pg/config-file.ts"],
				rules: active({
					/** The one load of a package's pg.config.ts, whose path toolchain-pg and the hold properties' run program
					 * learn only at run time, as the runner loads test.config.ts (lane CLUSTERPORT, 2026-11-18). */
					"devtools/no-dynamic-imports": "off"
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
