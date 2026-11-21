/**
 * A kill trial's templates are its own (resources/template.ts identify over runner/module-closure.ts, which the pool's
 * parent holds for the mutant its workers serve, runner/pool.ts): two runs one after another on one cluster, each a
 * lease of the mutator's pool (runner/lease.ts mutantPoolOf) from an image of the checkout (mutate/image.ts), unmutated
 * or serving a mutant of the module a template's build reads (mark.fixtures.ts) through its workers' module hook, as an
 * in-process kill trial does, each open a clone of one template declaration (templates.fixtures.ts opensMarked). Each
 * run's workers load the mark their image serves, and the clone each opens comes from a template that code built,
 * never one the other run's code built, whichever ran first; and the two runs open one template exactly when their
 * workers load the same text. The check starts pools from the checkout, so the property needs Checkout.dir: its kills
 * run in a worker tree. Oracle: the specification, stated in the check.
 */
import { Array as Arr, Effect, FileSystem, Option, Schema } from "effect"
import { assert } from "#assert.ts"
import { Checkout } from "#mutate/checkout.ts"
import { imagesOf } from "#mutate/image.ts"
import { realPathOf } from "#mutate/mutated.ts"
import {
	MARK_FILE,
	MARK_TOKEN,
	markedCase,
	markOf,
	OpenedJson,
	runPairs,
	sameText,
	servedText,
	situationOf
} from "#mutate/templates.fixtures.ts"
import { treesOf } from "#mutate/tree.ts"
import { property } from "#property.ts"
import { PgCluster, single } from "#resources/cluster.ts"
import { dropTemplate, services, templateNameOf } from "#resources/resources.fixtures.ts"
import { Scratch } from "#resources/scratch.ts"
import { mutantPoolOf } from "#runner/lease.ts"
import { runnerLimits } from "#runner/limits.ts"

export const trialTemplatesApart = property.exhaust(runPairs, {
	box: "two runs, each unmutated or serving one of two mutants",
	needs: { checkout: Checkout.dir, directory: Scratch.dir, services },
	situations: [
		"an unmutated run after a mutant's",
		"a mutant's run after an unmutated one",
		"runs of two mutants",
		"two runs of one mutant",
		"two unmutated runs"
	],
	check:
		({ checkout, directory, services: context }, c) =>
		(pair) =>
			Effect.gen(function* () {
				c.note(situationOf(pair))
				const root = yield* checkout
				const packageRoot = yield* realPathOf(root)
				const scratch = yield* directory
				const ctx = yield* context
				const fs = yield* FileSystem.FileSystem
				const member = yield* Effect.provideContext(
					Effect.flatMap(PgCluster, (cluster) => Effect.map(cluster.members, Arr.headNonEmpty)),
					ctx
				)
				const token = yield* Effect.provideContext(
					Effect.flatMap(PgCluster, (cluster) =>
						Effect.scoped(
							Effect.flatMap(cluster.connect(member, cluster.maintenance), (session) =>
								Effect.flatMap(
									single(session, "SELECT pg_catalog.gen_random_uuid()::text", []),
									(drawn) => Effect.fromOption(Option.fromNullishOr(drawn))
								)
							)
						)
					),
					ctx
				)
				const target = yield* realPathOf(`${packageRoot}/src/mutate/mark.fixtures.ts`)
				const trees = yield* treesOf(packageRoot)
				const images = yield* imagesOf(packageRoot, trees)
				const pool = yield* mutantPoolOf(packageRoot, packageRoot)
				const opened = yield* Effect.forEach(pair, (loads, at) =>
					Effect.scoped(
						Effect.gen(function* () {
							const file = `${scratch}/run-${String(at)}.json`
							const image = yield* images.open(
								"in-process",
								Option.map(servedText(loads), (text) => ({ target, text }))
							)
							const evaluator = yield* pool.lease(
								{ ...image, env: { [MARK_TOKEN]: token, [MARK_FILE]: file } },
								1,
								{ guide: "notes", runs: [] }
							)
							const results = yield* evaluator.evaluate(
								[markedCase(runnerLimits.deadline)],
								() => true
							)
							assert.deepEqual(
								Arr.map(Arr.flatten(results), (result) => result.outcome),
								[
									{
										kind: "passed",
										kept: { kind: "nothing" },
										shown: { kind: "unshown" }
									}
								]
							)
							const written = yield* fs.readFileString(file)
							return yield* Schema.decodeEffect(OpenedJson)(written)
						})
					)
				)
				yield* Effect.provideContext(
					Effect.forEach(
						Arr.dedupe(Arr.map(opened, (run) => run.template)),
						(name) => dropTemplate({ member, name: templateNameOf(name) }),
						{ discard: true }
					),
					ctx
				)
				assert.deepEqual(
					{
						marks: Arr.map(opened, (run) => ({ loaded: run.loaded, built: run.built })),
						oneTemplate: Arr.dedupe(Arr.map(opened, (run) => run.template)).length === 1
					},
					{
						marks: Arr.map(pair, (loads) => ({
							loaded: markOf(loads),
							built: [[String(markOf(loads))]]
						})),
						oneTemplate: sameText(pair)
					}
				)
			}),
	oracle: {
		kind: "specification",
		name: "each run opens a template its own workers' code built, and two runs share one exactly when their workers load the same text"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/pool.ts",
			original: "Option.map(spec.served, (served) => served.mutant)",
			replacement: "Option.none()",
			why: "The pool's parent hashes the checkout's files for a pool whose workers serve a mutant, as before (GZ-FIN): whichever run builds the template first, the other opens it, a mutant's template under the unmutated identity; this property fails."
		},
		{
			file: "packages/testing/src/runner/module-closure.ts",
			original: "path === replaced.path ? Effect.succeedSome(replaced.bytes) : tree.read(path)",
			replacement: "tree.read(path)",
			why: "The closure reads the mutant's file from disk, not the text the workers load, so a run of a mutant and an unmutated run name one template; this property fails."
		},
		{
			file: "packages/testing/src/runner/lease.ts",
			original: "served: image.served,",
			replacement: "served: Option.none(),",
			why: "A lease drops its image's mutant: its workers load the file as it is, so a mutant's run reads the unmutated mark; this property fails."
		}
	]
})
