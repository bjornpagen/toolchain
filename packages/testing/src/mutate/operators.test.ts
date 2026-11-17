/**
 * Operator mutation (mutate/operators.ts) end to end on real worker images: a checkout's file is mutated by the
 * library's operators, each mutant typed by the package's own tsconfig (the one with a type error invalid), each valid
 * one run against the properties whose coverage pass ran its function, in a process started from the mutant's image:
 * killed by a check that asserts what the function returns, survived when only checks that call it without asserting
 * ran it, uncovered when no check ran it; a mutant the run's judgments call equivalent is neither typed nor run; and
 * the run refuses when a check runs the file in a child process without a worker tree, where the file's probe never
 * reaches, or when a judgment of the mutated file names none of its mutants, while a judgment of a file the run does
 * not mutate is never read. The checks start processes that load the hook (hook.ts), so the property needs
 * Checkout.dir.
 */
import { Array as Arr, Effect, Order, Schema } from "effect"
import { deepStrictEqual } from "#assert.ts"
import { array, element } from "#gen.ts"
import { noFamilies, OPERATORS } from "#mutants.ts"
import { Checkout } from "#mutate/checkout.ts"
import { imagesOf } from "#mutate/image.ts"
import {
	checkGen,
	checkoutOf,
	equivalentOf,
	expectedOf,
	judgedGen,
	POPULATION,
	refusesOf,
	reportOf,
	type Run
} from "#mutate/operators.fixtures.ts"
import { MutationRefused, mutationOf } from "#mutate/operators.ts"
import { checkProperty, processPool } from "#mutate/processes.fixtures.ts"
import type { Subject } from "#mutate/schedule.ts"
import { treesOf } from "#mutate/tree.ts"
import { property, PropertyId } from "#property.ts"
import { runnerLimits } from "#runner/limits.ts"

export const operatorMutation = property.explore(
	(source): Run => ({
		checks: Arr.prepend(source.draw(array(checkGen, { min: 0, max: 1 })), source.draw(checkGen)),
		loading: source.draw(element(["in-process", "tree"])),
		judged: source.draw(judgedGen)
	}),
	{
		needs: { checkout: Checkout.dir },
		situations: [
			"killed",
			"survived",
			"uncovered",
			"invalid",
			"refused",
			"a child in a tree",
			"tree",
			"equivalent",
			"a stale judgment refused",
			"another file's judgment unread"
		],
		check: (_resources, c) => (run) =>
			Effect.gen(function* () {
				if (run.loading === "tree") {
					c.note("tree")
				}
				if (run.loading === "tree" && Arr.some(run.checks, (check) => check.child)) {
					c.note("a child in a tree")
				}
				const checkout = yield* checkoutOf(run)
				const pool = yield* processPool
				const trees = yield* treesOf(checkout)
				const images = yield* imagesOf(checkout, trees)
				const equivalent = yield* equivalentOf(run.judged)
				const subjects = Arr.map(run.checks, (_, index): Subject => ({
					id: PropertyId(`check${String(index)}`),
					property: checkProperty([]),
					loading: run.loading
				}))
				const measured = yield* Effect.result(
					mutationOf(pool, images, {
						witnesses: { seed: 1, limits: runnerLimits },
						checkout,
						pkg: checkout,
						subjects,
						files: ["src/f.ts"],
						families: noFamilies,
						equivalent,
						operators: new Set(OPERATORS),
						choice: { kind: "every" }
					})
				)
				const refuses = refusesOf(run)
				if (measured._tag === "Failure") {
					c.note("refused")
					if (run.judged.stale === "this file") {
						c.note("a stale judgment refused")
					}
					deepStrictEqual(
						{ refused: Schema.is(MutationRefused)(measured.failure), expected: refuses },
						{ refused: true, expected: true }
					)
					return
				}
				const judged = measured.success
				c.noteAll(Arr.map(judged, ({ verdict }) => verdict.kind))
				if (run.judged.stale === "another file") {
					c.note("another file's judgment unread")
				}
				deepStrictEqual(
					{
						refused: false,
						population: Arr.sort(
							Arr.map(judged, ({ mutant }) => `${mutant.fn} ${mutant.operator}`),
							Order.String
						),
						verdicts: Arr.map(judged, reportOf)
					},
					{
						refused: refuses,
						population: Arr.copy(POPULATION),
						verdicts: Arr.map(judged, (one) => expectedOf(run, one))
					}
				)
			}),
		oracle: {
			kind: "specification",
			name: "equivalent when judged so, else invalid when mistyped, uncovered when no check calls its function, killed when a strict one does, survived otherwise; refused when a check runs the file in a child without a tree or a judgment of the file names none of its mutants"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/mutate/operators.ts",
				original: "const covering = map.covering(source.target, mutant.start)",
				replacement: "const covering = map.touching(source.target)",
				why: "A mutant runs against every property that ran its file, not its place, so a mutant in a function no check calls is never uncovered."
			},
			{
				file: "packages/testing/src/mutate/operators.ts",
				original: "yield* probed(pool, run.witnesses, images, map, sources)",
				replacement: "yield* Effect.void",
				why: "The probes are skipped, so a check that runs the file in a child process without a tree is never refused."
			},
			{
				file: "packages/testing/src/mutate/operators.ts",
				original: "\t\tconst stale = staleOf(run, population)",
				replacement: "\t\tconst stale: ReadonlyArray<Equivalent> = []",
				why: "A judgment that names none of its file's current mutants is never refused, so an equivalence argued for code that moved or changed outlives it."
			},
			{
				file: "packages/testing/src/mutate/operators.ts",
				original:
					"\t\t\tArr.contains(run.files, entry.file) && !current.has(judgedKey(entry.file, entry.mutant))",
				replacement: "\t\t\t!current.has(judgedKey(entry.file, entry.mutant))",
				why: "A judgment of a file the run does not mutate, whose mutants it never reads, is called stale, so every run of one file refuses while any other file holds a judgment."
			},
			{
				file: "packages/testing/src/mutate/operators.ts",
				original: "\t\t\tconst why = equivalentWhy.get(judgedKey(source.file, mutant.id))",
				replacement: "\t\t\tconst why = equivalentWhy.get(mutant.id)",
				why: "A mutant's judgment is looked up by its id alone, never its file and id, so a mutant judged equivalent is typed and run like any other and reported killed, survived, invalid or uncovered instead of equivalent."
			}
		]
	}
)
