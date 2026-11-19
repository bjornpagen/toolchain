import { userInfo } from "node:os"
import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	Predicate,
	type Redacted,
	Result,
	Schema,
	Stream,
	String as Str
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { liveMillis } from "#live.ts"
import type { LocalCluster } from "#pg/spec.ts"
import type { MemberState } from "#pg/state.ts"

/**
 * A step of a local cluster's life failed: the cluster it was for, by its name, and what failed, with what the program
 * that refused said. Every command of `toolchain-pg` and every need that brings a cluster up fails with it.
 */
export class ClusterFailed extends Schema.TaggedError<
	ClusterFailed,
	{ readonly brand: unique symbol }
>()("ClusterFailed", { cluster: Schema.Int, message: Schema.String }) {}

/** A program's run: its exit code and what it wrote to stdout and stderr. */
export type Ran = Readonly<{ code: number; stdout: string; stderr: string }>

/** Runs `command` to its end, its stdout and stderr read whole. */
export const ran = (
	command: ChildProcess.Command
): Effect.Effect<Ran, ClusterFailed, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.scoped(
		Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
			Effect.flatMap(spawner.spawn(command), (handle) =>
				Effect.map(
					Effect.all(
						[
							Stream.mkString(Stream.decodeText(handle.stdout)),
							Stream.mkString(Stream.decodeText(handle.stderr)),
							handle.exitCode
						],
						{ concurrency: "unbounded" }
					),
					([stdout, stderr, code]): Ran => ({ code, stdout, stderr })
				)
			)
		)
	).pipe(Effect.mapError((error) => ClusterFailed.make({ cluster: 0, message: error.message })))

/** What a cluster's step needs to name its failure: the cluster's name and the step. */
export type Step = Readonly<{ cluster: number; doing: string }>

/** A failure of `step`, saying `detail`. */
export const failed = (step: Step, detail: string): ClusterFailed =>
	ClusterFailed.make({ cluster: step.cluster, message: `${step.doing}: ${detail}` })

/** `command` run to its end for `step`: its stdout when it exits 0, else the step's failure with what it said. */
export const succeeded = (
	step: Step,
	command: ChildProcess.Command
): Effect.Effect<string, ClusterFailed, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.flatMap(
		Effect.mapError(ran(command), (error) => failed(step, error.message)),
		(done) =>
			done.code === 0
				? Effect.succeed(done.stdout)
				: Effect.fail(
						failed(step, `exited ${done.code}: ${Str.trim(`${done.stderr}\n${done.stdout}`)}`)
					)
	)

/**
 * The directory of the server's programs a cluster runs from (spec.ts ServerBin): the one the repository names, or the
 * one the `pg_config` on PATH names (`pg_config --bindir`), which must be an absolute path.
 */
export const serverBin = (
	cluster: LocalCluster,
	step: Step
): Effect.Effect<string, ClusterFailed, ChildProcessSpawner.ChildProcessSpawner> =>
	cluster.bin.kind === "directory"
		? Effect.succeed(cluster.bin.directory)
		: Effect.flatMap(
				succeeded(
					{ ...step, doing: `${step.doing}: reading pg_config --bindir` },
					ChildProcess.make("pg_config", ["--bindir"])
				),
				(text) =>
					Str.startsWith("/")(Str.trim(text))
						? Effect.succeed(Str.trim(text))
						: Effect.fail(failed(step, `pg_config --bindir named ${text}, no absolute directory`))
			)

/** One of the server's programs, by its path in the bin directory. */
export const program = (
	bin: string,
	name: "initdb" | "pg_ctl" | "pg_isready" | "postgres" | "psql",
	args: ReadonlyArray<string>,
	options: ChildProcess.CommandOptions
): ChildProcess.Command => ChildProcess.make(`${bin}/${name}`, args, options)

/** The server's version as `postgres --version` prints it: what a cluster's manifest records it was made by. */
export const serverVersion = (
	bin: string,
	step: Step
): Effect.Effect<string, ClusterFailed, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.map(succeeded(step, program(bin, "postgres", ["--version"], {})), Str.trim)

/**
 * Whether a process of `pid` runs on this machine: signal 0 reaches it, or reaches a process of another user, which
 * refuses it (EPERM). Only an answer that no such process exists (ESRCH) says it has ended.
 */
export const processRuns = (pid: number): boolean =>
	Result.match(Result.try({ try: () => process.kill(pid, 0), catch: (error) => error }), {
		onSuccess: () => true,
		onFailure: (error) => !(Predicate.hasProperty(error, "code") && error.code === "ESRCH")
	})

/**
 * Whether `member`'s postmaster runs, read as `pg_ctl status` reads it, here in this process with no program run: its
 * data directory's lock file, postmaster.pid, names a process that runs (processRuns), where a member that never
 * started or stopped holds none. A member is started under its cluster's lock and its start waits until it accepts
 * connections (`pg_ctl -w`), so one that runs accepts them, however loaded the machine; a ping of the server would wait
 * on the machine to fork it a backend, and read a slow answer as none. A lock file whose first line is no process id is
 * no postmaster's, and fails.
 */
export const running = (
	member: Readonly<{ data: string }>,
	step: Step
): Effect.Effect<boolean, ClusterFailed, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const file = `${member.data}/postmaster.pid`
		const unread = (error: { readonly message: string }) => failed(step, error.message)
		if (!(yield* Effect.mapError(fs.exists(file), unread))) {
			return false
		}
		const text = yield* Effect.mapError(fs.readFileString(file), unread)
		const pid = Number(Arr.headNonEmpty(Str.split("\n")(text)))
		return Number.isSafeInteger(pid) && pid > 0
			? processRuns(pid)
			: yield* failed(step, `${file} names no process: ${Arr.headNonEmpty(Str.split("\n")(text))}`)
	})

/**
 * The port a member was to listen on was taken by another process between its finding and its start: the start's
 * log says no TCP socket could be made. A member other than a cluster's first is made again on another port.
 */
export class PortLost extends Schema.TaggedError<PortLost, { readonly brand: unique symbol }>()(
	"PortLost",
	{ cluster: Schema.Int, port: Schema.Int, message: Schema.String }
) {}

/** The postmaster's own words when no TCP socket of its listen addresses could be made (postmaster.c). */
const noSocket = "could not create any TCP/IP sockets"

/**
 * Starts `member`'s postmaster and waits until it accepts connections. A start that fails says why with its log, the
 * file pg_ctl's -l names, which holds what the postmaster wrote before its logging collector started, a bind's
 * failure among it; one that could make no TCP socket is PortLost.
 */
export const start = (
	bin: string,
	member: MemberState,
	step: Step
): Effect.Effect<
	void,
	ClusterFailed | PortLost,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
	Effect.catchTag(
		Effect.asVoid(
			succeeded(
				step,
				program(
					bin,
					"pg_ctl",
					["-D", member.data, "-l", `${member.log}/startup.log`, "-w", "start"],
					{}
				)
			)
		),
		"ClusterFailed",
		(failure) =>
			Effect.flatMap(FileSystem.FileSystem, (fs) =>
				Effect.flatMap(
					Effect.option(fs.readFileString(`${member.log}/startup.log`)),
					(log): Effect.Effect<never, ClusterFailed | PortLost> => {
						const message = Option.match(log, {
							onNone: () => failure.message,
							onSome: (written) => `${failure.message}\n${written}`
						})
						return Option.exists(log, Str.includes(noSocket))
							? Effect.fail(PortLost.make({ cluster: step.cluster, port: member.port, message }))
							: Effect.fail(ClusterFailed.make({ cluster: step.cluster, message }))
					}
				)
			)
	)

/** Restarts `member`'s postmaster, for a setting that takes effect only at a start. */
export const restart = (bin: string, member: MemberState, step: Step) =>
	Effect.asVoid(
		succeeded(
			step,
			program(
				bin,
				"pg_ctl",
				["-D", member.data, "-l", `${member.log}/startup.log`, "-w", "restart"],
				{}
			)
		)
	)

/** Makes `member`'s postmaster read its configuration files again, its TLS material among them. */
export const reload = (bin: string, member: MemberState, step: Step) =>
	Effect.asVoid(succeeded(step, program(bin, "pg_ctl", ["-D", member.data, "reload"], {})))

/** Stops `member`'s postmaster in `mode`: `fast` rolls its sessions back, `immediate` for a member about to go. */
export const stop = (bin: string, member: MemberState, mode: "fast" | "immediate", step: Step) =>
	Effect.asVoid(
		succeeded(step, program(bin, "pg_ctl", ["-D", member.data, "-m", mode, "-w", "stop"], {}))
	)

/**
 * The rows of `statements`, run one after another as the bootstrap superuser in `database` on `member`, over its socket:
 * each statement its own query (psql's -c), so CREATE DATABASE runs outside a transaction block, the first failing one
 * ending the run; each row one line, its columns separated by `|`.
 */
export const adminSql = (
	bin: string,
	member: MemberState,
	database: string,
	statements: Arr.NonEmptyReadonlyArray<string>,
	step: Step
): Effect.Effect<ReadonlyArray<string>, ClusterFailed, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.map(
		succeeded(
			step,
			program(
				bin,
				"psql",
				[
					"-X",
					"-q",
					"-A",
					"-t",
					"-v",
					"ON_ERROR_STOP=1",
					"-h",
					member.socket,
					"-p",
					`${member.port}`,
					"-U",
					"postgres",
					"-d",
					database,
					...Arr.flatMap(statements, (statement) => ["-c", statement])
				],
				{}
			)
		),
		(text) => Arr.filter(Str.split(text, "\n"), Str.isNonEmpty)
	)

/**
 * The libpq connection string of `role` in `database` on `member` at localhost, then `tls`, the keywords that say how
 * it signs in (`sslmode=verify-full sslrootcert=<CA>`, or what a refusal check tries): libpq takes a keyword's last
 * value, so `tls` may name another host too.
 */
export const conninfo = (
	member: MemberState,
	role: string,
	database: string,
	tls: string
): string => `host=localhost port=${member.port} dbname=${database} user=${role} ${tls}`

/** The keywords of a connection that verifies the server's certificate for localhost against `ca`, as every client does. */
export const verified = (ca: string): string => `sslmode=verify-full sslrootcert=${ca}`

/** psql as the owner over `connection`, a connection string (conninfo), its password given through PGPASSWORD. */
export const ownerPsql = (
	bin: string,
	connection: string,
	password: Redacted.Redacted,
	args: ReadonlyArray<string>,
	options: ChildProcess.CommandOptions
): ChildProcess.Command =>
	program(bin, "psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", connection, ...args], {
		...options,
		env: { PGPASSWORD: password },
		extendEnv: true
	})

/** The user this process runs as, whom a member's peer map admits as its bootstrap superuser. */
export const osUser = (): string => userInfo().username

/**
 * The lifetime of the certificates a member's TLS directory holds: its CA's, the server's it signed and the unrelated
 * CA's. A member reissues all three at a start or a need once any has expired (make.ts), so the lifetime only decides
 * how often its CA changes under the processes that read it.
 *
 * @limitKind provisional
 * @owner the toolchain's local clusters (pg/server.ts issueTls), from grizzle's scripts/pg/init.sh at a5dd3588d
 * @unit days
 * @scope each certificate a member's TLS directory holds, from its issue
 * @guards a reissue swaps the CA under every running process that read the old one, whose next verify-full connection
 *   to the member then fails: a lifetime longer than any member lives never swaps it
 * @measure none to run while a member is made again sooner than this; revisit when a member outlives it, or when a
 *   reissue is seen failing a run
 * @origin grizzle's scripts/pg/init.sh (3650 days), carried here with den's reissue at start
 * @recorded 2026-11-18
 */
const certificateDays = 3650

/** One openssl command in `directory`, for `step`. */
const openssl = (directory: string, args: ReadonlyArray<string>, step: Step) =>
	Effect.asVoid(succeeded(step, ChildProcess.make("openssl", args, { cwd: directory })))

/** A new EC P-256 key and a certificate for `subject`, self-signed as a CA, as `<name>.key` and `<name>.crt`. */
const issueCa = (directory: string, name: string, subject: string, step: Step) =>
	openssl(
		directory,
		[
			"req",
			"-x509",
			"-new",
			"-nodes",
			"-newkey",
			"ec",
			"-pkeyopt",
			"ec_paramgen_curve:prime256v1",
			"-sha256",
			"-days",
			`${certificateDays}`,
			"-subj",
			subject,
			"-keyout",
			`${name}.key`,
			"-out",
			`${name}.crt`
		],
		step
	)

/**
 * Issues a member's TLS material into `directory`: the local CA, which every verify-full client chains the server's
 * certificate to; the server's certificate it signed, for localhost, 127.0.0.1 and ::1; and an unrelated CA, which
 * signed nothing the server presents, for the refusal checks. Every key EC P-256 and readable by this user alone.
 */
export const issueTls = (
	directory: string,
	step: Step
): Effect.Effect<
	void,
	ClusterFailed,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const files = (doing: string) => (error: { readonly message: string }) =>
			failed({ ...step, doing: `${step.doing}: ${doing}` }, error.message)
		yield* issueCa(directory, "ca", "/CN=toolchain local development CA", step)
		yield* issueCa(directory, "wrong-ca", "/CN=toolchain unrelated CA", step)
		yield* openssl(
			directory,
			[
				"req",
				"-new",
				"-nodes",
				"-newkey",
				"ec",
				"-pkeyopt",
				"ec_paramgen_curve:prime256v1",
				"-sha256",
				"-subj",
				"/CN=localhost",
				"-keyout",
				"server.key",
				"-out",
				"server.csr"
			],
			step
		)
		yield* Effect.mapError(
			fs.writeFileString(
				`${directory}/server.ext`,
				"subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1\nextendedKeyUsage=serverAuth\n"
			),
			files("writing server.ext")
		)
		yield* openssl(
			directory,
			[
				"x509",
				"-req",
				"-in",
				"server.csr",
				"-CA",
				"ca.crt",
				"-CAkey",
				"ca.key",
				"-CAcreateserial",
				"-sha256",
				"-days",
				`${certificateDays}`,
				"-extfile",
				"server.ext",
				"-out",
				"server.crt"
			],
			step
		)
		yield* Effect.forEach(
			["server.csr", "server.ext", "ca.srl"],
			(name) =>
				Effect.mapError(
					fs.remove(`${directory}/${name}`, { force: true }),
					files(`removing ${name}`)
				),
			{ discard: true }
		)
		yield* Effect.forEach(
			["ca.key", "wrong-ca.key", "server.key"],
			(name) =>
				Effect.mapError(fs.chmod(`${directory}/${name}`, 0o600), files(`restricting ${name}`)),
			{ discard: true }
		)
	})

/** Node's certificates: a member's TLS is read in this process, with no openssl run. */
const { X509Certificate } = process.getBuiltinModule("node:crypto")

/**
 * Whether every certificate in a member's TLS directory is still valid, read here in this process with no program run:
 * each is there, parses as a certificate and has not expired on the live clock (openssl's -checkend 0). One that is
 * missing or does not parse is no current certificate, and the member's TLS is issued again.
 */
export const tlsCurrent = (
	directory: string,
	step: Step
): Effect.Effect<boolean, ClusterFailed, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const unread = (error: { readonly message: string }) => failed(step, error.message)
		const now = yield* liveMillis
		const current = yield* Effect.forEach(["ca.crt", "server.crt", "wrong-ca.crt"], (name) =>
			Effect.gen(function* () {
				const file = `${directory}/${name}`
				if (!(yield* fs.exists(file))) {
					return false
				}
				const pem = yield* fs.readFileString(file)
				return Result.match(
					Result.try({ try: () => new X509Certificate(pem), catch: (error) => error }),
					{
						onSuccess: (certificate) => certificate.validToDate.getTime() > now,
						onFailure: () => false
					}
				)
			}).pipe(Effect.mapError(unread))
		)
		return Arr.every(current, (valid) => valid)
	})

/** A fresh password for a member's owner: 24 random bytes, as hex. */
export const freshPassword = (step: Step) =>
	Effect.map(succeeded(step, ChildProcess.make("openssl", ["rand", "-hex", "24"])), Str.trim)
