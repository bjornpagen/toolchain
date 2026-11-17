import { regex } from "arkregex"
import {
	Array as Arr,
	Brand,
	Config,
	Context,
	Effect,
	type Layer,
	Option,
	Ref,
	Result,
	type Scope,
	String as Str
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
import type { TemplateDatabase } from "#resources/database.ts"
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
 * A host libpq's environment may name for the fixture's cluster: one only this machine answers on, a Unix socket's
 * directory (an absolute path) or a loopback address (localhost, ::1, or an IPv4 address in 127.0.0.0/8). Parsed once
 * from PGHOST before anything connects, so no stray environment can point a property, or collection, at another
 * machine's server.
 */
export type LocalHost =
	| Readonly<{ kind: "socket"; directory: string }>
	| Readonly<{ kind: "loopback"; address: string }>

/** An IPv4 address in dotted decimal, its four octets captured. */
const dottedQuad = regex("^([0-9]{1,3})\\.([0-9]{1,3})\\.([0-9]{1,3})\\.([0-9]{1,3})$")

/**
 * Whether `host` is an IPv4 address in 127.0.0.0/8: four decimal octets, none above 255, the first 127.
 *
 * @formatConstant IPv4's dotted decimal: four octets of 0 to 255; 127.0.0.0/8 is loopback (RFC 1122, 3.2.1.3)
 */
const loopbackQuad = (host: string): boolean =>
	Option.exists(Option.fromNullishOr(dottedQuad.exec(host)), (match) => {
		const octets = Arr.map([match[1], match[2], match[3], match[4]], Number)
		return (
			octets[0] === 127 && Arr.every(octets, (octet) => Number.isInteger(octet) && octet <= 255)
		)
	})

/** The local host `host` names, or NeedFailed naming it when it names any other machine's server. */
export const localHostOf = (host: string): Result.Result<LocalHost, NeedFailed> => {
	if (Str.startsWith("/")(host)) {
		return Result.succeed({ kind: "socket", directory: host })
	}
	if (host === "localhost" || host === "::1" || loopbackQuad(host)) {
		return Result.succeed({ kind: "loopback", address: host })
	}
	return Result.fail(
		NeedFailed.make({
			need: "fixture cluster",
			message: `PGHOST names ${host === "" ? "no host" : host}, which is no Unix socket directory and no loopback address: the fixture's cluster is this machine's alone`
		})
	)
}

/** Where the fixture's cluster is, from libpq's environment: a local host, the port, and the role to log in as. */
type Target = Readonly<{ host: LocalHost; port: string; user: string }>

/**
 * The fixture's cluster as libpq's environment names it, read and refused (localHostOf) before every member's reading
 * and every connection.
 */
const target: Effect.Effect<Target, NeedFailed> = Effect.gen(function* () {
	const host = yield* Config.String("PGHOST")
	const port = yield* Config.String("PGPORT")
	const user = yield* Config.String("PGUSER")
	return { host, port, user }
}).pipe(
	Effect.mapError((error) =>
		NeedFailed.make({
			need: "fixture cluster",
			message: `the resource properties run against the PostgreSQL libpq's environment names (PGHOST, PGPORT, PGUSER): ${error.message}`
		})
	),
	Effect.flatMap(({ host, port, user }) =>
		Effect.map(Effect.fromResult(localHostOf(host)), (local) => ({ host: local, port, user }))
	)
)

/** The host a pg client connects to for a local host: the socket's directory or the loopback address. */
const hostText = (host: LocalHost): string =>
	host.kind === "socket" ? host.directory : host.address

/**
 * A session over the pg driver to the local host libpq's environment names (target), as its PGUSER, in pg's pipeline
 * mode: a statement sent while another runs follows it on the wire, each its own exchange ending in a Sync, so
 * concurrent callers take turns in the server, and each statement goes out on the extended protocol with its rows
 * positional. The host, port and role are given to the client from the parsed target, never left to the client's own
 * reading of the environment.
 */
const connect = (database: string): Effect.Effect<PgSession, NeedFailed, Scope.Scope> =>
	Effect.map(
		Effect.acquireRelease(
			Effect.flatMap(
				Effect.map(
					target,
					({ host, port, user }) =>
						new pg.Client({
							host: hostText(host),
							port: Number(port),
							user,
							database,
							pipeline: true
						})
				),
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
 * The cluster the library's own resource properties run against: one member, the PostgreSQL on this machine that libpq's
 * environment names (PGHOST, a socket directory or a loopback address, refused otherwise; PGPORT; PGUSER, a superuser),
 * databases under `tc_`, templates built from template0, and the owner's sessions in `postgres`.
 */
const fixtureCluster: PgClusterSpec = {
	prefix: DatabasePrefix("tc_"),
	members: Effect.map(target, ({ host, port }) => [{ name: `${hostText(host)}:${port}` }] as const),
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
 * A template built from the marks template (its origin, not the cluster's base), whose identity is `token`, unique to
 * the case that declares it, so the case builds it: one table more, and nothing of the settings or privileges its
 * origin's build gave its database, which it must keep.
 */
export const derivedMarksTemplate = (token: string) =>
	Template.database({
		declaredIn: import.meta,
		name: `derived marks ${token}`,
		content: { token },
		from: marksTemplate,
		build: building(["CREATE TABLE public.derived (value int4 NOT NULL)"])
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
	build: (target: TemplateDatabase) => Effect.Effect<void, NeedFailed, Scope.Scope>
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
