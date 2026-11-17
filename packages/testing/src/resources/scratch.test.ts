/**
 * A scratch directory (scratch.ts Scratch.dir) is its case's own: empty when the case gets it, and gone, with
 * everything the case wrote in it, once the case ends; a check removes what it finds left before it judges, so a kill's
 * run leaves nothing behind. And a worker's scratch root outlives no worker: opening Scratch.dir removes the roots of
 * workers whose process has ended and keeps those of running ones. Oracle: the specification, stated in each check.
 */
import { Array as Arr, Effect, Exit, FileSystem, Option, Path, Scope, String as Str } from "effect"
import { deepStrictEqual, strictEqual } from "#assert.ts"
import { array, int } from "#gen.ts"
import { property } from "#property.ts"
import { Scratch } from "#resources/scratch.ts"
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
			original: 'fs.makeTempDirectoryScoped({ directory: root, prefix: "case-" })',
			replacement: 'fs.makeTempDirectory({ directory: root, prefix: "case-" })',
			why: "The directory outlives its case, so a later case could read what an earlier one wrote; the property fails."
		}
	]
})

export const deadRootsSwept = property.explore(
	(source) => ({ dead: source.draw(int(1, 3)), live: source.draw(int(0, 2)) }),
	{
		needs: {},
		situations: ["roots of ended workers alone", "roots of ended and running workers"],
		check:
			(_resources, c) =>
			({ dead, live }) =>
				Effect.gen(function* () {
					c.note(live === 0 ? "roots of ended workers alone" : "roots of ended and running workers")
					const fs = yield* FileSystem.FileSystem
					const path = yield* Path.Path
					const probe = yield* fs.makeTempDirectory({ prefix: "probe-" })
					const base = path.dirname(probe)
					yield* fs.remove(probe, { recursive: true })
					const pidMaxText = yield* fs.readFileString("/proc/sys/kernel/pid_max")
					const pidMax = Number(Str.trim(pidMaxText))
					const tag = path.basename(probe)
					const ended = Array.from({ length: dead }, (_, i) =>
						path.join(base, `toolchain-scratch-${pidMax + 1 + i}-${tag}`)
					)
					const runningRoots = Array.from({ length: live }, (_, i) =>
						path.join(base, `toolchain-scratch-${process.pid}-${tag}${i}`)
					)
					yield* Effect.forEach([...ended, ...runningRoots], (root) => fs.makeDirectory(root), {
						discard: true
					})
					const closures = yield* moduleClosureAt(process.cwd(), Option.none())
					yield* Effect.scoped(
						Effect.asVoid(
							Scratch.dir.open.pipe(
								Effect.provideService(WorkerIndex, { index: 0, workers: 1 }),
								Effect.provideService(ModuleClosure, closures)
							)
						)
					)
					const endedLeft = yield* Effect.forEach(ended, (root) => fs.exists(root))
					const runningKept = yield* Effect.forEach(runningRoots, (root) => fs.exists(root))
					yield* Effect.forEach([...ended, ...runningRoots], (root) =>
						fs.remove(root, { recursive: true, force: true })
					)
					deepStrictEqual(
						endedLeft,
						Arr.map(ended, () => false)
					)
					deepStrictEqual(
						runningKept,
						Arr.map(runningRoots, () => true)
					)
				}),
		oracle: {
			kind: "specification",
			name: "opening Scratch.dir removes the scratch roots of ended processes and keeps those of running ones"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/resources/scratch.ts",
				original:
					'onFailure: (error) => !(Predicate.hasProperty(error, "code") && error.code === "ESRCH")',
				replacement: "onFailure: () => true",
				why: "Every process reads as running, so a killed worker's scratch root, with every case directory it left, is never removed; the property fails."
			}
		]
	}
)
