/**
 * The guard (runner/observe.ts) sorts each act of a property's code made in a unit's window as its verdict depends on
 * it: a connection to the run's own server (one it was told of) is a keyable read of the PostgreSQL that serves it, and
 * a connection to any other an observation past every key; a file's bytes, an absent path's probe, a path's resolution
 * (realpath's own walk of it none of the property's) and a link's text are keyable reads of what they read; a file's
 * status is an observation, which no key holds; what the process made itself is nothing;
 * and a child process runs under strace, its reads keyable reads of the process (the file it reads among them). Each
 * case makes one act in a fresh Node process that installs the checkout's guard as a worker does (Checkout.dir, so a
 * kill's mutant is what it loads). Oracle: the specification, stated per act (observe.fixtures.ts expectedOf).
 */
import { Effect } from "effect"
import { assert } from "#assert.ts"
import { Checkout } from "#mutate/checkout.ts"
import { property } from "#property.ts"
import { Scratch } from "#resources/scratch.ts"
import { acts, expectedOf, madeOf } from "#runner/observe.fixtures.ts"

export const theGuardSortsEachAct = property.exhaust(acts, {
	box: "one act in a unit's window: a connection to the run's own server or another's, a file's bytes, an absent path's probe, a path's resolution, a link's text, a file's status, the process's own file, a child that reads a file",
	needs: { directory: Scratch.dir, checkout: Checkout.dir },
	situations: [],
	check:
		({ directory, checkout }) =>
		(act) =>
			Effect.gen(function* () {
				const scratch = yield* directory
				const library = yield* checkout
				const made = yield* madeOf(scratch, library, act)
				assert.deepEqual(made, expectedOf(act))
			}),
	oracle: {
		kind: "specification",
		name: "a connection to the run's own server is a read of its PostgreSQL and any other an observation; bytes, an absent probe, a resolution, a link and a child's reads are keyable reads; a status is an observation; the process's own data is nothing"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/observe.ts",
			original: "\t\tguard.servers.add(address)\n",
			replacement: "\t\tguard.servers.delete(address)\n",
			why: "The guard is never told the run's own servers, so a property's connection to its cluster's member is an observation and no property of the cluster is ever cached; the property fails."
		},
		{
			file: "packages/testing/src/runner/observe.ts",
			original: '\t\t\t\ttraced("postgres", "", "connect", guard.collecting())\n',
			replacement: "",
			why: "A connection to the run's own server keeps no read of the PostgreSQL that serves it, so a pass is kept across a rebuild of the server; the property fails."
		},
		{
			file: "packages/testing/src/runner/observe.ts",
			original: '\t["stat", "inspects"],\n',
			replacement: '\t["stat", "probes"],\n',
			why: "A file's status is taken for its presence, so a property that reads a file's times is answered from the cache; the property fails."
		},
		{
			file: "packages/testing/src/runner/observe.ts",
			original: '\t["realpath", "resolves"],\n',
			replacement: '\t["realpath", "inspects"],\n',
			why: "A path's resolution is taken for an act no key holds, so a property that resolves a path (a checkout's root, a module's real path) is never answered from the cache; the property fails."
		},
		{
			file: "packages/testing/src/runner/observe.ts",
			original: '\t\tconst runs = act === "resolves" ? inside : asIs\n',
			replacement: "\t\tconst runs = asIs\n",
			why: "realpath's own walk of its path (lstat on each component) counts as the property's, a status no key holds, so a property that resolves a path is never answered from the cache; the property fails."
		},
		{
			file: "packages/testing/src/runner/observe.ts",
			original: '\t["readlink", "readsLink"],\n',
			replacement: '\t["readlink", "inspects"],\n',
			why: "A link's text is taken for an act no key holds, so a property that reads a link is never answered from the cache; the property fails."
		},
		{
			file: "packages/testing/src/runner/observe.ts",
			original: '\t\tif (kind !== "postgres" && isOwn(file)) {\n\t\t\treturn\n\t\t}\n',
			replacement: "",
			why: "What the process made itself is traced, so a pass keeps a read of a scratch file that is gone by the next run, and never answers; the property fails."
		}
	]
})
