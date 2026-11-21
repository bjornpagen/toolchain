import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import {
	Array as Arr,
	Config,
	Console,
	Effect,
	Option,
	Path,
	type PlatformError,
	Redacted,
	Schema,
	String as Str
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { failureText } from "#failure.ts"
import { bootstrapSuperuser, type ClusterFailed, psql, serverBin } from "#pg/server.ts"
import { membersRead, type PgMember, settled } from "#pg/settle.ts"
import { LocalCluster } from "#pg/spec.ts"

/** The file a package's cluster is stated in, at the root the command runs from. */
const configFile = "pg.config.ts"

/** pg.config.ts could not be loaded as a cluster's spec, and why. */
class SpecUnloaded extends Schema.TaggedError<SpecUnloaded, { readonly brand: unique symbol }>()(
	"SpecUnloaded",
	{ message: Schema.String }
) {}

/** Whether a module's default export is a cluster's spec, made by localCluster: an instance of its class. */
const isLocalCluster = Schema.is(Schema.instanceOf(LocalCluster))

/** The cluster the package at the working directory states: its pg.config.ts's default export, a LocalCluster. */
const specOf: Effect.Effect<LocalCluster, SpecUnloaded, Path.Path> = Effect.gen(function* () {
	const paths = yield* Path.Path
	const url = yield* Effect.mapError(paths.toFileUrl(paths.resolve(configFile)), (bad) =>
		SpecUnloaded.make({ message: `${configFile} has no file URL: ${bad.message}` })
	)
	const namespace = yield* Effect.tryPromise({
		try: (): Promise<unknown> => import(url.href),
		catch: (cause) => SpecUnloaded.make({ message: `${configFile} did not load: ${String(cause)}` })
	})
	const spec: unknown =
		typeof namespace === "object" && namespace !== null
			? Reflect.get(namespace, "default")
			: undefined
	return isLocalCluster(spec)
		? spec
		: yield* SpecUnloaded.make({
				message: `${configFile} must export localCluster({ ... }) (@bjornpagen/testing/pg) as its default`
			})
})

/** A member's facts as `env` prints them, one `NAME=value` line each. */
const envLines = (member: PgMember, template: string): ReadonlyArray<string> => [
	`TOOLCHAIN_PG_PORT=${member.port}`,
	`TOOLCHAIN_PG_HOST=${member.tls.kind === "tls" ? "localhost" : member.socket}`,
	`TOOLCHAIN_PG_SOCKET=${member.socket}`,
	`TOOLCHAIN_PG_OWNER=${member.owner}`,
	`TOOLCHAIN_PG_TEMPLATE=${template}`,
	...(member.tls.kind === "tls" ? [`TOOLCHAIN_PG_CA=${member.tls.caFile}`] : []),
	`TOOLCHAIN_PG_PASSWORD_FILE=${member.passwordFile}`
]

/** The first of a cluster's members, as a run reads it. */
const firstMember = (cluster: LocalCluster) => Effect.map(membersRead(cluster), Arr.headNonEmpty)

/** psql on the first member with this terminal's stdin, stdout and stderr, its exit status this command's. */
const interactive = (cluster: LocalCluster, as: "owner" | "admin", args: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const member = yield* firstMember(cluster)
		const bin = yield* serverBin({ cluster: cluster.unit, doing: "running psql" })
		const [database, ...rest] = args
		const stdio = { stdin: "inherit", stdout: "inherit", stderr: "inherit" } as const
		const command =
			as === "owner"
				? psql(
						bin,
						[
							"-X",
							member.tls.kind === "tls"
								? `host=localhost port=${member.port} dbname=${database ?? member.owner} user=${member.owner} sslmode=verify-full sslrootcert=${member.tls.caFile}`
								: `host=${member.socket} port=${member.port} dbname=${database ?? member.owner} user=${member.owner}`,
							...rest
						],
						{ ...stdio, env: { PGPASSWORD: Redacted.value(member.password) }, extendEnv: true }
					)
				: psql(
						bin,
						[
							"-X",
							"-h",
							member.socket,
							"-p",
							`${member.port}`,
							"-U",
							bootstrapSuperuser(),
							"-d",
							database ?? "postgres",
							...rest
						],
						stdio
					)
		return yield* spawner.exitCode(command)
	})

/**
 * The variable a settle's own unit runs it with: present, the command settles here; absent, it starts its unit
 * (settleUnit) and waits on it, so every settle of a cluster runs as the one unit its name gives.
 */
const settlingVariable = "TOOLCHAIN_PG_SETTLING"

/** The unit a cluster's settle runs as, and its repository's slice: the cluster's unit name's first word. */
const settleUnit = (cluster: LocalCluster) => ({
	unit: `${cluster.unit}-settle`,
	slice: `${Option.getOrElse(Arr.head(Str.split(cluster.unit, "-")), () => cluster.unit)}.slice`
})

/** The usage this command prints for anything else. */
const usage = Arr.join(
	[
		"usage: toolchain-pg <command>, for the cluster the working directory's pg.config.ts states",
		"  settle                             start each member's unit (postgres@<unit>-<i>) and give it its spec,",
		"                                     as the unit <unit>-settle: a second settle of the cluster is refused",
		"  check                              read every member, as a run reads it, writing nothing",
		"  psql [database] [psql args...]     the owner, on the first member",
		"  admin [database] [psql args...]    the bootstrap superuser (this account) over the socket, on the first member",
		"  env                                the first member's facts, one NAME=value line each"
	],
	"\n"
)

/**
 * `settle` as the cluster's settle unit: run with this process's own program and flags in the working directory,
 * `systemd-run --wait --pipe`, which answers the unit's exit status and is refused at once when the unit already runs,
 * so two settles of one cluster never run together and none waits its turn.
 */
const settleAsUnit = (cluster: LocalCluster) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const { unit, slice } = settleUnit(cluster)
		return yield* spawner.exitCode(
			ChildProcess.make(
				"systemd-run",
				[
					"--user",
					"-d",
					"-u",
					unit,
					`--slice=${slice}`,
					"--wait",
					"--pipe",
					"--collect",
					"-E",
					`${settlingVariable}=1`,
					"--",
					process.execPath,
					...process.execArgv,
					...Arr.take(Arr.drop(process.argv, 1), 1),
					"settle"
				],
				{ stdin: "inherit", stdout: "inherit", stderr: "inherit" }
			)
		)
	})

/** The commands, by name, each from its arguments to its exit status. */
const commands = (
	cluster: LocalCluster
): Readonly<
	Record<
		string,
		(
			args: ReadonlyArray<string>
		) => Effect.Effect<
			number,
			ClusterFailed | PlatformError.PlatformError,
			NodeServices.NodeServices
		>
	>
> => ({
	settle: () =>
		Effect.flatMap(
			Config.option(Config.String(settlingVariable)).pipe(Effect.orDie),
			(
				settling
			): Effect.Effect<
				number,
				ClusterFailed | PlatformError.PlatformError,
				NodeServices.NodeServices
			> =>
				Option.isNone(settling)
					? Effect.map(settleAsUnit(cluster), (status): number => Number(status))
					: Effect.as(
							Effect.flatMap(settled(cluster), (members) =>
								Console.log(
									`settled: ${Arr.join(
										Arr.map(members, (member) => `${member.name} (port ${member.port})`),
										", "
									)}`
								)
							),
							0
						)
		),
	check: () =>
		Effect.as(
			Effect.flatMap(membersRead(cluster), (members) =>
				Console.log(
					`as its spec states: ${Arr.join(
						Arr.map(members, (member) => member.name),
						", "
					)}`
				)
			),
			0
		),
	psql: (args) => interactive(cluster, "owner", args),
	admin: (args) => interactive(cluster, "admin", args),
	env: () =>
		Effect.flatMap(firstMember(cluster), (member) =>
			Effect.as(
				Effect.forEach(envLines(member, cluster.template), (line) => Console.log(line), {
					discard: true
				}),
				0
			)
		)
})

/** Runs the command its arguments name over the working directory's cluster, its exit status this process's. */
const main = Effect.gen(function* () {
	const [name, ...args] = Arr.drop(process.argv, 2)
	const cluster = yield* specOf
	const all = commands(cluster)
	return yield* Option.match(
		Option.flatMap(Option.fromUndefinedOr(name), (named) => Option.fromUndefinedOr(all[named])),
		{
			onNone: () => Effect.as(Console.error(usage), 2),
			onSome: (command) => command(args)
		}
	)
})

NodeRuntime.runMain(
	main.pipe(
		Effect.catchCause((cause) =>
			Effect.as(Console.error(`toolchain-pg: ${failureText(cause)}`), 1)
		),
		Effect.flatMap((status) =>
			Effect.sync(() => {
				process.exitCode = status
			})
		),
		Effect.provide(NodeServices.layer)
	)
)
