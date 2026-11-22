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
import { checkoutHere, familyOf, homesHere } from "#pg/family.ts"
import { membersRead, type PgMember, type Platform } from "#pg/settle.ts"
import type { LocalCluster, WorkerSizing } from "#pg/spec.ts"
import { NeedFailed, WorkerIndex } from "#runner/services.ts"

export type { PgMember } from "#pg/settle.ts"

/**
 * A session on one member as the cluster's owner role (the role that may CREATE DATABASE and owns what it creates),
 * which the repository opens over its own client: one statement at a time, concurrent callers taking turns, each with
 * text parameters. Every statement this library sends casts each column it reads to text, so a row's columns arrive as
 * strings, or null, from any client. Its `query` is a declared wait of its process while the member works on the
 * statement (live.ts waitingOnWork, its claim checked against the session's backend, as pg/session.ts pgSession's is; or
 * live.ts waitingOn): the session declares its statements, the library's (run) and its caller's alike, so a statement
 * the member keeps busy is no stall of its case.
 */
export interface PgSession {
	readonly query: (
		sql: string,
		params: ReadonlyArray<string>
	) => Effect.Effect<ReadonlyArray<ReadonlyArray<unknown>>, NeedFailed>
}

/**
 * What the library asks of a session: its statements' rows (PgSession's query). A repository's PgSession may carry
 * more, which it declares on the interface (grizzle's connection, for its own code over the owner's session); a session
 * of the bootstrap superuser is the library's alone (PgClusterSpec's superuser), asked for its statements and nothing
 * more, so a repository gives it no more than that.
 */
export type Statements = Pick<PgSession, "query">

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
 * one sized for workers (WorkerSizing), which `toolchain-pg settle` gives its spec and the layer reads the first time a
 * need reaches it, whose members a run's workers spread over (worker i on member i mod their count), whose template
 * every template built from the cluster itself copies (IS_TEMPLATE, never connected to), and in whose owner's own
 * database this library's sessions and advisory locks live; and how to open a session on a member in a database, over
 * the repository's own client, from the member's facts: as the owner (`connect`, its port, CA and password), and as the
 * member's bootstrap superuser (`superuser`, over its socket), which remakes in a clone what only a superuser may be
 * sure to make, a role's setting in the database (template.ts replayOf).
 */
export type PgClusterSpec = Readonly<{
	prefix: DatabasePrefix
	cluster: LocalCluster<WorkerSizing>
	connect: (member: PgMember, database: string) => Effect.Effect<PgSession, NeedFailed, Scope.Scope>
	superuser: (
		member: PgMember,
		database: string
	) => Effect.Effect<Statements, NeedFailed, Scope.Scope>
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
	superuser: PgClusterSpec["superuser"]
	/** The cluster's members, read once the first time a need asks (pg/settle.ts membersRead), never changed by a run. */
	members: Effect.Effect<Arr.NonEmptyReadonlyArray<PgMember>, NeedFailed>
	/** The member a worker reaches: worker i on member i mod the members' count, so a run's workers spread over them. */
	memberOf: (
		worker: Context.Service.Shape<typeof WorkerIndex>
	) => Effect.Effect<PgMember, NeedFailed>
	/** The worker's owner on `member`, opened once (Owner). */
	owner: (member: PgMember) => Effect.Effect<Owner, NeedFailed>
	/**
	 * The run's checkout (pg/family.ts checkoutHere: its package root, a lane's workspace or trunk's worktree, which a
	 * mutant's worker tree is given), read once the first time a need asks: the checkout whose family the run reaches,
	 * and whose claims a template's use records (template.ts claimed), which collection keeps the template for while the
	 * checkout exists (collect.ts).
	 */
	checkout: Effect.Effect<string, NeedFailed>
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

/**
 * One statement on `session`, its rows decoded as text. The session's query declares it (PgSession): every statement
 * this library sends waits on the member's work, which no guard of the sender's counts as its stall however long the
 * member takes, and which PostgreSQL guards in turn. A clone's CREATE DATABASE waits on the checkpoints its strategy
 * forces and on the template's other users, a DROP DATABASE on every backend of the member taking in its barrier and on
 * the clone's last sessions leaving, an advisory lock on the builder or the collector that holds it (metis's 5451,
 * 2026-11-20: a case hung at 22 ms of CPU over 60 s, its worker in a clone's DROP DATABASE behind the member's
 * ProcSignalBarrier while other clones' FILE_COPY checkpoints ran). A second declaration here, a claim no guard checks,
 * would hide a statement whose answer never comes behind the session's checked one.
 */
export const run = (
	session: Statements,
	sql: string,
	params: ReadonlyArray<string>
): Effect.Effect<TextRows, NeedFailed> =>
	Effect.flatMap(session.query(sql, params), (rows) => textRows(sql, rows))

/** The first column of the first row of `sql`'s answer, or NeedFailed when it has none. */
export const single = (
	session: Statements,
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
 * key, 64 bits the server draws (pg_catalog.random over int8's whole range, as 16 hex digits) and locks in one
 * statement, and the counter of the clones it names.
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
			`SELECT k FROM (SELECT pg_catalog.lpad(pg_catalog.to_hex(pg_catalog.random((-9223372036854775808)::int8, 9223372036854775807::int8)), 16, '0') AS k) AS fresh, LATERAL (SELECT pg_catalog.pg_advisory_lock(${lockKey("fresh.k")})) AS locked`,
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
	 * there opens a need: it reads nothing then, so a worker whose needs use no database never reaches the cluster; the
	 * run's checkout and the account's homes are read once the first time a need asks (pg/family.ts checkoutHere,
	 * homesHere), and its family's members
	 * (pg/settle.ts membersRead, which refuses a member not as its spec states, naming `toolchain-pg settle`), and an
	 * owner per member opened when the worker first reaches it, held until the worker ends. Nothing admits a worker or
	 * makes it wait: a member past its capacity refuses a connection.
	 */
	static readonly layer = (
		spec: PgClusterSpec
	): Layer.Layer<PgCluster, never, Platform | WorkerIndex> =>
		Layer.effect(
			PgCluster,
			Effect.gen(function* () {
				const scope = yield* Effect.scope
				const platform = yield* Effect.context<Platform>()
				const checkout = yield* Effect.cached(
					Effect.mapError(Effect.provideContext(checkoutHere, platform), (failure) =>
						NeedFailed.make({ need: "the local cluster", message: failure.message })
					)
				)
				const members = yield* Effect.cached(
					Effect.flatMap(checkout, (at) =>
						Effect.mapError(
							Effect.provideContext(
								Effect.flatMap(homesHere, (homes) =>
									membersRead(familyOf(spec.cluster, at, homes))
								),
								platform
							),
							(failure) => NeedFailed.make({ need: "the local cluster", message: failure.message })
						)
					)
				)
				const owners = new Map<string, Deferred.Deferred<Owner, NeedFailed>>()
				return {
					prefix: spec.prefix,
					base: spec.cluster.template,
					maintenance: spec.cluster.owner,
					connect: spec.connect,
					superuser: spec.superuser,
					members,
					checkout,
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
										Deferred.into(openOwner(spec, member, scope), opened),
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
