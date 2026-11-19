import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Array as Arr, Console, Effect, Option, Path, type PlatformError, Schema } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { failureText } from "#failure.ts"
import { doctor } from "#pg/doctor.ts"
import {
	clusterStatus,
	clusterUp,
	destroyCluster,
	firstMember,
	type InitMode,
	initCluster,
	type PgMember,
	resetCluster,
	stopCluster
} from "#pg/make.ts"
import { type ClusterFailed, conninfo, ownerPsql, program, verified } from "#pg/server.ts"
import { LocalCluster } from "#pg/spec.ts"

/** The file a package's cluster is stated in, at the root the command runs from. */
const configFile = "pg.config.ts"

/** pg.config.ts could not be loaded as a cluster's spec, and why. */
class SpecUnloaded extends Schema.TaggedError<SpecUnloaded, { readonly brand: unique symbol }>()(
	"SpecUnloaded",
	{ message: Schema.String }
) {}

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
	return spec instanceof LocalCluster
		? spec
		: yield* SpecUnloaded.make({
				message: `${configFile} must export localCluster({ ... }) (@bjornpagen/testing/pg) as its default`
			})
})

/** A member's facts as `env` prints them, one `NAME=value` line each. */
const envLines = (member: PgMember, owner: string, template: string): ReadonlyArray<string> => [
	`TOOLCHAIN_PG_PORT=${member.port}`,
	`TOOLCHAIN_PG_HOST=localhost`,
	`TOOLCHAIN_PG_SOCKET=${member.socket}`,
	`TOOLCHAIN_PG_OWNER=${owner}`,
	`TOOLCHAIN_PG_TEMPLATE=${template}`,
	`TOOLCHAIN_PG_CA=${member.caFile}`,
	`TOOLCHAIN_PG_PASSWORD_FILE=${member.passwordFile}`
]

/** psql on the first member with this terminal's stdin, stdout and stderr, its exit status this command's. */
const interactive = (cluster: LocalCluster, as: "owner" | "admin", args: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const { bin, member, state } = yield* firstMember(cluster)
		const [database, ...rest] = args
		const stdio = { stdin: "inherit", stdout: "inherit", stderr: "inherit" } as const
		const command =
			as === "owner"
				? ownerPsql(
						bin,
						conninfo(state, member.owner, database ?? member.owner, verified(member.caFile)),
						member.password,
						rest,
						stdio
					)
				: program(
						bin,
						"psql",
						[
							"-X",
							"-h",
							member.socket,
							"-p",
							`${member.port}`,
							"-U",
							"postgres",
							"-d",
							database ?? "postgres",
							...rest
						],
						stdio
					)
		return yield* spawner.exitCode(command)
	})

/** The usage this command prints for anything else. */
const usage = Arr.join(
	[
		"usage: toolchain-pg <command>, for the cluster the working directory's pg.config.ts states",
		"  init [--force | --adopt | --adopt-from <data directory>]",
		"                                     make it; --force makes a throwaway one again, --adopt keeps and sizes it,",
		"                                     --adopt-from takes a cluster another maker made, its data where it lies",
		"  start | stop | status              start makes it when missing, then starts every member",
		"  doctor [--quick]                   check it; --quick needs no scratch database",
		"  psql [database] [psql args...]     the owner over verify-full TLS, on the first member",
		"  admin [database] [psql args...]    the bootstrap superuser over the socket, on the first member",
		"  reset                              drop every database and role its making did not leave (throwaway only)",
		"  destroy                            stop every member and remove its state (throwaway only)",
		"  env                                the first member's facts, one NAME=value line each"
	],
	"\n"
)

/**
 * The mode `init`'s arguments name: none for `create`, `--force`, `--adopt`, or `--adopt-from <data directory>`; none
 * for anything else.
 */
const initMode = (args: ReadonlyArray<string>): Option.Option<InitMode> => {
	const [flag, data, ...rest] = args
	if (flag === "--adopt-from" && data !== undefined && rest.length === 0) {
		return Option.some({ kind: "adoptFrom", data })
	}
	switch (Arr.join(args, " ")) {
		case "":
			return Option.some({ kind: "create" })
		case "--force":
			return Option.some({ kind: "force" })
		case "--adopt":
			return Option.some({ kind: "adopt" })
		default:
			return Option.none()
	}
}

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
	init: (args) =>
		Option.match(initMode(args), {
			onNone: () => Effect.as(Console.error(usage), 2),
			onSome: (mode) =>
				Effect.as(
					Effect.flatMap(initCluster(cluster, mode), (members) =>
						Console.log(
							`Cluster ready: ${members.length} member(s) on localhost:${Arr.join(
								Arr.map(members, (member) => member.name),
								" "
							)}`
						)
					),
					0
				)
		}),
	start: () =>
		Effect.as(
			Effect.flatMap(clusterUp(cluster), (members) =>
				Console.log(
					`PostgreSQL running on localhost:${Arr.join(
						Arr.map(members, (m) => m.name),
						" "
					)}`
				)
			),
			0
		),
	stop: () => Effect.as(Effect.andThen(stopCluster(cluster), Console.log("PostgreSQL stopped")), 0),
	status: () =>
		Effect.flatMap(clusterStatus(cluster), (members) =>
			Effect.as(
				Effect.forEach(
					members,
					(member) =>
						Console.log(`localhost:${member.port} ${member.running ? "running" : "stopped"}`),
					{ discard: true }
				),
				Arr.every(members, (member) => member.running) ? 0 : 3
			)
		),
	doctor: (args) =>
		Effect.flatMap(doctor(cluster, Arr.contains(args, "--quick")), (members) =>
			Effect.gen(function* () {
				yield* Effect.forEach(
					members,
					({ port, verdicts }) =>
						Effect.andThen(
							Console.log(`member on port ${port}`),
							Effect.forEach(
								verdicts,
								(verdict) =>
									Console.log(
										verdict.kind === "ok"
											? `  ok    ${verdict.name}`
											: `  FAIL  ${verdict.name}\n        ${verdict.detail}`
									),
								{ discard: true }
							)
						),
					{ discard: true }
				)
				const failures = Arr.flatMap(members, ({ verdicts }) =>
					Arr.filter(verdicts, (verdict) => verdict.kind === "failed")
				).length
				yield* Console.log(
					failures === 0 ? "doctor: all checks passed" : `doctor: ${failures} check(s) failed`
				)
				return failures === 0 ? 0 : 1
			})
		),
	psql: (args) => interactive(cluster, "owner", args),
	admin: (args) => interactive(cluster, "admin", args),
	reset: () =>
		Effect.as(
			Effect.andThen(
				resetCluster(cluster),
				Console.log("Every database and role its making did not leave is dropped")
			),
			0
		),
	destroy: () =>
		Effect.as(Effect.andThen(destroyCluster(cluster), Console.log("Cluster destroyed")), 0),
	env: () =>
		Effect.flatMap(firstMember(cluster), ({ member }) =>
			Effect.as(
				Effect.forEach(
					envLines(member, cluster.owner, cluster.template),
					(line) => Console.log(line),
					{
						discard: true
					}
				),
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
