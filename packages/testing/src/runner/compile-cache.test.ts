/**
 * Node's compile cache store (runner/compile-cache.ts). Each root a process loads its modules from has a directory of
 * its own, in a store sharded two levels deep by its root's digest, so no directory of the store holds more entries
 * than a shard level's fan-out or one root's modules, however many roots write to it; where one directory every root
 * shared (`toolchain-test/compile`) grew to millions of entries and queued every process that wrote one on its lock
 * (cassowary, 2026-11-21: ~800 processes in D state). And processes of one root started at once each compute the same
 * directory and leave one entry for the module they all load, nothing beside it. Oracle: the specification, stated in
 * each check.
 */
import { Array as Arr, Effect, String as Str } from "effect"
import { assert } from "#assert.ts"
import { finite, int } from "#gen.ts"
import { Checkout } from "#mutate/checkout.ts"
import { property } from "#property.ts"
import { Scratch } from "#resources/scratch.ts"
import {
	entriesOf,
	heldBy,
	MOST_MODULES,
	rootsGen,
	STORE,
	startedAtOnce
} from "#runner/compile-cache.fixtures.ts"
import { compileCacheIn, FANOUT } from "#runner/compile-cache.ts"

export const storeBounded = property.explore(rootsGen, {
	needs: {},
	situations: ["more roots than a shard level holds", "no more roots than a shard level holds"],
	check: (_resources, c) => (roots) =>
		Effect.sync(() => {
			c.note(
				roots.length > FANOUT
					? "more roots than a shard level holds"
					: "no more roots than a shard level holds"
			)
			const held = heldBy(STORE, entriesOf(STORE, roots))
			const overfull = Arr.filter(
				[...held],
				([, entries]) => entries > Math.max(FANOUT, MOST_MODULES)
			)
			const directories = new Set(Arr.map(roots, ({ root }) => compileCacheIn(STORE, root)))
			assert.deepEqual(
				{ overfull, distinct: directories.size },
				{ overfull: [], distinct: roots.length }
			)
		}),
	oracle: {
		kind: "specification",
		name: "no directory of the store holds more entries than a shard level's fan-out or one root's modules, and no two roots share a directory"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/compile-cache.ts",
			original: `return \`\${store}/\${first}/\${second}/\${digest}\``,
			replacement: "return store",
			why: "Every root's cache is the store itself, the flat layout every checkout shared before, so one directory holds every root's modules; the property fails on the bound once the roots' modules outnumber a shard level's fan-out."
		},
		{
			file: "packages/testing/src/runner/compile-cache.ts",
			original: `return \`\${store}/\${first}/\${second}/\${digest}\``,
			replacement: `return \`\${store}/\${digest}\``,
			why: "Each root has its own directory but all of them stand in the store's one directory, which then holds one entry per root; the property fails on the bound once the roots outnumber a shard level's fan-out."
		}
	]
})

export const startedAtOnceShareOneEntry = property.exhaust(finite(int(2, 8)), {
	box: "two to eight processes of one root started at once, each loading the root's one module",
	needs: { checkout: Checkout.dir, directory: Scratch.dir },
	situations: [],
	check:
		({ checkout, directory }) =>
		(processes) =>
			Effect.gen(function* () {
				const at = yield* directory
				const store = `${at}/store`
				const packageRoot = yield* checkout
				const ran = yield* startedAtOnce(packageRoot, at, store, processes)
				const own = compileCacheIn(store, ran.root)
				assert.deepEqual(
					{
						statuses: ran.statuses,
						entries: ran.files.length,
						inItsDirectory: Arr.every(ran.files, Str.startsWith(`${own}/`))
					},
					{
						statuses: Array.from({ length: processes }, () => 0),
						entries: 1,
						inItsDirectory: true
					}
				)
			}),
	oracle: {
		kind: "specification",
		name: "processes of one root started at once keep their compile cache in the root's one directory, and leave one entry for the module they all load"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/compile-cache.ts",
			original: ".update(root)",
			replacement: `.update(\`\${root}:\${process.pid}\`)`,
			why: "A root's directory depends on the process that computes it, as a key with a per-run or per-process part does, so processes of one root never reuse each other's entries and each writes its own; the property fails with one entry for each process."
		}
	]
})
