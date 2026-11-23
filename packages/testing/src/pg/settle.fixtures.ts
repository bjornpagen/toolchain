import { regex } from "arkregex"
import {
	Array as Arr,
	Effect,
	Exit,
	FileSystem,
	Option,
	Result,
	Scope,
	String as Str
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { boolean, type Gen } from "#gen.ts"
import { type CheckoutFamily, checkoutAt, familyOf, homesHere, unitOf } from "#pg/family.ts"
import { memberNames, memberSettled, settled } from "#pg/settle.ts"
import { type LocalCluster, localCluster, type WorkerSizing } from "#pg/spec.ts"
import { testWorkers } from "#workers.ts"

/**
 * What the settle properties (settle.test.ts, family.test.ts) draw and run: a cluster of a unit name of its own (a
 * case's, so no case reaches another's members), held by the case's process while it lives, reached over its socket or
 * over TLS at ports its families claim from one the machine has free, of one member or two, its predicate lock table
 * production's for each backend or a room for its workers; its family at a checkout of the case's own and with a
 * states home of its own, both in a scratch directory, so no case reads or writes the account's families' state or
 * port claims, its members' data in the workbench's data home, where their units keep it; the members' units, stopped
 * by name and their data removed as the case's scope closes; and every case cluster a process ended with its scope open
 * left, removed as the next case draws its own.
 */

/** The account's homes, which only the workbench's units' data of a case's members is kept in. */
const machineHomes = Effect.orDie(homesHere)

/**
 * A drawn cluster's shape: TLS or its socket alone, one member or two, and its predicate lock room, a room for its
 * workers (`room`) or production's for each backend.
 */
export type Shape = Readonly<{ tls: boolean; spread: boolean; room: boolean }>

/** Every shape, one case each. */
export const shapes: Gen<Shape> = (source) => ({
	tls: source.draw(boolean),
	spread: source.draw(boolean),
	room: source.draw(boolean)
})

/**
 * The room a case cluster's workers take a worker, when its shape draws a room: small enough that the member's table is
 * PostgreSQL's least a backend (settings.ts minimumPredicateLocks), as grizzle's measured rooms make it.
 */
const caseRoomTargets = 64

/** Node's sockets, as the process holds them. */
const net = process.getBuiltinModule("node:net")

/** A listener's server, as node:net makes it. */
type Listener = ReturnType<typeof net.createServer>

/** The addresses a member's TLS listener binds where it listens at localhost: IPv4's and IPv6's loopback. */
const LOOPBACKS = ["127.0.0.1", "::1"] as const

/** A listener at `at` now, a port of a host's or a socket's path, or none where another socket holds it. */
const listenerAt = (at: Readonly<{ port: number; host: string }> | Readonly<{ path: string }>) =>
	Effect.callback<Option.Option<Listener>>((resume) => {
		const server = net.createServer()
		server.once("error", () => resume(Effect.succeedNone))
		server.listen(at, () => resume(Effect.succeedSome(server)))
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
			listenerAt
		)
		yield* closedAll(Arr.getSomes(listeners))
		return Arr.every(listeners, Option.isSome)
			? port
			: yield* Effect.suspend(() => freePorts(count))
	})

/**
 * A case's cluster's unit name (`tcs-` and 8 random hex digits, clusterOf), a family's of it (`-` and its key's 8 hex
 * digits after it) or a member's or its data directory's (the family's name and `-<i>`): `cluster` is the cluster's.
 */
const CASE_NAME = regex("^(?<cluster>tcs-[0-9a-f]{8})(?:-[0-9a-f]{8})?(?:-[0-9]+)?$")

/**
 * The name a case's cluster is held by: an abstract Unix socket's (Linux's unix(7): a name in no directory, its first
 * byte NUL), which the kernel frees with the socket, so with the process that holds it however that process ends, a
 * SIGKILL's and its unit's stop included, where no finalizer of the process's runs and a directory it was to remove
 * stays (resources/scratch.ts processScratch's remover is in the unit's cgroup and is stopped with it).
 */
const holdOf = (unit: string) => `\0toolchain-settle/${unit}`

/**
 * `unit`'s hold taken for the enclosing scope (holdOf), or none where a socket holds it already, this process's own
 * among them. The hold never keeps its process alive (its listener unreferenced).
 */
export const holdTaken = (unit: string) =>
	Effect.acquireRelease(
		Effect.map(
			listenerAt({ path: holdOf(unit) }),
			Option.map((listener) => listener.unref())
		),
		(listener) => closedAll(Option.toArray(listener))
	)

/** A member's data directory, the workbench's postgres@ unit's: `<data>/<name>`. */
export const dataOf = (name: string) => Effect.map(machineHomes, (homes) => `${homes.data}/${name}`)

/** The names in `directory`, or none where there is no directory. */
const namesIn = (directory: string) =>
	Effect.flatMap(FileSystem.FileSystem, (fs) =>
		Effect.orElseSucceed(fs.readDirectory(directory), (): ReadonlyArray<string> => [])
	)

/**
 * Case cluster `unit` gone, whatever is left of it: its members' units stopped (`postgres@<unit>-*`, systemctl's
 * pattern over the units it has loaded, every family's) and their failures forgotten, then every member's data
 * directory (`<data>/<unit>-*`, the workbench's) removed: a member in memory (the workbench's memory list names
 * `tcs-*`) takes its data with its unit's stop. Its families' state and claims are in the case's scratch directory,
 * gone with it.
 */
const clusterRemoved = (unit: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		yield* Effect.forEach(
			["stop", "reset-failed"],
			(verb) =>
				Effect.ignore(
					spawner.exitCode(ChildProcess.make("systemctl", ["--user", verb, unitOf(`${unit}-*`)]))
				),
			{ discard: true }
		)
		const homes = yield* machineHomes
		const names = yield* namesIn(homes.data)
		yield* Effect.forEach(
			Arr.filter(names, Str.startsWith(`${unit}-`)),
			(member) => Effect.ignore(fs.remove(`${homes.data}/${member}`, { recursive: true })),
			{ discard: true }
		)
	})

/**
 * Every case cluster no process holds (holdOf) removed (clusterRemoved): one a case's process left as it ended with its
 * scope open, a worker the pool ended mid-case or a run's unit stopped (lane TOOLCHAIN6's stopped runs left four,
 * 2026-11-21, their servers running until a person stopped them). The clusters are named by what they leave, their
 * members' data directories and their state directories; each is held while it is removed, so a cluster a live case
 * holds is never touched and two sweeps never remove one at once.
 */
const swept = Effect.gen(function* () {
	const homes = yield* machineHomes
	const names = yield* Effect.forEach([homes.data, homes.states], namesIn)
	const clusters = new Set(
		Arr.filterMap(Arr.flatten(names), (name) =>
			Result.fromNullishOr(CASE_NAME.exec(name)?.groups.cluster, () => name)
		)
	)
	yield* Effect.forEach(
		clusters,
		(unit) =>
			Effect.scoped(
				Effect.flatMap(holdTaken(unit), (hold) =>
					Effect.when(clusterRemoved(unit), Effect.succeed(Option.isSome(hold)))
				)
			),
		{ discard: true }
	)
})

/**
 * A case's cluster of `shape`: a unit name of its own (`tcs-` and 8 random hex digits), held by this process for the
 * enclosing scope (holdTaken), its workers' capacity sized by a busy backend of the package's own (pg.config.ts's), two
 * members when `spread` (a family whose members serve half the run's workers each), its predicate lock room a room of
 * its workers' when `room` and production's a backend otherwise, and over TLS its families' ports claimed from a free
 * one (freePorts). Drawing it first removes every case cluster no process holds (swept).
 */
export const clusterOf = (
	shape: Shape
): Effect.Effect<
	LocalCluster<WorkerSizing>,
	never,
	FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
	Effect.gen(function* () {
		const unit = `tcs-${process.getBuiltinModule("node:crypto").randomBytes(4).toString("hex")}`
		const hold = yield* holdTaken(unit)
		if (Option.isNone(hold)) {
			return yield* Effect.die(`a case's cluster's name, ${unit}, is held by another process`)
		}
		yield* swept
		const port = shape.tls ? yield* freePorts(shape.spread ? 2 : 1) : 0
		return localCluster({
			unit,
			network: shape.tls ? { kind: "tls", from: port } : { kind: "socket" },
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
				locks: { kind: "perTransaction", locks: 256 },
				predicateLocks: shape.room
					? { kind: "perWorker", targets: caseRoomTargets }
					: { kind: "perBackend" }
			}
		})
	})

/**
 * `cluster`'s family at a checkout of the case's own, with a states home of its own, both in a scratch directory made
 * for the enclosing scope (the checkout under no `.git`, so a checkout while it exists, family.ts checkoutLive), and the
 * workbench's data home, where its members' units keep their data.
 */
export const familyIn = (cluster: LocalCluster) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const made = yield* Effect.orDie(fs.makeTempDirectoryScoped({ prefix: "toolchain-family-" }))
		const real = yield* Effect.orDie(fs.realPath(made))
		yield* Effect.orDie(fs.makeDirectory(`${real}/checkout`))
		const homes = yield* machineHomes
		return familyOf(cluster, checkoutAt(`${real}/checkout`), {
			states: `${real}/state`,
			data: homes.data
		})
	})

/**
 * `family` settled whole in this process: its state and its first member (settled, the member settled here as its unit
 * would, memberSettled), then every other member, in member order; each as a run reads it.
 */
export const settledWhole = (family: CheckoutFamily) =>
	Effect.gen(function* () {
		const first = yield* settled(family, memberSettled)
		const rest = yield* Effect.forEach(Arr.drop(memberNames(family), 1), (_, at) =>
			memberSettled(family, at + 1)
		)
		return Arr.prepend(rest, first)
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

/** `cluster` gone as the enclosing scope closes, however it ends (clusterRemoved), while the scope still holds it. */
export const removedAtEnd = (cluster: LocalCluster) =>
	Effect.addFinalizer(() => clusterRemoved(cluster.unit))

/**
 * `name`'s member unit stopped (`systemctl --user stop`), as a person does: a case cluster's member is in memory
 * (`tcs-*`), so its data goes with the stop and the next settle makes it again.
 */
export const memberStopped = (name: string) =>
	Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
		Effect.orDie(spawner.exitCode(ChildProcess.make("systemctl", ["--user", "stop", unitOf(name)])))
	)

/**
 * `port` held at IPv4's loopback by a listener of this process for the enclosing scope, where a member listening at
 * localhost binds it: another listener at a family's port, as a cluster outside the claims holds one. A port it cannot
 * take ends the case: the member it was stopped from holds it still.
 */
export const portHeldHere = (port: number) =>
	Effect.gen(function* () {
		const listener = yield* listenerAt({ port, host: Arr.headNonEmpty(LOOPBACKS) })
		if (Option.isNone(listener)) {
			return yield* Effect.die(`port ${port} is held already: its member still listens there`)
		}
		yield* Effect.addFinalizer(() => closedAll([listener.value]))
	})

/** A left cluster's case: one member or two, over its socket, and whether the process that drew it is still alive. */
export type Left = Readonly<{ spread: boolean; alive: boolean }>

/** Every left cluster's case, one each. */
export const lefts: Gen<Left> = (source) => ({
	spread: source.draw(boolean),
	alive: source.draw(boolean)
})

/**
 * A settled family of a case cluster of `left`'s shape, removed as the enclosing scope closes. Where its process is not
 * `alive` its hold is let go once it is settled, its units, data and state left as they are, as a process that ended
 * with its scope open leaves them: the kernel frees the hold's name either way. Its checkout lives for the enclosing
 * scope.
 */
export const leftCluster = (left: Left) =>
	Effect.gen(function* () {
		const holding = yield* Scope.make()
		yield* Effect.addFinalizer(() => Scope.close(holding, Exit.void))
		const cluster = yield* Scope.provide(holding)(
			clusterOf({ tls: false, spread: left.spread, room: true })
		)
		yield* removedAtEnd(cluster)
		const family = yield* familyIn(cluster)
		yield* settledWhole(family)
		if (!left.alive) {
			yield* Scope.close(holding, Exit.void)
		}
		return family
	})

/**
 * What is there of `family` now in the account's homes, which the sweep removes a left cluster from: whether each
 * member's unit is active (unitActive) and its data directory is. Its state is in its case's scratch directory, gone
 * with the case.
 */
export const presenceOf = (family: CheckoutFamily) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const exists = (path: string) => Effect.orElseSucceed(fs.exists(path), () => false)
		const active = yield* Effect.forEach(memberNames(family), unitActive)
		const data = yield* Effect.forEach(memberNames(family), (name) =>
			Effect.flatMap(dataOf(name), exists)
		)
		return [...active, ...data]
	})

/** Whether an effect failed: its Result's failure, as a fact. */
export const failedOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.map(Effect.result(effect), Result.isFailure)
