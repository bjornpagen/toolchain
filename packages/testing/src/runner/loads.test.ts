/**
 * `toolchain-test load` (runner/loads.ts) over a consumer package in a git repository, run twice: the first run loads
 * every test module apart and fails exactly on a module that throws as it loads (a const read in its temporal dead
 * zone, an initializer that throws, an export that is no property), naming it with what it threw; the second loads
 * only the modules with no cached load, the failing one again, and a module whose fixture was changed to throw since,
 * which then fails, its closure new though its path is the same; every other module is cached and loads nothing. Each
 * case writes its consumer from the checkout's own library (Checkout.dir, so a kill's mutant is in it) and runs the
 * command's own entry in a child process. Oracle: the specification, stated per case (loads.fixtures.ts expectedOf).
 */
import { Effect } from "effect"
import { assert } from "#assert.ts"
import { Checkout } from "#mutate/checkout.ts"
import { property } from "#property.ts"
import { Scratch } from "#resources/scratch.ts"
import { comparedOf, expectedOf, loadedTwice, packages } from "#runner/loads.fixtures.ts"

export const loadsOnce = property.exhaust(packages, {
	box: "a module reading a const in its temporal dead zone, one whose initializer throws, one exporting no property, or none, beside a module that loads and one that loads through a fixture changed to throw between the runs or not",
	needs: { directory: Scratch.dir, checkout: Checkout.dir },
	situations: [],
	check:
		({ directory, checkout }) =>
		(drawn) =>
			Effect.gen(function* () {
				const scratch = yield* directory
				const library = yield* checkout
				const { first, second } = yield* loadedTwice(scratch, library, drawn)
				assert.deepEqual(
					[comparedOf(drawn, first), comparedOf(drawn, second)],
					[expectedOf(drawn, "first"), expectedOf(drawn, "second")]
				)
			}),
	oracle: {
		kind: "specification",
		name: "load fails exactly on the modules that throw as they load, naming each with what it threw, and loads a module again exactly when its closure has no cached load"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/cache.ts",
			original: "\t\t\tplacedOf(directory, key.module, record)\n",
			replacement: "\t\t\tplacedOf(directory, key.module, key.module)\n",
			why: "A load is cached by its module's path, not its closure, so a module whose fixture was changed to throw is taken as loading and its failure is never seen; the property fails."
		},
		{
			file: "packages/testing/src/runner/load.ts",
			original:
				"\t\treturn Effect.fail(\n\t\t\tLoadFailed.make({\n\t\t\t\tpath,\n\t\t\t\tmessage: `",
			replacement:
				"\t\treturn Effect.succeed([])\n\t\treturn Effect.fail(\n\t\t\tLoadFailed.make({\n\t\t\t\tpath,\n\t\t\t\tmessage: `",
			why: "Discover takes an export that is no property as nothing, so a module exporting a helper loads, though every run refuses it; the property fails."
		},
		{
			file: "packages/testing/src/runner/loads.ts",
			original: 'outcome.kind === "loads" ? "passed" : "failed"',
			replacement: '"passed"',
			why: "A module that failed to load is recorded as loading, so the next run takes it as cached and passes; the property fails."
		}
	]
})
