import { totalmem } from "node:os"
import { regex } from "arkregex"
import {
	Array as Arr,
	Config,
	Effect,
	FileSystem,
	Option,
	Redacted,
	Result,
	String as Str
} from "effect"
import { ChildProcess, type ChildProcessSpawner } from "effect/process"
import {
	type CheckoutFamily,
	checkoutRecorded,
	checkoutVariable,
	familiesCollected,
	holderText,
	memberNamesOf,
	portHolders,
	portsClaimed,
	portsHeld,
	stateOf,
	unitOf
} from "#pg/family.ts"
import {
	adminSql,
	ClusterFailed,
	failed,
	freshPassword,
	serverBin,
	type SocketAt,
	type Step,
	succeeded,
	unrelatedCa
} from "#pg/server.ts"
import {
	fixedSettings,
	membersOf,
	type Setting,
	settingLine,
	shareOf,
	sizedSettings
} from "#pg/settings.ts"
import type { LocalCluster } from "#pg/spec.ts"
import { testWorkers } from "#workers.ts"

/**
 * A repository's cluster at a checkout (family.ts CheckoutFamily) as units of the workbench's PostgreSQL
 * (~/Documents/beefy-workspace/workbench/parts/postgres): member i of a family is the unit `postgres@<family>-<i>`,
 * which systemd makes on its first start (initdb, trust for the account) and runs, its data and its socket the unit's.
 * Nothing here makes, starts or stops a server by its own programs: a member's settle (memberSettled, its unit's
 * `toolchain-pg settle <index>`) starts the member's unit and gives it what the spec states, by ALTER SYSTEM and the
 * bootstrap superuser's statements, restarting the unit only when a setting it changed waits for one. `toolchain-pg
 * settle` (settled) settles the family's state and its first member; a run's worker brings up the member it reaches on
 * its first need (memberBroughtUp), and no other, so a family runs the members its runs reached, or none once stopped.
 * A read (memberRead) starts nothing, and refuses a member that is not as its spec states, naming the command.
 */

/** The platform a cluster's settling and reading run on: its processes and its files. */
export type Platform = ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem

/**
 * How a client verifies a member's server: over its socket alone (`socket`), or over verify-full TLS at localhost,
 * `ca` being the PEM text of the CA that signed the server's certificate and `caFile` its path, as the workbench's
 * PostgreSQL part installs it, and `wrongCa` the PEM text of a CA that signed nothing the server presents, for the
 * checks that must refuse a server they cannot verify.
 */
export type MemberTls =
	| Readonly<{ kind: "socket" }>
	| Readonly<{ kind: "tls"; ca: string; caFile: string; wrongCa: string }>

/**
 * A member as its clients reach it: its name (its unit's instance, `<unit>-<i>`), its socket directory (the unit's
 * runtime directory) and the port its socket file and, over TLS, its TCP listener at localhost are named by, the owner
 * role and its password (and the file that holds it, for a script's PGPASSFILE), and how a client verifies it.
 */
export type PgMember = Readonly<{
	name: string
	socket: string
	port: number
	owner: string
	password: Redacted.Redacted
	passwordFile: string
	tls: MemberTls
}>

/**
 * The variable that names the file of the CA the workbench's PostgreSQL part signs its servers' certificates with,
 * which every verify-full client of a member reads.
 */
export const caVariable = "PGSSLROOTCERT"

/**
 * The names of `family`'s members, `<family>-<i>` for each of the members its sizing gives a full-width run
 * (settings.ts membersOf).
 */
export const memberNames = (family: CheckoutFamily): Arr.NonEmptyReadonlyArray<string> =>
	memberNamesOf(family, membersOf(family.cluster.sizing, testWorkers))

/** A member's socket directory, its unit's runtime directory: `$XDG_RUNTIME_DIR/postgresql-<name>`. */
const socketOf = (name: string): Effect.Effect<string, ClusterFailed> =>
	Effect.mapBoth(Config.String("XDG_RUNTIME_DIR"), {
		onFailure: () =>
			ClusterFailed.make({
				cluster: name,
				message: "XDG_RUNTIME_DIR is unset: a member's socket is in its unit's runtime directory"
			}),
		onSuccess: (runtime) => `${runtime}/postgresql-${name}`
	})

/**
 * The files a family's state holds (family.ts stateOf, `<statesHome>/<family>`, beside no server's data): its owner's
 * password, its hba file (each member's hba_file) and its unrelated CA, beside the checkout it records.
 */
const stateFiles = (state: string) => ({
	password: `${state}/owner.password`,
	hba: `${state}/pg_hba.conf`,
	wrongCa: `${state}/wrong-ca.crt`
})

/** A socket file's name: PostgreSQL's `.s.PGSQL.<port>`. */
const socketFile = regex("^\\.s\\.PGSQL\\.([0-9]{1,5})$")

/**
 * The member at `name` as its socket directory holds it now: the port its socket file is named by, which the unit's
 * server listens on (5432, PostgreSQL's default, until settle gives it its spec's).
 */
const socketNow = (
	name: string,
	step: Step
): Effect.Effect<SocketAt, ClusterFailed, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const socket = yield* socketOf(name)
		const listed = yield* Effect.mapError(fs.readDirectory(socket), (error) =>
			failed(
				step,
				`${socket}: ${error.message}: is ${unitOf(name)} running? \`toolchain-pg settle\` starts it`
			)
		)
		const ports = Arr.getSomes(
			Arr.map(listed, (entry) =>
				Option.map(Option.fromNullishOr(socketFile.exec(entry)), ([, port]) => Number(port))
			)
		)
		const port = yield* Effect.mapError(Effect.fromOption(Arr.head(ports)), () =>
			failed(step, `${socket} holds no socket: is ${unitOf(name)} running?`)
		)
		const at: SocketAt = { socket, port }
		return at
	})

/** An identifier quoted for SQL. */
const ident = (name: string): string => `"${Str.replaceAll('"', '""')(name)}"`

/** A text quoted as an SQL literal. */
const literal = (text: string): string => `'${Str.replaceAll("'", "''")(text)}'`

/** What the hba file every member of `cluster` reads holds: the account over the socket, every role over TLS by SCRAM. */
const hbaOf = (cluster: LocalCluster): string =>
	Arr.join(
		[
			"# A local cluster of the toolchain's (@bjornpagen/testing/pg, settle.ts), written by `toolchain-pg settle`.",
			"local   all   all                    trust",
			...(cluster.network.kind === "tls"
				? [
						"hostssl all   all        127.0.0.1/32  scram-sha-256",
						"hostssl all   all        ::1/128       scram-sha-256"
					]
				: []),
			""
		],
		"\n"
	)

/**
 * PostgreSQL's port, which a member reached over its socket alone keeps: its socket file's name, in a directory of its
 * own.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit port
 * @scope the port of a member whose network is its socket alone
 * @constraint configurable default
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/misc/guc_parameters.dat
 * @quote boot_val => 'DEF_PGPORT',
 * @verified 2026-11-21
 */
const defaultPort = 5432

/** The CA file the workbench's PostgreSQL part names (caVariable), for `step`. */
const caFileOf = (step: Step): Effect.Effect<string, ClusterFailed> =>
	Effect.mapError(Config.String(caVariable), () =>
		failed(
			step,
			`${caVariable} is unset: the workbench's PostgreSQL part names the CA its servers' certificates chain to`
		)
	)

/**
 * The settings a member of `cluster` at `port` holds exactly, on a server of `blockSize` bytes a page: every member's
 * (fixedSettings), its sizing's over the machine's memory (sizedSettings), its hba file, and over TLS its port (its
 * family's claim) and localhost's listener, which its unit opts into by them (the workbench's postgres@ part listens on
 * no network until a cluster's own postgresql.auto.conf says so) and TLS on, which the part's included tls.conf gives
 * every member, with the server certificate its CA (caVariable) signed.
 */
const expectedSettings = (
	cluster: LocalCluster,
	port: number,
	hba: string,
	blockSize: number
): ReadonlyArray<Setting> => {
	const members = membersOf(cluster.sizing, testWorkers)
	return [
		...fixedSettings(cluster),
		...sizedSettings(cluster, members, shareOf(testWorkers, members), totalmem(), blockSize),
		["hba_file", hba],
		...(cluster.network.kind === "tls"
			? ([
					["port", `${port}`],
					["listen_addresses", "localhost"],
					["ssl", "on"]
				] satisfies ReadonlyArray<Setting>)
			: [])
	]
}

/**
 * How a member departs from its spec, a setting at a time: one the spec states that the member holds otherwise
 * (`held`: what the spec states and what the member holds), or one ALTER SYSTEM wrote to the member's
 * postgresql.auto.conf that the spec does not state (`unstated`: what was written), left by a spec of before or by a
 * person. The spec is the whole of what ALTER SYSTEM holds for a member, so a settle resets an unstated one, and a run
 * refuses a member that holds either.
 */
type Drift =
	| Readonly<{ kind: "held"; name: string; expected: string; actual: string }>
	| Readonly<{ kind: "unstated"; name: string; written: string }>

/**
 * What the drift query prints of a setting, between bars: whether the row is pg_settings' value of a setting the spec
 * states (`held`) or postgresql.auto.conf's line of one it does not (`written`), the setting's name, and its value.
 */
const settingRow = regex("^(held|written)\\|([^|]+)\\|(.*)$")

/** A drift as a report states it. */
const driftText = (drift: Drift): string =>
	drift.kind === "held"
		? `${drift.name} ${drift.actual} where its spec states ${drift.expected}`
		: `${drift.name} ${drift.written} written by ALTER SYSTEM, which its spec does not state`

/**
 * How the member at `at` departs from `expected` (Drift): each setting of `expected` it holds otherwise, as pg_settings
 * states its value, and each setting its postgresql.auto.conf holds that `expected` does not name (pg_file_settings,
 * the lines of the configuration files as the server reads them, of the one in its data directory that ALTER SYSTEM
 * writes). A setting's name is matched without its case, as PostgreSQL matches it: ALTER SYSTEM writes TimeZone as
 * `timezone`.
 */
const differing = (
	bin: string,
	at: SocketAt,
	expected: ReadonlyArray<Setting>,
	step: Step
): Effect.Effect<ReadonlyArray<Drift>, ClusterFailed, ChildProcessSpawner.ChildProcessSpawner> => {
	const names = Arr.join(
		Arr.map(expected, ([name]) => literal(name)),
		", "
	)
	const lowered = Arr.join(
		Arr.map(expected, ([name]) => literal(Str.toLowerCase(name))),
		", "
	)
	return Effect.map(
		adminSql(
			bin,
			at,
			"postgres",
			[
				`SELECT 'held', name, setting FROM pg_catalog.pg_settings WHERE name IN (${names}) UNION ALL SELECT 'written', name, setting FROM pg_catalog.pg_file_settings WHERE sourcefile = pg_catalog.current_setting('data_directory') || '/postgresql.auto.conf' AND pg_catalog.lower(name) NOT IN (${lowered})`
			],
			{ ...step, doing: `${step.doing}: reading its settings` }
		),
		(lines) => {
			const rows = Arr.getSomes(
				Arr.map(lines, (line) =>
					Option.map(
						Option.fromNullishOr(settingRow.exec(line)),
						([, source = "", name = "", value = ""]) => ({ source, name, value })
					)
				)
			)
			const held = new Map(
				Arr.map(
					Arr.filter(rows, (row) => row.source === "held"),
					(row) => [row.name, row.value] as const
				)
			)
			return [
				...Arr.flatMap(expected, ([name, value]): ReadonlyArray<Drift> => {
					const actual = held.get(name) ?? "(absent)"
					return actual === value ? [] : [{ kind: "held", name, expected: value, actual }]
				}),
				...Arr.map(
					Arr.filter(rows, (row) => row.source === "written"),
					(row): Drift => ({ kind: "unstated", name: row.name, written: row.value })
				)
			]
		}
	)
}

/** A setting's name as ALTER SYSTEM reads it: each part of a dotted name an identifier, quoted. */
const settingName = (name: string): string =>
	Arr.join(
		Arr.map(Str.split(".")(name), (part) => `"${Str.replaceAll('"', '""')(part)}"`),
		"."
	)

/** The statement that undoes `drift` (Drift): the spec's value set again, or an unstated setting reset. */
const undone = (drift: Drift, expected: ReadonlyArray<Setting>): string =>
	drift.kind === "held"
		? `ALTER SYSTEM SET ${settingLine(
				Option.getOrElse(
					Arr.findFirst(expected, ([named]) => named === drift.name),
					(): Setting => [drift.name, ""]
				)
			)}`
		: `ALTER SYSTEM RESET ${settingName(drift.name)}`

/** A member's server's page size, as it states it. */
const blockSizeOf = (bin: string, at: SocketAt, step: Step) =>
	Effect.flatMap(
		adminSql(bin, at, "postgres", ["SHOW block_size"], {
			...step,
			doing: `${step.doing}: reading its block size`
		}),
		(lines) =>
			Effect.mapError(
				Effect.fromOption(Option.filter(Option.map(Arr.head(lines), Number), Number.isInteger)),
				() => failed(step, `SHOW block_size printed [${Arr.join(lines, "\n")}]`)
			)
	)

/** `systemctl --user <verb> <unit>` for `step`, to its end: systemd starts a member's unit once it is ready (Type=notify). */
const systemctl = (verb: "start" | "restart", name: string, step: Step) =>
	Effect.asVoid(
		succeeded(
			{ ...step, doing: `${step.doing}: systemctl --user ${verb} ${unitOf(name)}` },
			ChildProcess.make("systemctl", ["--user", verb, unitOf(name)])
		)
	)

/** A file of a cluster's state written, this account's alone. */
const written = (step: Step, file: string, text: string) =>
	Effect.flatMap(FileSystem.FileSystem, (fs) =>
		Effect.mapError(
			Effect.andThen(fs.writeFileString(file, text), fs.chmod(file, 0o600)),
			(error) => failed(step, `${file}: ${error.message}`)
		)
	)

/** A file of a cluster's state, if it holds one. */
const readIfThere = (file: string) =>
	Effect.flatMap(FileSystem.FileSystem, (fs) =>
		Effect.orElseSucceed(
			Effect.map(fs.readFileString(file), (text) => Option.some(Str.trim(text))),
			() => Option.none<string>()
		)
	)

/**
 * The owner role with `password`, its grants, the template and its extensions, and the owner's own database with each
 * preloaded library's extension, in the member at `at`, as the bootstrap superuser makes them: each made where absent
 * and given what every member's holds where present (the role its attributes, password and grants, the template its
 * owner and IS_TEMPLATE).
 */
/**
 * The table in the owner's database that records which checkout claims which template (resources/template.ts claim,
 * resources/collect.ts): made by settle, the one writer of a cluster's structure, owned by the owner, whose sessions
 * write it.
 */
export const templateClaimsTable = "toolchain_template_claims"

const owned = (cluster: LocalCluster, bin: string, at: SocketAt, password: string, step: Step) =>
	Effect.gen(function* () {
		const owner = ident(cluster.owner)
		const template = ident(cluster.template)
		const doing = (what: string): Step => ({ ...step, doing: `${step.doing}: ${what}` })
		const [held = ""] = yield* adminSql(
			bin,
			at,
			"postgres",
			[
				`SELECT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = ${literal(cluster.owner)}), EXISTS (SELECT FROM pg_catalog.pg_database WHERE datname = ${literal(cluster.template)}), EXISTS (SELECT FROM pg_catalog.pg_database WHERE datname = ${literal(cluster.owner)})`
			],
			doing("what it holds of its owner and template")
		)
		const [role, hasTemplate, database] = Arr.map(Str.split(held, "|"), (flag) => flag === "t")
		const attributes = `LOGIN CREATEDB CREATEROLE REPLICATION PASSWORD ${literal(password)}`
		yield* adminSql(
			bin,
			at,
			"postgres",
			[
				role ? `ALTER ROLE ${owner} ${attributes}` : `CREATE ROLE ${owner} ${attributes}`,
				...Arr.map(
					cluster.ownerParameters,
					(name) => `GRANT SET ON PARAMETER ${ident(name)} TO ${owner}`
				),
				`GRANT pg_read_all_stats TO ${owner} WITH ADMIN TRUE, INHERIT FALSE, SET TRUE`,
				`GRANT pg_signal_backend TO ${owner}`,
				...(hasTemplate === true
					? [
							`ALTER DATABASE ${template} OWNER TO ${owner}`,
							`ALTER DATABASE ${template} WITH IS_TEMPLATE true ALLOW_CONNECTIONS true`
						]
					: [
							`CREATE DATABASE ${template} OWNER ${owner} TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' LOCALE 'C.UTF-8' IS_TEMPLATE true`
						])
			],
			doing("its owner and template")
		)
		yield* Arr.match(
			Arr.flatMap(cluster.extensions, ({ name, schema }) => [
				`CREATE SCHEMA IF NOT EXISTS ${ident(schema)} AUTHORIZATION ${owner}`,
				`CREATE EXTENSION IF NOT EXISTS ${ident(name)} SCHEMA ${ident(schema)}`
			]),
			{
				onEmpty: () => Effect.void,
				onNonEmpty: (statements) =>
					Effect.asVoid(
						adminSql(bin, at, cluster.template, statements, doing("its template's extensions"))
					)
			}
		)
		yield* adminSql(
			bin,
			at,
			"postgres",
			Arr.append(
				database === true ? [] : [`CREATE DATABASE ${owner} OWNER ${owner} TEMPLATE ${template}`],
				`ALTER DATABASE ${template} ALLOW_CONNECTIONS false`
			),
			doing("its owner's database")
		)
		yield* adminSql(
			bin,
			at,
			cluster.owner,
			[
				`CREATE TABLE IF NOT EXISTS public.${templateClaimsTable} (template text NOT NULL, checkout text NOT NULL, logical text NOT NULL, claimed timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(), PRIMARY KEY (template, checkout))`,
				`ALTER TABLE public.${templateClaimsTable} OWNER TO ${owner}`,
				...Arr.map(cluster.preload, (library) => `CREATE EXTENSION IF NOT EXISTS ${ident(library)}`)
			],
			doing("its template claims and its preloaded libraries' extensions")
		)
	})

/**
 * The port of each of `family`'s members, member i's the i-th (`count` of them): over TLS, the ports its family claims
 * (family.ts portsClaimed: claimed at its first settle, from the spec's first port, and kept), and over its socket alone
 * PostgreSQL's default, a socket file's name in a directory of its own.
 */
const portsOf = (family: CheckoutFamily, count: number, step: Step) => {
	const { network } = family.cluster
	return network.kind === "tls"
		? portsClaimed(family, count, network.from, step)
		: Effect.succeed(Array.from({ length: count }, () => defaultPort))
}

/**
 * Member `name`'s port, `port`, held by nothing but the member's own unit, else its settle refused, naming each other
 * holder (family.ts portHolders): its unit, a run's, a terminal's scope, by its pid. A family's members listen only at
 * the ports it claims, and a claim is made only where no family claims and nothing listens, so another listener there
 * took it outside the claims (a cluster made before families at a port of its own, a test's family claiming in homes of
 * its own, a listener a person started) while the member was stopped; started there, the member's server would fail to
 * bind it, or bind one loopback of two beside the other listener. Socket-only members listen at no TCP port.
 */
const portFree = (name: string, port: number, step: Step) =>
	Effect.gen(function* () {
		const holders = yield* portHolders(port, step)
		const others = Arr.filter(
			holders,
			(holder) => holder.kind === "unseen" || holder.unit !== unitOf(name)
		)
		if (Arr.isReadonlyArrayNonEmpty(others)) {
			return yield* failed(
				step,
				`its port ${port}, its family's claim, is held by ${Arr.join(Arr.map(others, holderText), " and ")}: stop that listener, then settle again`
			)
		}
	})

/**
 * Member `name`'s data directory in `data` (`<data>/<name>`) removed where it is a link that names nothing: a member in
 * memory whose files went with its unit's stop or with a restart of the machine, which the workbench's postgres@ unit
 * refuses to start bare rather than make it again as initdb leaves a cluster, its spec gone with its files
 * (~/Documents/beefy-workspace/workbench/parts/postgres/files/postgres-cluster). With the link gone the member's start
 * makes it again, and the settle gives it its spec. A data directory that holds a cluster, on disk or in memory, and
 * one that is not there are left as they are.
 */
const freedForgotten = (data: string, name: string, step: Step) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = `${data}/${name}`
		const linked = yield* Effect.isSuccess(fs.readLink(path))
		const named = yield* Effect.orElseSucceed(fs.exists(path), () => false)
		if (linked && !named) {
			yield* Effect.mapError(fs.remove(path), (error) =>
				failed(step, `${path}, a link to a freed member's data: ${error.message}`)
			)
		}
	})

/**
 * What every read and every member's settle of `family` takes from its state, writing nothing: its owner's password,
 * its state's files (stateFiles), how a client verifies its members (over TLS the CA the workbench's part names,
 * caVariable, and the family's unrelated CA), each member's name and port (its family's claim, over TLS) in member
 * order, and the server's bin directory. A family whose state lacks any of them, never settled, fails, naming
 * `toolchain-pg settle`.
 */
type FamilyState = Readonly<{
	password: string
	files: ReturnType<typeof stateFiles>
	tls: MemberTls
	members: ReadonlyArray<readonly [name: string, port: number]>
	bin: string
}>

/** A refusal of `family` for `why`, at `step`, naming the command that gives its family its spec. */
const unsettledOf =
	(family: CheckoutFamily, step: Step) =>
	(why: string): ClusterFailed =>
		failed(
			step,
			`${why}: run \`pnpm exec toolchain-pg settle\` (as a unit) in ${family.checkout} to give its family its spec`
		)

/** `family`'s state as its reads and its members' settles take it (FamilyState). */
const familyState = (
	family: CheckoutFamily,
	step: Step
): Effect.Effect<FamilyState, ClusterFailed, Platform> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const { cluster } = family
		const unsettled = unsettledOf(family, step)
		const files = stateFiles(stateOf(family))
		const keptPassword = yield* readIfThere(files.password)
		const password = yield* Effect.mapError(Effect.fromOption(keptPassword), () =>
			unsettled(`${files.password} holds no owner password`)
		)
		const tlsOf = Effect.gen(function* () {
			const caFile = yield* caFileOf(step)
			const ca = yield* Effect.mapError(fs.readFileString(caFile), (error) =>
				failed(step, `${caFile}: ${error.message}`)
			)
			const keptWrongCa = yield* readIfThere(files.wrongCa)
			const wrongCa = yield* Effect.mapError(Effect.fromOption(keptWrongCa), () =>
				unsettled(`${files.wrongCa} holds no unrelated CA`)
			)
			const verified: MemberTls = { kind: "tls", ca, caFile, wrongCa }
			return verified
		})
		const socketOnly: MemberTls = { kind: "socket" }
		const tls = cluster.network.kind === "tls" ? yield* tlsOf : socketOnly
		const names = memberNames(family)
		const ports =
			cluster.network.kind === "tls"
				? yield* portsHeld(family)
				: Array.from({ length: names.length }, () => defaultPort)
		if (ports.length < names.length) {
			return yield* unsettled(
				`its family claims ${ports.length} ports for its ${names.length} members`
			)
		}
		const bin = yield* serverBin(step)
		const state: FamilyState = { password, files, tls, members: Arr.zip(names, ports), bin }
		return state
	})

/** Member `index`'s name and port in `state`, or a failure at `step` naming the members there are. */
const memberIn = (state: FamilyState, index: number, step: Step) =>
	Effect.mapError(Effect.fromOption(Arr.get(state.members, index)), () =>
		failed(step, `it has no member ${index}: its members are 0 to ${state.members.length - 1}`)
	)

/**
 * Member `index` of `family` as a run reads it from `state`, writing nothing: its socket and port, its settings against
 * its spec's and its template claims table. A member whose unit runs no server, or that holds a setting other than its
 * spec states, fails, naming `toolchain-pg settle`.
 */
const memberReadIn = (
	family: CheckoutFamily,
	state: FamilyState,
	index: number
): Effect.Effect<PgMember, ClusterFailed, Platform> =>
	Effect.gen(function* () {
		const { cluster } = family
		const step: Step = { cluster: family.name, doing: `reading its member ${index}` }
		const unsettled = unsettledOf(family, step)
		const [name, port] = yield* memberIn(state, index, step)
		const socket = yield* Effect.mapError(socketNow(name, step), (error) =>
			unsettled(error.message)
		)
		const blockSize = yield* blockSizeOf(state.bin, socket, step)
		const differs = yield* differing(
			state.bin,
			socket,
			expectedSettings(cluster, port, state.files.hba, blockSize),
			step
		)
		if (Arr.isReadonlyArrayNonEmpty(differs)) {
			return yield* unsettled(`${name} holds ${Arr.join(Arr.map(differs, driftText), ", ")}`)
		}
		const [claims = "f"] = yield* Effect.mapError(
			adminSql(
				state.bin,
				socket,
				cluster.owner,
				[`SELECT pg_catalog.to_regclass('public.${templateClaimsTable}') IS NOT NULL`],
				{ ...step, doing: `${step.doing}: reading its template claims table` }
			),
			(error) => unsettled(error.message)
		)
		if (claims !== "t") {
			return yield* unsettled(`${name} holds no template claims table (${templateClaimsTable})`)
		}
		const member: PgMember = {
			name,
			socket: socket.socket,
			port,
			owner: cluster.owner,
			password: Redacted.make(state.password),
			passwordFile: state.files.password,
			tls: state.tls
		}
		return member
	})

/**
 * Member `index` of `family` as a run reads it, writing nothing: what its family's state holds for it (the owner's
 * password, its port, and over TLS the CA the workbench's part names and the family's unrelated CA), its socket, its
 * settings against its spec's and its template claims table. A member whose unit runs no server, whose port its family
 * does not claim, or that holds a setting other than its spec states, fails, naming `toolchain-pg settle`. A read
 * starts nothing and changes no server: a worker's first need brings up its own member (memberBroughtUp).
 */
export const memberRead = (
	family: CheckoutFamily,
	index: number
): Effect.Effect<PgMember, ClusterFailed, Platform> =>
	Effect.flatMap(familyState(family, { cluster: family.name, doing: "reading it" }), (state) =>
		memberReadIn(family, state, index)
	)

/**
 * The member of `family` whose port its family's claims give as `port` (over its socket alone every member is at
 * PostgreSQL's default port, so the first), read as a run reads it (memberRead), reading no other member: what a process
 * its parent lent a member by its port reaches (grizzle's command line children, which read a member a command). A port
 * no member of the family is at fails, naming the members' ports.
 */
export const memberAtPort = (
	family: CheckoutFamily,
	port: number
): Effect.Effect<PgMember, ClusterFailed, Platform> =>
	Effect.gen(function* () {
		const step: Step = { cluster: family.name, doing: `reading its member at port ${port}` }
		const state = yield* familyState(family, step)
		const index = yield* Effect.mapError(
			Effect.fromOption(Arr.findFirstIndex(state.members, ([, held]) => held === port)),
			() =>
				failed(
					step,
					`no member of it is at port ${port}: its members are at ${Arr.join(
						Arr.map(state.members, ([, held]) => `${held}`),
						", "
					)}`
				)
		)
		return yield* memberReadIn(family, state, index)
	})

/**
 * `family`'s members that run now, in member order, each read as a run reads it (memberRead): a member whose socket
 * directory holds no socket, its unit stopped or never started, is not among them. What collection reads
 * (resources/collect.ts) and `toolchain-pg check`: a family runs only the members its runs' workers reached.
 */
export const membersRunning = (
	family: CheckoutFamily
): Effect.Effect<ReadonlyArray<PgMember>, ClusterFailed, Platform> =>
	Effect.gen(function* () {
		const step: Step = { cluster: family.name, doing: "reading the members that run" }
		const state = yield* familyState(family, step)
		const running = yield* Effect.filter(
			Arr.map(state.members, (_, index) => index),
			(index) =>
				Effect.flatMap(memberIn(state, index, step), ([name]) =>
					Effect.isSuccess(socketNow(name, step))
				)
		)
		return yield* Effect.forEach(running, (index) => memberReadIn(family, state, index), {
			concurrency: "unbounded"
		})
	})

/**
 * `family`'s state settled, its members' own parts aside (memberSettled): first every family of its cluster whose
 * checkout is gone removed (family.ts familiesCollected), then its state (the checkout it records; the owner's
 * password, kept once made; its hba file; its unrelated CA) and the ports of all its members (portsOf), claimed at once,
 * so each member's port stays its own however many of them run.
 */
const familySettled = (family: CheckoutFamily): Effect.Effect<void, ClusterFailed, Platform> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const { cluster } = family
		const step: Step = { cluster: family.name, doing: "settling it" }
		yield* familiesCollected(family.homes, cluster.unit)
		const state = stateOf(family)
		const files = stateFiles(state)
		yield* Effect.mapError(fs.makeDirectory(state, { recursive: true }), (error) =>
			failed(step, `${state}: ${error.message}`)
		)
		yield* checkoutRecorded(family, step)
		const kept = yield* readIfThere(files.password)
		if (Option.isNone(kept)) {
			const fresh = yield* freshPassword(step)
			yield* written(step, files.password, `${fresh}\n`)
		}
		yield* written(step, files.hba, hbaOf(cluster))
		const unrelated = yield* readIfThere(files.wrongCa)
		if (cluster.network.kind === "tls" && Option.isNone(unrelated)) {
			const pem = yield* unrelatedCa(step, "/CN=toolchain unrelated CA")
			yield* written(step, files.wrongCa, pem)
		}
		yield* portsOf(family, memberNames(family).length, step)
	})

/**
 * Member `index` of `family` settled in this process from its family's state (familyState, which a family never settled
 * lacks): over TLS its port refused where another listener holds it (portFree), a freed member's link to nothing
 * removed (freedForgotten), its unit started (systemd makes it on its first start, and again after it was freed), every
 * setting its spec states written by ALTER SYSTEM and read again (pg_reload_conf), what the bootstrap superuser makes in
 * it (owned), and its unit restarted when a setting it changed waits for a restart (pg_settings' pending_restart),
 * which only a fresh member, a change of the spec or of the machine's memory makes; then it is read as a run reads it
 * (memberRead), which fails if it is still not as its spec states. What the member's settle unit runs (settleUnit,
 * `toolchain-pg settle <index>`), so a member has one settle at a time.
 */
export const memberSettled = (
	family: CheckoutFamily,
	index: number
): Effect.Effect<PgMember, ClusterFailed, Platform> =>
	Effect.gen(function* () {
		const { cluster } = family
		const at: Step = { cluster: family.name, doing: `settling its member ${index}` }
		const state = yield* familyState(family, at)
		const [name, port] = yield* memberIn(state, index, at)
		const { bin, files, password } = state
		if (cluster.network.kind === "tls") {
			yield* portFree(name, port, at)
		}
		yield* freedForgotten(family.homes.data, name, at)
		yield* systemctl("start", name, at)
		const socket = yield* socketNow(name, at)
		const blockSize = yield* blockSizeOf(bin, socket, at)
		const expected = expectedSettings(cluster, port, files.hba, blockSize)
		const changed = yield* differing(bin, socket, expected, at)
		yield* Arr.match(changed, {
			onEmpty: () => Effect.void,
			onNonEmpty: (settings) =>
				Effect.asVoid(
					adminSql(
						bin,
						socket,
						"postgres",
						Arr.append(
							Arr.map(settings, (drift) => undone(drift, expected)),
							"SELECT pg_catalog.pg_reload_conf()"
						),
						{ ...at, doing: `${at.doing}: ALTER SYSTEM` }
					)
				)
		})
		yield* owned(cluster, bin, socket, password, at)
		const [pending = "0"] = yield* adminSql(
			bin,
			socket,
			"postgres",
			["SELECT pg_catalog.count(*) FROM pg_catalog.pg_settings WHERE pending_restart"],
			{ ...at, doing: `${at.doing}: reading what waits for a restart` }
		)
		if (pending !== "0") {
			yield* systemctl("restart", name, at)
		}
		return yield* memberReadIn(family, state, index)
	})

/**
 * How a member of a family is settled where a worker's first need finds it absent or not as its spec states
 * (memberBroughtUp): by its settle unit (unitSettled), or, in a test of a case's cluster, which no package's
 * pg.config.ts states, in the case's own process (memberSettled).
 */
export type MemberSettle = (
	family: CheckoutFamily,
	index: number
) => Effect.Effect<unknown, ClusterFailed, Platform>

/**
 * Member `index` of `family` as a worker's first need reaches it: read (memberRead), and where the read refuses it
 * (absent, freed by its stop, or not as its spec states) settled by `settle` and read again. So a run brings up the
 * members its workers reach and no other, each by the worker that reaches it. A settle that fails is the worker's
 * failure, with what the settle said; one that succeeds is answered by the read after it.
 */
export const memberBroughtUp = (
	family: CheckoutFamily,
	index: number,
	settle: MemberSettle
): Effect.Effect<PgMember, ClusterFailed, Platform> =>
	Effect.catch(memberRead(family, index), () =>
		Effect.flatMap(Effect.result(settle(family, index)), (settling) =>
			Effect.mapError(memberRead(family, index), (refused) =>
				Result.isFailure(settling) ? settling.failure : refused
			)
		)
	)

/**
 * Settles `family` as `toolchain-pg settle` does: its state (familySettled), then its first member, the one `env`,
 * `psql` and `admin` reach, brought up as a worker brings up its own (memberBroughtUp, by `settle`). Its other members
 * its runs' workers bring up, each the one it reaches, on its first need. A run never settles a family's state.
 */
export const settled = (
	family: CheckoutFamily,
	settle: MemberSettle
): Effect.Effect<PgMember, ClusterFailed, Platform> =>
	Effect.andThen(familySettled(family), memberBroughtUp(family, 0, settle))

/** What a settle unit settles: a family's state and its first member (settled), or one member (memberSettled). */
export type SettleTarget =
	| Readonly<{ kind: "family" }>
	| Readonly<{ kind: "member"; index: number }>

/**
 * The variable a settle unit runs its settle with: present, `toolchain-pg settle` settles in its own process; absent, it
 * starts the settle's unit (settleUnit) and waits on it, so every settle of a family, and every settle of a member,
 * runs as the one unit its name gives.
 */
export const settlingVariable = "TOOLCHAIN_PG_SETTLING"

/** The command a settle unit runs: this package's `toolchain-pg`, which strips the types of its TypeScript source. */
const settleProgram = process
	.getBuiltinModule("node:url")
	.fileURLToPath(new URL("../../scripts/toolchain-pg.sh", import.meta.url))

/**
 * `target`'s settle as its unit: `<family>-settle` for its family, `<member>-settle` for a member, in its cluster's
 * repository's slice (its unit name's first word), run with `toolchain-pg settle [index]` in this process's working
 * directory, whose pg.config.ts states the cluster, and given the family's checkout, so it settles that family wherever
 * systemd starts it. Type=oneshot, so `systemctl --user start` of the unit while it runs joins its start and returns as
 * it ends (unitSettled). `systemd-run --wait --pipe` answers the unit's exit status and is refused at once while the
 * unit runs.
 */
export const settleUnit = (
	family: CheckoutFamily,
	target: SettleTarget,
	stdio: "inherit" | "pipe"
): Readonly<{ unit: string; command: ChildProcess.Command }> => {
	const named = target.kind === "family" ? family.name : `${family.name}-${target.index}`
	const unit = `${named}-settle`
	const slice = `${Option.getOrElse(Arr.head(Str.split(family.cluster.unit, "-")), () => family.cluster.unit)}.slice`
	return {
		unit,
		command: ChildProcess.make(
			"systemd-run",
			[
				"--user",
				"-d",
				"-u",
				unit,
				`--slice=${slice}`,
				"-p",
				"Type=oneshot",
				"--wait",
				"--pipe",
				"--collect",
				"-E",
				`${settlingVariable}=1`,
				"-E",
				`${checkoutVariable}=${family.checkout}`,
				"--",
				"/bin/sh",
				settleProgram,
				"settle",
				...(target.kind === "family" ? [] : [`${target.index}`])
			],
			{ stdin: stdio, stdout: stdio, stderr: stdio }
		)
	}
}

/**
 * A member's settle as its unit (settleUnit), as a run's worker settles the member it reaches: run, and where that
 * fails, the unit joined (`systemctl --user start`, which waits on the unit while another process's settle of the
 * member runs, and finds none once it has ended), its failure kept for memberBroughtUp to give where the member's read
 * still refuses it after.
 */
export const unitSettled: MemberSettle = (family, index) => {
	const { unit, command } = settleUnit(family, { kind: "member", index }, "pipe")
	const step: Step = { cluster: family.name, doing: `settling its member ${index} as ${unit}` }
	return Effect.tapError(succeeded(step, command), () =>
		Effect.ignore(
			succeeded(step, ChildProcess.make("systemctl", ["--user", "start", `${unit}.service`]))
		)
	)
}
