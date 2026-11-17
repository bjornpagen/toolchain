/**
 * A runner config's Mutation is loaded by `toolchain-test mutate` alone: loading the config, as the launcher, a run's
 * parent and every worker do (runner/load.ts configOf), never imports the module it names, and mutate's load
 * (mutate/commands.ts loadedMutation) imports it and gives back exactly its families and its equivalent judgments, or
 * refuses when the module throws as it loads. Each case writes a package of its own in its scratch directory, whose
 * mutation module records its import. Oracle: the specification, stated in the property.
 */
import { Array as Arr, Effect, FileSystem, Schema } from "effect"
import { deepStrictEqual } from "#assert.ts"
import { loadedMutation, MutatorRefused } from "#mutate/commands.ts"
import { expectedOf, IMPORTED, writtenGen, writtenPackage } from "#mutate/mutation.fixtures.ts"
import { property } from "#property.ts"
import { Scratch } from "#resources/scratch.ts"
import { configOf } from "#runner/load.ts"

export const mutationLoadsOnlyForMutate = property.explore(writtenGen, {
	needs: { directory: Scratch.dir },
	situations: ["a module that throws refused", "families", "equivalent judgments", "nothing added"],
	check:
		({ directory }, c) =>
		(written) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const root = yield* directory
				yield* writtenPackage(root, written)
				const config = yield* configOf(root)
				const importedByConfig = yield* fs.exists(`${root}/${IMPORTED}`)
				const loaded = yield* Effect.result(loadedMutation(config))
				const importedByMutate = yield* fs.exists(`${root}/${IMPORTED}`)
				const read =
					loaded._tag === "Failure"
						? {
								refused: Schema.is(MutatorRefused)(loaded.failure),
								families: [],
								equivalent: []
							}
						: {
								refused: false,
								families: Arr.map(loaded.success.families, (family) => Arr.copy(family.operators)),
								equivalent: Arr.map(loaded.success.equivalent, (entry) => entry.mutant)
							}
				if (read.refused) {
					c.note("a module that throws refused")
				}
				if (Arr.isReadonlyArrayNonEmpty(read.families)) {
					c.note("families")
				}
				if (Arr.isReadonlyArrayNonEmpty(read.equivalent)) {
					c.note("equivalent judgments")
				}
				if (
					!read.refused &&
					!Arr.isReadonlyArrayNonEmpty(read.families) &&
					!Arr.isReadonlyArrayNonEmpty(read.equivalent)
				) {
					c.note("nothing added")
				}
				deepStrictEqual(
					{ importedByConfig, importedByMutate, ...read },
					{ importedByConfig: false, importedByMutate: true, ...expectedOf(written) }
				)
			}),
	oracle: {
		kind: "specification",
		name: "the config's load never imports the mutation module; mutate's imports it and gives back its families and judgments, or refuses when it throws"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/load.ts",
			original: "? Effect.succeed(config)",
			replacement: "? Effect.as(Effect.promise(config.mutation), config)",
			why: "Loading a runner config loads its Mutation, so the launcher, a run's parent and every worker import what a repository's families read, and a module that throws as it loads breaks every run, not only mutate."
		},
		{
			file: "packages/testing/src/mutate/commands.ts",
			original: "\t\ttry: config.mutation,",
			replacement: "\t\ttry: () => Promise.resolve({ families: [], equivalent: [] }),",
			why: "mutate never loads the config's Mutation, so a repository's families never mutate anything and its equivalent judgments are never read."
		}
	]
})
