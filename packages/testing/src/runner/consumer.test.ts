import { Effect, Option } from "effect"
import { Checkout } from "#mutate/checkout.ts"
import { agree, exact } from "#oracle.ts"
import { property } from "#property.ts"
import { Scratch } from "#resources/scratch.ts"
import {
	consumerIn,
	consumerRun,
	judgeable,
	keyed,
	layoutSituationsOf,
	layouts,
	runnerFilesOf
} from "#runner/consumer.fixtures.ts"

/**
 * A package that holds the library runs its properties in every layout a repository gives it: the library a workspace
 * link (its files in the repository, as grizzle's vendor/toolchain) or installed under node_modules, in a git
 * repository or not, with a lockfile or not, with TypeScript or not. Its run passes the properties that pass, records
 * their verdicts exactly when it has a verdict key (a git repository and its lockfile, and the closure hasher, which
 * needs TypeScript), and otherwise says once why nothing was recorded; nothing passing fails for its layout. Where no
 * kill can be judged (no git repository, no TypeScript), a property with a kill fails, its searches passing: an
 * unjudged kill is no pass. Each layout is written in the case's scratch directory and run in a child process through
 * the library's loadPackage, its inline evaluator and settledRun, as `toolchain-test run` runs them. Oracle: the
 * specification, stated per layout.
 */
export const consumersRunInEveryLayout = property.exhaust(layouts, {
	box: "every layout: the library linked or installed, in a git repository or not, with a lockfile or not, with TypeScript or not",
	needs: { directory: Scratch.dir, checkout: Checkout.dir },
	situations: [
		"a workspace link with a verdict key",
		"an installed library with a verdict key",
		"a package in no git repository",
		"a package with no lockfile",
		"a package with no TypeScript"
	],
	check:
		({ directory, checkout }, c) =>
		(layout) =>
			Effect.gen(function* () {
				c.noteAll(layoutSituationsOf(layout))
				const scratch = yield* directory
				const consumer = `${scratch}/consumer`
				const library = yield* checkout
				yield* consumerIn(consumer, layout, library, runnerFilesOf(layout))
				const ran = yield* consumerRun(consumer, `${scratch}/cache`)
				yield* agree(
					[
						[
							"the specification",
							{
								exitCode: 0,
								verdicts: Option.some(judgeable(layout) ? ["explored"] : ["explored", "explored"]),
								passing: Option.some(1),
								recorded: keyed(layout) ? 1 : 0,
								said: keyed(layout) ? 0 : 1
							}
						],
						[
							`the consumer's run (${ran.stderr})`,
							{
								exitCode: ran.exitCode,
								verdicts: Option.map(ran.summary, (summary) => summary.verdicts),
								passing: Option.map(ran.summary, (summary) => summary.passing),
								recorded: ran.recorded,
								said: ran.said.length
							}
						]
					],
					exact
				)
			}),
	oracle: {
		kind: "specification",
		name: "a consumer's run passes its passing properties in every layout, fails one whose kill it cannot judge, and records its verdicts exactly when it has a verdict key"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/affected.ts",
			original: '&& !Str.includes("/node_modules/")(real)',
			replacement: "&& true",
			why: "an installed runner weighed as repository files: its imports resolve against the consumer's importers, and nothing is recorded where a key exists"
		},
		{
			file: "packages/testing/src/runner/affected.ts",
			original: 'const toplevel = yield* gitOf(packageRoot, ["rev-parse", "--show-toplevel"])',
			replacement:
				'const toplevel = Option.some(yield* required(packageRoot, ["rev-parse", "--show-toplevel"], "no git repository"))',
			why: "a package in no git repository fails its run"
		},
		{
			file: "packages/testing/src/runner/affected.ts",
			original:
				"const weighing = yield* Effect.result(weighingOf(grounds.packageRoot, repository, selected))",
			replacement:
				"const weighing = Result.succeed(yield* weighingOf(grounds.packageRoot, repository, selected))",
			why: "a package with no lockfile fails its run"
		},
		{
			file: "packages/testing/src/runner/run.ts",
			original:
				"searchedPassed(outcome, ran.id) && !Arr.isReadonlyArrayNonEmpty(ran.kills) ? [ran.id] : []",
			replacement: "searchedPassed(outcome, ran.id) ? [ran.id] : []",
			why: "a property whose kills no run can judge passes as its searches did, beside its UNJUDGED lines"
		},
		{
			file: "packages/testing/src/runner/affected.ts",
			original: "return yield* unjudgeable(",
			replacement: "return { lines: [], passing: passingOf(outcome, ids, []) } || unjudgeable(",
			why: "a package in no git repository passes a property whose kills it never judged"
		},
		{
			file: "packages/testing/src/runner/settle.ts",
			original: "onFailure: (unloaded) => unjudgeable(outcome, unloaded.message)",
			replacement:
				"onFailure: () => Effect.succeed({ lines: [], passing: new Set(outcome.properties.map((ran) => ran.id)) })",
			why: "a run whose closure hasher did not load (no TypeScript) passes a property whose kills it never judged, as `toolchain-test run` did"
		}
	]
})
