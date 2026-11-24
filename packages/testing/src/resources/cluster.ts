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
import {
	familyAsSettled,
	memberBroughtUp,
	memberNames,
	membersRunning,
	type PgMember,
	type Platform,
	unitSettler
} from "#pg/settle.ts"
import type { LocalCluster, WorkerSizing } from "#pg/spec.ts"
import { runnerLimits } from "#runner/limits.ts"
import { NeedFailed, WorkerIndex } from "#runner/services.ts"
import { testWorkers } from "#workers.ts"

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
	/**
	 * Member `index` mod the family's member count, brought up the first time a need asks (pg/settle.ts memberBroughtUp:
	 * read, and where it is absent or not as its spec states settled by its own unit, then read again), once a process:
	 * so a run starts the members its workers reach, and no other.
	 */
	memberAt: (index: number) => Effect.Effect<PgMember, NeedFailed>
	/** The member a worker reaches: worker i on member i mod the members' count (memberAt), so a run's workers spread over them. */
	memberOf: (
		worker: Context.Service.Shape<typeof WorkerIndex>
	) => Effect.Effect<PgMember, NeedFailed>
	/**
	 * The family's members that run now, each read at the width its state was last settled for, none brought up
	 * (pg/settle.ts familyAsSettled, membersRunning): what collection reads, before a run as after it, whatever width
	 * settled them.
	 */
	running: Effect.Effect<ReadonlyArray<PgMember>, NeedFailed>
	/** The worker's owner on `member`, opened once (Owner). */
	owner: (member: PgMember) => Effect.Effect<Owner, NeedFailed>
	/**
	 * The run's checkout (pg/family.ts checkoutHere: the workspace root of its package, a lane's workspace or trunk's
	 * worktree, which a mutant's worker tree is given), read once the first time a need asks: the checkout whose family the run reaches,
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

/**
 * How a drop of a database treats the sessions still in it (databaseDropped): `ended`, terminated by the drop (WITH
 * (FORCE)), for a database no live case holds, a collected clone or template or a build's own; `awaited`, left for
 * their backends to leave within the drop's own wait (dbcommands.c dropdb, CountOtherDBBackends: five seconds), and the
 * drop refused on one still in it, for a clone after its case, whose sessions the case closed: a session the case
 * leaked is the case's to end, never the drop's, whose ending would fail it mid-run in the client that holds it.
 */
export type SessionsAtDrop = "ended" | "awaited"

/**
 * How long a drop waits for a terminated walsender of the database it drops to exit (pg_terminate_backend's timeout)
 * before it drops the walsender's slot: the case deadline.
 *
 * @limitKind derived
 * @owner the testing library's resources (resources/cluster.ts databaseDropped)
 * @unit milliseconds
 * @scope one walsender's exit, waited for by one drop of a database on the local cluster
 * @derivation a clone's drop is its case's teardown, which the case deadline bounds, so a walsender that outlives a
 *   whole deadline after its termination has hung; a collection's or a build's drop waits on no more than a case's
 * @from {@link runnerLimits}
 */
const walsenderExitWait = runnerLimits.deadline

/**
 * The statements that drop database `name`, the one drop of a database, sent from a session outside it whose role
 * holds REPLICATION and pg_signal_backend, as a cluster owner's does (pg/settle.ts), or the bootstrap superuser's:
 * first every replication slot made in it, which PostgreSQL refuses to drop a database under (dbcommands.c dropdb,
 * 55006) and WITH (FORCE) ends neither, each slot's walsender terminated and its exit waited for (walsenderExitWait)
 * before the slot is dropped; then the database, its sessions as `sessions` says (SessionsAtDrop). A logical slot a
 * case's live source made in its clone (grizzle's served leader, `__live_<digest>`, named by its template) outlived the
 * clone's refused drop, and the next case on the member met it, 42710 (TESTRESET4, 2026-11-23,
 * test/pg/net/network.test.ts). A walsender that outlives the wait leaves its slot active, and the slot's drop fails.
 */
export const databaseDropped = (name: string, sessions: SessionsAtDrop): ReadonlyArray<string> => [
	`SELECT pg_catalog.pg_terminate_backend(active_pid, ${walsenderExitWait}) FROM pg_catalog.pg_replication_slots WHERE database = ${quoteLiteral(name)}::name AND active_pid IS NOT NULL`,
	`SELECT pg_catalog.pg_drop_replication_slot(slot_name) FROM pg_catalog.pg_replication_slots WHERE database = ${quoteLiteral(name)}::name`,
	`DROP DATABASE IF EXISTS ${quoteIdent(name)}${sessions === "ended" ? " WITH (FORCE)" : ""}`
]

/** Drops database `name` on `session` (databaseDropped), each statement in turn. */
export const databaseDroppedOn = (
	session: Statements,
	name: string,
	sessions: SessionsAtDrop
): Effect.Effect<void, NeedFailed> =>
	Effect.forEach(databaseDropped(name, sessions), (sql) => run(session, sql, []), { discard: true })

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
 * The level every transaction of a worker's owner session runs at, stated on the session as it opens whatever its
 * repository's sessions default to (grizzle's harness defaults to SERIALIZABLE): READ COMMITTED. Its statements are the
 * library's own bookkeeping in the owner's database, each a transaction of its own: a template's claim (template.ts
 * claimed), an upsert ON CONFLICT, which PostgreSQL arbitrates at READ COMMITTED natively, and whose DELETE takes only
 * its own checkout's rows of one logical template, so two checkouts' claims at once both commit, where under
 * SERIALIZABLE their reads of the claims table conflicted with each other's writes and one failed 40001 (grizzle's
 * whole network tier, lane CO-PG, 2026-11-23: 97 properties lost at once, every need whose claim failed); and its clones'
 * creations and drops, its locks and its reads of the catalog, none of which a level changes. A READ COMMITTED
 * transaction holds no SIREAD lock, so none of them fails 40001. The level is the session's, never a BEGIN of each
 * claim: the worker's needs share the session one statement at a time, so a claim's BEGIN and COMMIT, sent as statements
 * of their own, could take another need's CREATE DATABASE between them, which PostgreSQL refuses inside a transaction.
 */
const ownerLevel = "SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL READ COMMITTED"

/**
 * Opens the worker's owner on `member` in `scope`: a session in the owner's database at READ COMMITTED (`ownerLevel`),
 * holding the lock of a fresh owner key, 64 bits the server draws (pg_catalog.random over int8's whole range, as 16 hex
 * digits) and locks in one statement, and the counter of the clones it names.
 */
const openOwner = (
	spec: PgClusterSpec,
	member: PgMember,
	scope: Scope.Scope
): Effect.Effect<Owner, NeedFailed> =>
	Effect.gen(function* () {
		const session = yield* Scope.provide(spec.connect(member, spec.cluster.owner), scope)
		yield* run(session, ownerLevel, [])
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
	 * homesHere), and the member a need asks for brought up then, once (memberAt), and an owner per member opened when
	 * the worker first reaches it, held until the worker ends. Nothing admits a worker or
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
				const clusterFailed = (failure: Readonly<{ message: string }>) =>
					NeedFailed.make({ need: "the local cluster", message: failure.message })
				const family = yield* Effect.cached(
					Effect.flatMap(checkout, (at) =>
						Effect.mapBoth(homesHere, {
							onFailure: clusterFailed,
							onSuccess: (homes) => familyOf(spec.cluster, at, homes, testWorkers)
						})
					)
				)
				const brought = new Map<number, Deferred.Deferred<PgMember, NeedFailed>>()
				const memberAt = (index: number): Effect.Effect<PgMember, NeedFailed> =>
					Effect.flatMap(family, (reached) => {
						const at = index % memberNames(reached).length
						return Option.match(Option.fromUndefinedOr(brought.get(at)), {
							onSome: Deferred.await,
							onNone: () => {
								const bringing = Deferred.makeUnsafe<PgMember, NeedFailed>()
								brought.set(at, bringing)
								return Effect.andThen(
									Deferred.into(
										Effect.mapError(
											Effect.provideContext(memberBroughtUp(reached, at, unitSettler), platform),
											clusterFailed
										),
										bringing
									),
									Deferred.await(bringing)
								)
							}
						})
					})
				const running = Effect.flatMap(family, (reached) =>
					Effect.mapError(
						Effect.provideContext(
							Effect.flatMap(
								familyAsSettled(reached.cluster, reached.checkout, reached.homes),
								membersRunning
							),
							platform
						),
						clusterFailed
					)
				)
				const owners = new Map<string, Deferred.Deferred<Owner, NeedFailed>>()
				return {
					prefix: spec.prefix,
					base: spec.cluster.template,
					maintenance: spec.cluster.owner,
					connect: spec.connect,
					superuser: spec.superuser,
					memberAt,
					memberOf: (worker) => memberAt(worker.index),
					running,
					checkout,
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
