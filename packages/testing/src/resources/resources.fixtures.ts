import * as NodeServices from "@effect/platform-node/NodeServices"
import { Array as Arr, Brand, Context, Effect, Layer, Option, type Scope } from "effect"
import { ChildProcess } from "effect/process"
import pg from "pg"
import { boolean, characterOf, type Gen, int, string } from "#gen.ts"
import testingCluster from "#pg.config.ts"
import { bootstrapSuperuser, serverBin } from "#pg/server.ts"
import { pgOwnerSession, pgSuperuserSession } from "#pg/session.ts"
import { templateClaimsTable } from "#pg/settle.ts"
import { plantedBudget } from "#planted.fixtures.ts"
import type { Need } from "#property.ts"
import {
	DatabasePrefix,
	PgCluster,
	type PgClusterSpec,
	type PgMember,
	quoteIdent,
	required,
	run,
	single,
	type DatabaseName,
	type TextRows
} from "#resources/cluster.ts"
import type { TemplateDatabase } from "#resources/database.ts"
import { type DatabaseTemplate, Template } from "#resources/template.ts"
import { unwatched } from "#runner/observe.ts"
import { ModuleClosure, NeedFailed, RunValues, WorkerIndex } from "#runner/services.ts"

/** A database name the fixture read back from the cluster. */
const databaseNameOf = Brand.nominal<DatabaseName>()

/**
 * The cluster the library's own resource properties run against: the testing package's local cluster (its
 * pg.config.ts), which the layer makes and starts the first time a need reaches it, databases under `tc_`, every
 * session the owner's or the bootstrap superuser's over node-postgres (pg/session.ts).
 */
const fixtureCluster: PgClusterSpec = {
	prefix: DatabasePrefix("tc_"),
	cluster: testingCluster,
	connect: pgOwnerSession("toolchain fixtures"),
	superuser: pgSuperuserSession("toolchain fixtures superuser")
}

/** The fixture's runner services: the testing package's cluster; the runner gives the closure hashes. */
export const fixtureServices = PgCluster.layer(fixtureCluster)

/** The services a property about the resources themselves runs their internals under, from its worker's need context. */
export type Services = Context.Context<PgCluster | ModuleClosure | WorkerIndex | RunValues>

/** A need giving each case its worker's services, so a check can open templates and pools itself. */
export const services: Need<Services> = {
	key: "@bjornpagen/testing/resources fixture services",
	budget: plantedBudget,
	runNeeds: [],
	open: Effect.map(
		Effect.gen(function* () {
			const cluster = yield* required(PgCluster, "the fixture's runner config provides it")
			const closures = yield* ModuleClosure
			const worker = yield* WorkerIndex
			const runs = yield* RunValues
			return Context.make(PgCluster, cluster).pipe(
				Context.add(ModuleClosure, closures),
				Context.add(WorkerIndex, worker),
				Context.add(RunValues, runs)
			)
		}),
		Effect.succeed
	)
}

/** One statement as the cluster's owner in `database` on the worker's member, its rows as text. */
export const inDatabase = (
	database: TemplateDatabase,
	sql: string,
	params: ReadonlyArray<string>
): Effect.Effect<TextRows, NeedFailed, PgCluster> =>
	Effect.scoped(
		Effect.gen(function* () {
			const cluster = yield* PgCluster
			const session = yield* cluster.connect(database.member, database.name)
			return yield* run(session, sql, params)
		})
	)

/** Whether a database of `name` exists on the worker's member, as the owner's database sees it. */
export const exists = (database: TemplateDatabase): Effect.Effect<boolean, NeedFailed, PgCluster> =>
	Effect.scoped(
		Effect.gen(function* () {
			const cluster = yield* PgCluster
			const session = yield* cluster.connect(database.member, cluster.maintenance)
			const found = yield* single(
				session,
				"SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_database WHERE datname = $1::name",
				[database.name]
			)
			return found === "1"
		})
	)

/**
 * A session of the bootstrap superuser in `database` on `member` over its socket that is no declared wait of this
 * process (a node-postgres client of the fixture's own, outside pg/session.ts): what it runs stands for another
 * process's work, of which this process's guard knows nothing. Each statement runs to its answer, or fails with what the
 * server said; the session ends with the scope.
 */
export const undeclaredSession = (
	member: PgMember,
	database: string
): Effect.Effect<(sql: string) => Effect.Effect<void, string>, never, Scope.Scope> =>
	Effect.map(
		Effect.acquireRelease(
			Effect.tap(
				Effect.sync(
					() =>
						new pg.Client({
							host: member.socket,
							port: member.port,
							user: bootstrapSuperuser(),
							database,
							application_name: "toolchain undeclared session"
						})
				),
				(client) => Effect.promise(() => client.connect())
			),
			(client) => Effect.promise(() => client.end())
		),
		(client) => (sql: string) =>
			Effect.asVoid(
				Effect.tryPromise({
					try: () => client.query(sql),
					catch: (cause) => (Error.isError(cause) ? cause.message : String(cause))
				})
			)
	)

/**
 * Drops every claim of the templates under `prefix` on `member` (pg/settle.ts templateClaimsTable), as collection drops
 * the claims of a checkout that no longer exists: a case's templates are then kept by their use alone, or dropped.
 */
export const claimsGone = (
	member: PgMember,
	prefix: string
): Effect.Effect<void, NeedFailed, PgCluster> =>
	Effect.scoped(
		Effect.gen(function* () {
			const cluster = yield* PgCluster
			const session = yield* cluster.connect(member, cluster.maintenance)
			yield* run(
				session,
				`DELETE FROM public.${templateClaimsTable} WHERE pg_catalog.starts_with(template, $1)`,
				[`${prefix}tpl_`]
			)
		})
	)

/**
 * `template` (a database name) claimed on `member` by `checkout` alone, as a run of that checkout claims what it opens:
 * every other claim of it dropped, its own made.
 */
export const claimedBy = (
	member: PgMember,
	template: string,
	checkout: string
): Effect.Effect<void, NeedFailed, PgCluster> =>
	Effect.scoped(
		Effect.gen(function* () {
			const cluster = yield* PgCluster
			const session = yield* cluster.connect(member, cluster.maintenance)
			yield* run(session, `DELETE FROM public.${templateClaimsTable} WHERE template = $1`, [
				template
			])
			yield* run(
				session,
				`INSERT INTO public.${templateClaimsTable} (template, checkout, runner, logical) VALUES ($1, $2, '.', 'a checkout of its own')`,
				[template, checkout]
			)
		})
	)

/** Drops a template the properties built for one case, as collection would: no longer a template, then gone. */
export const dropTemplate = (
	database: TemplateDatabase
): Effect.Effect<void, NeedFailed, PgCluster> =>
	Effect.scoped(
		Effect.gen(function* () {
			const cluster = yield* PgCluster
			const session = yield* cluster.connect(database.member, cluster.maintenance)
			yield* run(session, `ALTER DATABASE ${quoteIdent(database.name)} IS_TEMPLATE false`, [])
			yield* run(session, `DROP DATABASE IF EXISTS ${quoteIdent(database.name)} WITH (FORCE)`, [])
		})
	)

/** Runs `statements` in the template being built, as the cluster's owner, one after another. */
const building =
	(statements: ReadonlyArray<string>) =>
	(built: TemplateDatabase): Effect.Effect<void, NeedFailed, Scope.Scope> =>
		Effect.gen(function* () {
			const cluster = yield* required(PgCluster, "the fixture's runner config provides it")
			const session = yield* cluster.connect(built.member, built.name)
			yield* Effect.forEach(statements, (statement) => run(session, statement, []), {
				discard: true
			})
		})

/**
 * The statements of the marks template: a table of tokens and values holding one seed row, and what CREATE DATABASE
 * does not copy, so every clone must get it again: the database's own settings (one a list of names, written as stored)
 * and privileges (TEMPORARY taken from PUBLIC and given to pg_monitor).
 */
const marksSchema = [
	"CREATE TABLE public.marks (token text NOT NULL, value int4 NOT NULL)",
	"INSERT INTO public.marks VALUES ('seed', 0)",
	"DO $$ BEGIN EXECUTE pg_catalog.format('ALTER DATABASE %I SET default_transaction_isolation = %L', pg_catalog.current_database(), 'serializable'); END $$",
	"DO $$ BEGIN EXECUTE pg_catalog.format('ALTER DATABASE %I SET search_path = \"$user\", public, pg_catalog', pg_catalog.current_database()); END $$",
	"DO $$ BEGIN EXECUTE pg_catalog.format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', pg_catalog.current_database()); END $$",
	"DO $$ BEGIN EXECUTE pg_catalog.format('GRANT TEMPORARY ON DATABASE %I TO pg_monitor', pg_catalog.current_database()); END $$"
] as const

/** A template whose clones each hold one seed mark: what a fresh clone must hold, and nothing a case before wrote. */
export const marksTemplate = Template.database({
	declaredIn: import.meta,
	name: "marks",
	content: { statements: marksSchema },
	from: Template.cluster,
	budget: plantedBudget,
	build: building(marksSchema)
})

/**
 * A template built from `origin` (not the cluster's base), whose identity is `token`, unique to the case that declares
 * it, so the case builds it: one table more, and nothing of the settings or privileges its origin's build gave its
 * database, which it must keep.
 */
export const derivedTemplate = (origin: DatabaseTemplate, token: string) =>
	Template.database({
		declaredIn: import.meta,
		name: `derived ${token}`,
		content: { token },
		from: origin,
		budget: plantedBudget,
		build: building(["CREATE TABLE public.derived (value int4 NOT NULL)"])
	})

/** A template built from the marks template (derivedTemplate), of the case's own `token`. */
export const derivedMarksTemplate = (token: string) => derivedTemplate(marksTemplate, token)

/**
 * A case of the fresh-locale property: a locale the member has (the `pick`-th, modulo their count, of its libc
 * collations of a UTF-8 codeset) or a name no system has (`zz` letters, a territory and a UTF-8 codeset), and two texts
 * of letters in both cases, a hyphen, a space and an accented letter, which a locale may order unlike their code points.
 */
export type LocaleCase = Readonly<{
	known: boolean
	pick: number
	unknown: string
	left: string
	right: string
}>

const localeText = string(characterOf(["a", "A", "b", "B", "-", " ", "é"]), { min: 0, max: 4 })

/** The cases of the fresh-locale property (LocaleCase). */
export const localeCases: Gen<LocaleCase> = (source) => ({
	known: boolean(source),
	pick: int(0, 999)(source),
	unknown: `zz${string(characterOf(["q", "x", "z"]), { min: 1, max: 3 })(source)}_ZZ.UTF-8`,
	left: localeText(source),
	right: localeText(source)
})

/** The member's libc collations of a UTF-8 codeset, each its name and its locale, in locale order. */
export const UTF8_COLLATIONS =
	"SELECT c.collname::text, c.collcollate FROM pg_catalog.pg_collation AS c WHERE c.collprovider = 'c' AND c.collcollate ~* 'utf-?8$' ORDER BY c.collcollate, c.collname"

/** A template of nothing built from template0 in `locale`, whose identity is `token`, unique to the case that declares it. */
export const freshTemplate = (locale: string, token: string) =>
	Template.database({
		declaredIn: import.meta,
		name: `fresh ${token}`,
		content: { token },
		from: Template.fresh(locale),
		budget: plantedBudget,
		build: building([])
	})

/** A template of one table whose identity is `token`, unique to the case that declares it, built by `build`. */
export const tokenTemplate = (
	token: string,
	build: (target: TemplateDatabase) => Effect.Effect<void, NeedFailed, Scope.Scope>
) =>
	Template.database({
		declaredIn: import.meta,
		name: `token ${token}`,
		content: { token },
		from: Template.cluster,
		budget: plantedBudget,
		build
	})

/** The cluster of the fixture's members under a prefix of a case's own, so a case's collection sees only its own. */
export const ownCluster = (prefix: string): Layer.Layer<PgCluster> =>
	Layer.provide(
		PgCluster.layer({ ...fixtureCluster, prefix: DatabasePrefix(prefix) }),
		Layer.mergeAll(NodeServices.layer, Layer.succeed(WorkerIndex, { index: 0, workers: 1 }))
	)

/** The runs a list of takers forms: each taker alone, but consecutive takers marked together run at once. */
export const runsOf = (together: ReadonlyArray<boolean>): ReadonlyArray<ReadonlyArray<boolean>> => {
	const none: ReadonlyArray<ReadonlyArray<boolean>> = []
	return Arr.reduce(together, none, (runs, at) => {
		const last = Arr.last(runs)
		return at && Option.exists(last, (group) => Arr.every(group, (b) => b))
			? [...Arr.dropRight(runs, 1), [...Option.getOrElse(last, () => []), at]]
			: [...runs, [at]]
	})
}

/** The name of a template a property found by its comment, as the fixture drops it. */
export const templateNameOf = databaseNameOf

/**
 * `script` (an ES module's text) run with `args` by a Node process of its own that no guard watches (runner/observe.ts
 * unwatched: Node's spawn as it was before the guard wrapped it), its work on `path`. What another process wrote is no
 * data of the reader's own, so a template's build that reads it makes a keyable read (runner/observe.ts), as a build
 * reads a repository's file; what the case's own process wrote is its own data, which no key holds.
 */
const ranElsewhere = (
	script: string,
	args: ReadonlyArray<string>,
	path: string
): Effect.Effect<void, NeedFailed> =>
	Effect.callback<void, NeedFailed>((resume) => {
		const child = unwatched.spawn(process.execPath, ["--input-type=module", "-e", script, ...args], {
			stdio: "ignore"
		})
		child.once("error", (failure) =>
			resume(Effect.fail(NeedFailed.make({ need: path, message: failure.message })))
		)
		child.once("exit", (code) =>
			resume(
				code === 0
					? Effect.void
					: Effect.fail(NeedFailed.make({ need: path, message: `its writer exited ${String(code)}` }))
			)
		)
	})

/** `text` written at `file` by a process of its own (ranElsewhere), its directory made. */
export const writtenElsewhere = (file: string, text: string) =>
	ranElsewhere(
		'import { mkdirSync, writeFileSync } from "node:fs"; import { dirname } from "node:path"; const [file, text] = process.argv.slice(1); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text)',
		[file, text],
		file
	)

/** `path` and everything under it removed by a process of its own (ranElsewhere). */
export const removedElsewhere = (path: string) =>
	ranElsewhere(
		'import { rmSync } from "node:fs"; rmSync(process.argv[1], { recursive: true, force: true })',
		[path],
		path
	)

/** This module's URL: a module whose closure differs from a test module's that imports it, so its hash is another. */
export const fixturesModule = import.meta.url

/**
 * A session of the member's bootstrap superuser (the account) in `database`, over the member's socket (psql, its
 * standard input held open), for the enclosing scope: a session the owner cannot end, which pg_signal_backend never
 * lets it terminate, so the owner's DROP DATABASE of the database is refused while it lasts, the collection's WITH
 * (FORCE) too, as a drop is refused when a session it waits for has not left in time (an autovacuum worker under load).
 */
export const superuserSessionIn = (database: TemplateDatabase) =>
	Effect.gen(function* () {
		const bin = yield* Effect.mapError(
			serverBin({ cluster: database.member.name, doing: "a superuser's session" }),
			(failure) => NeedFailed.make({ need: "pg", message: failure.message })
		)
		yield* ChildProcess.make(
			`${bin}/psql`,
			[
				"-X",
				"-q",
				"-h",
				database.member.socket,
				"-p",
				`${database.member.port}`,
				"-U",
				bootstrapSuperuser(),
				"-d",
				database.name
			],
			{ stdin: "pipe", stdout: "ignore", stderr: "ignore" }
		)
	})

/** How many sessions of the bootstrap superuser are in `database` now. */
export const superuserSessions = (
	database: TemplateDatabase
): Effect.Effect<number, NeedFailed, PgCluster> =>
	Effect.scoped(
		Effect.gen(function* () {
			const cluster = yield* PgCluster
			const session = yield* cluster.connect(database.member, cluster.maintenance)
			const found = yield* single(
				session,
				"SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_stat_activity WHERE datname = $1::name AND usename = $2::name",
				[database.name, bootstrapSuperuser()]
			)
			return Number(found)
		})
	)

/**
 * Twelve hex digits the server draws, a random UUID's first twelve, every one of them random: a name no other run
 * takes.
 */
export const freshHex =
	"SELECT pg_catalog.substr(pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', ''), 1, 12)"
