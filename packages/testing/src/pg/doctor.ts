import { Array as Arr, Effect, String as Str } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { examined, type Examined, type Platform } from "#pg/make.ts"
import type { PgMember } from "#pg/make.ts"
import { adminSql, type ClusterFailed, conninfo, ownerPsql, ran, verified } from "#pg/server.ts"
import type { LocalCluster } from "#pg/spec.ts"
import type { MemberState } from "#pg/state.ts"

/** One check's verdict: its name, and why it failed when it did. */
export type Verdict =
	| Readonly<{ name: string; kind: "ok" }>
	| Readonly<{ name: string; kind: "failed"; detail: string }>

/** The verdict of `name` on `actual` against `expected`, both as psql prints them. */
const compared = (name: string, expected: string, actual: string): Verdict =>
	actual === expected
		? { name, kind: "ok" }
		: { name, kind: "failed", detail: `expected [${expected}], got [${actual}]` }

/** What a check's statements printed, or why psql refused, as the text a check compares. */
const printed = (
	run: Effect.Effect<ReadonlyArray<string>, ClusterFailed, ChildProcessSpawner.ChildProcessSpawner>
) =>
	Effect.match(run, {
		onFailure: (error) => error.message,
		onSuccess: (lines) => Arr.join(lines, "\n")
	})

/** A member as the doctor reaches it: the server's bin directory, its state and its facts. */
type Reached = Readonly<{ bin: string; state: MemberState; member: PgMember }>

/** The owner's statements in `database` on the member, over verify-full TLS, their rows as psql prints them. */
const asOwner = (reached: Reached, database: string, statements: ReadonlyArray<string>) =>
	Effect.flatMap(
		ran(
			ownerPsql(
				reached.bin,
				conninfo(reached.state, reached.member.owner, database, verified(reached.member.caFile)),
				reached.member.password,
				["-A", "-t", ...Arr.flatMap(statements, (statement) => ["-c", statement])],
				{}
			)
		),
		(done) =>
			done.code === 0
				? Effect.succeed(Arr.join(Arr.filter(Str.split(done.stdout, "\n"), Str.isNonEmpty), "\n"))
				: Effect.succeed(Str.trim(done.stderr))
	)

/** The superuser's statements in `postgres` on the member, over its socket, as psql prints their rows. */
const asAdmin = (reached: Reached, statements: Arr.NonEmptyReadonlyArray<string>) =>
	printed(
		adminSql(reached.bin, reached.state, "postgres", statements, {
			cluster: reached.member.port,
			doing: "the doctor's check"
		})
	)

/** Whether a connection by `tls` is refused: the check passes when psql cannot sign in. */
const refused = (reached: Reached, name: string, tls: string) =>
	Effect.map(
		ran(
			ownerPsql(
				reached.bin,
				conninfo(reached.state, reached.member.owner, reached.member.owner, tls),
				reached.member.password,
				["-A", "-t", "-c", "SELECT 1"],
				{}
			)
		),
		(done): ReadonlyArray<Verdict> => [
			done.code === 0
				? { name, kind: "failed", detail: "the connection was accepted" }
				: { name, kind: "ok" }
		]
	)

/** A setting's value as pg_settings holds it, in the setting's own unit. */
const settingOf = (name: string) =>
	`SELECT setting FROM pg_catalog.pg_settings WHERE pg_catalog.lower(name) = pg_catalog.lower('${name}')`

/** A check whose one verdict compares what `statements` print as the owner in `database` with `expected`. */
const ownerCheck = (
	reached: Reached,
	name: string,
	expected: string,
	database: string,
	statements: ReadonlyArray<string>
) =>
	Effect.map(asOwner(reached, database, statements), (actual) => [compared(name, expected, actual)])

/** The checks that need no scratch database, each its verdicts. */
const quickChecks = (
	cluster: Examined,
	reached: Reached
): ReadonlyArray<
	Effect.Effect<ReadonlyArray<Verdict>, ClusterFailed, ChildProcessSpawner.ChildProcessSpawner>
> => {
	const owner = reached.member.owner
	const made = `the server is the one that made it, ${cluster.server}`
	return [
		Effect.map(
			asOwner(reached, owner, ["SHOW server_version"]),
			(version): ReadonlyArray<Verdict> => [
				Str.endsWith(` ${version}`)(cluster.server)
					? { name: made, kind: "ok" }
					: { name: made, kind: "failed", detail: `it answers server_version ${version}` }
			]
		),
		Effect.forEach(cluster.sized, ([name, value]) =>
			Effect.map(asAdmin(reached, [settingOf(name)]), (held): Verdict =>
				Number(held) >= Number(value)
					? { name: `${name} holds ${value}, sized for this machine`, kind: "ok" }
					: {
							name: `${name} holds ${value}, sized for this machine`,
							kind: "failed",
							detail: `it is ${held}: toolchain-pg init --adopt sizes it`
						}
			)
		),
		Effect.forEach(cluster.fixed, ([name, value]) =>
			Effect.map(asAdmin(reached, [settingOf(name)]), (held) =>
				compared(`${name} is ${value}, as every member's`, value, held)
			)
		),
		ownerCheck(reached, `${owner} holds REPLICATION, CREATEDB and CREATEROLE`, "t|t|t", owner, [
			"SELECT rolreplication, rolcreatedb, rolcreaterole FROM pg_catalog.pg_roles WHERE rolname = current_user"
		]),
		ownerCheck(reached, `${owner} holds SET on deadlock_timeout`, "t", owner, [
			"SELECT pg_catalog.has_parameter_privilege('deadlock_timeout', 'SET')"
		]),
		ownerCheck(
			reached,
			`${owner} holds pg_read_all_stats WITH ADMIN, SET, and no INHERIT`,
			"t|f|t|f",
			owner,
			[
				"SELECT m.admin_option, m.inherit_option, m.set_option, pg_catalog.has_table_privilege('pg_catalog.pg_backend_memory_contexts', 'SELECT') FROM pg_catalog.pg_auth_members AS m WHERE m.roleid = 'pg_read_all_stats'::regrole AND m.member = current_user::regrole"
			]
		),
		ownerCheck(reached, `${owner} is a member of pg_signal_backend`, "t", owner, [
			"SELECT pg_catalog.pg_has_role('pg_signal_backend', 'MEMBER')"
		]),
		Effect.map(
			asAdmin(reached, [
				"SELECT pg_catalog.bool_and(type = 'hostssl' AND auth_method = 'scram-sha-256') AND pg_catalog.bool_or('all' = ANY(database) AND 'all' = ANY(user_name)) FROM pg_catalog.pg_hba_file_rules WHERE type <> 'local'"
			]),
			(actual) => [
				compared(
					"every TCP line is hostssl SCRAM, and one admits every role to every database, logical replication too",
					"t",
					actual
				)
			]
		),
		ownerCheck(reached, "verify-full TLS connects", "t", owner, [
			"SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid = pg_catalog.pg_backend_pid()"
		]),
		refused(reached, "an unrelated CA is refused", verified(`${reached.state.tls}/wrong-ca.crt`)),
		refused(
			reached,
			"another hostname is refused",
			`${verified(reached.member.caFile)} sslsni=0 hostaddr=127.0.0.1 host=toolchain.invalid`
		),
		refused(reached, "plaintext is refused", "sslmode=disable")
	]
}

/**
 * The checks that need a scratch database, made from the template as the owner and dropped after: that it is made,
 * carries each of the template's extensions in its schema, and has UTF-8 and the builtin C.UTF-8 locale.
 */
const fullChecks = (
	cluster: Examined,
	reached: Reached
): Effect.Effect<
	ReadonlyArray<Verdict>,
	ClusterFailed,
	ChildProcessSpawner.ChildProcessSpawner
> => {
	const owner = reached.member.owner
	const scratch = `toolchain_doctor_${process.pid}`
	return Effect.acquireUseRelease(
		asOwner(reached, owner, [`CREATE DATABASE ${scratch} TEMPLATE ${quoted(cluster.template)}`]),
		(made) =>
			Effect.map(
				Effect.all([
					Effect.succeed([compared(`a database is made from ${cluster.template}`, "", made)]),
					Effect.forEach(cluster.extensions, ({ name, schema }) =>
						Effect.map(
							asOwner(reached, scratch, [
								`SELECT n.nspname FROM pg_catalog.pg_extension AS e JOIN pg_catalog.pg_namespace AS n ON n.oid = e.extnamespace WHERE e.extname = '${Str.replaceAll("'", "''")(name)}'`
							]),
							(found) => compared(`${name} is present in ${schema}`, schema, found)
						)
					),
					ownerCheck(
						reached,
						"its encoding, locale provider and locale",
						"UTF8|b|C.UTF-8",
						scratch,
						[
							"SELECT pg_catalog.pg_encoding_to_char(encoding) || '|' || datlocprovider::text || '|' || datlocale FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()"
						]
					)
				]),
				Arr.flatten
			),
		() =>
			Effect.ignore(asOwner(reached, owner, [`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`]))
	)
}

/** An identifier quoted for a statement: in double quotes, each double quote doubled. */
const quoted = (name: string): string => `"${Str.replaceAll('"', '""')(name)}"`

/** Every check of one member: the quick ones, then with `quick` off those that need a scratch database. */
const memberChecks = (
	cluster: Examined,
	reached: Reached,
	quick: boolean
): Effect.Effect<ReadonlyArray<Verdict>, ClusterFailed, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.map(
		Effect.all([
			...quickChecks(cluster, reached),
			...(quick ? [] : [fullChecks(cluster, reached)])
		]),
		Arr.flatten
	)

/**
 * The go/no-go checks of `cluster`, brought up first (make.ts examined): for every member, in member order, that its
 * server is the one that made it; each setting sized for this machine holds at least its size, and each setting every
 * member holds is exactly its value; the owner's attributes and grants; the hba's SCRAM line; that verify-full TLS
 * connects and an unrelated CA, another hostname and plaintext are refused; and, unless `quick`, that a database made
 * from the template carries each of its extensions in its schema, with UTF-8 and the builtin C.UTF-8 locale.
 */
export const doctor = (
	cluster: LocalCluster,
	quick: boolean
): Effect.Effect<
	ReadonlyArray<Readonly<{ port: number; verdicts: ReadonlyArray<Verdict> }>>,
	ClusterFailed,
	Platform
> =>
	Effect.flatMap(examined(cluster), (found) =>
		Effect.forEach(found.members, ({ state, member }) =>
			Effect.map(memberChecks(found, { bin: found.bin, state, member }, quick), (verdicts) => ({
				port: member.port,
				verdicts
			}))
		)
	)
