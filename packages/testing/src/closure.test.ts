import { Effect, Option } from "effect"
import { Digest } from "effect/crypto"
import { closuresAt } from "#closure.ts"
import { agree, exact } from "#oracle.ts"
import { property } from "#property.ts"
import {
	aimedWorkspaces,
	filesOf,
	hashing,
	loadSituationsOf,
	rootsOf,
	scratch,
	writtenTo
} from "#runner/closure.fixtures.ts"
import { closuresOf, ModuleSyntax, workingTree } from "#runner/closure.ts"

/**
 * The public door to the runner's closures is the runner's: for a workspace written to disk, the closure `closuresAt`
 * gives each root, under the conditions it is given, is the one closuresOf walks over the same working tree for this
 * Node. Oracle: closuresOf itself, the runner's one resolver, held to Node's own loader by closureIsWhatNodeLoads.
 */
export const closuresAtIsTheRunnersClosure = property.explore(aimedWorkspaces, {
	needs: { hashing, directory: scratch },
	situations: [
		"a type-only import Node never loads",
		"an inline type import that loads its module",
		"an import cycle",
		"the library's export pattern by self-reference",
		"an imports map naming a bare package",
		"a conditional the config's condition chooses",
		"a conditional Node's own condition chooses",
		"a conditional that falls to its default",
		"an external's own dependency Node loads beside it",
		"a built-in named bare",
		"a JSON module",
		"a dynamic import"
	],
	check:
		({ hashing: services, directory }, c) =>
		(workspace) =>
			Effect.gen(function* () {
				c.noteAll(loadSituationsOf(workspace))
				const written = yield* directory
				yield* writtenTo(written, filesOf(workspace, { kind: "nothing" }))
				const roots = yield* Effect.fromOption(rootsOf(workspace))
				const conditions = workspace.configured ? ["custom"] : []
				const parser = yield* services
				const tree = yield* workingTree(written)
				const expected = yield* closuresOf({
					tree,
					conditions,
					runtime: process.version,
					roots
				}).pipe(
					Effect.provideService(ModuleSyntax, parser.syntax),
					Effect.provideService(Digest.Digest, parser.digest)
				)
				const given = yield* closuresAt(written, roots, conditions)
				for (const root of roots) {
					yield* agree(
						[
							[`closuresOf's closure of ${root}`, Option.fromUndefinedOr(expected.get(root))],
							[`closuresAt's closure of ${root}`, Option.fromUndefinedOr(given.get(root))]
						],
						exact
					)
				}
			}),
	oracle: {
		kind: "second-implementation",
		name: "closuresOf over the written workspace's working tree, under the same conditions and this Node's version"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/closure.ts",
			original: "closuresOf({ tree, conditions, runtime: process.version, roots })",
			replacement: "closuresOf({ tree, conditions: [], runtime: process.version, roots })",
			why: "the door drops the conditions it is given: a configured workspace's closures are keyed and resolved as an unconfigured one's, a conditional the config's condition chooses resolving to another file than the process it bounds loads"
		}
	]
})
