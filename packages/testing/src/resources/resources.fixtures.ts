import {
	Array as Arr,
	Brand,
	Config,
	Context,
	Effect,
	type Layer,
	Option,
	type Scope
} from "effect"
import pg from "pg"
import type { Need } from "#property.ts"
import {
	DatabasePrefix,
	PgCluster,
	type PgClusterSpec,
	type PgSession,
	quoteIdent,
	required,
	run,
	single,
	type DatabaseName,
	type TextRows
} from "#resources/cluster.ts"
import type { Database } from "#resources/database.ts"
import { Template } from "#resources/template.ts"
import { ModuleClosure, NeedFailed, WorkerIndex } from "#runner/services.ts"

/** A database name the fixture read back from the cluster. */
const databaseNameOf = Brand.nominal<DatabaseName>()

/** A failure of the fixture cluster's driver, as the need it failed. */
const failed = (cause: unknown): NeedFailed =>
	NeedFailed.make({
		need: "fixture cluster",
		message: Error.isError(cause) ? cause.message : String(cause)
	})

/**
 * A session over the pg driver, as the bootstrap superuser over the Unix socket libpq's environment names (PGHOST, a
 * socket directory, and PGPORT), in pg's pipeline mode: a statement sent while another runs follows it on the wire,
 * each its own exchange ending in a Sync, so concurrent callers take turns in the server, and each statement goes out
 * on the extended protocol with its rows positional.
 */
const connect = (database: string): Effect.Effect<PgSession, NeedFailed, Scope.Scope> =>
	Effect.map(
		Effect.acquireRelease(
			Effect.flatMap(
				Effect.sync(() => new pg.Client({ database, pipeline: true })),
				(client) =>
					Effect.tap(Effect.succeed(client), () =>
						Effect.tryPromise({ try: () => client.connect(), catch: failed })
					)
			),
			(client) => Effect.ignore(Effect.tryPromise({ try: () => client.end(), catch: failed }))
		),
		(client): PgSession => ({
			query: (sql, params) =>
				Effect.map(
					Effect.tryPromise({
						try: () =>
							client.query<Array<unknown>>({ text: sql, values: [...params], rowMode: "array" }),
						catch: failed
					}),
					(result) => result.rows
				)
		})
	)

/**
 * The cluster the library's own resource properties run against: one member, the PostgreSQL that libpq's environment
 * names (PGHOST and PGPORT, PGUSER a superuser), databases under `tc_`, templates built from template0, and the
 * owner's sessions in `postgres`.
 */
const fixtureCluster: PgClusterSpec = {
	prefix: DatabasePrefix("tc_"),
	members: Effect.gen(function* () {
		const host = yield* Config.String("PGHOST")
		const port = yield* Config.String("PGPORT")
		return [{ name: `${host}:${port}` }] as const
	}).pipe(
		Effect.mapError((error) =>
			NeedFailed.make({
				need: "fixture cluster",
				message: `the resource properties run against the PostgreSQL libpq's environment names: ${error.message}`
			})
		)
	),
	base: "template0",
	maintenance: "postgres",
	connect: (_member, database) => connect(database)
}

/** The fixture's runner services: the cluster libpq's environment names; the runner gives the closure hashes. */
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
	database: Database,
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
export const exists = (database: Database): Effect.Effect<boolean, NeedFailed, PgCluster> =>
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
export const dropTemplate = (database: Database): Effect.Effect<void, NeedFailed, PgCluster> =>
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
	(target: Database): Effect.Effect<void, NeedFailed, Scope.Scope> =>
		Effect.gen(function* () {
			const cluster = yield* required(PgCluster, "the fixture's runner config provides it")
			const session = yield* cluster.connect(target.member, target.name)
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

/** The seat's reset: the items, and their identity, as the template has them. */
export const seatReset = ["TRUNCATE public.items RESTART IDENTITY"] as const

/** A template of one table whose identity is `token`, unique to the case that declares it, built by `build`. */
export const tokenTemplate = (
	token: string,
	build: (target: Database) => Effect.Effect<void, NeedFailed, Scope.Scope>
) =>
	Template.database({
		declaredIn: import.meta,
		name: `token ${token}`,
		content: { token },
		from: Template.cluster,
		build
	})

/** The cluster of the fixture's members under a prefix of a case's own, so a case's collection sees only its own. */
export const ownCluster = (prefix: string): Layer.Layer<PgCluster> =>
	PgCluster.layer({ ...fixtureCluster, prefix: DatabasePrefix(prefix) })

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
