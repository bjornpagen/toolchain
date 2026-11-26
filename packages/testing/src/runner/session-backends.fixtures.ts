import { Array as Arr, Effect, FileSystem, Schema, String as Str } from "effect"
import { caseUnit, unitRemovedAtEnd } from "#pg/settle.fixtures.ts"
import { plantedBudget } from "#planted.fixtures.ts"
import { budgetLinesOf } from "#runner/budget.fixtures.ts"
import { consumerIn, type Layout, manifestOf } from "#runner/consumer.fixtures.ts"
import { clusterConfigOf, unitIn } from "#runner/reuse.fixtures.ts"

/** The consumer's layout: the library linked, in a git repository with its lockfile, TypeScript installed. */
const layout: Layout = { library: "link", git: true, lockfile: true, typescript: true }

/**
 * The consumer's runner config: a cluster of its own (pg.config.ts), its databases under `s_`, and a budget of none,
 * 0 ms, so its run ends past it, naming what it spent with its backends'.
 */
const CONFIG = `import { defineRunner, noMutation } from "@bjornpagen/testing/runner"\nimport { pgOwnerSession, pgSuperuserSession } from "@bjornpagen/testing/pg-session"\nimport { DatabasePrefix, PgCluster } from "@bjornpagen/testing/resources"\nimport cluster from "./pg.config.ts"\n\nexport default defineRunner({ budget: { kind: "cpu", millis: 0 }, include: ["test/*.test.ts"], smallStack: [], conditions: [], environment: [], layer: PgCluster.layer({ prefix: DatabasePrefix("s_"), cluster, connect: pgOwnerSession("short"), superuser: pgSuperuserSession("short superuser") }), mutation: noMutation })\n`

/**
 * The consumer's property, `cases` cases: each opens a session of its own on a clone of an empty template (a backend
 * of its own, which ends with the case's scope), counts twenty million rows on it, reads the backend's own CPU off
 * /proc/<pid>/stat (its user and system ticks, at 100 a second) just before the session closes, and appends it to
 * spent.txt in ms: a backend that lives a second or two inside one case, under any reading the budget meter takes.
 */
const propertyOf = (cases: number) =>
	`import { appendFileSync, readFileSync } from "node:fs"\nimport { Effect } from "effect"\nimport { finite, int } from "@bjornpagen/testing/gen"\nimport { pgOwnerSession } from "@bjornpagen/testing/pg-session"\nimport { property } from "@bjornpagen/testing/property"\nimport { Database, Template } from "@bjornpagen/testing/resources"\n\nconst empty = Template.database({ declaredIn: import.meta, name: "empty", content: {}, from: Template.cluster, budget: ${String(plantedBudget)}, build: () => Effect.void })\n\nexport const short = property.exhaust(finite((source) => source.draw(int(1, ${String(cases)}))), {\n\tneeds: { db: Database.fresh(empty) },\n\tsituations: [],\n\tcheck: ({ db }) => () => Effect.scoped(Effect.gen(function* () {\n\t\tconst clone = yield* db\n\t\tconst session = yield* pgOwnerSession("short")(clone.member, clone.name)\n\t\tconst [[pid]] = yield* session.query("SELECT pg_catalog.pg_backend_pid()::text", [])\n\t\tyield* session.query("SELECT count(*)::text FROM pg_catalog.generate_series(1, 20000000)", [])\n\t\tconst stat = readFileSync(\`/proc/\${pid}/stat\`, "utf8")\n\t\tconst fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")\n\t\tappendFileSync(new URL("../spent.txt", import.meta.url), \`\${(Number(fields[11]) + Number(fields[12])) * 10}\\n\`)\n\t})),\n\toracle: { kind: "specification", name: "a backend of its own counts twenty million rows" },\n\tkept: [],\n\tkills: []\n})\n`

/** The run's backends' CPU and its CPU with theirs, as its JSON record holds them (runner/usage.ts UsageRecord), in ms. */
const Recorded = Schema.fromJsonString(
	Schema.Struct({ report: Schema.Struct({ backends: Schema.Finite, metered: Schema.Finite }) })
)

/** One line of spent.txt: a backend's CPU in ms. */
const SpentLine = Schema.FiniteFromString

/**
 * Writes the consumer of `cases` cases into `directory` from the library at `library` (Checkout.dir, so a kill's
 * mutant is in it), its cluster under a case cluster's unit name removed at the scope's end, settles its family and
 * runs `toolchain-test run` in it (reuse.fixtures.ts unitIn); answers the backends' CPU its run's JSON record counts,
 * the CPU with theirs it records, the lines the run printed that name its budget, and each case's backend's own CPU, as
 * the cases read them.
 */
export const shortBackendsRun = (directory: string, library: string, cases: number) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const unit = yield* caseUnit("tcs")
			yield* unitRemovedAtEnd(unit)
			const consumer = `${directory}/consumer`
			const homes = { XDG_CACHE_HOME: `${directory}/cache`, XDG_STATE_HOME: `${directory}/state` }
			yield* consumerIn(consumer, layout, library, [
				["package.json", manifestOf(layout)],
				["test.config.ts", CONFIG],
				["pg.config.ts", clusterConfigOf(unit)],
				["test/short.test.ts", propertyOf(cases)]
			])
			const [settled, settleOut, settleErr] = yield* Effect.orDie(
				unitIn(consumer, homes, "pg/cli.ts", ["settle"])
			)
			if (settled !== 0) {
				return yield* Effect.die(
					`toolchain-pg settle exited ${String(settled)}: ${settleOut}${settleErr}`
				)
			}
			const [, stdout, stderr] = yield* Effect.orDie(
				unitIn(consumer, homes, "runner/cli-entry.ts", ["run"])
			)
			const recorded = yield* Effect.flatMap(
				fs.readFileString(`${directory}/cache/toolchain-test/runs/last.json`),
				Schema.decodeEffect(Recorded)
			)
			const spent = yield* Effect.flatMap(fs.readFileString(`${consumer}/spent.txt`), (text) =>
				Effect.forEach(
					Arr.filter(Str.split("\n")(text), (line) => line !== ""),
					(line) => Schema.decodeEffect(SpentLine)(line)
				)
			)
			return {
				backends: recorded.report.backends,
				metered: recorded.report.metered,
				budgetLines: budgetLinesOf(`${stdout}${stderr}`),
				spent
			}
		})
	)

/** The consumer's module that reads a backend's CPU off its /proc stat (its user and system ticks, at 100 a second), in ms. */
const CPU_MODULE = `import { readFileSync } from "node:fs"\n\nexport const cpuOf = (pid) => {\n\tconst stat = readFileSync(\`/proc/\${pid}/stat\`, "utf8")\n\tconst fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")\n\treturn (Number(fields[11]) + Number(fields[12])) * 10\n}\n`

/**
 * The heavy run's property, one case: it opens a backend of its own, names it in heavy-pid, counts forty million rows
 * on it, writes the backend's own CPU then to heavy-done, and keeps it open (a declared wait) until the light run has
 * written light-done, so the backend outlives every count of the light run's; each file written whole, then renamed
 * into place.
 */
const HEAVY_PROPERTY = `import { existsSync, renameSync, writeFileSync } from "node:fs"\nimport { Effect } from "effect"\nimport { finite, int } from "@bjornpagen/testing/gen"\nimport { liveSleep, waitingOn } from "@bjornpagen/testing/live"\nimport { pgOwnerSession } from "@bjornpagen/testing/pg-session"\nimport { property } from "@bjornpagen/testing/property"\nimport { Database, Template } from "@bjornpagen/testing/resources"\nimport { cpuOf } from "./cpu.ts"\n\nconst empty = Template.database({ declaredIn: import.meta, name: "heavy", content: {}, from: Template.cluster, budget: ${String(plantedBudget)}, build: () => Effect.void })\nconst written = (name, text) => { const path = new URL(\`../\${name}\`, import.meta.url); writeFileSync(\`\${path.pathname}.part\`, text); renameSync(\`\${path.pathname}.part\`, path) }\nconst until = (name) => waitingOn(\`the light run's \${name}\`)(Effect.gen(function* () { while (!existsSync(new URL(\`../\${name}\`, import.meta.url))) { yield* liveSleep("20 millis") } }))\n\nexport const heavy = property.exhaust(finite((source) => source.draw(int(1, 1))), {\n\tneeds: { db: Database.fresh(empty) },\n\tsituations: [],\n\tcheck: ({ db }) => () => Effect.scoped(Effect.gen(function* () {\n\t\tconst clone = yield* db\n\t\tconst session = yield* pgOwnerSession("heavy")(clone.member, clone.name)\n\t\tconst [[pid]] = yield* session.query("SELECT pg_catalog.pg_backend_pid()::text", [])\n\t\twritten("heavy-pid", pid)\n\t\tyield* session.query("SELECT count(*)::text FROM pg_catalog.generate_series(1, 40000000)", [])\n\t\twritten("heavy-done", String(cpuOf(pid)))\n\t\tyield* until("light-done")\n\t})),\n\toracle: { kind: "specification", name: "a backend of its own counts forty million rows" },\n\tkept: [],\n\tkills: []\n})\n`

/**
 * The light run's property, one case: it waits (a declared wait) until heavy-pid names the heavy run's backend, opens a
 * backend of its own, reads the heavy backend's CPU, waits until heavy-done states it at its end, and writes to
 * light-done its own backend's CPU and what the heavy backend spent while its own was open, one per line.
 */
const LIGHT_PROPERTY = `import { existsSync, readFileSync, writeFileSync } from "node:fs"\nimport { Effect } from "effect"\nimport { finite, int } from "@bjornpagen/testing/gen"\nimport { liveSleep, waitingOn } from "@bjornpagen/testing/live"\nimport { pgOwnerSession } from "@bjornpagen/testing/pg-session"\nimport { property } from "@bjornpagen/testing/property"\nimport { Database, Template } from "@bjornpagen/testing/resources"\nimport { cpuOf } from "./cpu.ts"\n\nconst empty = Template.database({ declaredIn: import.meta, name: "light", content: {}, from: Template.cluster, budget: ${String(plantedBudget)}, build: () => Effect.void })\nconst pathOf = (name) => new URL(\`../\${name}\`, import.meta.url).pathname\nconst until = (name) => waitingOn(\`the heavy run's \${name}\`)(Effect.gen(function* () { while (!existsSync(pathOf(name))) { yield* liveSleep("20 millis") } }))\n\nexport const light = property.exhaust(finite((source) => source.draw(int(1, 1))), {\n\tneeds: { db: Database.fresh(empty) },\n\tsituations: [],\n\tcheck: ({ db }) => () => Effect.scoped(Effect.gen(function* () {\n\t\tconst clone = yield* db\n\t\tyield* until("heavy-pid")\n\t\tconst heavy = readFileSync(pathOf("heavy-pid"), "utf8")\n\t\tconst session = yield* pgOwnerSession("light")(clone.member, clone.name)\n\t\tconst [[pid]] = yield* session.query("SELECT pg_catalog.pg_backend_pid()::text", [])\n\t\tconst before = cpuOf(heavy)\n\t\tyield* until("heavy-done")\n\t\tconst after = Number(readFileSync(pathOf("heavy-done"), "utf8"))\n\t\twriteFileSync(pathOf("light-done"), \`\${cpuOf(pid)}\\n\${after - before}\\n\`)\n\t})),\n\toracle: { kind: "specification", name: "a backend of its own lives while another run's works" },\n\tkept: [],\n\tkills: []\n})\n`

/** What the light run's case wrote: its backend's own CPU, and what the heavy one spent while its own lived (ms). */
const LightDone = Schema.Tuple([SpentLine, SpentLine])

/**
 * Writes the consumer, with a cluster of its own, under a case cluster's unit name removed at the scope's end, into
 * `directory` from the library at `library` (Checkout.dir, so a kill's mutant is in it), settles its family, and runs
 * `toolchain-test run` of its heavy and its light property at once, two runs on the family's one member, each with its
 * own cache home; answers each run's recorded backends' CPU and what the cases wrote: each backend's own CPU, and what
 * the heavy one spent while the light one's lived.
 */
export const runsAtOnce = (directory: string, library: string) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const unit = yield* caseUnit("tcs")
			yield* unitRemovedAtEnd(unit)
			const consumer = `${directory}/consumer`
			const state = { XDG_STATE_HOME: `${directory}/state` }
			yield* consumerIn(consumer, layout, library, [
				["package.json", manifestOf(layout)],
				["test.config.ts", CONFIG],
				["pg.config.ts", clusterConfigOf(unit)],
				["test/cpu.ts", CPU_MODULE],
				["test/heavy.test.ts", HEAVY_PROPERTY],
				["test/light.test.ts", LIGHT_PROPERTY]
			])
			const [settled, settleOut, settleErr] = yield* Effect.orDie(
				unitIn(consumer, { ...state, XDG_CACHE_HOME: `${directory}/cache` }, "pg/cli.ts", [
					"settle"
				])
			)
			if (settled !== 0) {
				return yield* Effect.die(
					`toolchain-pg settle exited ${String(settled)}: ${settleOut}${settleErr}`
				)
			}
			const runOf = (name: string) =>
				Effect.andThen(
					Effect.orDie(
						unitIn(
							consumer,
							{ ...state, XDG_CACHE_HOME: `${directory}/cache-${name}` },
							"runner/cli-entry.ts",
							["run", `test/${name}.test.ts`]
						)
					),
					Effect.flatMap(
						fs.readFileString(`${directory}/cache-${name}/toolchain-test/runs/last.json`),
						Schema.decodeEffect(Recorded)
					)
				)
			const [heavy, light] = yield* Effect.all([runOf("heavy"), runOf("light")], {
				concurrency: "unbounded"
			})
			const heavyOwn = yield* Effect.flatMap(fs.readFileString(`${consumer}/heavy-done`), (text) =>
				Schema.decodeEffect(SpentLine)(Str.trim(text))
			)
			const lightDone = yield* fs.readFileString(`${consumer}/light-done`)
			const [lightOwn, overlapped] = yield* Schema.decodeUnknownEffect(LightDone)(
				Str.split("\n")(Str.trim(lightDone))
			)
			return {
				heavy: heavy.report.backends,
				light: light.report.backends,
				wrote: { heavy: heavyOwn, light: lightOwn, overlapped }
			}
		})
	)
