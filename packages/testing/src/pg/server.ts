import { userInfo } from "node:os"
import { Array as Arr, Effect, Schema, Stream, String as Str } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { waitingOn } from "#live.ts"

/**
 * What every step of a local cluster's settling and reading shares: its failure, a program run to its end, the
 * bootstrap superuser's statements over a member's socket, and the account's identity there.
 */

/**
 * A step of a local cluster's settling or reading failed: the cluster it was for, by its unit name, and what failed,
 * with what the program that refused said. Every command of `toolchain-pg` and every need that reads a cluster fails
 * with it.
 */
export class ClusterFailed extends Schema.TaggedError<
	ClusterFailed,
	{ readonly brand: unique symbol }
>()("ClusterFailed", { cluster: Schema.String, message: Schema.String }) {}

/** A program's run: its exit code and what it wrote to stdout and stderr. */
type Ran = Readonly<{ code: number; stdout: string; stderr: string }>

/** What a cluster's step needs to name its failure: the cluster's unit name and the step. */
export type Step = Readonly<{ cluster: string; doing: string }>

/** A failure of `step`, saying `detail`. */
export const failed = (step: Step, detail: string): ClusterFailed =>
	ClusterFailed.make({ cluster: step.cluster, message: `${step.doing}: ${detail}` })

/** Runs `command` to its end for `step`, its stdout and stderr read whole. */
const ran = (
	step: Step,
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
	).pipe(Effect.mapError((error) => failed(step, error.message)))

/** `command` run to its end for `step`: its stdout when it exits 0, else the step's failure with what it said. */
export const succeeded = (
	step: Step,
	command: ChildProcess.Command
): Effect.Effect<string, ClusterFailed, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.flatMap(ran(step, command), (done) =>
		done.code === 0
			? Effect.succeed(done.stdout)
			: Effect.fail(
					failed(step, `exited ${done.code}: ${Str.trim(`${done.stderr}\n${done.stdout}`)}`)
				)
	)

/**
 * The directory of the server's programs, as the `pg_config` on PATH names it (`pg_config --bindir`): the release the
 * workbench's PostgreSQL units run (the machine layer's), whose psql reads a member as the server it talks to.
 */
export const serverBin = (
	step: Step
): Effect.Effect<string, ClusterFailed, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.flatMap(
		succeeded(
			{ ...step, doing: `${step.doing}: reading pg_config --bindir` },
			ChildProcess.make("pg_config", ["--bindir"])
		),
		(text) =>
			Str.startsWith("/")(Str.trim(text))
				? Effect.succeed(Str.trim(text))
				: Effect.fail(failed(step, `pg_config --bindir named ${text}, no absolute directory`))
	)

/** psql from the server's bin directory. */
export const psql = (
	bin: string,
	args: ReadonlyArray<string>,
	options: ChildProcess.CommandOptions
): ChildProcess.Command => ChildProcess.make(`${bin}/psql`, args, options)

/** The account this process runs as: a member's bootstrap superuser, the role its unit's initdb made. */
export const bootstrapSuperuser = (): string => userInfo().username

/** Where a member's socket is: its unit's runtime directory and the port its socket file is named by. */
export type SocketAt = Readonly<{ socket: string; port: number }>

/**
 * The rows of `statements`, run one after another as the bootstrap superuser in `database` on the member at `at`, over
 * its socket, where the unit's trust admits the account: each statement its own query (psql's -c), so CREATE DATABASE
 * runs outside a transaction block, the first failing one ending the run; each row one line, its columns separated by
 * `|`. A declared wait of this process named by its statements (live.ts waitingOn), as every statement the library
 * sends is (resources/cluster.ts run): psql, its child, waits on the member's work, which spends none of its tree's
 * CPU, and a run reads a member through it (pg/settle.ts membersRead) the first time a need reaches the cluster.
 */
export const adminSql = (
	bin: string,
	at: SocketAt,
	database: string,
	statements: Arr.NonEmptyReadonlyArray<string>,
	step: Step
): Effect.Effect<ReadonlyArray<string>, ClusterFailed, ChildProcessSpawner.ChildProcessSpawner> =>
	Effect.map(
		waitingOn(Arr.join(statements, "; "))(
			succeeded(
				step,
				psql(
					bin,
					[
						"-X",
						"-q",
						"-A",
						"-t",
						"-v",
						"ON_ERROR_STOP=1",
						"-h",
						at.socket,
						"-p",
						`${at.port}`,
						"-U",
						bootstrapSuperuser(),
						"-d",
						database,
						...Arr.flatMap(statements, (statement) => ["-c", statement])
					],
					{}
				)
			)
		),
		(text) => Arr.filter(Str.split(text, "\n"), Str.isNonEmpty)
	)

/** A fresh password for a cluster's owner: 24 random bytes, as hex. */
export const freshPassword = (step: Step) =>
	Effect.map(succeeded(step, ChildProcess.make("openssl", ["rand", "-hex", "24"])), Str.trim)

/**
 * The lifetime of the unrelated CA a cluster's state holds (unrelatedCa), which `toolchain-pg settle` issues once and
 * keeps.
 *
 * @limitKind provisional
 * @owner the toolchain's local clusters (pg/server.ts unrelatedCa), from grizzle's scripts/pg/init.sh at a5dd3588d
 * @unit days
 * @scope the unrelated CA a cluster's state directory holds, from its issue
 * @guards an expired unrelated CA could fail a refusal check for its expiry rather than for its chain: a lifetime
 *   longer than any cluster's state lives never does
 * @measure none to run while a cluster's state is made again sooner than this; revisit when one outlives it
 * @origin grizzle's scripts/pg/init.sh (3650 days), carried here
 * @recorded 2026-11-18
 */
const certificateDays = 3650

/**
 * A certificate authority no server presents a certificate of, self-signed for `subject`, its PEM text: what a client
 * check that must refuse a server it cannot verify is handed instead of the server's CA. Its key is thrown away.
 */
export const unrelatedCa = (step: Step, subject: string) =>
	succeeded(
		step,
		ChildProcess.make("openssl", [
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
			"/dev/null"
		])
	)
