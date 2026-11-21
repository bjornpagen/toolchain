import { regex } from "arkregex"
import {
	Array as Arr,
	Config,
	Effect,
	FileSystem,
	Option,
	Redacted,
	Schema,
	String as Str
} from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { lockHeld } from "#pg/hold.ts"
import { capacityFile } from "#pg/lease.ts"
import { freePort, portFree } from "#pg/ports.ts"
import {
	BOOTSTRAP_SUPERUSER,
	adminSql,
	type ClusterFailed,
	failed,
	PortLost,
	freshPassword,
	issueTls,
	osUser,
	program,
	reload,
	restart,
	running,
	serverBin,
	serverVersion,
	type Step,
	start,
	stop,
	succeeded,
	tlsCurrent
} from "#pg/server.ts"
import {
	fixedSettings,
	membersOf,
	type Setting,
	settingLine,
	shareOf,
	sizedSettings
} from "#pg/settings.ts"
import { ClusterPort, type LocalCluster } from "#pg/spec.ts"
import {
	type ClusterState,
	clusterState,
	disagreements,
	grantsAgree,
	type MadeFor,
	MadeForFile,
	type Manifest,
	ManifestFile,
	madeAs,
	type MemberState
} from "#pg/state.ts"
import { testWorkers } from "#workers.ts"

/**
 * A member of a cluster as a client reaches it: its name (its port, unique among its cluster's members), its port on
 * localhost and its Unix socket's directory (where the bootstrap superuser connects by peer authentication), the owner
 * role and its password (and the file that holds it, for a script's PGPASSWORD), and the PEM text of the local CA every verify-full connection chains the server's certificate
 * to, with its file for a client that reads one (psql, a connection URL's sslrootcert), and of an unrelated CA that
 * signed nothing the server presents, for the refusal checks.
 */
export type PgMember = Readonly<{
	name: string
	port: number
	socket: string
	owner: string
	password: Redacted.Redacted
	passwordFile: string
	ca: string
	caFile: string
	wrongCa: string
	lease: string
}>

/** The platform a cluster's life runs on: its processes and its files. */
export type Platform = ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem

/**
 * The variable that names a cluster other than the spec's for a process and every child it starts: a port in canonical
 * decimal, a private cluster of the same spec on a port of its own (a lane's experiment, a run that must not share).
 * Unset, a process reaches its spec's cluster (spec.ts LocalCluster port), the one documented default; a name that is
 * no port, or a port spelled otherwise (a sign, a leading zero), fails rather than reaching the spec's.
 */
export const clusterVariable = "TOOLCHAIN_PG_CLUSTER"

/** The cluster `cluster`'s spec reaches in this process's environment (clusterVariable). */
export const reachedPort = (cluster: LocalCluster): Effect.Effect<ClusterPort, ClusterFailed> =>
	Effect.flatMap(
		Effect.mapError(
			Config.option(
				Config.all({ port: Config.Port(clusterVariable), text: Config.String(clusterVariable) })
			),
			(error) =>
				failed({ cluster: cluster.port, doing: `reading ${clusterVariable}` }, error.message)
		),
		Option.match({
			onNone: () => Effect.succeed(cluster.port),
			onSome: ({ port, text }) =>
				String(port) === text && port > 0
					? Effect.succeed(ClusterPort(port))
					: Effect.fail(
							failed(
								{ cluster: cluster.port, doing: `reading ${clusterVariable}` },
								`"${text}" names no cluster: a port in canonical decimal it must be`
							)
						)
		})
	)

/** A cluster's life, as every operation reads it: its spec, its state, the server's bin directory and version. */
type Life = Readonly<{
	cluster: LocalCluster
	state: ClusterState
	bin: string
	server: string
}>

/** The step `doing` of the cluster `life` is. */
const stepOf = (life: Life, doing: string): Step => ({ cluster: life.state.port, doing })

/** `cluster`'s life in this process: the cluster it reaches (reachedPort), its state, its server's bin and version. */
const lifeOf = (
	cluster: LocalCluster
): Effect.Effect<Life, ClusterFailed, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.gen(function* () {
		const port = yield* reachedPort(cluster)
		const step: Step = { cluster: port, doing: "finding its server" }
		const bin = yield* serverBin(cluster, step)
		return {
			cluster,
			state: yield* clusterState(port),
			bin,
			server: yield* serverVersion(bin, step)
		}
	})

/**
 * Runs `operation` under the cluster's lock (hold.ts lockHeld), so of every process that would make, start, stop or
 * destroy the same cluster at once (the runner's workers, each opening the cluster as a need, a person's command,
 * another repository's checkout of the same port), one at a time acts and the rest find what it left: a cluster made
 * once, a server started once. A waiter waits in the kernel, the one wait of a cluster's life on another process: under
 * the lock every step is this process's own and stays watched, and a server another process started already accepts
 * connections when its starter lets the lock go (pg_ctl's --wait ends first). A holder that dies frees the lock with it.
 */
const underLock = <A, E, R>(
	life: Life,
	operation: Effect.Effect<A, E, R>
): Effect.Effect<A, E | ClusterFailed, R | Platform> =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const step = stepOf(life, `taking its lock ${life.state.lock}`)
			const lockFailed = (error: { readonly message: string }) => failed(step, error.message)
			yield* Effect.mapError(fs.makeDirectory(life.state.base, { recursive: true }), lockFailed)
			yield* Effect.mapError(lockHeld(life.state.lock), lockFailed)
			return yield* operation
		})
	)

/** Node's file system: a cluster's manifest is read synchronously, so a reader of a made cluster needs no runtime. */
const files = process.getBuiltinModule("node:fs")

/**
 * The manifest of the cluster whose state is `state` when one is written, decoded; a file that is no manifest fails.
 * It is read synchronously, the one file read, so a caller that runs it with Effect.runSync (a repository's config
 * building its connection: madeMembers) reads it as every bring-up does.
 */
/** A cluster's manifest file read as `file` decodes it, none when no manifest is written. */
const recordRead =
	<A>(file: Schema.Codec<A, string>) =>
	(state: ClusterState): Effect.Effect<Option.Option<A>, ClusterFailed> => {
		const step: Step = { cluster: state.port, doing: `reading its manifest ${state.manifest}` }
		return Effect.flatMap(
			Effect.try({
				try: () =>
					files.existsSync(state.manifest)
						? Option.some(files.readFileSync(state.manifest, "utf8"))
						: Option.none<string>(),
				catch: (error) => failed(step, String(error))
			}),
			Option.match({
				onNone: () => Effect.succeedNone,
				onSome: (text) =>
					Effect.mapBoth(Schema.decodeEffect(file)(text), {
						onFailure: (error) => failed(step, error.message),
						onSuccess: Option.some
					})
			})
		)
	}

/** A cluster's manifest, whole, in the format this library writes (ManifestFile). */
const manifestRead = recordRead(ManifestFile)

/** Whose a cluster is, read from its manifest in any format that wrote it (MadeForFile). */
const madeForRead = recordRead(MadeForFile)

/** The manifest of `life`'s cluster when one is written (manifestRead). */
const manifestOf = (life: Life): Effect.Effect<Option.Option<Manifest>, ClusterFailed> =>
	manifestRead(life.state)

/** The members a run of this machine's width asks of `life`'s cluster (settings.ts membersOf). */
const familySize = (life: Life): number => membersOf(life.cluster.sizing, testWorkers)

/**
 * The manifest of `life`'s cluster, refused unless it is one this spec and server made at this machine's width: an
 * owner, template, extensions or durability of another spec (another repository's cluster on this port), another
 * server's version (a repin), or another count of members (a machine of another width; `toolchain-pg init --adopt`
 * grows it).
 */
/** Whose `life`'s cluster is, or its manifest, refused when another spec made it (disagreements). */
const agreeingMade = <M extends MadeFor>(
	life: Life,
	manifest: M
): Effect.Effect<M, ClusterFailed> => {
	const differences = disagreements(life.cluster, manifest)
	return Arr.isReadonlyArrayNonEmpty(differences)
		? Effect.fail(
				failed(
					stepOf(life, `taking the cluster at ${life.state.root}`),
					`it was made for another spec: ${Arr.join(differences, "; ")}. Name a cluster of its own with ${clusterVariable}=<port>`
				)
			)
		: Effect.succeed(manifest)
}

const agreeing = (life: Life, manifest: Manifest): Effect.Effect<Manifest, ClusterFailed> => {
	const step = stepOf(life, `taking the cluster at ${life.state.root}`)
	const differences = disagreements(life.cluster, manifest)
	if (Arr.isReadonlyArrayNonEmpty(differences)) {
		return Effect.flatMap(agreeingMade(life, manifest), () =>
			Effect.fail(failed(step, "it was made for another spec"))
		)
	}
	if (manifest.server !== life.server) {
		return Effect.fail(
			failed(
				step,
				`it was made by ${manifest.server}, and its bin directory ${life.bin} runs ${life.server}: make it again with toolchain-pg init --force`
			)
		)
	}
	if (manifest.members.length < familySize(life)) {
		return Effect.fail(
			failed(
				step,
				`it has ${manifest.members.length} member(s), and this machine's width asks ${familySize(life)}: toolchain-pg init --adopt grows it`
			)
		)
	}
	return Effect.succeed(manifest)
}

/** The settings each member of `life`'s cluster holds at a share of `share` workers, on pages of `blockSize` bytes. */
const settingsOf = (life: Life, share: number, blockSize: number): ReadonlyArray<Setting> => [
	...sizedSettings(life.cluster, share, blockSize),
	...fixedSettings(life.cluster)
]

/** A statement's identifier, quoted: in double quotes, each double quote doubled. */
const ident = (name: string): string => `"${Str.replaceAll('"', '""')(name)}"`

/** A statement's text literal, quoted: in single quotes, each single quote doubled. */
const literal = (text: string): string => `'${Str.replaceAll("'", "''")(text)}'`

/** `text` written to `file` for `step`, readable and writable by this user alone when `secret`. */
const written = (step: Step, file: string, text: string, mode: number) =>
	Effect.flatMap(FileSystem.FileSystem, (fs) =>
		Effect.mapError(fs.writeFileString(file, text, { mode }), (error) =>
			failed(step, error.message)
		)
	)

/** The file mode of what only this user may read: the owner's password, a member's state directory. */
const ownerOnly = 0o600

/** The file mode of what anyone may read: a member's configuration files. */
const readable = 0o644

/**
 * A member's state directory made ready for its data: this user's alone, its TLS material (issueTls), and the owner's
 * password, fresh, which it returns for the owner role's making (owned).
 */
const prepared = (
	member: MemberState,
	step: Step
): Effect.Effect<string, ClusterFailed, Platform> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const filesFailed = (error: { readonly message: string }) => failed(step, error.message)
		yield* Effect.forEach(
			[member.tls, member.log, member.socket],
			(directory) => Effect.mapError(fs.makeDirectory(directory, { recursive: true }), filesFailed),
			{ discard: true }
		)
		yield* Effect.mapError(fs.chmod(member.state, 0o700), filesFailed)
		yield* issueTls(member.tls, step)
		const password = yield* freshPassword(step)
		yield* written(step, member.passwordFile, `${password}\n`, ownerOnly)
		return password
	})

/**
 * A member's data directory configured as every member's is, sized to a share of `share` workers: its
 * postgresql.conf given localhost alone, its socket in its state directory, TLS on, its logs in its state directory,
 * and every setting it holds, after what the file held (a later line wins); its hba, the bootstrap superuser and each
 * of the spec's peer logins by peer over the socket mapped from this user, every role over hostssl by SCRAM; and its
 * ident map.
 */
const configured = (
	life: Life,
	member: MemberState,
	share: number,
	step: Step
): Effect.Effect<void, ClusterFailed, Platform> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const filesFailed = (error: { readonly message: string }) => failed(step, error.message)
		const blockText = yield* succeeded(
			{ ...step, doing: `${step.doing}: reading its block size` },
			program(life.bin, "postgres", ["-D", member.data, "-C", "block_size"], {})
		)
		const blockSize = Number(Str.trim(blockText))
		const configuration = Arr.join(
			[
				"",
				"# A local cluster of the toolchain's (@bjornpagen/testing/pg, make.ts). Everything else is PostgreSQL's default.",
				...Arr.map(
					[
						["port", `${member.port}`],
						["listen_addresses", "localhost"],
						["unix_socket_directories", member.socket],
						["ssl", "on"],
						["ssl_cert_file", `${member.tls}/server.crt`],
						["ssl_key_file", `${member.tls}/server.key`],
						["logging_collector", "on"],
						["log_directory", member.log],
						["log_filename", "postgresql-%Y-%m-%d.log"]
					] satisfies ReadonlyArray<Setting>,
					settingLine
				),
				...Arr.map(settingsOf(life, share, blockSize), settingLine),
				""
			],
			"\n"
		)
		const conf = `${member.data}/postgresql.conf`
		const initial = yield* Effect.mapError(fs.readFileString(conf), filesFailed)
		yield* written(step, conf, `${initial}${configuration}`, ownerOnly)
		const peers = [BOOTSTRAP_SUPERUSER, ...life.cluster.peerLogins]
		yield* written(
			step,
			`${member.data}/pg_hba.conf`,
			Arr.join(
				[
					...Arr.map(peers, (role) => `local   all   ${role}   peer map=admin`),
					"hostssl all   all        127.0.0.1/32  scram-sha-256",
					"hostssl all   all        ::1/128       scram-sha-256",
					""
				],
				"\n"
			),
			ownerOnly
		)
		yield* written(
			step,
			`${member.data}/pg_ident.conf`,
			Arr.join([...Arr.map(peers, (role) => `admin   ${osUser()}   ${role}`), ""], "\n"),
			ownerOnly
		)
	})

/**
 * Which of what the owner's making (owned) makes a member already holds, as the bootstrap superuser reads it: the owner
 * role, the template and the owner's own database. A member made here holds none; one adopted from a cluster another
 * maker made (adoptMember) may hold each, made by that maker.
 */
type Held = Readonly<{ role: boolean; template: boolean; database: boolean }>

/** What psql prints of heldOf's three booleans: each t or f, between bars. */
const heldLine = regex("^([tf])\\|([tf])\\|([tf])$")

/** What `member` holds of `life`'s owner, template and owner's database (Held), each a boolean psql prints as t or f. */
const heldOf = (
	life: Life,
	member: MemberState,
	step: Step
): Effect.Effect<Held, ClusterFailed, Platform> =>
	Effect.flatMap(
		adminSql(
			life.bin,
			member,
			"postgres",
			[
				`SELECT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = ${literal(life.cluster.owner)}), EXISTS (SELECT FROM pg_catalog.pg_database WHERE datname = ${literal(life.cluster.template)}), EXISTS (SELECT FROM pg_catalog.pg_database WHERE datname = ${literal(life.cluster.owner)})`
			],
			{ ...step, doing: `${step.doing}: what it holds of its owner and template` }
		),
		(lines) =>
			Option.match(Option.fromNullishOr(heldLine.exec(Arr.join(lines, ""))), {
				onNone: () =>
					Effect.fail(failed(step, `psql printed [${Arr.join(lines, "\n")}] for what it holds`)),
				onSome: ([, role, template, database]) =>
					Effect.succeed({
						role: role === "t",
						template: template === "t",
						database: database === "t"
					})
			})
	)

/** The statements that give `life`'s owner SET on each parameter its spec names and on none that `granted` names alone. */
const grantStatements = (life: Life, granted: ReadonlyArray<string>): ReadonlyArray<string> => {
	const owner = ident(life.cluster.owner)
	return [
		...Arr.map(
			Arr.filter(granted, (name) => !Arr.contains(life.cluster.ownerParameters, name)),
			(name) => `REVOKE SET ON PARAMETER ${ident(name)} FROM ${owner}`
		),
		...Arr.map(
			life.cluster.ownerParameters,
			(name) => `GRANT SET ON PARAMETER ${ident(name)} TO ${owner}`
		)
	]
}

/**
 * What the bootstrap superuser makes in a started member, which every member holds: the owner role with `password`,
 * its grants, the template and its extensions, and the owner's own database, the template closed to connections. What
 * the member already holds (heldOf: a cluster another maker made, which `init --adopt-from` takes) is kept and given
 * what every member's holds: the owner role its attributes and `password`, the template its owner and IS_TEMPLATE, each
 * extension's schema and the extension created where absent, the owner's database kept as it is.
 */
const owned = (
	life: Life,
	member: MemberState,
	password: string,
	step: Step
): Effect.Effect<void, ClusterFailed, Platform> =>
	Effect.gen(function* () {
		const owner = ident(life.cluster.owner)
		const template = ident(life.cluster.template)
		const held = yield* heldOf(life, member, step)
		const attributes = `LOGIN CREATEDB CREATEROLE REPLICATION PASSWORD ${literal(password)}`
		yield* adminSql(
			life.bin,
			member,
			"postgres",
			[
				held.role ? `ALTER ROLE ${owner} ${attributes}` : `CREATE ROLE ${owner} ${attributes}`,
				...grantStatements(life, []),
				`GRANT pg_read_all_stats TO ${owner} WITH ADMIN TRUE, INHERIT FALSE, SET TRUE`,
				`GRANT pg_signal_backend TO ${owner}`,
				...(held.template
					? [
							`ALTER DATABASE ${template} OWNER TO ${owner}`,
							`ALTER DATABASE ${template} WITH IS_TEMPLATE true ALLOW_CONNECTIONS true`
						]
					: [
							`CREATE DATABASE ${template} OWNER ${owner} TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' LOCALE 'C.UTF-8' IS_TEMPLATE true`
						])
			],
			{ ...step, doing: `${step.doing}: its owner and template` }
		)
		yield* Arr.match(
			Arr.flatMap(life.cluster.extensions, ({ name, schema }) => [
				`CREATE SCHEMA IF NOT EXISTS ${ident(schema)} AUTHORIZATION ${owner}`,
				`CREATE EXTENSION IF NOT EXISTS ${ident(name)} SCHEMA ${ident(schema)}`
			]),
			{
				onEmpty: () => Effect.void,
				onNonEmpty: (statements) =>
					Effect.asVoid(
						adminSql(life.bin, member, life.cluster.template, statements, {
							...step,
							doing: `${step.doing}: its template's extensions`
						})
					)
			}
		)
		yield* adminSql(
			life.bin,
			member,
			"postgres",
			Arr.append(
				held.database ? [] : [`CREATE DATABASE ${owner} OWNER ${owner} TEMPLATE ${template}`],
				`ALTER DATABASE ${template} ALLOW_CONNECTIONS false`
			),
			{ ...step, doing: `${step.doing}: its owner's database` }
		)
	})

/**
 * Makes one member of `life`'s cluster at `member`, sized to a share of `share` workers, on its port, which must be
 * free: its state (prepared), its data directory (initdb: UTF-8, the builtin C.UTF-8 locale, peer authentication on
 * the socket and none over TCP until its hba), its configuration (configured), its start, and what the superuser makes
 * in it (owned).
 */
const makeMember = (
	life: Life,
	member: MemberState,
	share: number
): Effect.Effect<void, ClusterFailed | PortLost, Platform> =>
	Effect.gen(function* () {
		const step = stepOf(life, `making its member on port ${member.port} at ${member.state}`)
		yield* Effect.mapError(portFree(member.port), (error) => failed(step, error.message))
		const password = yield* prepared(member, step)
		yield* succeeded(
			{ ...step, doing: `${step.doing}: initdb` },
			program(
				life.bin,
				"initdb",
				[
					"-D",
					member.data,
					"-U",
					BOOTSTRAP_SUPERUSER,
					"-E",
					"UTF8",
					"--locale-provider=builtin",
					"--builtin-locale=C.UTF-8",
					"--locale=C.UTF-8",
					"--auth-local=peer",
					"--auth-host=reject"
				],
				{}
			)
		)
		yield* configured(life, member, share, step)
		yield* start(life.bin, member, { ...step, doing: `${step.doing}: starting it` })
		yield* owned(life, member, password, step)
	})

/** A server's major version as `postgres --version` prints it ("postgres (PostgreSQL) 18.6 ..."), none if it prints none. */
const majorOf = (server: string): Option.Option<string> =>
	Option.flatMap(Option.fromNullishOr(regex("\\(PostgreSQL\\) ([0-9]+)").exec(server)), (found) =>
		Option.fromUndefinedOr(found[1])
	)

/**
 * Adopts a cluster another maker made as `life`'s first member, its data kept where it lies: the data directory
 * `data` of the spec's major version (its PG_VERSION) is refused otherwise; its postmaster, when it runs, is stopped
 * (pg_ctl's fast mode, its sessions rolled back); the member's state is made (prepared) with its `data` a symbolic link
 * to `data`; the directory is configured as every member is (configured), its hba and ident replaced; it is started on
 * the cluster's port, and the superuser makes in it what every member holds (owned). Nothing of its databases, roles or
 * rows is touched. A member's data that lies outside its state directory is never removed by these commands: a
 * removal takes the link alone.
 */
const adoptMember = (
	life: Life,
	data: string,
	share: number
): Effect.Effect<void, ClusterFailed, Platform> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const member = life.state.member(life.state.port)
		const step = stepOf(life, `adopting ${data} as its member on port ${member.port}`)
		const filesFailed = (error: { readonly message: string }) => failed(step, error.message)
		const versionText = yield* Effect.mapError(fs.readFileString(`${data}/PG_VERSION`), filesFailed)
		const version = Str.trim(versionText)
		if (!Option.exists(majorOf(life.server), (major) => major === version)) {
			return yield* failed(
				step,
				`its data is PostgreSQL ${version}'s, and its bin directory runs ${life.server}`
			)
		}
		const foreign = { ...member, data }
		if (yield* running(foreign, step)) {
			yield* stop(life.bin, foreign, "fast", {
				...step,
				doing: `${step.doing}: stopping its postmaster`
			})
		}
		const password = yield* prepared(member, step)
		yield* Effect.mapError(fs.symlink(data, member.data), filesFailed)
		yield* configured(life, member, share, step)
		yield* Effect.catchTag(
			start(life.bin, member, { ...step, doing: `${step.doing}: starting it` }),
			"PortLost",
			(lost) => Effect.fail(failed(step, `another process holds its port: ${lost.message}`))
		)
		yield* owned(life, member, password, step)
	})

/** Writes `life`'s manifest for its members `ports`, the first its name: the last step of a cluster's making. */
const record = (
	life: Life,
	ports: Arr.NonEmptyReadonlyArray<number>
): Effect.Effect<void, ClusterFailed, FileSystem.FileSystem> =>
	Effect.flatMap(
		Effect.mapError(
			Schema.encodeEffect(ManifestFile)({
				...madeAs(life.cluster),
				server: life.server,
				members: ports
			}),
			(error) => failed(stepOf(life, "writing its manifest"), error.message)
		),
		(text) =>
			written(stepOf(life, "writing its manifest"), life.state.manifest, `${text}\n`, readable)
	)

/**
 * Makes members of `life`'s cluster after `made`, the members it already has, until it has `size`: each on a port free
 * at that moment and none of the others' (ports.ts freePort), none derived from another, each sized to its share of the
 * family; then records the family (record). A port another process took between its finding and the member's start
 * (PortLost) is let go, the member's directory removed, and another found: no port is the member's name but its own.
 */
const grow = (
	life: Life,
	made: Arr.NonEmptyReadonlyArray<number>,
	size: number
): Effect.Effect<void, ClusterFailed, Platform> => {
	const share = shareOf(testWorkers, size)
	const more = (
		ports: Arr.NonEmptyReadonlyArray<number>
	): Effect.Effect<Arr.NonEmptyReadonlyArray<number>, ClusterFailed, Platform> =>
		ports.length >= size
			? Effect.succeed(ports)
			: Effect.flatMap(
					Effect.mapError(freePort(ports), (error) =>
						failed(stepOf(life, "finding a free port for a member"), error.message)
					),
					(port) =>
						Effect.matchEffect(makeMember(life, life.state.member(port), share), {
							onFailure: (failure) =>
								failure._tag === "PortLost"
									? Effect.andThen(removeMember(life, life.state.member(port)), more(ports))
									: Effect.fail(failure),
							onSuccess: () => more(Arr.append(ports, port))
						})
				)
	return Effect.flatMap(more(made), (ports) => record(life, ports))
}

/**
 * Makes `life`'s whole cluster: its first member on its name's port, then the rest of its family (grow). The first
 * member's port is the cluster's name, so another process holding it fails the making.
 */
const makeCluster = (life: Life): Effect.Effect<void, ClusterFailed, Platform> =>
	Effect.andThen(
		Effect.catchTag(
			makeMember(life, life.state.member(life.state.port), shareOf(testWorkers, familySize(life))),
			"PortLost",
			(lost) =>
				Effect.fail(
					failed(stepOf(life, `starting its first member on its port ${lost.port}`), lost.message)
				)
		),
		grow(life, [life.state.port], familySize(life))
	)

/** Removes one member's state directory, its postmaster stopped at once when it runs. */
const removeMember = (
	life: Life,
	member: MemberState
): Effect.Effect<void, ClusterFailed, Platform> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const step = stepOf(life, `removing its member at ${member.state}`)
		if (yield* running(member, step)) {
			yield* stop(life.bin, member, "immediate", step)
		}
		yield* Effect.mapError(fs.remove(member.state, { recursive: true, force: true }), (error) =>
			failed(step, error.message)
		)
	})

/**
 * Removes `life`'s cluster whole, whatever it holds: each member directory's postmaster stopped at once (pg_ctl's
 * immediate mode) and its state directory removed, the members a failed make left among them, which no manifest
 * records.
 */
const removeCluster = (life: Life): Effect.Effect<void, ClusterFailed, Platform> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const step = stepOf(life, `removing ${life.state.root}`)
		const filesFailed = (error: { readonly message: string }) => failed(step, error.message)
		if (!(yield* Effect.mapError(fs.exists(life.state.root), filesFailed))) {
			return
		}
		const names = yield* Effect.mapError(fs.readDirectory(life.state.root), filesFailed)
		yield* Effect.forEach(
			Arr.filter(names, (name) => `${Number(name)}` === name),
			(name) => removeMember(life, life.state.member(Number(name))),
			{ discard: true }
		)
		yield* Effect.mapError(
			fs.remove(life.state.root, { recursive: true, force: true }),
			filesFailed
		)
	})

/**
 * A made member as its state directory holds it, before any file of it is read: its name (its port), its port, its Unix
 * socket's directory, the owner and the template its cluster was made with, the files of the owner's password, of the
 * local CA and of the unrelated CA, and its lease directory. Every reader of a member's files takes their paths here
 * (memberOf, madeMembers), so no path to a member's file is spelled twice.
 */
export type MadeMember = Readonly<{
	name: string
	port: number
	socket: string
	owner: string
	template: string
	passwordFile: string
	caFile: string
	wrongCaFile: string
	lease: string
}>

/** `member` of a cluster made for `cluster`'s owner and template, described (MadeMember). */
const describedMember = (cluster: LocalCluster, member: MemberState): MadeMember => ({
	name: `${member.port}`,
	port: member.port,
	socket: member.socket,
	owner: cluster.owner,
	template: cluster.template,
	passwordFile: member.passwordFile,
	caFile: `${member.tls}/ca.crt`,
	wrongCaFile: `${member.tls}/wrong-ca.crt`,
	lease: member.lease
})

/** Reads `member`'s facts as a client reaches it (PgMember) from the files its description names (describedMember). */
const memberOf = (
	life: Life,
	member: MemberState
): Effect.Effect<PgMember, ClusterFailed, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const step = stepOf(life, `reading its member on port ${member.port}`)
		const read = (file: string) =>
			Effect.mapError(fs.readFileString(file), (error) => failed(step, error.message))
		const made = describedMember(life.cluster, member)
		const [password, ca, wrongCa] = yield* Effect.all([
			read(made.passwordFile),
			read(made.caFile),
			read(made.wrongCaFile)
		])
		return {
			name: made.name,
			port: made.port,
			socket: made.socket,
			owner: made.owner,
			password: Redacted.make(Str.trim(password)),
			passwordFile: made.passwordFile,
			ca,
			caFile: made.caFile,
			wrongCa,
			lease: made.lease
		}
	})

/** No cluster is made on the port a spec reaches: its manifest, which its making writes last, is not there. */
export class ClusterUnmade extends Schema.TaggedError<
	ClusterUnmade,
	{ readonly brand: unique symbol }
>()("ClusterUnmade", { cluster: Schema.Int, message: Schema.String }) {}

/**
 * The members of the cluster `cluster` reaches (reachedPort) as its making recorded them, in member order: its manifest
 * read and agreeing with the spec's owner, template, extensions and durability (disagreements), each member described
 * as clusterUp's members are (describedMember), with no file read but the manifest and no program run, so it runs
 * synchronously (Effect.runSync), for a repository's config that builds its connection to a made cluster before any
 * runtime runs. A cluster not made is ClusterUnmade, naming the command that makes it; a manifest another spec made, or
 * one that cannot be read, is ClusterFailed. Whether a member runs is not read: a connection to one that does not run
 * is refused by the server.
 */
export const madeMembers = (
	cluster: LocalCluster
): Effect.Effect<Arr.NonEmptyReadonlyArray<MadeMember>, ClusterFailed | ClusterUnmade> =>
	Effect.gen(function* () {
		const port = yield* reachedPort(cluster)
		const state = yield* clusterState(port)
		const recorded = yield* manifestRead(state)
		if (Option.isNone(recorded)) {
			return yield* ClusterUnmade.make({
				cluster: port,
				message: `no cluster is made on port ${port} (no ${state.manifest}): toolchain-pg start makes it`
			})
		}
		const differences = disagreements(cluster, recorded.value)
		if (Arr.isReadonlyArrayNonEmpty(differences)) {
			return yield* failed(
				{ cluster: port, doing: `reading the cluster at ${state.root}` },
				`it was made for another spec: ${Arr.join(differences, "; ")}`
			)
		}
		return Arr.map(recorded.value.members, (member) =>
			describedMember(cluster, state.member(member))
		)
	})

/**
 * Records in `member`'s lease directory the connections its running server admits beside those it reserves
 * (max_connections less superuser_reserved_connections and reserved_connections), read from the server, which every
 * lessee of the member reads (lease.ts leaseSlots): what a lease divides is the server's own number, never one the spec
 * or a lessee assumes.
 */
const recordCapacity = (
	life: Life,
	member: MemberState,
	step: Step
): Effect.Effect<void, ClusterFailed, Platform> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const lines = yield* adminSql(
			life.bin,
			member,
			"postgres",
			[
				"SELECT pg_catalog.current_setting('max_connections')::int4 - pg_catalog.current_setting('superuser_reserved_connections')::int4 - pg_catalog.current_setting('reserved_connections')::int4"
			],
			{ ...step, doing: `${step.doing}: reading its capacity` }
		)
		const capacity = yield* Option.match(Arr.head(lines), {
			onNone: () => Effect.fail(failed(step, "its server answered no capacity")),
			onSome: (line) => Effect.succeed(Str.trim(line))
		})
		yield* Effect.mapError(fs.makeDirectory(member.lease, { recursive: true }), (error) =>
			failed(step, error.message)
		)
		yield* written(step, capacityFile(member), `${capacity}\n`, readable)
	})

/**
 * Brings `member` up as it is: its TLS material issued again once any certificate has expired (read again by a running
 * postmaster at a reload), and its postmaster started when it does not run (server.ts running). A member another
 * process started is taken as it is.
 */
const upMember = (life: Life, member: MemberState): Effect.Effect<void, ClusterFailed, Platform> =>
	Effect.gen(function* () {
		const step = stepOf(life, `starting its member on port ${member.port}`)
		const up = yield* running(member, step)
		if (!(yield* tlsCurrent(member.tls, step))) {
			yield* issueTls(member.tls, step)
			if (up) {
				yield* reload(life.bin, member, step)
			}
		}
		if (!up) {
			yield* Effect.catchTag(start(life.bin, member, step), "PortLost", (lost) =>
				Effect.fail(failed(step, `another process holds its port: ${lost.message}`))
			)
		}
		yield* recordCapacity(life, member, step)
	})

/** The members of `manifest` in member order, each as its state directory holds it. */
const membersIn = (life: Life, manifest: Manifest): Arr.NonEmptyReadonlyArray<MemberState> =>
	Arr.map(manifest.members, life.state.member)

/**
 * `life`'s cluster up, under its lock: made whole when it has no manifest (a throwaway cluster a failed make left in
 * part made again from nothing, a kept one's refused, since its data may be a person's), else its manifest taken
 * (agreeing) and every member brought up as it is (upMember), its owner's parameters granted as the spec names them
 * when the manifest records others; its members' facts in member order.
 */
const upCluster = (
	life: Life
): Effect.Effect<Arr.NonEmptyReadonlyArray<PgMember>, ClusterFailed, Platform> =>
	underLock(
		life,
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const step = stepOf(life, `bringing it up at ${life.state.root}`)
			const recorded = yield* manifestOf(life)
			if (Option.isNone(recorded)) {
				const partial = yield* Effect.mapError(fs.exists(life.state.root), (error) =>
					failed(step, error.message)
				)
				if (partial && life.cluster.durability === "kept") {
					return yield* failed(
						step,
						"it holds members but no manifest, a make that did not finish: toolchain-pg init --force makes it again"
					)
				}
				yield* removeCluster(life)
				yield* makeCluster(life)
			}
			const manifest = yield* Effect.flatMap(manifestOf(life), (made) =>
				Option.match(made, {
					onNone: () => Effect.fail(failed(step, "it has no manifest after its making")),
					onSome: (found) => agreeing(life, found)
				})
			)
			const members = membersIn(life, manifest)
			yield* Effect.forEach(members, (member) => upMember(life, member), { discard: true })
			if (!grantsAgree(life.cluster, manifest)) {
				yield* Effect.forEach(
					members,
					(member) =>
						Arr.match(grantStatements(life, manifest.ownerParameters), {
							onEmpty: () => Effect.void,
							onNonEmpty: (statements) =>
								Effect.asVoid(
									adminSql(life.bin, member, "postgres", statements, {
										...step,
										doing: `${step.doing}: its owner's parameters`
									})
								)
						}),
					{ discard: true }
				)
				yield* record(life, manifest.members)
			}
			return yield* Effect.forEach(members, (member) => memberOf(life, member))
		})
	)

/**
 * `life`'s cluster when it runs whole, taken as it is without its lock: its manifest, which its making writes last, is
 * this spec's (agreeing, which refuses another's) with its owner granted the parameters this spec names, and every
 * member's postmaster runs with its TLS current and its capacity recorded for its lessees, all read
 * in this process (server.ts running, tlsCurrent), so taking a running cluster runs no program and waits on no other
 * process; none when anything is to do, which the lock's holder does (upCluster). What a member's facts are read from
 * is written before its making records it, so a concurrent maker's cluster is either taken whole or left to the lock.
 */
const takenRunning = (
	life: Life
): Effect.Effect<Option.Option<Arr.NonEmptyReadonlyArray<PgMember>>, ClusterFailed, Platform> =>
	Effect.gen(function* () {
		const recorded = yield* manifestOf(life)
		if (Option.isNone(recorded)) {
			return Option.none()
		}
		const manifest = yield* agreeing(life, recorded.value)
		if (!grantsAgree(life.cluster, manifest)) {
			return Option.none()
		}
		const members = membersIn(life, manifest)
		const step = stepOf(life, `taking it as it runs at ${life.state.root}`)
		const fs = yield* FileSystem.FileSystem
		const whole = yield* Effect.forEach(members, (member) =>
			Effect.map(
				Effect.all([
					running(member, step),
					tlsCurrent(member.tls, step),
					Effect.mapError(fs.exists(capacityFile(member)), (error) => failed(step, error.message))
				]),
				([up, current, capacityRecorded]) => up && current && capacityRecorded
			)
		)
		if (!Arr.every(whole, (up) => up)) {
			return Option.none()
		}
		const facts = yield* Effect.forEach(members, (member) => memberOf(life, member))
		return Option.some(facts)
	})

/**
 * `cluster` up and its members' facts, in member order: what a need of the runner opens the first time it reaches the
 * cluster, and `toolchain-pg start`. A running cluster is taken as it is, with no lock and no program run
 * (takenRunning), so every worker and test file opening it at once reads it side by side; anything else is done under
 * its lock (upCluster): made whole when it does not exist, its members started when they do not run, their TLS issued
 * again when it expired.
 */
export const clusterUp = (
	cluster: LocalCluster
): Effect.Effect<Arr.NonEmptyReadonlyArray<PgMember>, ClusterFailed, Platform> =>
	Effect.flatMap(lifeOf(cluster), (life) =>
		Effect.flatMap(
			takenRunning(life),
			Option.match({ onNone: () => upCluster(life), onSome: Effect.succeed })
		)
	)

/** The members `cluster`'s manifest records, refused when it records none: what every command but init and start acts on. */
const recordedMembers = (
	life: Life,
	doing: string
): Effect.Effect<Arr.NonEmptyReadonlyArray<MemberState>, ClusterFailed, FileSystem.FileSystem> =>
	Effect.flatMap(manifestOf(life), (made) =>
		Option.match(made, {
			onNone: () =>
				Effect.fail(
					failed(
						stepOf(life, doing),
						`no cluster is recorded at ${life.state.manifest}: toolchain-pg start makes one`
					)
				),
			onSome: (manifest) => Effect.succeed(membersIn(life, manifest))
		})
	)

/**
 * How `toolchain-pg init` makes a cluster: `create` one where none exists; `force` one again over what exists;
 * `adopt` the recorded members, sized again, the family grown; or `adoptFrom` a cluster another maker made, its data
 * directory kept where it lies (adoptMember).
 */
export type InitMode =
	| Readonly<{ kind: "create" }>
	| Readonly<{ kind: "force" }>
	| Readonly<{ kind: "adopt" }>
	| Readonly<{ kind: "adoptFrom"; data: string }>

/**
 * Sizes the running `member` to a share of `share` workers and gives it the settings every member holds, then
 * restarts it, since max_connections and shared_buffers take effect only at a start: so a family that grows keeps the
 * memory it had, divided over more members, never a kept member's old share beside the new members' smaller ones.
 */
const resizeMember = (
	life: Life,
	member: MemberState,
	share: number
): Effect.Effect<void, ClusterFailed, Platform> =>
	Effect.gen(function* () {
		const step = stepOf(life, `sizing its member on port ${member.port}`)
		yield* upMember(life, member)
		const [blockSize] = yield* adminSql(life.bin, member, "postgres", ["SHOW block_size"], step)
		const settings = settingsOf(life, share, Number(blockSize))
		yield* Arr.match(settings, {
			onEmpty: () => Effect.void,
			onNonEmpty: (nonEmpty) =>
				Effect.asVoid(
					adminSql(
						life.bin,
						member,
						"postgres",
						[
							...Arr.map(nonEmpty, (setting) => `ALTER SYSTEM SET ${settingLine(setting)}`),
							...grantStatements(life, [])
						],
						step
					)
				)
		})
		yield* restart(life.bin, member, step)
	})

/**
 * `toolchain-pg init`: makes `cluster` whole, under its lock. `create` refuses a cluster that exists, recorded or in
 * part; `force` removes what exists first, refused unless it and the spec are throwaway (throwaway); `adoptFrom` takes
 * a cluster another maker made as its first member, its data where it lies (adoptMember), and grows its family;
 * `adopt` keeps the recorded members, their data
 * untouched, sizes each to its share of this machine's family (resizeMember) and makes the members the family's size
 * asks beyond them (grow): how a family made on a narrower machine, or before a spec's sizing changed, becomes this
 * machine's. A family recorded with more members than its size keeps them all, each sized as a member of its size, and
 * every run is served by all of them, its workers spread over every member (its lease takes each slot on the member
 * where it holds fewest, pg/lease.ts), so a run leases its workers' share of the members and runs beside it lease the
 * rest, where a narrower run was served by the first members alone and every run on the machine queued behind them
 * (5491 and 5442, 2026-11-20: each run took all 16 slots of the first two of four members, the other two idle).
 */
export const initCluster = (
	cluster: LocalCluster,
	mode: InitMode
): Effect.Effect<Arr.NonEmptyReadonlyArray<PgMember>, ClusterFailed, Platform> =>
	Effect.flatMap(lifeOf(cluster), (life) =>
		Effect.andThen(
			underLock(
				life,
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const step = stepOf(life, `init (${mode.kind}) at ${life.state.root}`)
					const exists = yield* Effect.mapError(fs.exists(life.state.root), (error) =>
						failed(step, error.message)
					)
					switch (mode.kind) {
						case "create": {
							if (exists) {
								return yield* failed(
									step,
									"a cluster exists there: pass --force to remove and make it again, or --adopt to keep it"
								)
							}
							return yield* makeCluster(life)
						}
						case "force": {
							yield* throwaway(life, step.doing)
							yield* removeCluster(life)
							return yield* makeCluster(life)
						}
						case "adoptFrom": {
							if (exists) {
								return yield* failed(step, "a cluster exists there already: nothing to adopt it as")
							}
							const size = familySize(life)
							yield* adoptMember(life, mode.data, shareOf(testWorkers, size))
							return yield* grow(life, [life.state.port], size)
						}
						case "adopt": {
							const members = yield* recordedMembers(life, step.doing)
							const size = familySize(life)
							yield* Effect.forEach(
								members,
								(member) => resizeMember(life, member, shareOf(testWorkers, size)),
								{ discard: true }
							)
							return yield* grow(
								life,
								Arr.map(members, (member) => member.port),
								size
							)
						}
					}
				})
			),
			upCluster(life)
		)
	)

/** `toolchain-pg stop`: stops every recorded member that runs, under the cluster's lock. */
export const stopCluster = (cluster: LocalCluster): Effect.Effect<void, ClusterFailed, Platform> =>
	Effect.flatMap(lifeOf(cluster), (life) =>
		underLock(
			life,
			Effect.flatMap(recordedMembers(life, "stopping it"), (members) =>
				Effect.forEach(
					members,
					(member) =>
						Effect.flatMap(running(member, stepOf(life, `stopping ${member.port}`)), (up) =>
							up
								? stop(life.bin, member, "fast", stepOf(life, `stopping ${member.port}`))
								: Effect.void
						),
					{ discard: true }
				)
			)
		)
	)

/** A member's state as `toolchain-pg status` reports it: its port, and whether its postmaster runs. */
export type MemberStatus = Readonly<{ port: number; running: boolean }>

/** `toolchain-pg status`: whether each recorded member's postmaster runs, in member order. */
export const clusterStatus = (
	cluster: LocalCluster
): Effect.Effect<ReadonlyArray<MemberStatus>, ClusterFailed, Platform> =>
	Effect.flatMap(lifeOf(cluster), (life) =>
		Effect.flatMap(recordedMembers(life, "reading its status"), (members) =>
			Effect.forEach(members, (member) =>
				Effect.map(running(member, stepOf(life, `reading ${member.port}'s status`)), (up) => ({
					port: member.port,
					running: up
				}))
			)
		)
	)

/**
 * Refuses an operation that drops data unless the spec is throwaway and the cluster recorded on its port was made for
 * it (agreeingMade), a throwaway one: so no spec on a kept cluster's port (TOOLCHAIN_PG_CLUSTER naming it) drops a
 * person's data, whatever durability it states. A port with no manifest holds at most a make that did not finish, whose data
 * removeCluster may remove: a kept cluster's adopted data lies outside its state, behind a link a removal takes alone.
 */
const throwaway = (
	life: Life,
	doing: string
): Effect.Effect<void, ClusterFailed, FileSystem.FileSystem> =>
	life.cluster.durability === "throwaway"
		? Effect.flatMap(madeForRead(life.state), (recorded) =>
				Option.match(recorded, {
					onNone: () => Effect.void,
					onSome: (madeFor) => Effect.asVoid(agreeingMade(life, madeFor))
				})
			)
		: Effect.fail(
				failed(stepOf(life, doing), "a kept cluster's data is never dropped by these commands")
			)

/** `toolchain-pg destroy`: removes a throwaway cluster whole (removeCluster), under its lock. */
export const destroyCluster = (
	cluster: LocalCluster
): Effect.Effect<void, ClusterFailed, Platform> =>
	Effect.flatMap(lifeOf(cluster), (life) =>
		underLock(life, Effect.andThen(throwaway(life, "destroying it"), removeCluster(life)))
	)

/**
 * `toolchain-pg reset`: returns every member of a throwaway cluster to what its making left: every database but
 * PostgreSQL's own, the template and the owner's dropped, sessions and all, and every role but the bootstrap
 * superuser, the owner and PostgreSQL's own, what it owns in every database dropped first.
 */
export const resetCluster = (cluster: LocalCluster): Effect.Effect<void, ClusterFailed, Platform> =>
	Effect.flatMap(lifeOf(cluster), (life) =>
		Effect.andThen(
			underLock(life, throwaway(life, "resetting it")),
			Effect.flatMap(recordedMembers(life, "resetting it"), (members) =>
				Effect.forEach(
					members,
					(member) =>
						Effect.gen(function* () {
							const step = stepOf(life, `resetting ${member.port}`)
							const kept = Arr.join(
								Arr.map(
									["postgres", "template0", "template1", life.cluster.template, life.cluster.owner],
									literal
								),
								", "
							)
							const databases = yield* adminSql(
								life.bin,
								member,
								"postgres",
								[`SELECT datname FROM pg_catalog.pg_database WHERE datname NOT IN (${kept})`],
								step
							)
							yield* Effect.forEach(
								databases,
								(database) =>
									adminSql(
										life.bin,
										member,
										"postgres",
										[`DROP DATABASE ${ident(database)} WITH (FORCE)`],
										step
									),
								{ discard: true }
							)
							const roles = yield* adminSql(
								life.bin,
								member,
								"postgres",
								[
									`SELECT rolname FROM pg_catalog.pg_roles WHERE NOT pg_catalog.starts_with(rolname, 'pg_') AND rolname NOT IN ('postgres', ${literal(life.cluster.owner)})`
								],
								step
							)
							const connectable = yield* adminSql(
								life.bin,
								member,
								"postgres",
								["SELECT datname FROM pg_catalog.pg_database WHERE datallowconn"],
								step
							)
							yield* Effect.forEach(
								roles,
								(role) =>
									Effect.andThen(
										Effect.forEach(
											connectable,
											(database) =>
												adminSql(
													life.bin,
													member,
													database,
													[`DROP OWNED BY ${ident(role)}`],
													step
												),
											{ discard: true }
										),
										adminSql(life.bin, member, "postgres", [`DROP ROLE ${ident(role)}`], step)
									),
								{ discard: true }
							)
						}),
					{ discard: true }
				)
			)
		)
	)

/** What a command that runs psql on the first member needs: the server's bin directory, and the member's facts. */
export type FirstMember = Readonly<{ bin: string; member: PgMember; state: MemberState }>

/** The first recorded member of `cluster`, up, with the server's bin directory: what psql, admin and env act on. */
export const firstMember = (
	cluster: LocalCluster
): Effect.Effect<FirstMember, ClusterFailed, Platform> =>
	Effect.flatMap(lifeOf(cluster), (life) =>
		Effect.map(upCluster(life), (members) => ({
			bin: life.bin,
			member: Arr.headNonEmpty(members),
			state: life.state.member(Arr.headNonEmpty(members).port)
		}))
	)

/** What the doctor checks of `cluster`: its life, its recorded members, each up, and the settings each must hold. */
export type Examined = Readonly<{
	bin: string
	server: string
	members: Arr.NonEmptyReadonlyArray<Readonly<{ state: MemberState; member: PgMember }>>
	sized: ReadonlyArray<Setting>
	fixed: Arr.NonEmptyReadonlyArray<Setting>
	owner: string
	template: string
	extensions: LocalCluster["extensions"]
	ownerParameters: LocalCluster["ownerParameters"]
}>

/** `cluster` as the doctor examines it: up (clusterUp), with the settings each member must hold at this machine's width. */
export const examined = (cluster: LocalCluster): Effect.Effect<Examined, ClusterFailed, Platform> =>
	Effect.flatMap(lifeOf(cluster), (life) =>
		Effect.gen(function* () {
			const members = yield* upCluster(life)
			const first = life.state.member(Arr.headNonEmpty(members).port)
			const [blockSize] = yield* adminSql(
				life.bin,
				first,
				"postgres",
				["SHOW block_size"],
				stepOf(life, "reading its block size")
			)
			return {
				bin: life.bin,
				server: life.server,
				members: Arr.map(members, (member) => ({ state: life.state.member(member.port), member })),
				sized: sizedSettings(cluster, shareOf(testWorkers, members.length), Number(blockSize)),
				fixed: fixedSettings(cluster),
				owner: cluster.owner,
				template: cluster.template,
				extensions: cluster.extensions,
				ownerParameters: cluster.ownerParameters
			}
		})
	)
