import { regex } from "arkregex"
import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	Record as Rec,
	type Scope,
	String as Str
} from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { element, finite } from "#gen.ts"
import { accountStatesOf, caseUnit, unitRemovedAtEnd } from "#pg/settle.fixtures.ts"
import { plantedBudget } from "#planted.fixtures.ts"
import {
	type ConsumerFiles,
	consumerIn,
	type Layout,
	manifestOf,
	ran
} from "#runner/consumer.fixtures.ts"

/**
 * What the reuse property (reuse.test.ts) runs: a consumer package holding the library as a workspace link, in a git
 * repository with its lockfile, so its verdicts are keyed, whose one property `toolchain-test run` runs twice, one input
 * of its verdict's key changed between the runs, or none, or one input that is no part of it; or whose property observes
 * past its key, which no run answers from the cache; or whose property clones a database template on a cluster of the
 * consumer's own, the template's build reading a file.
 */

/**
 * What changes between a case's two runs: nothing; a module the property imports; a file of the toolchain no module
 * imports; the value of a variable the runner config gives its workers; the value of a variable it does not, which the
 * property reads and must find unset; TEST_SEED, set for the second run; nothing, or the file, of a property that reads
 * a fixture file at run time, of one whose child process reads it, of one that resolves a path (realpath, whose own
 * walk of the path is no act of the property's) and of one that reads a symbolic link's text; another checkout of the
 * repository running it second, its property resolving the checkout's own root; nothing, of a property that reads a
 * file's status, which no key holds; and nothing, or the file, of a property that clones a database template whose
 * build reads a file, the property reading nothing itself.
 */
const CHANGES = [
	"nothing",
	"a module it imports",
	"a file of the toolchain",
	"a variable its workers are given",
	"a variable its workers are not given",
	"TEST_SEED",
	"nothing, a file read at run time",
	"a file it reads at run time",
	"nothing, a file its child process reads",
	"a file its child process reads",
	"nothing, a path resolved at run time",
	"a path it resolves at run time",
	"nothing, a link read at run time",
	"a link it reads at run time",
	"another checkout of it, its root resolved at run time",
	"nothing, a file's status read at run time",
	"nothing, a file its template's build reads",
	"a file its template's build reads"
] as const

export type Change = (typeof CHANGES)[number]

/** Every case: each change. */
export const changes = finite((source): Change => source.draw(element(CHANGES)))

/** The consumer's layout: the library linked, in a git repository with its lockfile and TypeScript, so it is keyed. */
const layout: Layout = { library: "link", git: true, lockfile: true, typescript: true }

/** The variable the consumer's runner config gives its workers, and one it does not. */
const GIVEN = "TOOLCHAIN_REUSE_GIVEN"

const UNGIVEN = "TOOLCHAIN_REUSE_UNGIVEN"

/** A check that observes nothing past its key, and finds the variable no worker is given unset. */
const PLAIN_CHECK = `() => (a) => (process.env["${UNGIVEN}"] === undefined && a + shared >= 0 ? Effect.void : Effect.die("a variable no worker is given reached one"))`

/** A check that reads a fixture file at run time, which its trace keys. */
const READS = `() => (a) => (readFileSync(new URL("./data.txt", import.meta.url), "utf8").length + a >= 0 ? Effect.void : Effect.die("never"))`

/** A check whose child process reads a fixture file, which the child's trace keys. */
const CHILD_READS = `() => (a) => (spawnSync("cat", [new URL("./data.txt", import.meta.url).pathname]).status === 0 && a >= 0 ? Effect.void : Effect.die("cat failed"))`

/**
 * A check that resolves `path` (from the property's module) at run time through realpath's callback form, which walks
 * the path with lstat, stat and readlink.
 */
const resolving = (path: string): string =>
	`() => (a) => Effect.asVoid(Effect.promise(() => new Promise((answer) => realpath(new URL("${path}", import.meta.url).pathname, (failure, to) => answer([failure, to, a])))))`

/** A check that resolves the link the link-reading check reads (POINTER). */
const RESOLVES = resolving("./pointer")

/** A check that resolves its checkout's root, which every checkout of the repository resolves alike. */
const RESOLVES_ROOT = resolving("..")

/** A check that reads a symbolic link's text at run time, the link pointing at a file in both runs. */
const READS_LINK = `() => (a) => (readlinkSync(new URL("./pointer", import.meta.url)).length + a >= 0 ? Effect.void : Effect.die("never"))`

/** A check that reads a file's status at run time, which no key holds (its times, its inode). */
const STATUS = `() => (a) => (statSync(new URL("./data.txt", import.meta.url)).size + a >= 0 ? Effect.void : Effect.die("never"))`

/** Both runs' variables: the given one's and the ungiven one's first values. */
const FIRST: Readonly<Record<string, string>> = { [GIVEN]: "first", [UNGIVEN]: "first" }

/** What a case writes in the consumer, by a path from its root: a file's text, or a symbolic link to a target. */
type Write =
	| Readonly<{ kind: "file"; path: string; text: string }>
	| Readonly<{ kind: "link"; path: string; to: string }>

/**
 * The consumer's property: one whose check is a check's text (what it observes at run time), needing nothing; or one
 * that clones a database template of the consumer's own cluster (DATABASE_PROPERTY).
 */
type ConsumerProperty = Readonly<{ kind: "check"; check: string }> | Readonly<{ kind: "database" }>

/**
 * What a change is: the consumer's property, what is written before the first run and between the runs, the second
 * run's variables, and the checkout the second run runs in: the first run's, or another of the same repository, written
 * alike.
 */
type Making = Readonly<{
	property: ConsumerProperty
	first: ReadonlyArray<Write>
	between: ReadonlyArray<Write>
	second: Readonly<Record<string, string>>
	checkout: "same" | "another"
}>

/** A change whose check is `check`, `between` written between its runs, `second` the second run's variables. */
const making = (
	check: string,
	between: ReadonlyArray<Write>,
	second: Readonly<Record<string, string>>
): Making => ({ property: { kind: "check", check }, first: [], between, second, checkout: "same" })

/** A change of the property that clones a template whose build reads a file, `between` written between its runs. */
const databaseMaking = (between: ReadonlyArray<Write>): Making => ({
	property: { kind: "database" },
	first: [],
	between,
	second: FIRST,
	checkout: "same"
})

/** The remote every checkout of the consumer names, so its checkouts are one repository's and share its verdicts. */
const REMOTE = "https://consumer.invalid/consumer.git"

/** The link the link-reading check reads, written before its first run. */
const POINTER: Write = { kind: "link", path: "test/pointer", to: "data.txt" }

/** Each change as it is made. */
const MAKINGS: Readonly<Record<Change, Making>> = {
	nothing: making(PLAIN_CHECK, [], FIRST),
	"a module it imports": making(
		PLAIN_CHECK,
		[{ kind: "file", path: "test/shared.ts", text: "export const shared = 2\n" }],
		FIRST
	),
	"a file of the toolchain": making(
		PLAIN_CHECK,
		[{ kind: "file", path: "vendor/testing/src/unloaded.txt", text: "no module loads this\n" }],
		FIRST
	),
	"a variable its workers are given": making(PLAIN_CHECK, [], { ...FIRST, [GIVEN]: "second" }),
	"a variable its workers are not given": making(PLAIN_CHECK, [], {
		...FIRST,
		[UNGIVEN]: "second"
	}),
	TEST_SEED: making(PLAIN_CHECK, [], { ...FIRST, TEST_SEED: "7" }),
	"nothing, a file read at run time": making(READS, [], FIRST),
	"a file it reads at run time": making(
		READS,
		[{ kind: "file", path: "test/data.txt", text: "other data\n" }],
		FIRST
	),
	"nothing, a file its child process reads": making(CHILD_READS, [], FIRST),
	"a file its child process reads": making(
		CHILD_READS,
		[{ kind: "file", path: "test/data.txt", text: "other data\n" }],
		FIRST
	),
	"nothing, a path resolved at run time": { ...making(RESOLVES, [], FIRST), first: [POINTER] },
	"a path it resolves at run time": {
		...making(RESOLVES, [{ kind: "link", path: "test/pointer", to: "shared.ts" }], FIRST),
		first: [POINTER]
	},
	"nothing, a link read at run time": { ...making(READS_LINK, [], FIRST), first: [POINTER] },
	"a link it reads at run time": {
		...making(READS_LINK, [{ kind: "link", path: "test/pointer", to: "shared.ts" }], FIRST),
		first: [POINTER]
	},
	"another checkout of it, its root resolved at run time": {
		...making(RESOLVES_ROOT, [], FIRST),
		checkout: "another"
	},
	"nothing, a file's status read at run time": making(STATUS, [], FIRST),
	"nothing, a file its template's build reads": databaseMaking([]),
	"a file its template's build reads": databaseMaking([
		{ kind: "file", path: "test/schema.sql", text: "CREATE TABLE other ()\n" }
	])
}

/** Writes `write` in the consumer at `consumer`, a link replacing whatever its path held. */
const written = (consumer: string, write: Write) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = `${consumer}/${write.path}`
		switch (write.kind) {
			case "file":
				return yield* fs.writeFileString(path, write.text)
			case "link":
				yield* fs.remove(path, { force: true })
				return yield* fs.symlink(write.to, path)
		}
	})

/**
 * The consumer's cluster of its own, under the case cluster's unit name `unit` (pg/settle.fixtures.ts caseUnit): one
 * member, in memory (the workbench's memory list names `tcs-*`), reached over its socket alone, so it claims no port.
 */
const clusterConfigOf = (unit: string): string =>
	`import { localCluster } from "@bjornpagen/testing/pg"\n\nexport default localCluster({ unit: "${unit}", network: { kind: "socket" }, owner: "toolchain_reuse", template: "toolchain_reuse_template", extensions: [], preload: [], ownerParameters: [], durability: "throwaway", sizing: { kind: "workers", family: { kind: "one" }, connections: { kind: "capacity", backendBytes: 37_301_248 }, replication: { kind: "default" }, sharedBuffers: { kind: "default" }, locks: { kind: "default" }, predicateLocks: { kind: "perBackend" } } })\n`

/**
 * The property that clones a template of the consumer's cluster whose build reads test/schema.sql, a file no module
 * loads, and queries its clone over a session of its own (the owner's, as the consumer's own code reaches its cluster),
 * no session of the runner's: a connection to one of the run's own members, which the guard keys by the PostgreSQL
 * serving it. The property reads nothing itself, so what its verdict rests on of the file is its template's build's.
 */
const DATABASE_PROPERTY = `import { readFileSync } from "node:fs"\nimport { Effect } from "effect"\nimport { int } from "@bjornpagen/testing/gen"\nimport { pgOwnerSession } from "@bjornpagen/testing/pg-session"\nimport { property } from "@bjornpagen/testing/property"\nimport { Database, Template } from "@bjornpagen/testing/resources"\n\nconst schema = Template.database({ declaredIn: import.meta, name: "schema", content: {}, from: Template.cluster, budget: ${String(plantedBudget)}, build: () => Effect.sync(() => readFileSync(new URL("./schema.sql", import.meta.url), "utf8")) })\n\nexport const reused = property.explore(int(0, 9), {\n\tneeds: { db: Database.fresh(schema) },\n\tsituations: [],\n\tcheck: ({ db }) => (a) => Effect.scoped(Effect.gen(function* () {\n\t\tconst clone = yield* db\n\t\tconst session = yield* pgOwnerSession("reused")(clone.member, clone.name)\n\t\tconst rows = yield* session.query("SELECT $1::int4 + 0", [String(a)])\n\t\treturn rows.length === 1 ? undefined : yield* Effect.die("not one row")\n\t})),\n\toracle: { kind: "specification", name: "a clone answers a query of its own" },\n\tkept: [],\n\tkills: []\n})\n`

/** The runner config of a consumer whose property needs nothing: its include, and GIVEN given its workers. */
const PLAIN_CONFIG = `import { defineRunner, noMutation } from "@bjornpagen/testing/runner"\nimport { Layer } from "effect"\n\nexport default defineRunner({ include: ["test/*.test.ts"], smallStack: [], conditions: [], environment: ["${GIVEN}"], layer: Layer.empty, mutation: noMutation })\n`

/** The runner config of a consumer with a cluster of its own (pg.config.ts): its databases under `r_`. */
const DATABASE_CONFIG = `import { defineRunner, noMutation } from "@bjornpagen/testing/runner"\nimport { pgOwnerSession, pgSuperuserSession } from "@bjornpagen/testing/pg-session"\nimport { DatabasePrefix, PgCluster } from "@bjornpagen/testing/resources"\nimport cluster from "./pg.config.ts"\n\nexport default defineRunner({ include: ["test/*.test.ts"], smallStack: [], conditions: [], environment: ["${GIVEN}"], layer: PgCluster.layer({ prefix: DatabasePrefix("r_"), cluster, connect: pgOwnerSession("reuse"), superuser: pgSuperuserSession("reuse superuser") }), mutation: noMutation })\n`

/**
 * What the consumer's property needs before its first run, in the consumer at `consumer` with the case's variables
 * `env`: nothing, or its cluster's family settled (`toolchain-pg settle`, at the runs' width, as unitIn runs it), since
 * a run reads its family's state and settles only its own member.
 */
type Before = (
	consumer: string,
	env: Readonly<Record<string, string>>
) => Effect.Effect<void, string, ChildProcessSpawner.ChildProcessSpawner>

/**
 * The files of the consumer's property and what it runs under, and what it needs before its first run (Before): a
 * check's property and the plain runner config, needing nothing; or the database property (DATABASE_PROPERTY), the
 * runner config over a cluster of the consumer's own and its pg.config.ts, under a case cluster's unit name held for the
 * case (pg/settle.fixtures.ts caseUnit) and removed at its end, since the consumer's runs make it in processes of their
 * own, its family settled first.
 */
/**
 * The consumer's property as a case writes and runs it: its files, what it needs before its first run (Before), and what
 * its cluster left in the account's states home once its runs ended (Reused's `left`).
 */
type Consumer = Readonly<{
	files: ConsumerFiles
	before: Before
	left: Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem>
}>

const propertyFilesOf = (
	property: ConsumerProperty
): Effect.Effect<
	Consumer,
	never,
	FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> => {
	switch (property.kind) {
		case "check":
			return Effect.succeed<Consumer>({
				files: [
					["test.config.ts", PLAIN_CONFIG],
					[
						"test/reused.test.ts",
						`import { readFileSync, readlinkSync, realpath, statSync } from "node:fs"\nimport { spawnSync } from "node:child_process"\nimport { Effect } from "effect"\nimport { int } from "@bjornpagen/testing/gen"\nimport { property } from "@bjornpagen/testing/property"\nimport { shared } from "./shared.ts"\n\nexport const reused = property.explore(int(0, 9), {\n\tneeds: {},\n\tsituations: [],\n\tcheck: ${property.check},\n\toracle: { kind: "specification", name: "never fails" },\n\tkept: [],\n\tkills: []\n})\n`
					]
				],
				before: () => Effect.void,
				left: Effect.succeed([])
			})
		case "database":
			return Effect.gen(function* () {
				const unit = yield* caseUnit("tcs")
				yield* unitRemovedAtEnd(unit)
				const files: ConsumerFiles = [
					["test.config.ts", DATABASE_CONFIG],
					["test/reused.test.ts", DATABASE_PROPERTY],
					["pg.config.ts", clusterConfigOf(unit)]
				]
				const before: Before = (consumer, env) =>
					Effect.flatMap(
						Effect.orDie(unitIn(consumer, env, "pg/cli.ts", ["settle"])),
						([exitCode, stdout, stderr]) =>
							exitCode === 0
								? Effect.void
								: Effect.fail(`toolchain-pg settle exited ${String(exitCode)}: ${stdout}${stderr}`)
					)
				return { files, before, left: accountStatesOf(unit) }
			})
	}
}

/**
 * The consumer's files: its manifest, the module its property imports, a fixture, the file a template's build reads,
 * and its property's (propertyFilesOf).
 */
const filesOf = (property: ConsumerProperty) =>
	Effect.map(propertyFilesOf(property), (own): Consumer => ({
		files: [
			["package.json", manifestOf(layout)],
			["test/shared.ts", "export const shared = 1\n"],
			["test/data.txt", "data\n"],
			["test/schema.sql", "CREATE TABLE one ()\n"],
			...own.files
		],
		before: own.before,
		left: own.left
	}))

/**
 * How a run went, as the check compares it: whether it passed, how many properties it answered cached and ran, and
 * what the case's cluster left in the account's states home (pg/settle.fixtures.ts accountStatesOf) once both runs
 * ended: none, since every settle of a family keeps its state in the family's own states home, the case's.
 */
export type Reused = Readonly<{
	passed: boolean
	cached: number
	ran: number
	left: ReadonlyArray<string>
}>

/** The summary line a run ends on: `<n> properties: <c> cached, <r> run (...)`. */
const SUMMARY = regex("([0-9]+) properties: ([0-9]+) cached, ([0-9]+) run")

/**
 * The library's entry `entry` run with `args` in the consumer at `directory`, git looking no higher, its CPU allowance
 * two CPUs (one worker), and the variables `env` names added (the case's cache and states homes among them, so its
 * verdicts and its cluster's family state are the case's own): its exit code and what it printed. It runs as a transient
 * unit of systemd's (`systemd-run --user --wait --pipe`), no descendant of this process, so the guard of the worker that
 * runs this case (runner/observe.ts) traces none of it, and the consumer's own workers trace their children as a lane's
 * do: a process has one tracer.
 */
const unitIn = (
	directory: string,
	env: Readonly<Record<string, string>>,
	entry: string,
	args: ReadonlyArray<string>
) =>
	ran(
		directory,
		"systemd-run",
		[
			"--user",
			"--quiet",
			"--wait",
			"--pipe",
			"--collect",
			`--working-directory=${directory}`,
			...Arr.flatMap(
				Rec.toEntries({
					...env,
					GIT_CEILING_DIRECTORIES: Arr.join(Arr.initNonEmpty(Str.split("/")(directory)), "/"),
					TOOLCHAIN_CPU_ALLOWANCE: "2"
				}),
				([name, value]) => ["-E", `${name}=${value}`]
			),
			"--",
			process.execPath,
			"--disable-warning=ExperimentalWarning",
			`vendor/testing/src/${entry}`,
			...args
		],
		{}
	)

/** `toolchain-test run` in the consumer at `directory` (unitIn): how it went (Reused), or none when it printed no summary. */
const runIn = (directory: string, env: Readonly<Record<string, string>>) =>
	Effect.map(unitIn(directory, env, "runner/cli-entry.ts", ["run"]), ([exitCode, stdout]) =>
		Option.map(Option.fromNullishOr(SUMMARY.exec(stdout)), (found) => ({
			passed: exitCode === 0,
			cached: Number(found[2]),
			ran: Number(found[3])
		}))
	)

/**
 * Writes the consumer for `change` into `directory` from the checkout whose testing package is at `library`
 * (Checkout.dir, so a kill's mutant is in it), runs `toolchain-test run` there, makes the change, and runs it again;
 * gives how the second run went.
 */
export const reusedOf = (directory: string, library: string, change: Change) =>
	Effect.scoped(
		Effect.gen(function* () {
			const homes = { XDG_CACHE_HOME: `${directory}/cache`, XDG_STATE_HOME: `${directory}/state` }
			const made = MAKINGS[change]
			const { files, before, left } = yield* filesOf(made.property)
			const checkoutAt = (consumer: string) =>
				Effect.gen(function* () {
					yield* consumerIn(consumer, layout, library, files)
					yield* ran(consumer, "git", ["remote", "add", "origin", REMOTE], {})
					yield* Effect.forEach(made.first, (write) => written(consumer, write), { discard: true })
					return consumer
				})
			const first = yield* checkoutAt(`${directory}/consumer`)
			yield* Effect.orDie(before(first, { ...homes, ...FIRST }))
			yield* runIn(first, { ...homes, ...FIRST })
			const second = made.checkout === "same" ? first : yield* checkoutAt(`${directory}/another`)
			yield* Effect.forEach(made.between, (write) => written(second, write), { discard: true })
			const outcome = yield* runIn(second, { ...homes, ...made.second })
			const leftThere = yield* left
			return Option.map(outcome, (run): Reused => ({ ...run, left: leftThere }))
		})
	)

/**
 * Whether the second run answers its one property from the cache, by the specification: exactly when nothing its key
 * or its trace holds changed (nothing, or a variable no worker is given, a file it, its child or its template's build
 * reads, a path it resolves or a link it reads unchanged, another checkout of the repository) and the property observes
 * nothing past both (a file's status).
 */
const ANSWERED: Readonly<Record<Change, boolean>> = {
	nothing: true,
	"a module it imports": false,
	"a file of the toolchain": false,
	"a variable its workers are given": false,
	"a variable its workers are not given": true,
	TEST_SEED: false,
	"nothing, a file read at run time": true,
	"a file it reads at run time": false,
	"nothing, a file its child process reads": true,
	"a file its child process reads": false,
	"nothing, a path resolved at run time": true,
	"a path it resolves at run time": false,
	"nothing, a link read at run time": true,
	"a link it reads at run time": false,
	"another checkout of it, its root resolved at run time": true,
	"nothing, a file's status read at run time": false,
	"nothing, a file its template's build reads": true,
	"a file its template's build reads": false
}

/** How the second run must go: it passes, and answers its property from the cache or runs it (ANSWERED). */
export const expectedOf = (change: Change): Option.Option<Reused> =>
	Option.some({
		passed: true,
		cached: ANSWERED[change] ? 1 : 0,
		ran: ANSWERED[change] ? 0 : 1,
		left: []
	})
