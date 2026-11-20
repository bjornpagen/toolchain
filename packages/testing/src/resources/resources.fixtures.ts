import * as NodeServices from "@effect/platform-node/NodeServices"
import { Array as Arr, Brand, Context, Effect, Layer, Option, Ref, type Scope } from "effect"
import { ChildProcess } from "effect/process"
import { boolean, characterOf, type Gen, int, string } from "#gen.ts"
import testingCluster from "#pg.config.ts"
import { machineBin } from "#pg/make.fixtures.ts"
import { pgOwnerSession } from "#pg/session.ts"
import type { Need } from "#property.ts"
import {
	DatabasePrefix,
	PgCluster,
	type PgClusterSpec,
	quoteIdent,
	required,
	run,
	single,
	type DatabaseName,
	type TextRows
} from "#resources/cluster.ts"
import type { TemplateDatabase } from "#resources/database.ts"
import { type DatabaseTemplate, Template } from "#resources/template.ts"
import { ModuleClosure, type NeedFailed, RunLease, WorkerIndex } from "#runner/services.ts"

/** A database name the fixture read back from the cluster. */
const databaseNameOf = Brand.nominal<DatabaseName>()

/**
 * The cluster the library's own resource properties run against: the testing package's local cluster (its
 * pg.config.ts), which the layer makes and starts the first time a need reaches it, databases under `tc_`, every
 * session the owner's over node-postgres (pg/session.ts).
 */
const fixtureCluster: PgClusterSpec = {
	prefix: DatabasePrefix("tc_"),
	cluster: testingCluster,
	connect: pgOwnerSession("toolchain fixtures")
}

/** The fixture's runner services: the testing package's cluster; the runner gives the closure hashes. */
export const fixtureServices = PgCluster.layer(fixtureCluster)

/** The services a property about the resources themselves runs their internals under, from its worker's need context. */
export type Services = Context.Context<PgCluster | ModuleClosure | WorkerIndex>

/** A need giving each case its worker's services, so a check can open templates and pools itself. */
export const services: Need<Services> = {
	key: "@bjornpagen/testing/resources fixture services",
	open: Effect.map(
		Effect.gen(function* () {
			const cluster = yield* required(PgCluster, "the fixture's runner config provides it")
			const closures = yield* ModuleClosure
			const worker = yield* WorkerIndex
			return Context.make(PgCluster, cluster).pipe(
				Context.add(ModuleClosure, closures),
				Context.add(WorkerIndex, worker)
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
		build: building(["CREATE TABLE public.derived (value int4 NOT NULL)"])
	})

/** A template built from the marks template (derivedTemplate), of the case's own `token`. */
export const derivedMarksTemplate = (token: string) => derivedTemplate(marksTemplate, token)

/**
 * The statements of the seat template: items with an identity, which the seat's reset truncates, and a ledger it does
 * not, holding one seed row, and a sequence of its own advanced once.
 */
const seatSchema = [
	"CREATE TABLE public.items (id int8 GENERATED ALWAYS AS IDENTITY PRIMARY KEY, value int4 NOT NULL)",
	"CREATE TABLE public.ledger (entry text NOT NULL)",
	"INSERT INTO public.ledger VALUES ('seed')",
	"CREATE SEQUENCE public.tickets",
	"SELECT pg_catalog.nextval('public.tickets')"
] as const

/** A template a seat or a transaction case runs on. */
export const seatTemplate = Template.database({
	declaredIn: import.meta,
	name: "seat",
	content: { statements: seatSchema },
	from: Template.cluster,
	build: building(seatSchema)
})

/**
 * A template a seat runs on whose materialized view is created WITH NO DATA, so reading it fails until a REFRESH: items,
 * and their tally.
 */
export const unpopulatedViewTemplate = Template.database({
	declaredIn: import.meta,
	name: "unpopulated view",
	content: {
		statements: [
			"CREATE TABLE public.items (id int8 GENERATED ALWAYS AS IDENTITY PRIMARY KEY, value int4 NOT NULL)",
			"CREATE MATERIALIZED VIEW public.tallies AS SELECT pg_catalog.count(*) AS n FROM public.items WITH NO DATA"
		]
	},
	from: Template.cluster,
	build: building([
		"CREATE TABLE public.items (id int8 GENERATED ALWAYS AS IDENTITY PRIMARY KEY, value int4 NOT NULL)",
		"CREATE MATERIALIZED VIEW public.tallies AS SELECT pg_catalog.count(*) AS n FROM public.items WITH NO DATA"
	])
})

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
		build: building([])
	})

/** The seat's reset: the items, and their identity, as the template has them. */
export const seatReset = ["TRUNCATE public.items RESTART IDENTITY"] as const

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
		build
	})

/**
 * The run's lease as a case inside the run sees it: the run that runs the case already holds its reservation on the
 * fixture's cluster (runner/leases.ts), which covers the case's own connections, so a cluster a case builds for itself
 * reserves nothing more, and never waits on the slots its own run holds; its one worker is on the first member.
 */
const leasedByTheRun = Layer.succeed(
	RunLease,
	RunLease.of({ reserve: () => Effect.succeed(Arr.of(0)) })
)

/** The cluster of the fixture's members under a prefix of a case's own, so a case's collection sees only its own. */
export const ownCluster = (prefix: string): Layer.Layer<PgCluster> =>
	Layer.provide(
		PgCluster.layer({ ...fixtureCluster, prefix: DatabasePrefix(prefix) }),
		Layer.mergeAll(
			NodeServices.layer,
			leasedByTheRun,
			Layer.succeed(WorkerIndex, { index: 0, workers: 1 })
		)
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

/** This module's URL: a module whose closure differs from a test module's that imports it, so its hash is another. */
export const fixturesModule = import.meta.url

/**
 * `cluster` with every session its connect opens counted in `open` while it lives, so a property can see how many
 * sessions the resources hold between cases.
 */
export const countedConnections = (
	cluster: Context.Service.Shape<typeof PgCluster>,
	open: Ref.Ref<number>
): Context.Service.Shape<typeof PgCluster> => ({
	...cluster,
	connect: (member, database) =>
		Effect.andThen(
			Effect.acquireRelease(
				Ref.update(open, (n) => n + 1),
				() => Ref.update(open, (n) => n - 1)
			),
			cluster.connect(member, database)
		)
})

/**
 * A session of the member's bootstrap superuser in `database`, over the member's socket by peer authentication (psql,
 * its standard input held open), for the enclosing scope: a session the owner cannot end, which pg_signal_backend never
 * lets it terminate, so the owner's DROP DATABASE ... WITH (FORCE) of the database is refused while it lasts, as a drop
 * is refused when a session it signals has not left in time (an autovacuum worker under load).
 */
export const superuserSessionIn = (database: TemplateDatabase) =>
	Effect.gen(function* () {
		const bin = yield* machineBin
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
				"postgres",
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
				"SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_stat_activity WHERE datname = $1::name AND usename = 'postgres'",
				[database.name]
			)
			return Number(found)
		})
	)
