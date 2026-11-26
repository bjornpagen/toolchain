/**
 * `toolchain-test load` (runner/loads.ts) over a consumer package in a git repository. loadsOnce runs it twice: the first run loads
 * every test module apart and fails exactly on a module that throws as it loads (a const read in its temporal dead
 * zone, an initializer that throws, an export that is no property), naming it with what it threw; the second loads
 * only the modules with no cached load, the failing one again, and a module whose fixture was changed to throw since,
 * which then fails, its closure new though its path is the same; every other module is cached and loads nothing. Each
 * case writes its consumer from the checkout's own library (Checkout.dir, so a kill's mutant is in it) and runs the
 * command's own entry in a child process. Oracle: the specification, stated per case (loads.fixtures.ts expectedOf).
 *
 * loadsApartAtItsBound runs it once, one module at a time, and holds the load to what its guarantee needs and no more
 * (loads.fixtures.ts expectedApart): one process for each module, so a module that loads only after another (the side of
 * an import cycle that reads the other's const in its temporal dead zone, which loads once the cycle ran from its other
 * side) fails as it would first in a worker, whichever sorts first; each process resolving by Node only the specifiers
 * no process before it met, every other answer handed it (resolutions.ts: the parent's own chunk and each chunk its
 * earlier processes handed back), so resolution is done once a load where each process did it all again (2.77 CPU-s a
 * grizzle module where 0.96 is its own, 2026-11-26, lane LOADFAST); and every process's compile cache in the root's
 * directory of the store, the account's switch never reaching one, so a module is compiled once a load. A process's own
 * cost is what isolation leaves: its closure linked and run afresh.
 */
import { Effect } from "effect"
import { assert } from "#assert.ts"
import { Checkout } from "#mutate/checkout.ts"
import { property } from "#property.ts"
import { Scratch } from "#resources/scratch.ts"
import {
	aparts,
	comparedApart,
	comparedOf,
	expectedApart,
	expectedOf,
	loadedApartOnce,
	loadedTwice,
	packages
} from "#runner/loads.fixtures.ts"

export const loadsOnce = property.exhaust(packages, {
	box: "a module reading a const in its temporal dead zone, one whose initializer throws, one exporting no property, one exiting as it loads, one leaving a handle open, or none, beside a module that loads and one that loads through a fixture changed to throw between the runs or not",
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
		name: "load fails exactly on the modules that throw as they load or end their process before it reports, naming each with what it threw, ends every process whatever its module left open, and loads a module again exactly when its closure has no cached load"
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
			original: '\t\t\t\tonNone: (): Loaded => ({\n\t\t\t\t\tmodule,\n\t\t\t\t\tkind: "failed",',
			replacement: '\t\t\t\tonNone: (): Loaded => ({\n\t\t\t\t\tmodule,\n\t\t\t\t\tkind: "loads",',
			why: "A process that ended before it reported is taken as loading, as the exit status 0 of a module's own process.exit was; the property fails on the module exiting as it loads."
		},
		{
			file: "packages/testing/src/runner/loads.ts",
			original: '\t\t\tyield* Effect.ignore(handle.kill({ killSignal: "SIGKILL" }))\n',
			replacement: "",
			why: "The load waits for each process to end on its own, so a module that left a handle open holds its process, and the load, forever; the property's case on it never ends."
		},
		{
			file: "packages/testing/src/runner/loads.ts",
			original: 'outcome.kind === "loads" ? "passed" : "failed"',
			replacement: '"passed"',
			why: "A module that failed to load is recorded as loading, so the next run takes it as cached and passes; the property fails."
		}
	]
})

export const loadsApartAtItsBound = property.exhaust(aparts, {
	box: "one load, one module at a time, of two modules sharing fixtures, a third importing none, one, the other or both of them, and two entering one import cycle from its two sides, the one reading the other's const in its temporal dead zone sorted first or second",
	needs: { directory: Scratch.dir, checkout: Checkout.dir },
	situations: [],
	check:
		({ directory, checkout }) =>
		(drawn) =>
			Effect.gen(function* () {
				const scratch = yield* directory
				const library = yield* checkout
				const run = yield* loadedApartOnce(scratch, library, drawn)
				assert.deepEqual(comparedApart(drawn, run), expectedApart(drawn))
			}),
	oracle: {
		kind: "specification",
		name: "a load runs each module in a process of its own, which resolves by Node only what no process before it met, keeps its compile cache in the root's directory, the account's switch reaching none, and never calls process.exit"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/loads.ts",
			original:
				"\tEffect.forEach(modules, (module) => loadedApart(root, module, start), {\n\t\tconcurrency: loadWorkers\n\t})\n",
			replacement:
				'\tEffect.forEach(modules, (module) =>\n\t\tEffect.flatMap(\n\t\t\tEffect.promise(() => import("#runner/load.ts")),\n\t\t\t(load) =>\n\t\t\t\tEffect.match(load.discover(root, [module]), {\n\t\t\t\t\tonSuccess: () => ({ module, kind: "loads" }) as const,\n\t\t\t\t\tonFailure: (failed) => ({ module, kind: "failed", message: failed.message }) as const\n\t\t\t\t})\n\t\t)\n\t)\n',
			why: "The load imports every module in its own process, in path order, as the script it replaced did: a module that loads only once another ran its cycle from the other side loads, and one met after its cycle failed fails with it, and no process of its own is seen; the property fails."
		},
		{
			file: "packages/testing/src/runner/load-child.ts",
			original: "\tfs.closeSync(REPORT)\n",
			replacement: '\tfs.closeSync(REPORT)\n\tprocess.exit(verdict.kind === "loads" ? 0 : 1)\n',
			why: "A load's process ends by process.exit once it reported, as it did, whose join of V8's threads can wait forever under load (nodejs/node#54918); the observer sees each call, as each process's report ends only with the process, whatever the machine's load; the property fails."
		},
		{
			file: "packages/testing/src/runner/load-child.ts",
			original: "\tfor (const part of reportOf(verdict, answeredChunk())) {\n",
			replacement: "\tfor (const part of reportOf(verdict, new Uint8Array())) {\n",
			why: "A load's process hands nothing back, so every process after the first resolves by Node the fixtures the first resolved; the property fails on the second module's count."
		},
		{
			file: "packages/testing/src/runner/load-child.ts",
			original: "\tfor (const part of reportOf(verdict, answeredChunk())) {\n",
			replacement:
				'\tfor (const part of reportOf(verdict, verdict.kind === "loads" ? answeredChunk() : new Uint8Array())) {\n',
			why: "A process whose module fails hands nothing back, though its whole closure resolved before its module ran, so the module after the cycle's reading side resolves the cycle again; the property fails where the reading side sorts first."
		},
		{
			file: "packages/testing/src/runner/loads.ts",
			original: "\t\t\tyield* Ref.update(start.chunks, Arr.appendAll(fresh))\n",
			replacement: "\t\t\tyield* Effect.void\n",
			why: "The load's parent keeps nothing its processes handed back, so each is handed the parent's own resolutions alone and resolves every fixture by Node again; the property fails."
		},
		{
			file: "packages/testing/src/runner/resolutions.ts",
			original: "\t\t\t\tanswered.set(key, answer)\n",
			replacement: "",
			why: "A process keeps no record of what Node answered it, so what it hands back is empty and every process resolves its fixtures again; the property fails."
		},
		{
			file: "packages/testing/src/runner/loads.ts",
			original: "\t\tconst cache = yield* childCompileCacheOf(sharedStore, root, false)\n",
			replacement: "\t\tconst cache = yield* childCompileCacheOf(sharedStore, root, true)\n",
			why: "A load's processes are given no compile cache, as none was on cassowary, so each compiles every module of its closure again; the property fails on every process's directory."
		},
		{
			file: "packages/testing/src/runner/compile-cache.ts",
			original: "\t\t\tReflect.deleteProperty(process.env, SWITCH)\n",
			replacement: "",
			why: "The account's switch, which Node reads as the runner enables its cache, turns the runner's own cache off, as on every unit of cassowary's; the property fails on the parent's directory."
		}
	]
})
