import { regex } from "arkregex"
import {
	Array as Arr,
	Effect,
	Exit,
	FileSystem,
	Option,
	Record as Rec,
	Result,
	Schema,
	Scope,
	String as Str
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { boolean, element, type Gen } from "#gen.ts"
import {
	type CheckoutFamily,
	checkoutAt,
	familyOf,
	homesHere,
	imagesHomeOf,
	imagesOf,
	memberNames,
	unitOf
} from "#pg/family.ts"
import { familyHeld, leaseOf } from "#pg/hold.ts"
import { failed, succeeded } from "#pg/server.ts"
import {
	familySettled,
	memberSettled,
	processSettler,
	type Settler,
	settleArgv,
	settled,
	settleEnvironment
} from "#pg/settle.ts"
import {
	type Family,
	type LocalCluster,
	localCluster,
	type PredicateRoom,
	type PreloadedLibrary,
	type SessionsSizing,
	type WorkerSizing
} from "#pg/spec.ts"
import { allowanceVariable, testWorkers } from "#workers.ts"

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

/**
 * The pid of the postmaster serving `member`, the first line of its socket's lock file (PostgreSQL's
 * `<socket>/.s.PGSQL.<port>.lock`): another pid after a read means the member's server was restarted between them.
 */
export const postmasterOf = (member: Readonly<{ socket: string; port: number }>) =>
	Effect.map(
		Effect.orDie(
			Effect.flatMap(FileSystem.FileSystem, (fs) =>
				fs.readFileString(`${member.socket}/.s.PGSQL.${String(member.port)}.lock`)
			)
		),
		(text) => Option.getOrElse(Arr.head(Str.split("\n")(text)), () => "")
	)

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
 * A case's cluster's unit name (`tcs-` and 8 random hex digits, clusterOf; `tck-` for a kept one, keptCluster; `tcd-`
 * for a throwaway one on disk), a family's of it (`-` and its key's 8 hex digits after it, its images' folder's too) or
 * a member's or its data directory's (the family's name and `-<i>`): `cluster` is the cluster's.
 */
const CASE_NAME = regex("^(?<cluster>tc[skd]-[0-9a-f]{8})(?:-[0-9a-f]{8})?(?:-[0-9]+)?$")

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

/**
 * What case cluster `unit`'s families keep in the account's states home: each state directory named after it, none
 * where every settle of them kept its family's state in the family's own states home (settle.ts settleEnvironment).
 */
export const accountStatesOf = (unit: string) =>
	Effect.flatMap(machineHomes, (homes) =>
		Effect.map(namesIn(homes.states), Arr.filter(Str.startsWith(`${unit}-`)))
	)

/** A member's data directory, the workbench's postgres@ unit's: `<data>/<name>`. */
export const dataOf = (name: string) => Effect.map(machineHomes, (homes) => `${homes.data}/${name}`)

/** The names in `directory`, or none where there is no directory. */
const namesIn = (directory: string) =>
	Effect.flatMap(FileSystem.FileSystem, (fs) =>
		Effect.orElseSucceed(fs.readDirectory(directory), (): ReadonlyArray<string> => [])
	)

/**
 * Case cluster `unit` gone, whatever is left of it: every unit named after it stopped (`<unit>-*`: its families' holds,
 * leases and settles, a hold property's runs, which a kill trial's mutant may leave running), each lease's stop stopping
 * its member (pg/hold.ts), and their failures forgotten, then every member's data directory (`<data>/<unit>-*`, the
 * workbench's) removed, and its families' images (family.ts imagesOf): a member in memory (the workbench's memory list
 * names `tcs-*`) takes its data with its unit's stop, a throwaway one on disk (`tcd-*`) leaves a link naming nothing and
 * its images, and a kept one's (`tck-*`, on disk) is removed here. Its families' state and
 * claims are in the case's scratch directory, gone with it.
 */
const clusterRemoved = (unit: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		yield* Effect.forEach(
			["stop", "reset-failed"],
			(verb) =>
				Effect.ignore(
					spawner.exitCode(ChildProcess.make("systemctl", ["--user", verb, `${unit}-*`]))
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
		const families = yield* namesIn(imagesHomeOf(homes.data))
		yield* Effect.forEach(
			Arr.filter(families, Str.startsWith(`${unit}-`)),
			(family) => Effect.ignore(fs.remove(imagesOf(homes.data, family), { recursive: true })),
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
	const names = yield* Effect.forEach([homes.data, homes.states, imagesHomeOf(homes.data)], namesIn)
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
 * A case cluster's unit name of its own, `prefix` and 8 random hex digits (`tcs`, a throwaway case's, in memory;
 * `tck`, a kept case's; `tcd`, a throwaway case's on disk, whose members' folders the workbench's postgres@ unit takes
 * as they stop), held by this process for the enclosing scope (holdTaken). Drawing it first removes every case cluster no
 * process holds (swept): the cluster of a case here (clusterSized, keptCluster), or of a consumer whose runs make it in
 * processes of their own (runner/reuse.fixtures.ts), which the case removes at its end (unitRemovedAtEnd).
 */
export const caseUnit = (prefix: "tcs" | "tck" | "tcd") =>
	Effect.gen(function* () {
		const unit = `${prefix}-${process.getBuiltinModule("node:crypto").randomBytes(4).toString("hex")}`
		const hold = yield* holdTaken(unit)
		if (Option.isNone(hold)) {
			return yield* Effect.die(`a case's cluster's name, ${unit}, is held by another process`)
		}
		yield* swept
		return unit
	})

/**
 * What a case cluster states of its members beside its unit name and ports: whether its clients reach them over TLS,
 * its family (one member, or a spread of members each serving `workersPerMember` of a run's workers), its predicate
 * lock room and the libraries every member preloads.
 */
type Sized = Readonly<{
	tls: boolean
	family: Family
	room: PredicateRoom
	preload: ReadonlyArray<PreloadedLibrary>
}>

/**
 * A case's cluster `sized` so: a unit name of its own (caseUnit, `tcs-`), its workers' capacity sized by a busy
 * backend of the package's own (pg.config.ts's), and over TLS its families' ports claimed from one that `members`
 * consecutive ports are free from (freePorts).
 */
const clusterSized = (
	sized: Sized,
	members: number
): Effect.Effect<
	LocalCluster<WorkerSizing>,
	never,
	FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
	Effect.gen(function* () {
		const unit = yield* caseUnit("tcs")
		const port = sized.tls ? yield* freePorts(members) : 0
		return localCluster({
			unit,
			network: sized.tls ? { kind: "tls", from: port } : { kind: "socket" },
			owner: "toolchain_settle",
			template: "toolchain_settle_template",
			extensions: [],
			preload: sized.preload,
			ownerParameters: [],
			durability: "throwaway",
			sizing: {
				kind: "workers",
				family: sized.family,
				connections: { kind: "capacity", backendBytes: 37_301_248 },
				replication: { kind: "default" },
				sharedBuffers: { kind: "default" },
				locks: { kind: "perTransaction", locks: 256 },
				predicateLocks: sized.room
			}
		})
	})

/**
 * A kept case cluster (caseUnit, `tck-`), whose members' data is on disk, since the workbench's memory list names no
 * `tck-*`, so a member's data outlives its unit's stop as a person's development cluster's does; sized by its sessions,
 * over TLS from a free port or over its socket. What it answers states the cluster with its lock table holding `locks`
 * at once, one unit and network for every `locks`, so two of its specs differ in their lock table alone.
 */
export const keptCluster = (tls: boolean) =>
	Effect.gen(function* () {
		const unit = yield* caseUnit("tck")
		const port = tls ? yield* freePorts(1) : 0
		return (locks: number): LocalCluster<SessionsSizing> =>
			localCluster({
				unit,
				network: tls ? { kind: "tls", from: port } : { kind: "socket" },
				owner: "toolchain_settle",
				template: "toolchain_settle_template",
				extensions: [],
				preload: [],
				ownerParameters: [],
				durability: "kept",
				sizing: { kind: "sessions", sessions: 4, locks: { kind: "held", locks } }
			})
	})

/**
 * The lock tables a kept case's two specs hold, each past PostgreSQL's default per transaction on a member of a kept
 * case cluster's few sessions, so a move between them changes max_locks_per_transaction, a setting only a restart
 * applies.
 */
export const keptLocks = { few: 10_000, many: 20_000 } as const

/**
 * How a kept case moves its cluster's spec: its lock table grown (`more`) or shrunk (`fewer`), over TLS or over its
 * socket.
 */
export type KeptCase = Readonly<{ move: "more" | "fewer"; tls: boolean }>

/** Every kept case, one each. */
export const keptCases: Gen<KeptCase> = (source) => ({
	move: source.draw(element(["more", "fewer"])),
	tls: source.draw(boolean)
})

/**
 * A case's cluster of `shape` (clusterSized): two members when `spread` (a family whose members serve half the run's
 * workers each), its predicate lock room a room of its workers' when `room` and production's a backend otherwise.
 */
export const clusterOf = (shape: Shape) =>
	clusterSized(
		{
			tls: shape.tls,
			family: shape.spread
				? { kind: "spread", workersPerMember: Math.max(1, Math.ceil(testWorkers / 2)) }
				: { kind: "one" },
			room: shape.room ? { kind: "perWorker", targets: caseRoomTargets } : { kind: "perBackend" },
			preload: []
		},
		shape.spread ? 2 : 1
	)

/**
 * What tells that a session loaded each library a cluster may preload: a setting the library defines, which
 * current_setting reads as NULL where the library is not loaded, and as its inert value where it is (settings.ts
 * preloadSettings). Total over the roster, so a library added to it states how a session shows it.
 */
export const loadedProbes = {
	pg_stat_statements: { setting: "pg_stat_statements.track", value: "none" },
	pg_plan_advice: { setting: "pg_plan_advice.feedback_warnings", value: "off" }
} as const satisfies Readonly<
	Record<PreloadedLibrary, Readonly<{ setting: string; value: string }>>
>

/** Every subset of the libraries a cluster may preload, in the roster's order, one case each. */
export const preloads: Gen<ReadonlyArray<PreloadedLibrary>> = (source) =>
	Arr.filter(Rec.keys(loadedProbes), () => source.draw(boolean))

/** A case's cluster of one member over its socket that preloads `preload`, a room for its workers. */
export const preloadCluster = (preload: ReadonlyArray<PreloadedLibrary>) =>
	clusterSized(
		{
			tls: false,
			family: { kind: "one" },
			room: { kind: "perWorker", targets: caseRoomTargets },
			preload
		},
		1
	)

/**
 * The widths the width properties settle a family at, a run's workers: a run of one worker, and one of two, so a family
 * spread a member a worker (widthCluster) has one member at the first and two at the second.
 */
export const widths = { narrow: 1, wide: 2 } as const

/**
 * How a family's width moves in a width case: a family settled for the narrow width reached by a run of the wide
 * (`wider`), or the other way (`narrower`); over a family spread a member a worker over TLS, whose members' count and
 * capacity follow the width, or of one member over its socket, whose every setting is the same at both widths.
 */
export type WidthCase = Readonly<{ move: "wider" | "narrower"; family: "spread" | "one" }>

/** Every width case, one each. */
export const widthCases: Gen<WidthCase> = (source) => ({
	move: source.draw(element(["wider", "narrower"])),
	family: source.draw(element(["spread", "one"]))
})

/**
 * A case's cluster whose sizing follows a run's width as `kind` states (WidthCase's family): spread a member a worker
 * over TLS, with a room for its workers, so its members' count is the width and each member's capacity the machine's
 * over them; or one member over its socket at production's room, whose settings no width moves.
 */
export const widthCluster = (kind: WidthCase["family"]) =>
	clusterSized(
		kind === "spread"
			? {
					tls: true,
					family: { kind: "spread", workersPerMember: 1 },
					room: { kind: "perWorker", targets: caseRoomTargets },
					preload: []
				}
			: { tls: false, family: { kind: "one" }, room: { kind: "perBackend" }, preload: [] },
		widths.wide
	)

/**
 * A family's settles run in this process as a worker that finds its family's settle unit running runs them
 * (settle.ts unitSettler): the family's state settled, as the first asker's unit settles it, and then refused, as
 * systemd refuses to start that unit again while it runs and the joiner's wait answers nothing of how it ended; and the
 * member settled here (memberSettled).
 */
export const joinedSettler: Settler = {
	family: (family) =>
		Effect.andThen(
			familySettled(family),
			Effect.fail(
				failed(
					{ cluster: family.name, doing: `settling it as ${family.name}-settle` },
					`Unit ${family.name}-settle.service was already loaded or has a fragment file`
				)
			)
		),
	member: memberSettled
}

/**
 * `family`'s cluster stated as a package's pg.config.ts states it, in its checkout, `<checkout>/pg.config.ts`: its spec
 * as its default export (localCluster of its fields, @bjornpagen/testing/pg by this module's file), so `toolchain-pg`
 * run in the checkout reads the case's cluster.
 */
export const specWritten = (family: CheckoutFamily) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
		const library = yield* Effect.orDie(json(new URL("./pg.ts", import.meta.url).href))
		const fields = yield* Effect.orDie(json(family.cluster))
		yield* Effect.orDie(
			fs.writeFileString(
				`${family.checkout}/pg.config.ts`,
				`import { localCluster } from ${library}\nexport default localCluster(${fields})\n`
			)
		)
	})

/**
 * Member `index` of `family` settled by exactly what its settle unit runs (settle.ts settleArgv) with exactly what the
 * unit is given (settleEnvironment, its states home the family's among it), in the checkout, whose pg.config.ts states
 * the case's cluster (specWritten), as a child of this process rather than a unit of systemd's, with its own CPU
 * allowance `own` (workers.ts allowanceVariable), standing in for the slice a unit runs in,
 * whose run's width is not the family's. Its stdout, or its failure with what it printed. The command is the one the
 * loaded settle.ts names, so a property that runs it needs Checkout.dir: its kills then run in a worker tree, whose
 * command on disk holds the kill's edit, where the module hook would serve it to the worker alone.
 */
export const settledAsItsUnit = (family: CheckoutFamily, index: number, own: number) =>
	Effect.gen(function* () {
		yield* specWritten(family)
		const [program, ...args] = settleArgv({ kind: "member", index })
		return yield* succeeded(
			{ cluster: family.name, doing: `settling its member ${index} as its unit would` },
			ChildProcess.make(program, args, {
				cwd: family.checkout,
				env: { ...settleEnvironment(family), [allowanceVariable]: `${own}` },
				extendEnv: true
			})
		)
	})

/**
 * `cluster`'s family at a checkout of the case's own, as a run of `width` workers reaches it, with a states home of its
 * own, both in a scratch directory made for the enclosing scope (the checkout under no `.git`, so a checkout while it
 * exists, family.ts checkoutLive), the states home where a process whose XDG_STATE_HOME is the scratch's `state` keeps
 * its families' (family.ts homesHere, stateHomeOf), and the workbench's data home, where its members' units keep their
 * data.
 */
export const familyIn = (cluster: LocalCluster, width: number) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const made = yield* Effect.orDie(fs.makeTempDirectoryScoped({ prefix: "toolchain-family-" }))
		const real = yield* Effect.orDie(fs.realPath(made))
		yield* Effect.orDie(fs.makeDirectory(`${real}/checkout`))
		const homes = yield* machineHomes
		return familyOf(
			cluster,
			checkoutAt(`${real}/checkout`),
			{ states: `${real}/state/toolchain-pg`, data: homes.data },
			width
		)
	})

/**
 * `family` settled whole in this process and held by it for the enclosing scope (hold.ts familyHeld), as a run's
 * workers hold what they reach: its state and its first member (settled, the member settled here as its unit would,
 * processSettler), then every other member, in member order (memberSettled); each as a run reads it.
 */
export const settledWhole = (family: CheckoutFamily) =>
	Effect.gen(function* () {
		yield* familyHeld(family)
		const first = yield* settled(family, processSettler)
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

/** Case cluster `unit` gone as the enclosing scope closes, however it ends (clusterRemoved), while the scope still holds it. */
export const unitRemovedAtEnd = (unit: string) => Effect.addFinalizer(() => clusterRemoved(unit))

/** `cluster` gone as the enclosing scope closes (unitRemovedAtEnd). */
export const removedAtEnd = (cluster: LocalCluster) => unitRemovedAtEnd(cluster.unit)

/**
 * `name`'s member stopped by its lease's stop (pg/hold.ts leaseOf), the one way a member stops, and the member's own stop
 * job, which the lease's stop brings about (PropagatesStopTo=), waited for in the same call: `systemctl stop` of the
 * lease alone waits for the lease's job, which ends at once, so the member still listened at its port as it returned
 * (aHeldPortRefusesItsSettle under the toolchain merge's gate at load 700, 2026-11-26: "port 28844 is held already"). A
 * case cluster's member is in memory (`tcs-*`), so its data goes with the stop and the next settle makes it again.
 */
export const memberStopped = (name: string) =>
	Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
		Effect.orDie(
			spawner.exitCode(
				ChildProcess.make("systemctl", ["--user", "stop", leaseOf(name), unitOf(name)])
			)
		)
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
 * `alive` its holds are let go once it is settled, the cluster's name's and the family's (its members stopping with
 * the family's, as with an ended process's), its data and state left as they are, as a process that ended with its
 * scope open leaves them: the kernel frees both either way. Its checkout lives for the enclosing scope.
 */
export const leftCluster = (left: Left) =>
	Effect.gen(function* () {
		const holding = yield* Scope.make()
		yield* Effect.addFinalizer(() => Scope.close(holding, Exit.void))
		const cluster = yield* Scope.provide(holding)(
			clusterOf({ tls: false, spread: left.spread, room: true })
		)
		yield* removedAtEnd(cluster)
		const family = yield* familyIn(cluster, testWorkers)
		yield* Scope.provide(holding)(settledWhole(family))
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
