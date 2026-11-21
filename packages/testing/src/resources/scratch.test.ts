/**
 * A scratch directory (scratch.ts Scratch.dir) is its case's own: empty when the case gets it, and gone, with
 * everything the case wrote in it, once the case ends; a check removes what it finds left before it judges, so a kill's
 * run leaves nothing behind. And no scratch directory outlives the process that made it (processScratch, and
 * cachedScratch, which makes it in toolchain-test's cache), however that process ends: its scope closed, exited with
 * the scope open, or killed, the maker a program of the package's checkout
 * (Checkout.dir, so a mutant of scratch.ts reaches it). Oracle: the specification, stated in each check.
 */
import { Effect, Exit, FileSystem, Option, Scope, String as Str } from "effect"
import { assert } from "#assert.ts"
import { array, int } from "#gen.ts"
import { Checkout } from "#mutate/checkout.ts"
import { property } from "#property.ts"
import { ENDINGS, madeAndEnded, madeGen, PLACES } from "#resources/scratch.fixtures.ts"
import { Scratch } from "#resources/scratch.ts"
import { toolchainTestCache } from "#runner/cache-home.ts"
import { moduleClosureAt } from "#runner/module-closure.ts"
import { ModuleClosure, WorkerIndex } from "#runner/services.ts"

export const scratchOwn = property.explore(array(int(0, 3), { min: 0, max: 4 }), {
	needs: {},
	situations: ["an empty scratch directory", "a scratch directory with files"],
	check: (_resources, c) => (files) =>
		Effect.gen(function* () {
			c.note(files.length === 0 ? "an empty scratch directory" : "a scratch directory with files")
			const fs = yield* FileSystem.FileSystem
			const closures = yield* moduleClosureAt(process.cwd(), Option.none())
			const take = yield* Scratch.dir.open.pipe(
				Effect.provideService(WorkerIndex, { index: 0, workers: 1 }),
				Effect.provideService(ModuleClosure, closures)
			)
			const used = yield* Scope.make()
			const dir = yield* Scope.provide(take, used)
			const before = yield* fs.readDirectory(dir)
			yield* Effect.forEach(
				files,
				(file, index) => fs.writeFileString(`${dir}/${index}-${file}`, String(file)),
				{
					discard: true
				}
			)
			yield* Scope.close(used, Exit.void)
			const after = yield* fs.exists(dir)
			yield* fs.remove(dir, { recursive: true, force: true })
			assert.deepEqual(before, [])
			assert.equal(after, false)
		}),
	oracle: {
		kind: "specification",
		name: "a scratch directory is empty when given and gone with everything in it after"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/resources/scratch.ts",
			original: 'fs.makeTempDirectoryScoped({ directory: root, prefix: "case-" })',
			replacement: 'fs.makeTempDirectory({ directory: root, prefix: "case-" })',
			why: "The directory outlives its case, so a later case could read what an earlier one wrote; the property fails."
		}
	]
})

export const scratchOutlivesNoProcess = property.explore(madeGen, {
	needs: { checkout: Checkout.dir },
	situations: [...ENDINGS, ...PLACES],
	check:
		({ checkout }, c) =>
		(made) =>
			Effect.gen(function* () {
				c.note(made.ending)
				c.note(made.place)
				const dir = yield* checkout
				const { directory, removers } = yield* madeAndEnded(dir, made)
				const fs = yield* FileSystem.FileSystem
				const left = yield* fs.exists(directory)
				yield* fs.remove(directory, { recursive: true, force: true })
				const cached = Str.startsWith(`${yield* toolchainTestCache}/scratch/`)(directory)
				assert.deepEqual(
					{ removers, left, cached },
					{ removers: 1, left: false, cached: made.place === "in toolchain-test's cache" }
				)
			}),
	oracle: {
		kind: "specification",
		name: "a scratch directory is gone once the process that made it ends, whether its scope closed, it exited with its scope open, or it was killed"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/resources/scratch.ts",
			original: "const REMOVER = 'while read -r _; do :; done; exec rm -rf -- \"$1\"'",
			replacement: "const REMOVER = 'while read -r _; do :; done; exit 0'",
			why: "The directory outlives the process that made it, as /tmp's toolchain-trees-* did past every killed run; the property fails."
		},
		{
			file: "packages/testing/src/resources/scratch.ts",
			original: "return yield* processScratch({ prefix, directory })",
			replacement: "return yield* processScratch({ prefix })",
			why: "A cached scratch directory is made in the run's temporary directory, a tmpfs here, where an install copies every file of a store on disk; the property fails."
		}
	]
})
