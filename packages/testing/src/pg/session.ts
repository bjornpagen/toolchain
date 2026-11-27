import { Array as Arr, Effect, Redacted, type Scope, String as Str } from "effect"
import pg from "pg"
import { bootstrapSuperuser } from "#pg/server.ts"
import type { PgMember } from "#pg/settle.ts"
import type { PgSession, Statements } from "#resources/cluster.ts"
import { observeBackend, registerServerAt } from "#runner/backends.ts"
import { needStallMillis } from "#runner/limits.ts"
import { NeedFailed } from "#runner/services.ts"
import { sessionClosed, sessionOpened } from "#runner/work.ts"

/**
 * How a repository's own client counts its backends as its run's (runner/work.ts): `sessionOpened(pid)` once it knows
 * its backend's pid (node-postgres's BackendKeyData), `sessionClosed(pid)` before it ends the connection, as the
 * runner's own sessions do (pgSession), so a driver a repository hands its code counts in its run's budget.
 */
export { sessionClosed, sessionOpened }

/** A failure of a session on `member` as the need it failed: what it was doing, and what the driver said. */
const sessionFailed = (member: PgMember, doing: string) => (cause: unknown) =>
	NeedFailed.make({
		need: "the local cluster",
		message: `${doing} on member ${member.name}: ${Error.isError(cause) ? cause.message : String(cause)}`
	})

/**
 * The statement a server answers what its backends wait on with (runner/backends.ts Carriers), `$1` the backends of a
 * case's process tree: for each, the pids whose CPU carries its wait. A backend behind a heavyweight lock is carried by
 * every backend holding a lock it waits behind, at any remove (pg_blocking_pids, again for each holder found; a
 * prepared transaction is pid 0, in no row of pg_stat_activity), that works: active and behind no heavyweight lock. A
 * holder idle in a transaction, idle between statements or prepared carries nothing, so a wait on one moves nothing
 * and its case is judged a stall: nothing moves until that holder's client acts, and when the client is the waiter's
 * own process, which awaits the statement, nothing ever will (grizzle's test/pg/substrate/budget.test.ts under its first
 * kill, UNITREDS, 2026-11-22: its holder idle in transaction on ACCESS EXCLUSIVE and two pool reads of its own behind
 * it, 14 to 73 minutes with no verdict). A backend waiting for a safe snapshot (a SERIALIZABLE READ ONLY DEFERRABLE
 * transaction's first, wait event SafeSnapshot) waits out the serializable read-write transactions active when it took
 * its snapshot, as a den step's read waits out every serializable writer on the whole cluster (PostgreSQL 19's
 * Transaction Isolation; trunk@metis b35b5a76, 2026-11-22), and is carried by every backend of its server holding an
 * assigned xid (backend_xid) whose transaction began before its statement, that works: more than it waits out, since an
 * unrelated writer counts too, so such a wait is judged hung later while some writer works, never stalled while one it
 * waits out does; a serializable transaction that has written nothing yet holds no xid and carries nothing.
 * pg_safe_snapshot_blocking_pids would name them exactly, but PostgreSQL 19 answers it from the first serializable
 * transaction of the pid it finds (predicate.c GetSafeSnapshotBlockingPids), which for a session that ran serializable
 * transactions before (grizzle's and den's, every one of theirs) is one already committed, and so answers none. A
 * backend waiting on a checkpoint (CREATE DATABASE's FILE_COPY) is carried by the checkpointer, no one's backend; one
 * waiting on I/O (wait_event_type IO) by the server's I/O workers (io_method worker), which every backend of the server
 * shares, so none is a case's own work.
 */
const CARRIERS = `WITH RECURSIVE asked AS (
	SELECT a.pid, a.wait_event_type, a.wait_event, a.query_start FROM pg_catalog.pg_stat_activity AS a WHERE a.pid = ANY($1::int4[])
), blockers (waiter, pid) AS (
	SELECT asked.pid, pg_catalog.unnest(pg_catalog.pg_blocking_pids(asked.pid)) FROM asked
	WHERE asked.wait_event_type = 'Lock'
	UNION
	SELECT asked.pid, w.pid FROM asked JOIN pg_catalog.pg_stat_activity AS w
		ON w.backend_xid IS NOT NULL AND w.xact_start < asked.query_start AND w.pid <> asked.pid
	WHERE asked.wait_event = 'SafeSnapshot'
	UNION
	SELECT blockers.waiter, pg_catalog.unnest(pg_catalog.pg_blocking_pids(blockers.pid)) FROM blockers
)
SELECT asked.pid::text, pg_catalog.array_to_string(
	ARRAY(
		SELECT h.pid::text FROM blockers JOIN pg_catalog.pg_stat_activity AS h ON h.pid = blockers.pid
		WHERE blockers.waiter = asked.pid AND h.state = 'active' AND h.wait_event_type IS DISTINCT FROM 'Lock'
		UNION ALL
		SELECT c.pid::text FROM pg_catalog.pg_stat_activity AS c
		WHERE c.backend_type = 'checkpointer' AND asked.wait_event IN ('CheckpointStart', 'CheckpointDone')
		UNION ALL
		SELECT w.pid::text FROM pg_catalog.pg_stat_activity AS w
		WHERE w.backend_type = 'io worker' AND asked.wait_event_type = 'IO'
	),
	' '
)
FROM asked`

/**
 * What `member` says carries each of `backends`' waits (CARRIERS), on this process's monitor connection to it
 * (monitorOf), the bootstrap superuser's over the member's socket, opened once and asked again and again, one
 * statement at a time: a fresh connection each reading cost its process milliseconds of CPU at every reading
 * (lockedStatementIsDeclared spent its 150 ms case's budget so under trunk's load at da272aeb, 2026-11-22), and a
 * connect a busy member never answered held a guard 69 minutes, so the monitor is bounded (monitorBoundMillis) and a
 * member that cannot be asked carries nothing.
 */
const carriersOn =
	(member: PgMember) =>
	(backends: ReadonlyArray<string>): Promise<ReadonlyMap<string, ReadonlyArray<string>>> =>
		Effect.runPromise(carriersWithin(member, backends, monitorBoundMillis))

/**
 * Registers `member` with this process (runner/backends.ts registerServerAt), so a guard asks it what carries its
 * backends' waits (carriersOn): what the cluster does for each member it brings up in a worker (resources/cluster.ts
 * PgCluster.layer), so every client of every repository reaches a registered member, the repository's own as the
 * toolchain's sessions, and none can forget it (grizzle passed its own sessions, which never registered: a lock wait
 * behind an outside holder that worked, and an I/O worker's, counted as nothing until a stall window passed).
 */
export const memberRegistered = (member: PgMember): void => {
	registerServerAt(member.socket, member.port, carriersOn(member))
}

/**
 * carriersOn with the monitor bounded by `bound` milliseconds (monitorBoundMillis in production; a test's own): what
 * `member` says carries each of `backends`' waits, or nothing where it cannot be asked (its connection fails or
 * overruns the bound, and is made again at the next ask).
 */
export const carriersWithin = (
	member: PgMember,
	backends: ReadonlyArray<string>,
	bound: number
): Effect.Effect<ReadonlyMap<string, ReadonlyArray<string>>> =>
	Effect.orElseSucceed(
		Effect.tryPromise({
			try: () => monitorOf(member, bound).ask(backends),
			catch: () => "unasked" as const
		}),
		(): ReadonlyMap<string, ReadonlyArray<string>> => new Map()
	)

/**
 * How long this process's monitor connection to a member may take to open, or to answer one ask, before it is dropped
 * and the ask answers as one that cannot be made: a member that takes the connection and never answers would hold the
 * monitor, and every later ask of every case on that member, for good.
 *
 * @limitKind derived
 * @owner the testing library's carrier asks (pg/session.ts monitorOf)
 * @unit milliseconds
 * @scope the open of one monitor connection, and each ask made on it
 * @derivation an ask that has not answered within a need's stall window answers nothing a guard could use: the stall
 *   window bounds every wait a guard does not count (runner/limits.ts needStallMillis)
 * @from runner/limits.ts needStallMillis
 */
const monitorBoundMillis = needStallMillis

/** This process's monitor connection to a member: what it asks, and the turn its next statement waits for. */
type Monitor = Readonly<{
	ask: (backends: ReadonlyArray<string>) => Promise<ReadonlyMap<string, ReadonlyArray<string>>>
}>

declare global {
	var bjornpagenTestingMonitors: Map<string, Monitor> | undefined
}

/**
 * This process's one monitor connection to `member`, made the first time a check asks it and kept for the process's
 * life, its statements one at a time (pg 8 refuses a statement sent while another runs, and the hardened flags make
 * that fatal); its open and each statement bounded by `bound` (node-postgres's connectionTimeoutMillis and
 * query_timeout), and a connection that fails or overruns is forgotten and ended, so the next check makes it again.
 */
const monitorOf = (member: PgMember, bound: number): Monitor => {
	globalThis.bjornpagenTestingMonitors ??= new Map()
	const monitors = globalThis.bjornpagenTestingMonitors
	const key = `${member.socket}:${String(member.port)}`
	const known = monitors.get(key)
	if (known !== undefined) {
		return known
	}
	const client = new pg.Client({
		host: member.socket,
		port: member.port,
		user: bootstrapSuperuser(),
		database: "postgres",
		application_name: "toolchain carrier ask",
		connectionTimeoutMillis: bound,
		query_timeout: bound
	})
	const forget = () => {
		if (monitors.get(key) === monitor) {
			monitors.delete(key)
			void client.end().catch(() => undefined)
		}
	}
	client.on("error", forget)
	const connected = client
		.connect()
		.then(() =>
			client.query<[number]>({ text: "SELECT pg_catalog.pg_backend_pid()", rowMode: "array" })
		)
		.then((own) => {
			observeBackend(String(own.rows[0]?.[0] ?? ""))
		})
	let turn: Promise<unknown> = connected
	const monitor: Monitor = {
		ask: (backends) => {
			const asked = turn.then(() =>
				client.query<[string, string]>({
					text: CARRIERS,
					values: [Arr.map(backends, Number)],
					rowMode: "array"
				})
			)
			turn = asked.catch(() => undefined)
			return asked.then(
				(result) =>
					new Map(
						Arr.map(result.rows, ([pid, carriers]) => [
							pid,
							Arr.filter(Str.split(" ")(carriers), Str.isNonEmpty)
						])
					),
				(cause: unknown) => {
					forget()
					throw cause
				}
			)
		}
	}
	monitors.set(key, monitor)
	return monitor
}

/**
 * A session over node-postgres (pg, a peer of this module) on `member` with `config` (where and as whom it signs in),
 * in `database`, for the scope, as `applicationName`, in pg's pipeline mode, so a statement sent while another runs
 * follows it on the wire, each its own exchange ending in a Sync, and concurrent callers take turns in the server (a
 * worker's owner session serves its needs at once): 2,000 statements sent at once took 190 to 380 ms pipelined and 413
 * to 1,152 ms queued in the client, which pg 8 deprecates and the hardened flags make fatal, where one after another
 * took the same either way (the shared server at load 350, 2026-11-21); every statement goes out on the extended
 * protocol with its rows positional, each column the server's text. No statement is a declared wait: its backend is
 * the process tree's (runner/backends.ts, the peer of the session's socket), so a guard counts the backend's CPU and
 * storage work as the case's and a wait the member's server says a working holder or the checkpointer carries as moving
 * it, as it would any client's, where a statement held up server-side spent no CPU of this process and was judged hung
 * (RECORDS-ATTACH, 2026-11-21: SSI waits of about 2 s a statement, 25 ms of CPU over 60 s). The member it reaches was
 * registered with the process by the cluster that brought it up (memberRegistered), so a guard can ask it what its
 * backends wait on, whatever client a repository reaches it with. The session registers the backends its pid statement
 * names, its own, with the process's session ledger (runner/work.ts sessionOpened), which counts each one's CPU off its
 * own /proc stat until the session ends, read before its Terminate, as the run's backends' CPU.
 */
const pgSession = (
	applicationName: string,
	member: PgMember,
	database: string,
	config: pg.ClientConfig
): Effect.Effect<PgSession, NeedFailed, Scope.Scope> =>
	Effect.map(
		Effect.acquireRelease(
			Effect.flatMap(
				Effect.tap(
					Effect.sync(
						() =>
							new pg.Client({
								...config,
								port: member.port,
								database,
								application_name: applicationName,
								pipeline: true
							})
					),
					(client) =>
						Effect.tryPromise({
							try: () => client.connect(),
							catch: sessionFailed(member, `a session in ${database}`)
						})
				),
				(client) =>
					Effect.map(
						Effect.tryPromise({
							try: () =>
								client.query<[string]>({
									text: "SELECT pg_catalog.pg_backend_pid()::text",
									rowMode: "array"
								}),
							catch: sessionFailed(member, `its backend in ${database}`)
						}),
						(result) => {
							const pids = Arr.map(result.rows, ([pid]) => pid)
							Arr.forEach(pids, sessionOpened)
							return { client, pids }
						}
					)
			),
			({ client, pids }) =>
				Effect.andThen(
					Effect.sync(() => Arr.forEach(pids, sessionClosed)),
					Effect.ignore(
						Effect.tryPromise({ try: () => client.end(), catch: sessionFailed(member, "an end") })
					)
				)
		),
		({ client }): PgSession => ({
			query: (sql, params) =>
				Effect.map(
					Effect.tryPromise({
						try: () =>
							client.query<Array<unknown>>({ text: sql, values: [...params], rowMode: "array" }),
						catch: sessionFailed(member, `${sql} in ${database}`)
					}),
					(result) => result.rows
				)
		})
	)

/**
 * The runner's session as the owner in `database` on `member` (pgSession), signed in with the owner's password: over
 * verify-full TLS against the member's CA at localhost where the member is reached over TLS, else over its socket.
 * What a repository whose own code reaches its cluster over pg passes as its PgCluster spec's `connect`.
 */
export const pgOwnerSession =
	(applicationName: string) =>
	(member: PgMember, database: string): Effect.Effect<PgSession, NeedFailed, Scope.Scope> =>
		pgSession(applicationName, member, database, ownerSignIn(member))

/**
 * How the owner signs in to `member`, with its password: over verify-full TLS against the member's CA at localhost
 * where the member is reached over TLS, else over its socket.
 */
const ownerSignIn = (member: PgMember): pg.ClientConfig => ({
	user: member.owner,
	password: Redacted.value(member.password),
	...(member.tls.kind === "tls"
		? { host: "localhost", ssl: { ca: member.tls.ca, servername: "localhost" } }
		: { host: member.socket })
})

/**
 * The runner's session as the member's bootstrap superuser, the account (server.ts bootstrapSuperuser), in `database`
 * on `member` (pgSession): over the member's socket, which its hba admits the account over with no secret. What a
 * repository whose own code reaches its cluster over pg passes as its PgCluster spec's `superuser`.
 */
export const pgSuperuserSession =
	(applicationName: string) =>
	(member: PgMember, database: string): Effect.Effect<Statements, NeedFailed, Scope.Scope> =>
		pgSession(applicationName, member, database, {
			host: member.socket,
			user: bootstrapSuperuser()
		})
