/**
 * A scratch directory (scratch.ts Scratch.dir) is its case's own: empty when the case gets it, and gone, with
 * everything the case wrote in it, once the case ends. Oracle: the specification, stated in the check.
 */
import { Effect, Exit, FileSystem, Scope } from "effect"
import { deepStrictEqual, strictEqual } from "#assert.ts"
import { array, int } from "#gen.ts"
import { property } from "#property.ts"
import { Scratch } from "#resources/scratch.ts"
import { WorkerIndex } from "#runner/services.ts"

export const scratchOwn = property.explore(array(int(0, 3), { min: 0, max: 4 }), {
	needs: {},
	situations: ["an empty scratch directory", "a scratch directory with files"],
	check: (_resources, c) => (files) =>
		Effect.gen(function* () {
			c.note(files.length === 0 ? "an empty scratch directory" : "a scratch directory with files")
			const fs = yield* FileSystem.FileSystem
			const take = yield* Effect.provideService(Scratch.dir.open, WorkerIndex, {
				index: 0,
				workers: 1
			})
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
			deepStrictEqual(before, [])
			strictEqual(after, false)
		}),
	oracle: {
		kind: "specification",
		name: "a scratch directory is empty when given and gone with everything in it after"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/resources/scratch.ts",
			original: 'fs.makeTempDirectoryScoped({ prefix: "case-" })',
			replacement: 'fs.makeTempDirectory({ prefix: "case-" })',
			why: "The directory outlives its case, so a later case could read what an earlier one wrote; the property fails."
		}
	]
})
