/**
 * A run's run needs (runner/runs.ts, property.ts RunNeed), over a planted package (runs.fixtures.ts) run whole by
 * runPackage: a run need opens ONCE a run, in the runner's own process, before any worker, however many workers its
 * properties' cases spread over, and every worker's need that reads it (Need.overRun) gets the value that one open
 * gave. Oracle: stated per property.
 */
import { Array as Arr, Effect, FileSystem, String as Str } from "effect"
import { assert } from "#assert.ts"
import { finite, int } from "#gen.ts"
import { property } from "#property.ts"
import { Scratch } from "#resources/scratch.ts"
import { runPackage } from "#runner/run.ts"
import { countedRunRoot, OPENED } from "#runner/runs.fixtures.ts"

export const runNeedOpensOnce = property.exhaust(finite(int(1, 3)), {
	box: "a run need read by the properties of one to three test modules, a worker each",
	needs: { directory: Scratch.dir },
	situations: [],
	check:
		({ directory }) =>
		(modules) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const scratch = yield* directory
				const root = yield* countedRunRoot(scratch, modules)
				const outcome = yield* runPackage({ root, seed: 1, reach: "full", selected: [] })
				const written = yield* fs.readFileString(`${root}/${OPENED}`)
				const opened = Arr.filter(Str.split(written, "\n"), Str.isNonEmpty)
				assert.deepEqual(
					{
						verdicts: Arr.map(outcome.properties, (ran) => ran.verdict.kind),
						opened
					},
					{
						verdicts: Array.from({ length: modules }, () => "exhausted" as const),
						opened: [String(process.pid)]
					}
				)
			}),
	oracle: {
		kind: "specification",
		name: "a run need opens once a run, in the runner's process, and every worker's need reads the value it gave"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/property.ts",
			original: "\t\topen: Effect.flatMap(runValueOf(run), need.open)\n",
			replacement: "\t\topen: Effect.flatMap(Effect.scoped(run.open(process.cwd())), need.open)\n",
			why: "Each worker opens the run need itself, as metis's builtForRun had each worker build the app under a lock: it opens once a worker, in the workers' processes, never in the runner's; the property fails."
		}
	]
})
