import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { regex } from "arkregex"
import { Array as Arr, Config, Console, Effect, Option, type PlatformError, Redacted } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { failureText } from "#failure.ts"
import { specAt } from "#pg/config-file.ts"
import {
	type Checkout,
	type CheckoutFamily,
	checkoutHere,
	familyOf,
	type Homes,
	homesHere,
	memberNames
} from "#pg/family.ts"
import { familyHeld } from "#pg/hold.ts"
import { bootstrapSuperuser, type ClusterFailed, psql, serverBin } from "#pg/server.ts"
import {
	familyAsSettled,
	familyReached,
	memberBroughtUp,
	memberSettled,
	membersRunning,
	type PgMember,
	type SettleTarget,
	settled,
	settleUnit,
	settleWidthVariable,
	unitSettler
} from "#pg/settle.ts"
import type { LocalCluster } from "#pg/spec.ts"
import { testWorkers } from "#workers.ts"

/** A member's facts as `run` gives its command them, by variable. */
const factsOf = (member: PgMember, template: string): Readonly<Record<string, string>> => ({
	TOOLCHAIN_PG_PORT: `${member.port}`,
	TOOLCHAIN_PG_HOST: member.tls.kind === "tls" ? "localhost" : member.socket,
	TOOLCHAIN_PG_SOCKET: member.socket,
	TOOLCHAIN_PG_OWNER: member.owner,
	TOOLCHAIN_PG_TEMPLATE: template,
	...(member.tls.kind === "tls" ? { TOOLCHAIN_PG_CA: member.tls.caFile } : {}),
	TOOLCHAIN_PG_PASSWORD_FILE: member.passwordFile
})

/**
 * `use` of the first of `family`'s members, the family held by this command for as long as `use` runs (hold.ts
 * familyHeld) and its first member brought up as a worker brings up its own (memberBroughtUp, by its settle unit): so
 * the member runs while the command needs it, and stops with the command's end, however it ends, unless another hold of
 * the family lasts.
 */
const withFirstMember = <A, E, R>(
	family: CheckoutFamily,
	use: (member: PgMember) => Effect.Effect<A, E, R>
) =>
	Effect.scoped(
		Effect.flatMap(
			Effect.flatMap(familyHeld(family), (held) => memberBroughtUp(held, 0, unitSettler)),
			use
		)
	)

/** psql on the first member with this terminal's stdin, stdout and stderr, its exit status this command's. */
const interactive = (family: CheckoutFamily, as: "owner" | "admin", args: ReadonlyArray<string>) =>
	withFirstMember(family, (member) =>
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
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
	)

/**
 * `command` with this terminal's stdin, stdout and stderr and the first member's facts in its environment (factsOf),
 * the member held up for as long as it runs (withFirstMember), its exit status this command's.
 */
const ranWithFirstMember = (family: CheckoutFamily, command: Arr.NonEmptyReadonlyArray<string>) =>
	withFirstMember(family, (member) =>
		Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
			spawner.exitCode(
				ChildProcess.make(Arr.headNonEmpty(command), Arr.tailNonEmpty(command), {
					stdin: "inherit",
					stdout: "inherit",
					stderr: "inherit",
					env: factsOf(member, family.cluster.template),
					extendEnv: true
				})
			)
		)
	)

/** The usage this command prints for anything else. */
const usage = Arr.join(
	[
		"usage: toolchain-pg <command>, for this checkout's family of the cluster the working directory's pg.config.ts states",
		"  settle                             remove the cluster's families whose checkout is gone, settle the family's state",
		"                                     and its first member (postgres@<family>-0), as the unit <family>-settle: a",
		"                                     second settle of the family is refused; a run's worker brings up its own member",
		"  settle <member>                    start that member by its lease and give it its spec, as the unit",
		"                                     <family>-<member>-settle",
		"  check                              read every member that runs, as a run reads it, writing nothing",
		"  psql [database] [psql args...]     the owner, on the first member",
		"  admin [database] [psql args...]    the bootstrap superuser (this account) over the socket, on the first member",
		"  run [--] <command> [args...]       the command, the first member's facts in its environment (TOOLCHAIN_PG_PORT,",
		"                                     _HOST, _SOCKET, _OWNER, _TEMPLATE, _CA over TLS, _PASSWORD_FILE)",
		"",
		"A member runs only while a process holds its family: a run's worker, a settle while it settles, and psql, admin",
		"and run while they run. Each stops once the last of them has ended, however it ended."
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
 * (testWorkers), which it gives the unit it starts; `check` at the width the family's state was last settled for
 * (familyAsSettled), since a person's command runs no workers; and `psql`, `admin` and `run`, which bring up the first
 * member, at that width where its state records one, else at this process's own (familyReached).
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
	const reached = familyReached(cluster, checkout, homes)
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
		psql: (args) => Effect.flatMap(reached, (family) => interactive(family, "owner", args)),
		admin: (args) => Effect.flatMap(reached, (family) => interactive(family, "admin", args)),
		run: (args) =>
			Arr.match(Option.contains(Arr.head(args), "--") ? Arr.drop(args, 1) : args, {
				onEmpty: () => Effect.as(Console.error(usage), 2),
				onNonEmpty: (command) =>
					Effect.flatMap(reached, (family) => ranWithFirstMember(family, command))
			})
	}
}

/**
 * Runs the command its arguments name over the working directory's cluster at this process's checkout and in its
 * account's homes (family.ts checkoutHere and homesHere, read here once), its exit status this process's.
 */
const main = Effect.gen(function* () {
	const [name, ...args] = Arr.drop(process.argv, 2)
	const cluster = yield* specAt(".")
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
