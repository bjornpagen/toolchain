import { Effect, Redacted, type Scope } from "effect"
import pg from "pg"
import { waitingOn, waitingOnWork } from "#live.ts"
import { bootstrapSuperuser } from "#pg/server.ts"
import type { PgMember } from "#pg/settle.ts"
import type { PgSession, Statements } from "#resources/cluster.ts"
import { NeedFailed } from "#runner/services.ts"

/** A failure of a session on `member` as the need it failed: what it was doing, and what the driver said. */
const sessionFailed = (member: PgMember, doing: string) => (cause: unknown) =>
	NeedFailed.make({
		need: "the local cluster",
		message: `${doing} on member ${member.name}: ${Error.isError(cause) ? cause.message : String(cause)}`
	})

/**
 * The statement backendWorking runs, `$1` the backend: true while it works on its client's statement. `blockers` is
 * every backend that holds a lock it waits behind, at any remove (pg_blocking_pids, again for each holder found; a
 * prepared transaction is pid 0, in no row of pg_stat_activity); a holder that works (active and behind no heavyweight
 * lock) or sits between statements (idle, out of any transaction) carries the wait, and holders idle in a transaction,
 * or prepared, alone do not. The CASE asks the lock graph only of a backend behind a heavyweight lock.
 */
const BACKEND_WORKING = `WITH RECURSIVE blockers (pid) AS (
	SELECT pg_catalog.unnest(pg_catalog.pg_blocking_pids($1::int4))
	UNION
	SELECT pg_catalog.unnest(pg_catalog.pg_blocking_pids(blockers.pid)) FROM blockers
)
SELECT CASE
	WHEN a.state IS DISTINCT FROM 'active' THEN false
	WHEN a.wait_event_type IS DISTINCT FROM 'Lock' THEN true
	ELSE EXISTS (
		SELECT FROM blockers JOIN pg_catalog.pg_stat_activity AS h USING (pid)
		WHERE h.state = 'idle' OR (h.state = 'active' AND h.wait_event_type IS DISTINCT FROM 'Lock')
	)
END
FROM pg_catalog.pg_stat_activity AS a WHERE a.pid = $1::int4`

/**
 * Whether the backend `pid` of `member` works on what its client awaits, as the member says on a connection of its own,
 * the bootstrap superuser's over the member's socket (no secret, no TLS: a check costs its process a few milliseconds
 * of CPU, which a case's guard counts as the case's, where a TLS sign-in cost tens) (BACKEND_WORKING): it runs a
 * statement (pg_stat_activity's `active`, behind an LWLock, I/O or a checkpoint as much as on a CPU), where `idle`,
 * `idle in transaction` or a backend gone means the member has answered, or never will, so its client awaits nothing
 * the member does. A backend behind a heavyweight lock works while something holding it, at any remove (a holder
 * itself behind a lock passes the question on), works or is a session between statements, which holds only a
 * session's lock (an advisory mutex whose holder's client works elsewhere, a template's build gate); one whose every
 * holder sits idle in a transaction, or is a prepared transaction, waits on a client, not on the member: nothing moves
 * until that client acts, and when the client is the waiter's own process, which awaits the statement, nothing ever
 * will (grizzle's test/pg/substrate/budget.test.ts under its first kill, UNITREDS, 2026-11-22: the case failed with
 * its holder idle in transaction on ACCESS EXCLUSIVE and two pool reads of its own behind it; its cleanup closed the
 * pool before the holder, so it waited on the reads, the reads on the holder, and the reads' waits read active, 14 to
 * 73 minutes and more with no verdict). A member
 * that cannot be asked (the connection fails) answers yes: the claim holds when it cannot be checked.
 */
export const backendWorking = (member: PgMember, pid: number): Effect.Effect<boolean> => {
	const unasked = () => "unasked" as const
	return Effect.orElseSucceed(
		Effect.acquireUseRelease(
			Effect.tap(
				Effect.sync(
					() =>
						new pg.Client({
							host: member.socket,
							port: member.port,
							user: bootstrapSuperuser(),
							database: "postgres",
							application_name: "toolchain backend check"
						})
				),
				(client) => Effect.tryPromise({ try: () => client.connect(), catch: unasked })
			),
			(client) =>
				Effect.map(
					Effect.tryPromise({
						try: () =>
							client.query<[boolean]>({
								text: BACKEND_WORKING,
								values: [pid],
								rowMode: "array"
							}),
						catch: unasked
					}),
					(result) => result.rows[0]?.[0] === true
				),
			(client) => Effect.ignore(Effect.tryPromise({ try: () => client.end(), catch: unasked }))
		),
		() => true
	)
}

/**
 * A session over node-postgres (pg, a peer of this module) on `member` with `config` (where and as whom it signs in),
 * in `database`, for the scope, as `applicationName`, in pg's pipeline mode, so a statement sent while another runs
 * follows it on the wire, each its own exchange ending in a Sync, and concurrent callers take turns in the server (a
 * worker's owner session serves its needs at once): 2,000 statements sent at once took 190 to 380 ms pipelined and 413
 * to 1,152 ms queued in the client, which pg 8 deprecates and the hardened flags make fatal, where one after another
 * took the same either way (the shared server at load 350, 2026-11-21); every statement goes out on the extended
 * protocol with its rows positional, each column the server's text. Its connect and its end are
 * declared waits of this process (live.ts waitingOn), and each statement one whose claim the guard checks against its
 * backend (live.ts waitingOnWork, backendWorking): each waits on the member's work (a backend forked and signed in, a
 * statement's execution, a backend leaving), which no guard of this process counts as its stall, however long the member
 * takes. A statement held up server-side spends no CPU of this process: under SERIALIZABLE contention a large install's
 * statements waited about 2 s each on the member's SSI locks while its client sat idle, and the guard judged live cases
 * hung (RECORDS-ATTACH, 2026-11-21: 25 ms of CPU over 60 s). A statement whose backend is idle while its client still
 * awaits it is no work of the member's, and the guard judges it so; one that never ends is PostgreSQL's to end (its
 * deadlock detection, statement_timeout) or the run's budget's.
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
					waitingOn(`a session's connect in ${database} on member ${member.name}`)(
						Effect.andThen(
							Effect.tryPromise({
								try: () => client.connect(),
								catch: sessionFailed(member, `a session in ${database}`)
							}),
							Effect.map(
								Effect.tryPromise({
									try: () =>
										client.query<[number]>({
											text: "SELECT pg_catalog.pg_backend_pid()",
											rowMode: "array"
										}),
									catch: sessionFailed(member, `a session's backend in ${database}`)
								}),
								(own) => ({ client, pid: own.rows[0]?.[0] ?? 0 })
							)
						)
					)
			),
			({ client }) =>
				Effect.ignore(
					waitingOn(`a session's end in ${database} on member ${member.name}`)(
						Effect.tryPromise({ try: () => client.end(), catch: sessionFailed(member, "an end") })
					)
				)
		),
		({ client, pid }): PgSession => ({
			query: (sql, params) =>
				waitingOnWork(
					`${sql} (in ${database} on member ${member.name})`,
					backendWorking(member, pid)
				)(
					Effect.map(
						Effect.tryPromise({
							try: () =>
								client.query<Array<unknown>>({ text: sql, values: [...params], rowMode: "array" }),
							catch: sessionFailed(member, `${sql} in ${database}`)
						}),
						(result) => result.rows
					)
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
