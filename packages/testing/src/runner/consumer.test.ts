import { Effect, Option } from "effect"
import { Checkout } from "#mutate/checkout.ts"
import { agree, exact } from "#oracle.ts"
import { property } from "#property.ts"
import { Scratch } from "#resources/scratch.ts"
import {
	consumerIn,
	consumerRun,
	keyed,
	layoutSituationsOf,
	layouts
} from "#runner/consumer.fixtures.ts"

/**
 * A package that holds the library runs its properties in every layout a repository gives it: the library a workspace
 * link (its files in the repository, as grizzle's vendor/toolchain) or installed under node_modules, in a git
 * repository or not, with a lockfile or not. Its run passes when its properties pass, records their verdicts exactly
 * when it has a verdict key (a git repository and its lockfile), and otherwise says once why nothing was recorded;
 * nothing fails for its layout. Each layout is written in the case's scratch directory and run in a child process
 * through the library's loadPackage, its inline evaluator and recordedRun, as `toolchain-test run` runs them. Oracle:
 * the specification, stated per layout.
 */
export const consumersRunInEveryLayout = property.exhaust(layouts, {
	box: "every layout: the library linked or installed, in a git repository or not, with a lockfile or not",
	needs: { directory: Scratch.dir, checkout: Checkout.dir },
	situations: [
		"a workspace link with a verdict key",
		"an installed library with a verdict key",
		"a package in no git repository",
		"a package with no lockfile"
	],
	check:
		({ directory, checkout }, c) =>
		(layout) =>
			Effect.gen(function* () {
				c.noteAll(layoutSituationsOf(layout))
				const scratch = yield* directory
				const consumer = `${scratch}/consumer`
				const library = yield* checkout
				yield* consumerIn(consumer, layout, library)
				const ran = yield* consumerRun(consumer, `${scratch}/cache`)
				yield* agree(
					[
						[
							"the specification",
							{
								exitCode: 0,
								verdicts: Option.some(["explored"]),
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
		name: "a consumer's run passes in every layout and records its verdicts exactly when it has a verdict key"
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
		}
	]
})
