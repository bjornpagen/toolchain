import { Config, Effect, Equal, FileSystem, Option, Schema } from "effect"
import { element, finite, int } from "#gen.ts"
import { mark } from "#mutate/mark.fixtures.ts"
import { property } from "#property.ts"
import { PgCluster, required, run } from "#resources/cluster.ts"
import { inDatabase, services } from "#resources/resources.fixtures.ts"
import { Template } from "#resources/template.ts"
import type { Batch } from "#runner/protocol.ts"

/**
 * A kill trial's templates (templates.test.ts) are proven by runs of a planted property on pools of their own, some
 * serving a mutant of mark.fixtures.ts: this module is that property, and the support of the property that leases them.
 */

/** The variable of a worker's environment holding its case's token, which names the template the planted case opens. */
export const MARK_TOKEN = "TOOLCHAIN_TEST_MARK_TOKEN"

/** The variable of a worker's environment naming the file the planted case writes what it opened to. */
export const MARK_FILE = "TOOLCHAIN_TEST_MARK_FILE"

/** The planted property's identity, as its pool's workers load it from the testing package's root. */
const PLANTED = "src/mutate/templates.fixtures.ts#opensMarked"

/** The mark mark.fixtures.ts holds on disk, as an unmutated worker loads it. */
export const UNMUTATED_MARK = 1

/** What a run's workers load mark.fixtures.ts as: the file as it is, or a mutant of it holding another mark. */
export type Loads = Readonly<{ kind: "unmutated" }> | Readonly<{ kind: "mutant"; mark: number }>

/** The loadings a run's workers are started with: unmutated, or one of two mutants, each with a mark of its own. */
const LOADS = element<Loads>([
	{ kind: "unmutated" },
	{ kind: "mutant", mark: 2 },
	{ kind: "mutant", mark: 3 }
])

/** Two runs one after another, on one cluster, each started from its own loading: every pair of the loadings. */
export const runPairs = finite((source): readonly [Loads, Loads] => [
	source.draw(LOADS),
	source.draw(LOADS)
])

/** The mark a worker of a run loads: the file's own, or its mutant's. */
export const markOf = (loads: Loads): number =>
	loads.kind === "unmutated" ? UNMUTATED_MARK : loads.mark

/** The text of mark.fixtures.ts a mutant serves in its place: the module, holding the mutant's mark. */
export const mutantText = (mutantMark: number): string =>
	`export const mark = ${String(mutantMark)}\n`

/** The text a run's image serves in mark.fixtures.ts's place: none for an unmutated run, whose workers load the file. */
export const servedText = (loads: Loads): Option.Option<string> =>
	loads.kind === "unmutated" ? Option.none() : Option.some(mutantText(loads.mark))

/** Whether two runs' workers load the same text of mark.fixtures.ts: both the file's, or both one mutant's. */
export const sameText = ([first, second]: readonly [Loads, Loads]): boolean =>
	Equal.equals(servedText(first), servedText(second))

/** The situation a pair of runs stands for, in the order they ran. */
export const situationOf = ([first, second]: readonly [Loads, Loads]) => {
	if (sameText([first, second])) {
		return first.kind === "unmutated" ? "two unmutated runs" : "two runs of one mutant"
	}
	if (first.kind === "mutant" && second.kind === "mutant") {
		return "runs of two mutants"
	}
	return first.kind === "mutant"
		? "an unmutated run after a mutant's"
		: "a mutant's run after an unmutated one"
}

/**
 * The template the planted case opens, a template of the case's own by its token: its build writes the mark the
 * building worker loads into a table, so a clone says which code built the template it came from.
 */
const markedTemplate = (token: string) =>
	Template.database({
		declaredIn: import.meta,
		name: `marked ${token}`,
		content: { token },
		from: Template.cluster,
		build: (built) =>
			Effect.scoped(
				Effect.gen(function* () {
					const cluster = yield* required(PgCluster, "the fixture's runner config provides it")
					const session = yield* cluster.connect(built.member, built.name)
					yield* run(
						session,
						`CREATE TABLE public.marked AS SELECT ${String(mark)}::int4 AS mark`,
						[]
					)
				})
			)
	})

/**
 * What the planted case writes, as JSON: the template its clone came from, the rows of the mark that template's build
 * wrote, and the mark the case's own worker loads.
 */
export const OpenedJson = Schema.fromJsonString(
	Schema.Struct({
		template: Schema.String,
		built: Schema.Array(Schema.Array(Schema.NullOr(Schema.String))),
		loaded: Schema.Int
	})
)

/** What the planted case opened (OpenedJson). */
export type Opened = typeof OpenedJson.Type

/**
 * A property planted to open a clone of its case's template (markedTemplate, by the token MARK_TOKEN names) on its
 * worker, and write to the file MARK_FILE names the template's name, the mark its build wrote, and the mark the worker
 * itself loads.
 */
export const opensMarked = property.exhaust(finite(int(0, 1)), {
	box: "two values",
	needs: { services },
	situations: [],
	check:
		({ services: context }) =>
		() =>
			Effect.gen(function* () {
				const token = yield* Config.String(MARK_TOKEN)
				const file = yield* Config.String(MARK_FILE)
				const ctx = yield* context
				const opened = yield* Effect.provideContext(
					Effect.scoped(
						Effect.gen(function* () {
							const template = yield* markedTemplate(token).open
							const clone = yield* template.clone
							const built = yield* inDatabase(clone, "SELECT mark::text FROM public.marked", [])
							const seen: Opened = { template: clone.template, built, loaded: mark }
							return seen
						})
					),
					ctx
				)
				const fs = yield* FileSystem.FileSystem
				const text = yield* Schema.encodeEffect(OpenedJson)(opened)
				yield* fs.writeFileString(file, text)
			}),
	oracle: {
		kind: "specification",
		name: "a property planted to open a clone of its case's template and say what built it"
	},
	kept: [],
	kills: []
})

/** The planted property's one case, as a search orders it, at the runner's deadline and open bound. */
export const markedCase = (deadline: number, open: number): Batch => [
	{
		property: PLANTED,
		chooser: { kind: "simplest" },
		drawn: { kind: "unsteered" },
		keep: "nothing",
		sense: { kind: "notes" },
		deadline,
		open,
		print: "failing"
	}
]
