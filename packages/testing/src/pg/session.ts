import { Effect, Redacted, type Scope } from "effect"
import pg from "pg"
import type { PgMember } from "#pg/make.ts"
import { BOOTSTRAP_SUPERUSER } from "#pg/server.ts"
import type { PgSession } from "#resources/cluster.ts"
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
 * every statement goes out on the extended protocol with its rows positional, each column the server's text.
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
					Effect.tryPromise({
						try: () => client.connect(),
						catch: sessionFailed(member, `a session in ${database}`)
					})
			),
			(client) =>
				Effect.ignore(
					Effect.tryPromise({ try: () => client.end(), catch: sessionFailed(member, "an end") })
				)
		),
		(client): PgSession => ({
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
 * The runner's session as the owner in `database` on `member` (pgSession): verify-full TLS against the member's CA for
 * localhost, signed in with the owner's password. What a repository whose own code reaches its cluster over pg passes
 * as its PgCluster spec's `connect`.
 */
export const pgOwnerSession =
	(applicationName: string) =>
	(member: PgMember, database: string): Effect.Effect<PgSession, NeedFailed, Scope.Scope> =>
		pgSession(applicationName, member, database, {
			host: "localhost",
			user: member.owner,
			password: Redacted.value(member.password),
			ssl: { ca: member.ca, servername: "localhost" }
		})

/**
 * The runner's session as the member's bootstrap superuser in `database` on `member` (pgSession): over the member's
 * socket, by peer authentication mapped from this user (pg/make.ts's hba), with no secret. What a repository whose own
 * code reaches its cluster over pg passes as its PgCluster spec's `superuser`.
 */
export const pgSuperuserSession =
	(applicationName: string) =>
	(member: PgMember, database: string): Effect.Effect<PgSession, NeedFailed, Scope.Scope> =>
		pgSession(applicationName, member, database, { host: member.socket, user: BOOTSTRAP_SUPERUSER })
