import { Array as Arr, Config, Effect, FileSystem, Option, Result, String as Str } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { boolean, type Gen } from "#gen.ts"
import { memberNames, unitOf } from "#pg/settle.ts"
import { type LocalCluster, localCluster, type WorkerSizing } from "#pg/spec.ts"
import { testWorkers } from "#workers.ts"

/**
 * What the settle properties (settle.test.ts) draw and run: a cluster of a unit name of its own (a case's, so no case
 * reaches another's members), reached over its socket or over TLS at a port the machine has free, of one member or
 * two; and the members' units, stopped by name and their data and state removed as the case's scope closes.
 */

/** A drawn cluster's shape: TLS or its socket alone, and one member or two. */
export type Shape = Readonly<{ tls: boolean; spread: boolean }>

/** Every shape, one case each. */
export const shapes: Gen<Shape> = (source) => ({
	tls: source.draw(boolean),
	spread: source.draw(boolean)
})

/** Node's sockets, as the process holds them. */
const net = process.getBuiltinModule("node:net")

/** A listener's server, as node:net makes it. */
type Listener = ReturnType<typeof net.createServer>

/** The addresses a member's TLS listener binds where it listens at localhost: IPv4's and IPv6's loopback. */
const LOOPBACKS = ["127.0.0.1", "::1"] as const

/** A listener on `port` of `host` now (0 for any the kernel hands out), or none where another process holds it. */
const listenerAt = (port: number, host: string) =>
	Effect.callback<Option.Option<Listener>>((resume) => {
		const server = net.createServer()
		server.once("error", () => resume(Effect.succeedNone))
		server.listen(port, host, () => resume(Effect.succeedSome(server)))
	})

/** These listeners closed. */
const closedAll = (listeners: ReadonlyArray<Listener>) =>
	Effect.forEach(
		listeners,
		(listener) =>
			Effect.callback<void>((resume) => {
				listener.close(() => resume(Effect.void))
			}),
		{ discard: true }
	)

/**
 * @formatConstant Linux's /proc/sys/net/ipv4/ip_local_port_range (ip-sysctl.rst): two numbers on a line, the first and
 * last port the kernel hands a socket that binds none of its own (an outgoing connection's local port, a listener on
 * port 0); and the lowest port an unprivileged process may listen on, net.ipv4.ip_unprivileged_port_start's default.
 */
const PORT_RANGE = { file: "/proc/sys/net/ipv4/ip_local_port_range", unprivileged: 1024 } as const

/** The first port of the kernel's ephemeral range (PORT_RANGE), read from /proc: the text before its first blank. */
const ephemeralFloor = Effect.flatMap(FileSystem.FileSystem, (fs) =>
	Effect.map(Effect.orDie(fs.readFileString(PORT_RANGE.file)), (text) =>
		Number.parseInt(Str.trim(text), 10)
	)
)

/**
 * The first of `count` consecutive TCP ports free at localhost now, on both loopbacks, as a spread family's members take
 * them (member i at the port and i past it), drawn below the kernel's ephemeral range: a port of that range is any
 * outgoing connection's local port at any moment, so one free when drawn is taken by the time a member binds it
 * (trunk@toolchain's run at 37b414b1: a member's restart at 34562, "could not bind IPv4 address \"127.0.0.1\": Address
 * already in use", the machine's thousands of database clients holding ephemeral ports), where below it no port is
 * handed out unasked. A drawn port another listener holds is drawn again.
 */
const freePorts = (count: number): Effect.Effect<number, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const floor = yield* ephemeralFloor
		const port =
			PORT_RANGE.unprivileged +
			process.getBuiltinModule("node:crypto").randomInt(floor - PORT_RANGE.unprivileged - count)
		const listeners = yield* Effect.forEach(
			Arr.flatMap(
				Array.from({ length: count }, (_, offset) => port + offset),
				(at) => Arr.map(LOOPBACKS, (host) => ({ port: at, host }))
			),
			(at) => listenerAt(at.port, at.host)
		)
		yield* closedAll(Arr.getSomes(listeners))
		return Arr.every(listeners, Option.isSome)
			? port
			: yield* Effect.suspend(() => freePorts(count))
	})

/**
 * A case's cluster of `shape`: a unit name of its own (`tcs-` and 8 random hex digits), its workers' capacity sized by
 * a busy backend of the package's own (pg.config.ts's), two members when `spread` (a family whose members serve half
 * the run's workers each), and over TLS free ports, the first and, spread, the one after it (freePorts).
 */
export const clusterOf = (
	shape: Shape
): Effect.Effect<LocalCluster<WorkerSizing>, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const port = shape.tls ? yield* freePorts(shape.spread ? 2 : 1) : 0
		return localCluster({
			unit: `tcs-${process.getBuiltinModule("node:crypto").randomBytes(4).toString("hex")}`,
			network: shape.tls ? { kind: "tls", port } : { kind: "socket" },
			owner: "toolchain_settle",
			template: "toolchain_settle_template",
			extensions: [],
			ownerParameters: [],
			durability: "throwaway",
			sizing: {
				kind: "workers",
				family: shape.spread
					? { kind: "spread", workersPerMember: Math.max(1, Math.ceil(testWorkers / 2)) }
					: { kind: "one" },
				connections: { kind: "capacity", backendBytes: 37_301_248 },
				replication: { kind: "default" },
				sharedBuffers: { kind: "default" },
				locks: { kind: "perTransaction", locks: 256 }
			}
		})
	})

/** Whether `name`'s member unit is active now, as systemctl says (`systemctl --user is-active`, which exits 0 when it is). */
export const unitActive = (name: string) =>
	Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
		Effect.map(
			Effect.orElseSucceed(
				Effect.map(
					spawner.exitCode(
						ChildProcess.make("systemctl", ["--user", "is-active", "--quiet", unitOf(name)])
					),
					Number
				),
				() => 1
			),
			(code) => code === 0
		)
	)

/**
 * `cluster`'s units and files gone as the enclosing scope closes, however it ends: each member's unit stopped by its
 * name and its failure forgotten, its data directory (the workbench's, ~/.local/var/postgres/<name>) and the cluster's
 * state directory removed.
 */
export const removedAtEnd = (cluster: LocalCluster) =>
	Effect.addFinalizer(() =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			const home = yield* Config.String("HOME")
			const state = yield* Config.withDefault(
				Config.String("XDG_STATE_HOME"),
				`${home}/.local/state`
			)
			yield* Effect.forEach(
				memberNames(cluster),
				(name) =>
					Effect.gen(function* () {
						yield* Effect.ignore(
							spawner.exitCode(ChildProcess.make("systemctl", ["--user", "stop", unitOf(name)]))
						)
						yield* Effect.ignore(
							spawner.exitCode(
								ChildProcess.make("systemctl", ["--user", "reset-failed", unitOf(name)])
							)
						)
						const data = yield* dataOf(name)
						yield* Effect.ignore(fs.remove(data, { recursive: true }))
					}),
				{ discard: true }
			)
			yield* Effect.ignore(fs.remove(`${state}/toolchain-pg/${cluster.unit}`, { recursive: true }))
		}).pipe(Effect.orDie)
	)

/** A member's data directory, the workbench's postgres@ unit's: `~/.local/var/postgres/<name>`. */
export const dataOf = (name: string) =>
	Effect.map(Effect.orDie(Config.String("HOME")), (home) => `${home}/.local/var/postgres/${name}`)

/** Whether an effect failed: its Result's failure, as a fact. */
export const failedOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.map(Effect.result(effect), Result.isFailure)
