/**
 * A run's run needs (runner/runs.ts, property.ts RunNeed), over a planted package (runs.fixtures.ts) run whole by
 * runPackage: a run need opens ONCE a run, in the runner's own process, before any worker, however many workers its
 * properties' cases spread over, and every worker's need that reads it (Need.overRun) gets the value that one open
 * gave; and a run need's open is given its package's closures (ModuleClosure), so one that records the digest of what
 * it makes skips its work while that digest stands and makes it again once any module of the closure changed, however
 * deep the import that changed (openedRuns, over a workspace written per case). Oracle: stated per property.
 */
import { Array as Arr, Effect, FileSystem, String as Str } from "effect"
import { assert } from "#assert.ts"
import { finite, int } from "#gen.ts"
import { property } from "#property.ts"
import { Scratch } from "#resources/scratch.ts"
import { runPackage } from "#runner/run.ts"
import {
	closureWorkspaceIn,
	countedRunRoot,
	lastLinkOf,
	OPENED,
	skipping
} from "#runner/runs.fixtures.ts"
import { openedRuns } from "#runner/runs.ts"

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
				const outcome = yield* runPackage({
					root,
					seedOf: () => 1,
					conductOf: () => "clean",
					reach: "full",
					selected: []
				})
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

export const aRunNeedMakesOnceAClosure = property.exhaust(finite(int(1, 3)), {
	box: "a run need that digests a module's closure through a chain of one to three imports, opened three times: unchanged, then with the chain's last module changed",
	needs: { directory: Scratch.dir },
	situations: [],
	check:
		({ directory }) =>
		(depth) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const scratch = yield* directory
				yield* closureWorkspaceIn(scratch, depth, 1)
				const did = Effect.map(Effect.scoped(openedRuns([skipping], scratch, 60_000)), (values) =>
					Arr.map(values, (value) => (value.kind === "opened" ? value.value : value.message))
				)
				const first = yield* did
				const again = yield* did
				yield* fs.writeFileString(lastLinkOf(scratch, depth), "export const link = 2\n")
				const changed = yield* did
				assert.deepEqual([first, again, changed], [["ran"], ["skipped"], ["ran"]])
			}),
	oracle: {
		kind: "specification",
		name: "a run need given its package's closures makes what a closure determines once: skipped while the digest it recorded stands, made again once any module of the closure changed"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/closure.ts",
			original: "\tCODE.test(path)\n\t\t? Effect.flatMap(ModuleSyntax",
			replacement: "\tfalse\n\t\t? Effect.flatMap(ModuleSyntax",
			why: "A closure is its entry file alone, no import followed, so a run need keyed by it skips its work after a module the entry imports changed; the third open skips."
		}
	]
})
