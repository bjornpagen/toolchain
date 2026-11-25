/**
 * A run that executes no test fails, whatever its worker setting: Vitest under the library's config
 * (vitest/config.ts defineTestConfig) fails a run whose filter matches no test case or whose include matches no file,
 * each saying why, and refuses a VITEST_MAX_WORKERS of 0 before it starts; under a config of the package's own that
 * names the library's reporter, a run whose workers never start (VITEST_MAX_WORKERS=0) fails, saying why; toolchain-test's `run` fails a runner config whose include holds no property; and a run that executes its
 * one test passes. Each case writes a consumer package from the checkout's own library (Checkout.dir, so a kill's
 * mutant is in it) and runs the command in a child process. Oracle: the specification, stated per case
 * (norun.fixtures.ts expectedOf and reasonOf): edullm's gate, 2026-11-24, whose unit pinned to 8 CPUs derived
 * VITEST_MAX_WORKERS=0, ran no test and exited 0.
 */
import { Effect } from "effect"
import { assert } from "#assert.ts"
import { Checkout } from "#mutate/checkout.ts"
import { property } from "#property.ts"
import { Scratch } from "#resources/scratch.ts"
import { endedOf, expectedOf, runs } from "#runner/norun.fixtures.ts"

export const aRunOfNoTestFails = property.exhaust(runs, {
	box: "a consumer's Vitest run executing its one test, filtering every test out, including no file, told VITEST_MAX_WORKERS=0, and its reporter alone told it, and its toolchain-test run of an include holding no property",
	needs: { directory: Scratch.dir, checkout: Checkout.dir },
	situations: [],
	check:
		({ directory, checkout }) =>
		(run) =>
			Effect.gen(function* () {
				const scratch = yield* directory
				const library = yield* checkout
				const ended = yield* endedOf(scratch, library, run)
				assert.deepEqual(ended, expectedOf(run))
			}),
	oracle: {
		kind: "specification",
		name: "a run passes exactly when it executes a test; a run that executes none, by a filter, an include, a worker setting of 0 or a runner config of no property, fails and says why"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/vitest/reporter.ts",
			original:
				'\t\tif (watched.kind === "running" && watched.executed === 0 && reason !== "interrupted") {\n',
			replacement:
				'\t\tif (watched.kind === "running" && watched.executed < 0 && reason !== "interrupted") {\n',
			why: "A run that ended with no test case executed passes, so a filter that matches none is a green gate; the property fails."
		},
		{
			file: "packages/testing/src/vitest/reporter.ts",
			original: '\t\tprocess.on("beforeExit", () => {\n',
			replacement: '\t\tprocess.on("never", () => {\n',
			why: "A run whose workers never start is left to Node, which exits 0 as the event loop drains, the false green of edullm's gate; the property fails."
		},
		{
			file: "packages/testing/src/vitest/config.ts",
			original: "\t\t\tif (!workersText.test(text)) {\n",
			replacement: '\t\t\tif (!workersText.test(text) && text !== "0") {\n',
			why: "VITEST_MAX_WORKERS=0 is taken, so Vitest starts with no worker rather than refusing as it loads its config; the property fails."
		},
		{
			file: "packages/testing/src/vitest/config.ts",
			original: "\t\t\tpassWithNoTests: false,\n",
			replacement: "\t\t\tpassWithNoTests: true,\n",
			why: "A run whose include matches no file passes; the property fails."
		},
		{
			file: "packages/testing/src/runner/run.ts",
			original: "\t\tif (!Arr.isReadonlyArrayNonEmpty(discovered)) {\n",
			replacement: "\t\tif (discovered.length < 0) {\n",
			why: "A runner config whose include holds no property loads, so `run` runs none and exits 0; the property fails."
		}
	]
})
