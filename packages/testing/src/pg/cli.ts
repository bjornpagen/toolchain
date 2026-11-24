import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { regex } from "arkregex"
import {
	Array as Arr,
	Config,
	Console,
	Effect,
	Option,
	Path,
	type PlatformError,
	Redacted,
	Schema
} from "effect"
import { ChildProcessSpawner } from "effect/process"
import { failureText } from "#failure.ts"
import {
	type Checkout,
	type CheckoutFamily,
	checkoutHere,
	familyOf,
	type Homes,
	homesHere
} from "#pg/family.ts"
import { bootstrapSuperuser, type ClusterFailed, psql, serverBin } from "#pg/server.ts"
import {
	familyAsSettled,
	memberNames,
	memberRead,
	memberSettled,
	membersRunning,
	type PgMember,
	type SettleTarget,
	settled,
	settleUnit,
	settleWidthVariable,
	unitSettler
} from "#pg/settle.ts"
import { LocalCluster } from "#pg/spec.ts"
import { testWorkers } from "#workers.ts"

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

/** The first of a family's members, as a run reads it, which `toolchain-pg settle` brings up. */
const firstMember = (family: CheckoutFamily) => memberRead(family, 0)

/** psql on the first member with this terminal's stdin, stdout and stderr, its exit status this command's. */
const interactive = (family: CheckoutFamily, as: "owner" | "admin", args: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const member = yield* firstMember(family)
		const bin = yield* serverBin({ cluster: family.name, doing: "running psql" })
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

/** The usage this command prints for anything else. */
const usage = Arr.join(
	[
		"usage: toolchain-pg <command>, for this checkout's family of the cluster the working directory's pg.config.ts states",
		"  settle                             remove the cluster's families whose checkout is gone, settle the family's state",
		"                                     and its first member (postgres@<family>-0), as the unit <family>-settle: a",
		"                                     second settle of the family is refused; a run's worker brings up its own member",
		"  settle <member>                    start that member's unit and give it its spec, as the unit <family>-<member>-settle",
		"  check                              read every member that runs, as a run reads it, writing nothing",
		"  psql [database] [psql args...]     the owner, on the first member",
		"  admin [database] [psql args...]    the bootstrap superuser (this account) over the socket, on the first member",
		"  env                                the first member's facts, one NAME=value line each"
	],
	"\n"
)

/** A member's index as `settle <member>` names it: decimal, one of the family's. */
const memberIndex = regex("^[0-9]+$")

/** What `settle [member]` settles: the family, or the member its argument names, else none. */
const targetOf = (
	family: CheckoutFamily,
	args: ReadonlyArray<string>
): Option.Option<SettleTarget> =>
	Arr.match(args, {
		onEmpty: () => Option.some<SettleTarget>({ kind: "family" }),
		onNonEmpty: ([named, ...rest]) =>
			memberIndex.test(named) &&
			Arr.isReadonlyArrayEmpty(rest) &&
			Number(named) < memberNames(family).length
				? Option.some<SettleTarget>({ kind: "member", index: Number(named) })
				: Option.none()
	})

/**
 * `target` settled here, as its settle unit runs it: the family's state and its first member (settled, which brings
 * the member up by its own unit, as a worker does), or one member (memberSettled); either named on stdout.
 */
const settledHere = (family: CheckoutFamily, target: SettleTarget) =>
	Effect.flatMap(
		target.kind === "family" ? settled(family, unitSettler) : memberSettled(family, target.index),
		(member) => Console.log(`settled: ${member.name} (port ${member.port})`)
	)

/** A width as a settle unit is given it (settleWidthVariable): a whole number of workers, one at least, in decimal. */
const widthText = regex("^[1-9][0-9]*$")

/**
 * The width a settle unit was given (settleWidthVariable): none for a process no settle unit is, a person's or a
 * script's, and a defect for a variable that is no width, which only a broken starter writes.
 */
const settleWidth: Effect.Effect<Option.Option<number>> = Effect.map(
	Effect.orDie(Config.option(Config.String(settleWidthVariable))),
	Option.map((text) => {
		if (!widthText.test(text)) {
			throw new Error(
				`${settleWidthVariable}=${text} is no width: a whole number of workers it must be`
			)
		}
		return Number(text)
	})
)

/**
 * The commands, by name, each from its arguments to its exit status, over `cluster`'s family at this process's checkout
 * in its account's homes: `settle` at the width a settle unit was given, else at this process's own run width
 * (testWorkers), which it gives the unit it starts; every other command at the width the family's state was last
 * settled for (familyAsSettled), since a person's command runs no workers.
 */
const commands = (
	cluster: LocalCluster,
	checkout: Checkout,
	homes: Homes
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
> => {
	const asSettled = familyAsSettled(cluster, checkout, homes)
	return {
		settle: (args) =>
			Effect.flatMap(
				settleWidth,
				(
					given
				): Effect.Effect<
					number,
					ClusterFailed | PlatformError.PlatformError,
					NodeServices.NodeServices
				> => {
					const family = familyOf(
						cluster,
						checkout,
						homes,
						Option.getOrElse(given, () => testWorkers)
					)
					return Option.match(targetOf(family, args), {
						onNone: () => Effect.as(Console.error(usage), 2),
						onSome: (target) =>
							Option.isNone(given)
								? Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
										Effect.map(
											spawner.exitCode(settleUnit(family, target, "inherit").command),
											(status): number => Number(status)
										)
									)
								: Effect.as(settledHere(family, target), 0)
					})
				}
			),
		check: () =>
			Effect.as(
				Effect.flatMap(Effect.flatMap(asSettled, membersRunning), (members) =>
					Console.log(
						`as its spec states: ${Arr.join(
							Arr.map(members, (member) => member.name),
							", "
						)}`
					)
				),
				0
			),
		psql: (args) => Effect.flatMap(asSettled, (family) => interactive(family, "owner", args)),
		admin: (args) => Effect.flatMap(asSettled, (family) => interactive(family, "admin", args)),
		env: () =>
			Effect.flatMap(Effect.flatMap(asSettled, firstMember), (member) =>
				Effect.as(
					Effect.forEach(envLines(member, cluster.template), (line) => Console.log(line), {
						discard: true
					}),
					0
				)
			)
	}
}

/**
 * Runs the command its arguments name over the working directory's cluster at this process's checkout and in its
 * account's homes (family.ts checkoutHere and homesHere, read here once), its exit status this process's.
 */
const main = Effect.gen(function* () {
	const [name, ...args] = Arr.drop(process.argv, 2)
	const cluster = yield* specOf
	const checkout = yield* checkoutHere
	const homes = yield* homesHere
	const all = commands(cluster, checkout, homes)
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
