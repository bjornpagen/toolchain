import { Array as Arr, Effect, FileSystem, String as Str } from "effect"
import { finite, int } from "#gen.ts"
import { homesHere, imagesOf } from "#pg/family.ts"
import { caseUnit, memberStopped, unitRemovedAtEnd } from "#pg/settle.fixtures.ts"
import { plantedBudget } from "#planted.fixtures.ts"
import { consumerIn, type Layout, manifestOf } from "#runner/consumer.fixtures.ts"
import { clusterConfigOf, unitIn } from "#runner/reuse.fixtures.ts"

/** The consumer's layout: the library linked, in a git repository with its lockfile, TypeScript installed. */
const layout: Layout = { library: "link", git: true, lockfile: true, typescript: true }

/** How many times the throwaway property runs its consumer: two or three. */
export const runsOfIt = finite((source) => source.draw(int(2, 3)))

/**
 * The consumer's runner config: a cluster of its own (pg.config.ts, under a throwaway case cluster's unit name on
 * disk, `tcd-`), its databases under `d_`, and budget parts of none, since the property reads what its runs did and
 * not how they ended.
 */
const CONFIG = `import { defineRunner, noMutation } from "@bjornpagen/testing/runner"\nimport { pgOwnerSession, pgSuperuserSession } from "@bjornpagen/testing/pg-session"\nimport { DatabasePrefix, PgCluster } from "@bjornpagen/testing/resources"\nimport cluster from "./pg.config.ts"\n\nexport default defineRunner({ budget: { kind: "cpu", run: 0, import: 0 }, include: ["test/*.test.ts"], smallStack: [], conditions: [], environment: [], layer: PgCluster.layer({ prefix: DatabasePrefix("d_"), cluster, connect: pgOwnerSession("kept"), superuser: pgSuperuserSession("kept superuser") }), mutation: noMutation })\n`

/**
 * The consumer's property, one case: it clones a template whose build appends a line to built.txt, so how many times
 * the template was built reads off the file, and makes its one table; reads its member for a database a run before left (`left` and a pid), of
 * which it finds none or fails; and leaves one of its own, which its case never drops, as a run that ended before its
 * collection leaves a clone.
 */
const PROPERTY = `import { appendFileSync } from "node:fs"\nimport { Effect } from "effect"\nimport { finite, int } from "@bjornpagen/testing/gen"\nimport { pgOwnerSession } from "@bjornpagen/testing/pg-session"\nimport { property } from "@bjornpagen/testing/property"\nimport { Database, Template } from "@bjornpagen/testing/resources"\n\nconst counted = Template.database({ declaredIn: import.meta, name: "counted", content: {}, from: Template.cluster, budget: ${String(plantedBudget)}, build: (target) => Effect.scoped(Effect.gen(function* () { appendFileSync(new URL("../built.txt", import.meta.url), "built\\n"); const session = yield* pgOwnerSession("kept build")(target.member, target.name); yield* session.query("CREATE TABLE kept (k int)", []) })) })\n\nexport const kept = property.exhaust(finite((source) => source.draw(int(1, 1))), {\n\tneeds: { db: Database.fresh(counted) },\n\tsituations: [],\n\tcheck: ({ db }) => () => Effect.scoped(Effect.gen(function* () {\n\t\tconst clone = yield* db\n\t\tconst session = yield* pgOwnerSession("kept")(clone.member, clone.name)\n\t\tconst [[left]] = yield* session.query("SELECT count(*)::text FROM pg_catalog.pg_database WHERE datname LIKE 'left%'", [])\n\t\tyield* session.query(\`CREATE DATABASE left\${process.pid}\`, [])\n\t\tconst rows = yield* session.query("SELECT count(*)::text FROM kept", [])\n\t\treturn left === "0" && rows.length === 1 ? undefined : yield* Effect.die(\`\${left} databases a run before left\`)\n\t})),\n\toracle: { kind: "specification", name: "a clone holds its template's table, and its member nothing a run before left" },\n\tkept: [],\n\tkills: []\n})\n`

/**
 * What one run of the consumer came to: whether its property passed (or what the run said, where it did not), its
 * member's folder once it stopped, and its family's images.
 */
export type RunSeen = Readonly<{
	passed: string
	folder: "a link to nothing" | "there" | "gone"
	images: number
}>

/** What the consumer's runs came to: each run's, and how many times its template was built in all. */
export type RunsSeen = Readonly<{ runs: ReadonlyArray<RunSeen>; builds: number }>

/**
 * Writes the consumer into `directory` from the library at `library` (Checkout.dir), its cluster a throwaway case
 * cluster of its own on disk, removed at the scope's end (unitRemovedAtEnd); settles its family and runs it `runs`
 * times, each on a fresh cache, so its verdict is never answered from an earlier run's, all of one family (one states
 * home); after each, stops its member as the run's end does (memberStopped: the lease's stop and the member's, its last
 * step run), then reads the member's folder and its family's images. Answers each run's and the template's builds.
 */
export const runsSeen = (directory: string, library: string, runs: number) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const homes = yield* Effect.orDie(homesHere)
			const unit = yield* caseUnit("tcd")
			yield* unitRemovedAtEnd(unit)
			const consumer = `${directory}/consumer`
			const states = `${directory}/state`
			yield* consumerIn(consumer, layout, library, [
				["package.json", manifestOf(layout)],
				["test.config.ts", CONFIG],
				["pg.config.ts", clusterConfigOf(unit)],
				["test/kept.test.ts", PROPERTY]
			])
			const [settled, settleOut, settleErr] = yield* Effect.orDie(
				unitIn(consumer, { XDG_STATE_HOME: states }, "pg/cli.ts", ["settle"])
			)
			if (settled !== 0) {
				return yield* Effect.die(
					`toolchain-pg settle exited ${String(settled)}: ${settleOut}${settleErr}`
				)
			}
			const family = yield* Effect.flatMap(fs.readDirectory(`${states}/toolchain-pg`), (names) =>
				Effect.fromOption(Arr.findFirst(names, Str.startsWith(`${unit}-`)))
			)
			const member = `${family}-0`
			const seen = yield* Effect.forEach(
				Array.from({ length: runs }, (_, at) => at),
				(at) =>
					Effect.gen(function* () {
						const [, stdout, stderr] = yield* Effect.orDie(
							unitIn(
								consumer,
								{ XDG_CACHE_HOME: `${directory}/cache-${String(at)}`, XDG_STATE_HOME: states },
								"runner/cli-entry.ts",
								["run"]
							)
						)
						yield* memberStopped(member)
						const path = `${homes.data}/${member}`
						const linked = yield* Effect.isSuccess(fs.readLink(path))
						const there = yield* Effect.orElseSucceed(fs.exists(path), () => false)
						const images = yield* Effect.orElseSucceed(
							fs.readDirectory(imagesOf(homes.data, family)),
							(): ReadonlyArray<string> => []
						)
						return {
							passed:
								Str.includes("1 run (")(`${stdout}${stderr}`) &&
								Str.includes(", 0 failed, in ")(`${stdout}${stderr}`)
									? "passed"
									: Arr.join(
											Arr.filter(
												Str.split("\n")(`${stdout}${stderr}`),
												(line) => !Str.startsWith("    at ")(line)
											),
											"\n"
										),
							folder: there ? "there" : linked ? "a link to nothing" : "gone",
							images: images.length
						} satisfies RunSeen
					})
			)
			const built = yield* fs.readFileString(`${consumer}/built.txt`)
			return {
				runs: seen,
				builds: Arr.filter(Str.split("\n")(built), Str.isNonEmpty).length
			} satisfies RunsSeen
		})
	)
