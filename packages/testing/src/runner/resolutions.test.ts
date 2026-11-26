/**
 * A runner process's resolutions (runner/resolutions.ts): a process handed what another resolved over the same files
 * resolves every module that one did to the same URL without Node's resolver, whatever kind of specifier names it (a
 * relative path, a package's imports map, a dependency's main export and a subpath of its exports through a symlink as
 * pnpm links one, a builtin), and loads the same modules; the first process, handed nothing, resolved each by Node's.
 * Oracle: second-implementation, Node's own resolver, the first run's, whose every answer the second run gives.
 */
import { Effect, Option } from "effect"
import { assert } from "#assert.ts"
import { finite } from "#gen.ts"
import { Checkout } from "#mutate/checkout.ts"
import { property } from "#property.ts"
import { Scratch } from "#resources/scratch.ts"
import {
	graphIn,
	kindSets,
	mergedAs,
	namesOf,
	ranAs,
	resolutionsProgram
} from "#runner/resolutions.fixtures.ts"

export const resolvedAsHanded = property.exhaust(finite(kindSets), {
	box: "every non-empty set of the kinds of specifier a module names",
	needs: { checkout: Checkout.dir, directory: Scratch.dir },
	situations: [],
	check:
		({ checkout, directory }) =>
		(kinds) =>
			Effect.gen(function* () {
				const dir = yield* checkout
				const program = resolutionsProgram(dir)
				const graph = yield* directory
				yield* graphIn(graph, kinds)
				const first = yield* ranAs(program, graph, "parent")
				const second = yield* Option.match(first, {
					onNone: () => Effect.succeedNone,
					onSome: () => ranAs(program, graph, "worker")
				})
				assert.deepEqual(
					{
						first: Option.map(first, (ran) => ({
							names: ran.names,
							byNode: ran.byNode - ran.resolved
						})),
						second: Option.map(second, (ran) => ({
							names: ran.names,
							byNode: ran.byNode,
							resolved: ran.resolved
						}))
					},
					{
						first: Option.some({ names: namesOf(kinds), byNode: 0 }),
						second: Option.map(first, (ran) => ({
							names: namesOf(kinds),
							byNode: 0,
							resolved: ran.resolved
						}))
					}
				)
			}),
	oracle: {
		kind: "second-implementation",
		name: "Node's own resolver, the first run's, every answer of which the second run gives without it"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/resolutions.ts",
			original: "if (!UNPLAIN.test(fields)) {",
			replacement: "if (!UNPLAIN.test(key)) {",
			why: "A resolution is kept only when its key, tabs and all, holds no tab, so none is: a run's parent hands its workers nothing and every worker resolves every module again by Node's resolver (this lane's first cut did so, unseen until an edullm run counted 0 hits); this property fails."
		},
		{
			file: "packages/testing/src/runner/resolutions.ts",
			original: "const answer = { url: line.groups.url, format: line.groups.format }",
			replacement: "const answer = { url: line.groups.format, format: line.groups.url }",
			why: "A handed resolution is read with its URL and format swapped, so a worker resolves a module to its format's name and cannot load it; this property fails."
		}
	]
})

/**
 * A load's parent hands each resolution once (resolutions.ts freshChunksOf): the processes of a load that start
 * together are handed the same and so hand back the same, and the parent keeps of each chunk only what it did not hold,
 * so a later process is handed every resolution once, never each copy (grizzle's first sixteen processes handed back
 * about 7,000 resolutions each, nearly all the same, and every later one parsed them all: 1.23 CPU-s a process where
 * 0.96 is its own, 2026-11-26, lane LOADFAST). Oracle: the specification, each resolution once.
 */
export const handedOnce = property.exhaust(finite(kindSets), {
	box: "a parent run's payload over every non-empty set of the kinds of specifier a module names, taken as two processes' chunks at once and then as a third's",
	needs: { checkout: Checkout.dir, directory: Scratch.dir },
	situations: [],
	check:
		({ checkout, directory }) =>
		(kinds) =>
			Effect.gen(function* () {
				const dir = yield* checkout
				const program = resolutionsProgram(dir)
				const graph = yield* directory
				yield* graphIn(graph, kinds)
				const parent = yield* ranAs(program, graph, "parent")
				const merged = yield* Option.match(parent, {
					onNone: () => Effect.succeedNone,
					onSome: () => mergedAs(program, graph)
				})
				assert.deepEqual(
					Option.map(merged, (taken) => ({
						eachOnce: taken.handed === taken.distinct,
						some: taken.handed > 0,
						again: taken.again
					})),
					Option.some({ eachOnce: true, some: true, again: 0 })
				)
			}),
	oracle: { kind: "specification", name: "a load's parent hands each resolution once" },
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/resolutions.ts",
			original: "\t\tif (known.has(line.groups.key)) {\n",
			replacement: "\t\tif (line.groups.key.length === 0) {\n",
			why: "A load's parent keeps every resolution its processes hand back, each copy, so a later process is handed what its earlier ones resolved together once for each of them; the property fails."
		}
	]
})
