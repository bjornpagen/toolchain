/**
 * A Node child's recorder (runner/recorder.ts) reads what strace(1) read of it, at no stop. The guard (runner/observe.ts)
 * keys a property's verdict by every read its children made; it read a Node child's off strace's trace until the
 * recorder, whose stops cost a traced child of grizzle's four times its plain run at load 500 (lane TRACE, 2026-11-26).
 * Each case writes a tree of its own and runs one program of the roster in it, each run by Node's spawn as it was before
 * the worker's guard (recorder.fixtures.ts). The first property runs it alone under strace, the reference, and as a
 * property starts it, through the checkout's guard (Checkout.dir, so a kill's mutant is what it loads): the keyed reads
 * of each past the runtime's own start are the same, as are how each ended and what it said, and the guard observes
 * nothing past its key. The second runs it plain and through the guard, beside the empty program: each recorder writes
 * one line a distinct read of its own, and stops the child at no call, so the child's CPU and context switches stay
 * within twice their plain values past the recorder's own load (recorder.fixtures.ts exceededOf).
 */
import { Effect } from "effect"
import { assert } from "#assert.ts"
import { Checkout } from "#mutate/checkout.ts"
import { property } from "#property.ts"
import { Scratch } from "#resources/scratch.ts"
import { comparedOf, exceededOf, programs, spentOf } from "#runner/recorder.fixtures.ts"

export const aNodeChildRecordsWhatStraceReads = property.exhaust(programs, {
	box: "one Node child program in a tree of its own: a relative import, its package's imports, a package's exports, a package's legacy main, a package behind a link, a CommonJS require, a JSON module, a dynamic import, the testing library's own modules, a file's bytes, an absent file, a directory's entries, a path's status, a link's text, a real path, its own files, a Node child, another program, a worker thread",
	needs: { directory: Scratch.dir, checkout: Checkout.dir },
	situations: [],
	check:
		({ directory, checkout }) =>
		(program) =>
			Effect.gen(function* () {
				const scratch = yield* directory
				const library = yield* checkout
				const compared = yield* comparedOf(scratch, library, program)
				assert.deepEqual(compared.recorded.said, compared.traced.said)
				assert.deepEqual(compared.recorded.reads, compared.traced.reads)
				assert.equal(compared.observed, false)
			}),
	oracle: {
		kind: "second-implementation",
		name: "strace(1)'s trace of the same program run alone, read as the guard read a traced child's (runner/strace.ts)"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/observe.ts",
			original: "				? { ...start, args: [...recorderArguments(directory), ...start.args] }\n",
			replacement: "				? start\n",
			why: "The guard starts a Node child without its recorder: nothing records what it reads, and its verdict is never kept; the property fails."
		},
		{
			file: "packages/testing/src/runner/recorder.ts",
			original: '		"--expose-internals",\n',
			replacement: "",
			why: "A Node child's recorder cannot reach the module loader's internals: no read the loader makes outside node:fs (a module's status, a package.json's) is recorded; the property fails."
		},
		{
			file: "packages/testing/src/runner/recorder.ts",
			original: '			case "internalModuleStat":\n				read("presence", pathOf(args[0]))\n',
			replacement: '			case "internalModuleStat":\n',
			why: "The loader's status reads go unrecorded: a module's presence and a package's place among the node_modules directories are no key's, so a package placed nearer the importer would not end the pass; the property fails."
		},
		{
			file: "packages/testing/src/runner/recorder.ts",
			original: `		if (!firstWalk(\`scoped\\u0000\${start}\\u0000\${found ?? ""}\`)) {\n`,
			replacement: "		if (start !== undefined) {\n",
			why: "A module's package scope lookup goes unrecorded: the package.json that decides its format, and each absent one below it, are no key's; the property fails."
		},
		{
			file: "packages/testing/src/runner/recorder.ts",
			original: `					read(\n						"presence",\n						path.resolve(\n							directory,\n							\`\${byMain ? String(main) : ""}\${loader.extensions[index] ?? ""}\`\n						)\n					)\n`,
			replacement: "",
			why: "A package's legacy main candidates go unrecorded: a file placed where the loader looked before the one it runs would not end the pass; the property fails."
		},
		{
			file: "packages/testing/src/runner/recorder.ts",
			original: '					read("directory", pathOf(args[0]))\n',
			replacement: "",
			why: "A directory listed goes unrecorded: its entries are no key's; the property fails."
		},
		{
			file: "packages/testing/src/runner/recorder.ts",
			original: '			read("link", at)\n			links += 1\n',
			replacement: "			links += 1\n",
			why: "realpath's walk reads a link's text unrecorded: a link pointed elsewhere would not end the pass; the property fails."
		},
		{
			file: "packages/testing/src/runner/recorder.ts",
			original:
				"				restarted(args, { ...start, args: [...recorderArguments(to), ...start.args] })\n",
			replacement: "",
			why: "A Node child's own Node child runs unrecorded: what it reads goes unkeyed; the property fails."
		},
		{
			file: "packages/testing/src/runner/recorder.ts",
			original: "		const trace = traceFile(call, start.command)\n",
			replacement: "		const trace = undefined\n",
			why: "A Node child's other programs run untraced: what they read goes unkeyed; the property fails."
		},
		{
			file: "packages/testing/src/runner/recorder.ts",
			original: "				recordsAlready(execArgv)\n					? options\n",
			replacement: "				recordsAlready(execArgv) || true\n					? options\n",
			why: "A worker thread started with arguments of its own runs unrecorded: what it reads goes unkeyed; the property fails."
		}
	]
})

export const aRecordedChildRunsUnstopped = property.exhaust(programs, {
	box: "each program of the recorder's roster beside the empty program, plain and as a property starts it",
	needs: { directory: Scratch.dir, checkout: Checkout.dir },
	situations: [],
	check:
		({ directory, checkout }) =>
		(program) =>
			Effect.gen(function* () {
				const scratch = yield* directory
				const library = yield* checkout
				const spent = yield* spentOf(scratch, library, program)
				assert.equal(spent.observed, false)
				assert.deepEqual(exceededOf(spent), [])
			}),
	oracle: {
		kind: "specification",
		name: "one line a distinct read a recorder, and the CPU and context switches of a recorded run within twice a plain run's past the recorder's own load"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/observe.ts",
			original:
				'		const isNode =\n			runs !== undefined &&\n			node !== "failed" &&\n			failing(() => original.realpathNative(runs)) === node\n',
			replacement: "		const isNode = false\n",
			why: "The guard starts a Node child under strace again, as any other: it stops at every file call it makes; the property fails."
		},
		{
			file: "packages/testing/src/runner/recorder.ts",
			original:
				"		if (seen.has(text)) {\n			return\n		}\n		seen.add(text)\n		if (!isLive(file)) {\n",
			replacement: "		seen.add(text)\n		if (!isLive(file)) {\n",
			why: "The recorder writes every read it sees, each time: its writes grow with the child's calls, not its reads; the property fails."
		}
	]
})
