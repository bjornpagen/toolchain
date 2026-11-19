import { regex } from "arkregex"
import {
	Array as Arr,
	Brand,
	Context,
	Deferred,
	Effect,
	Layer,
	Option,
	Predicate,
	Ref,
	Scope,
	String as Str
} from "effect"
import { reservationOf } from "#pg/lease.ts"
import { clusterUp, type PgMember, type Platform } from "#pg/make.ts"
import type { LocalCluster } from "#pg/spec.ts"
import { NeedFailed, RunLease, WorkerIndex } from "#runner/services.ts"

export type { PgMember } from "#pg/make.ts"

/**
 * A session on one member as the cluster's owner role (the role that may CREATE DATABASE and owns what it creates),
 * which the repository opens over its own client: one statement at a time, concurrent callers taking turns, each with
 * text parameters. Every statement this library sends casts each column it reads to text, so a row's columns arrive as
 * strings, or null, from any client.
 */
export interface PgSession {
	readonly query: (
		sql: string,
		params: ReadonlyArray<string>
	) => Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, NeedFailed>
}

/** A statement's rows as this library reads them: each column the server's text, or null. */
export type TextRows = ReadonlyArray<ReadonlyArray<string | null>>

/** The prefix every database this library names on a cluster carries: the repository's, so its sweep can tell them. */
export type DatabasePrefix = string & Brand.Brand<"DatabasePrefix">

/**
 * A prefix is a lowercase letter, then lowercase letters, digits and underscores, at most 27 characters in all, so the
 * longest name this library mints after it (names.ts templateName: `tpl_` and 32 hex digits) fits PostgreSQL's
 * identifiers.
 *
 * @formatConstant PostgreSQL's NAMEDATALEN of 64: an identifier is at most 63 bytes
 * (https://github.com/postgres/postgres/blob/REL_19_RC2/src/include/pg_config_manual.h#L29), less the 36 of the
 * longest suffix
 */
const prefixPattern = regex("^[a-z][a-z0-9_]{0,26}$")

/** The repository's prefix, refused unless it is a lowercase identifier short enough for every name minted after it. */
export const DatabasePrefix = Brand.make<DatabasePrefix>((text) => prefixPattern.test(text))

/** A database name on a member: minted only in names.ts, after the cluster's prefix. */
export type DatabaseName = string & Brand.Brand<"DatabaseName">

/**
 * What a repository states about its cluster, which `PgCluster.layer` turns into the runner service its databases come
 * from: the prefix of every name this library mints there; its local cluster (@bjornpagen/testing/pg's LocalCluster),
 * which the layer makes and starts the first time a need reaches it, whose members a run's workers spread over (the
 * first a worker of index i reaches is member i mod their count), whose template every template built from the cluster
 * itself copies (IS_TEMPLATE, never connected to), and in whose owner's own database this library's sessions and
 * advisory locks live; and how to open a session as the owner on a member in a database, over the repository's own
 * client, from the member's facts (its port, CA and owner's password).
 */
export type PgClusterSpec = Readonly<{
	prefix: DatabasePrefix
	cluster: LocalCluster
	connect: (member: PgMember, database: string) => Effect.Effect<PgSession, NeedFailed, Scope.Scope>
}>

/**
 * A worker's owner session on one member, opened the first time the worker reaches the member and held for the
 * worker's life: every create and drop of the worker's databases there runs on it, and it holds the session-level
 * advisory lock of the worker's owner key, which every clone the worker makes carries in its name. A clone whose owner
 * lock is free belongs to a worker that has ended, so collection drops it (collect.ts); the lock, not a process id, is
 * what tells, so it holds across machines and reused pids.
 */
export type Owner = Readonly<{
	member: PgMember
	session: PgSession
	key: OwnerKey
	serial: Effect.Effect<number>
}>

/** A worker's owner key on a member: 16 lowercase hex digits, 64 random bits, an advisory lock's bigint key. */
export type OwnerKey = string & Brand.Brand<"OwnerKey">

const ownerKey = Brand.nominal<OwnerKey>()

/** The service a repository's runner config provides for its cluster (PgCluster.layer of its spec). */
export type PgClusterShape = Readonly<{
	prefix: DatabasePrefix
	base: string
	maintenance: string
	connect: PgClusterSpec["connect"]
	/** The cluster's members, made and started when they are not (pg/make.ts clusterUp) and read once, the first time a need asks. */
	members: Effect.Effect<Arr.NonEmptyReadonlyArray<PgMember>, NeedFailed>
	/** The member a worker reaches: worker i of a run on member i mod the members' count. */
	memberOf: (
		worker: Context.Service.Shape<typeof WorkerIndex>
	) => Effect.Effect<PgMember, NeedFailed>
	/** The worker's owner on `member`, opened once (Owner). */
	owner: (member: PgMember) => Effect.Effect<Owner, NeedFailed>
}>

/** The decode of a statement's rows: every column a string or null, or NeedFailed naming the statement. */
const textRows = (
	sql: string,
	rows: ReadonlyArray<ReadonlyArray<unknown>>
): Effect.Effect<TextRows, NeedFailed> =>
	Arr.every(rows, (row) =>
		Arr.every(row, (column) => Predicate.isString(column) || Predicate.isNull(column))
	)
		? Effect.succeed(
				Arr.map(rows, (row) =>
					Arr.map(row, (column) => (Predicate.isString(column) ? column : null))
				)
			)
		: Effect.fail(
				NeedFailed.make({
					need: "pg",
					message: `a column of ${sql} came back as neither text nor null: the session must give each column's text`
				})
			)

/** One statement on `session`, its rows decoded as text. */
export const run = (
	session: PgSession,
	sql: string,
	params: ReadonlyArray<string>
): Effect.Effect<TextRows, NeedFailed> =>
	Effect.flatMap(session.query(sql, params), (rows) => textRows(sql, rows))

/** The first column of the first row of `sql`'s answer, or NeedFailed when it has none. */
export const single = (
	session: PgSession,
	sql: string,
	params: ReadonlyArray<string>
): Effect.Effect<string | null, NeedFailed> =>
	Effect.flatMap(run(session, sql, params), (rows) =>
		Effect.mapError(Effect.fromOption(Option.flatMap(Arr.head(rows), Arr.head)), () =>
			NeedFailed.make({ need: "pg", message: `${sql} answered no row` })
		)
	)

/** The bigint advisory-lock key a 16-hex-digit text names, in SQL: its 64 bits read as a signed int8. */
export const lockKey = (placeholder: string): string => `('x' || ${placeholder})::bit(64)::int8`

/**
 * The advisory-lock key of a template's use, in SQL, from the same 16 hex digits as its build gate's (lockKey): the two
 * int4 halves of its 64 bits, a key of PostgreSQL's two-int4 space, which no int8 key shares (advisory.c: the lock tag's
 * last field is 2, an int8's 1), so a template's users and its builder never wait on each other.
 */
export const useKey = (placeholder: string): string =>
	`('x' || pg_catalog.substr(${placeholder}, 1, 8))::bit(32)::int4, ('x' || pg_catalog.substr(${placeholder}, 9, 8))::bit(32)::int4`

/**
 * Opens the worker's owner on `member` in `scope`: a session in the owner's database holding the lock of a fresh owner
 * key, 64 bits the server draws (the MD5 of a random UUID's text) and locks in one statement, and the counter of the
 * clones it names.
 */
const openOwner = (
	spec: PgClusterSpec,
	member: PgMember,
	scope: Scope.Scope
): Effect.Effect<Owner, NeedFailed> =>
	Effect.gen(function* () {
		const session = yield* Scope.provide(spec.connect(member, spec.cluster.owner), scope)
		const drawn = yield* single(
			session,
			`SELECT k FROM (SELECT pg_catalog.substr(pg_catalog.md5(pg_catalog.gen_random_uuid()::text), 1, 16) AS k) AS fresh, LATERAL (SELECT pg_catalog.pg_advisory_lock(${lockKey("fresh.k")})) AS locked`,
			[]
		)
		const text = yield* Effect.mapError(Effect.fromNullishOr(drawn), () =>
			NeedFailed.make({ need: "pg", message: "the server drew no owner key" })
		)
		const key = ownerKey(text)
		const serial = yield* Ref.make(0)
		return { member, session, key, serial: Ref.updateAndGet(serial, (n) => n + 1) }
	})

/** The runner service of a repository's PostgreSQL cluster, from which every Template.database and Database comes. */
export class PgCluster extends Context.Service<PgCluster, PgClusterShape>()(
	"@bjornpagen/testing/resources/cluster/PgCluster"
) {
	/**
	 * The service a repository's runner config provides (its `layer`), built once per worker the first time a case
	 * there opens a need: it reads nothing then, so a worker whose needs use no database never reaches the cluster; its
	 * members are made and started when they are not and read the first time a need asks (pg/make.ts clusterUp, under
	 * the cluster's lock, whose wait is declared to the worker's guards), and an owner per member opened when the worker
	 * first reaches it, held until the worker ends, once the run holds its lease on the cluster (pg/lease.ts reservationOf,
	 * runner/leases.ts): a slot for each of its workers on every member, so no connection of the run is refused.
	 */
	static readonly layer = (
		spec: PgClusterSpec
	): Layer.Layer<PgCluster, never, Platform | RunLease | WorkerIndex> =>
		Layer.effect(
			PgCluster,
			Effect.gen(function* () {
				const scope = yield* Effect.scope
				const platform = yield* Effect.context<Platform>()
				const lease = yield* RunLease
				const ofTheRun = yield* WorkerIndex
				const members = yield* Effect.cached(
					Effect.mapError(Effect.provideContext(clusterUp(spec.cluster), platform), (failure) =>
						NeedFailed.make({ need: "the local cluster", message: failure.message })
					)
				)
				const leased = yield* Effect.cached(
					Effect.flatMap(members, (all) =>
						Effect.flatMap(
							Effect.mapError(
								Effect.provideContext(
									reservationOf(
										Arr.headNonEmpty(all).port,
										all,
										{
											perLessee: spec.cluster.sizing.connections.perWorker,
											outside: spec.cluster.sizing.connections.outside
										},
										ofTheRun.workers
									),
									platform
								),
								(failure) =>
									NeedFailed.make({ need: "the local cluster's lease", message: failure.message })
							),
							lease.reserve
						)
					)
				)
				const owners = new Map<string, Deferred.Deferred<Owner, NeedFailed>>()
				return {
					prefix: spec.prefix,
					base: spec.cluster.template,
					maintenance: spec.cluster.owner,
					connect: spec.connect,
					members,
					memberOf: (worker) =>
						Effect.map(members, (all) => Arr.getUnsafe(all, worker.index % all.length)),
					owner: (member) =>
						Effect.suspend(() =>
							Option.match(Option.fromUndefinedOr(owners.get(member.name)), {
								onSome: Deferred.await,
								onNone: () => {
									const opened = Deferred.makeUnsafe<Owner, NeedFailed>()
									owners.set(member.name, opened)
									return Effect.andThen(
										Deferred.into(Effect.andThen(leased, openOwner(spec, member, scope)), opened),
										Deferred.await(opened)
									)
								}
							})
						)
				}
			})
		)
}

/**
 * A repository's runner service a need reads (PgCluster, which its runner config's layer provides): the library does
 * not declare it in RunnerServices, so a repository with no database needs provides none; a need that reads one the run
 * lacks fails, naming it.
 */
export const required = <I, S>(key: Context.Key<I, S>, why: string): Effect.Effect<S, NeedFailed> =>
	Effect.flatMap(Effect.serviceOption(key), (found) =>
		Effect.mapError(Effect.fromOption(found), () =>
			NeedFailed.make({ need: key.key, message: `the run provides no ${key.key}: ${why}` })
		)
	)

/** An identifier quoted for SQL: in double quotes, each double quote doubled. */
export const quoteIdent = (name: string): string => `"${Str.replaceAll('"', '""')(name)}"`

/** A text quoted as an SQL literal under standard_conforming_strings: in single quotes, each single quote doubled. */
export const quoteLiteral = (text: string): string => `'${Str.replaceAll("'", "''")(text)}'`
