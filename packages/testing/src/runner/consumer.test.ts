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
	layouts,
	runnerFilesOf
} from "#runner/consumer.fixtures.ts"

/**
 * A package that holds the library runs its properties in every layout a repository gives it: the library a workspace
 * link (its files in the repository, as grizzle's vendor/toolchain) or installed under node_modules, in a git
 * repository or not, with a lockfile or not, with TypeScript or not. Its run passes the properties whose searches pass,
 * records their verdicts exactly when it has a verdict key (a git repository and its lockfile, and the closure hasher,
 * which needs TypeScript), and otherwise says once why nothing was recorded; nothing passing fails for its layout. A run
 * judges no kill: a property whose kill survives passes as its search does, and its kill leaves no verdict. Each layout
 * is written in the case's scratch directory and run in a child process through the library's run keying, its
 * loadPackage and its inline evaluator, as `toolchain-test run` runs them. Oracle: the specification, stated per layout.
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
								verdicts: Option.some(["explored", "explored"]),
								recorded: keyed(layout) ? 2 : 0,
								said: keyed(layout) ? 0 : 1
							}
						],
						[
							`the consumer's run (${ran.stderr})`,
							{
								exitCode: ran.exitCode,
								verdicts: Option.map(ran.summary, (summary) => summary.verdicts),
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
		name: "a consumer's run passes its passing properties in every layout, judges no kill, and records their verdicts exactly when it has a verdict key"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/affected.ts",
			original:
				'(path) => Str.startsWith("node_modules/")(path) || Str.includes("/node_modules/")(path)',
			replacement: "(path) => false",
			why: "an installed runner weighed as repository files: its imports resolve against the consumer's importers, and nothing is recorded where a key exists"
		},
		{
			file: "packages/testing/src/runner/affected.ts",
			original:
				'const toplevel = yield* Effect.map(\n\t\t\tgitOf(packageRoot, ["rev-parse", "--show-toplevel"]),\n\t\t\tResult.getSuccess\n\t\t)',
			replacement:
				'const toplevel = Option.some(yield* required(packageRoot, ["rev-parse", "--show-toplevel"], "no git repository"))',
			why: "a package in no git repository fails its run"
		},
		{
			file: "packages/testing/src/runner/affected.ts",
			original: "const weighing = yield* Effect.result(\n\t\t\tEffect.flatMap(",
			replacement: "const weighing = yield* Effect.map(Result.succeed)(\n\t\t\tEffect.flatMap(",
			why: "a package with no lockfile, or in no git repository, fails its run, where it records nothing and says why"
		},
		{
			file: "packages/testing/src/runner/affected.ts",
			original:
				'kept.has(each.record)\n\t\t\t\t\t\t? weighing.cache.record(each.one.key, "passed")',
			replacement:
				'kept.has(each.record)\n\t\t\t\t\t\t? weighing.cache.record(each.one.key, "failed")',
			why: "a run records no pass for a property whose search passed, so a key that holds a verdict never holds it"
		}
	]
})
