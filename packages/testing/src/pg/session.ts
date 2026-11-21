import { Effect, Redacted, type Scope } from "effect"
import pg from "pg"
import { waitingOn } from "#live.ts"
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
 * A session over node-postgres (pg, a peer of this module) on `member` with `config` (where and as whom it signs in),
 * in `database`, for the scope, as `applicationName`, in pg's pipeline mode, so a statement sent while another runs
 * follows it on the wire, each its own exchange ending in a Sync, and concurrent callers take turns in the server;
 * every statement goes out on the extended protocol with its rows positional, each column the server's text. Its
 * connect, each of its statements and its end are declared waits of this process (live.ts waitingOn), each named by
 * what it waits on: each waits on the member's work (a backend forked and signed in, a statement's execution, a backend
 * leaving), which no guard of this process counts as its stall, however long the member takes. A statement held up
 * server-side spends no CPU of this process: under SERIALIZABLE contention a statement of a large install waited about
 * 2 s on the member's SSI locks (LWLock SerializableFinishedList, SerializablePredicateList) while its client sat idle,
 * and the guard judged live cases hung (RECORDS-ATTACH, 2026-11-21: 25 ms of CPU over 60 s). A statement that never
 * ends is PostgreSQL's to end (its deadlock detection, statement_timeout) or the run's budget's.
 */
const pgSession = (
	applicationName: string,
	member: PgMember,
	database: string,
	config: pg.ClientConfig
): Effect.Effect<PgSession, NeedFailed, Scope.Scope> =>
	Effect.map(
		Effect.acquireRelease(
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
					waitingOn(`a session's connect in ${database} on member ${member.name}`)(
						Effect.tryPromise({
							try: () => client.connect(),
							catch: sessionFailed(member, `a session in ${database}`)
						})
					)
			),
			(client) =>
				Effect.ignore(
					waitingOn(`a session's end in ${database} on member ${member.name}`)(
						Effect.tryPromise({ try: () => client.end(), catch: sessionFailed(member, "an end") })
					)
				)
		),
		(client): PgSession => ({
			query: (sql, params) =>
				waitingOn(`${sql} (in ${database} on member ${member.name})`)(
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
		pgSession(applicationName, member, database, {
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
