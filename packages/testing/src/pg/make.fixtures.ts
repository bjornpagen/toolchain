import {
	Array as Arr,
	ConfigProvider,
	Effect,
	type Exit,
	FileSystem,
	Option,
	String as Str
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { element, finite } from "#gen.ts"
import { type ClusterUnmade, type MadeMember, madeMembers } from "#pg/make.ts"
import { type ClusterFailed, program, succeeded } from "#pg/server.ts"
import { localCluster, type LocalCluster } from "#pg/spec.ts"
import { testWorkers } from "#workers.ts"

/** What the lifecycle property (make.test.ts) draws, and the helpers its check runs. */

/** How a case's cluster is sized: leased by a run's workers over a family of one or two members, or by its sessions. */
export type SizedBy = Readonly<{ kind: "leased"; members: 1 | 2 }> | Readonly<{ kind: "sessions" }>

/** Every sizing a case's cluster takes: a leased family of one and of two, and a cluster sized by its sessions. */
const sizings: Arr.NonEmptyReadonlyArray<SizedBy> = [
	{ kind: "leased", members: 1 },
	{ kind: "leased", members: 2 },
	{ kind: "sessions" }
]

/** A case's cluster: its durability, how it is sized, and how many bring it up at once. */
export type Life = Readonly<{
	durability: "throwaway" | "kept"
	sizedBy: SizedBy
	atOnce: 1 | 2 | 3
}>

/** Every case: both durabilities, every sizing, brought up by one to three at once. */
export const lives = finite((source): Life => ({
	durability: source.draw(element(["throwaway", "kept"] as const)),
	sizedBy: source.draw(element(sizings)),
	atOnce: source.draw(element([1, 2, 3] as const))
}))

/** The members a case's cluster has: its leased family's, or one sized by its sessions. */
export const membersOfLife = (life: Life): number =>
	life.sizedBy.kind === "leased" ? life.sizedBy.members : 1

/**
 * What one worker of a case's leased cluster holds at most, and what is held outside any worker, as the testing
 * package's own cluster states them (pg.config.ts: two a worker, three outside).
 */
const casePerWorker = { perWorker: 2, outside: 3 } as const

/** The sessions a case's cluster sized by its sessions is stated to hold: a case's own number. */
const caseSessions = 5

/**
 * The connections each member of a case's cluster admits beside those its server reserves, as its sizing states them:
 * a leased member's share of the machine's workers (its family's members serving them all, the share rounded up) at
 * casePerWorker's each, and the outside's; a member sized by its sessions, caseSessions, whatever the machine's width.
 */
export const admittedOf = (life: Life): number =>
	life.sizedBy.kind === "sessions"
		? caseSessions
		: Math.ceil(testWorkers / life.sizedBy.members) * casePerWorker.perWorker +
			casePerWorker.outside

/**
 * Stops every postmaster a case's cluster left under `root` at once, whatever its making reached: what a case's scope
 * does before its home goes, so a failing case, a kill's above all, leaves no server running in a removed directory.
 */
export const stopEvery = (root: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		if (!(yield* fs.exists(root))) {
			return
		}
		const bindir = yield* spawner.string(ChildProcess.make("pg_config", ["--bindir"]))
		const bin = Str.trim(bindir)
		const names = yield* fs.readDirectory(root)
		yield* Effect.forEach(
			Arr.filter(names, (name) => `${Number(name)}` === name),
			(name) =>
				spawner.exitCode(
					ChildProcess.make(`${bin}/pg_ctl`, [
						"-D",
						`${root}/${name}/data`,
						"-m",
						"immediate",
						"-w",
						"stop"
					])
				),
			{ discard: true }
		)
	}).pipe(Effect.ignore)

/**
 * The spec of a case's cluster on `port`, owned by `owner`, at PostgreSQL's default sizes but its connections, sized as
 * the testing package's own cluster is (casePerWorker) when it is leased and for caseSessions when it is sized by its
 * sessions, its owner granted SET on two parameters only a superuser may set by default, as grizzle's is.
 */
export const specOf = (life: Life, port: number, owner: string): LocalCluster =>
	localCluster({
		port,
		bin: { kind: "pg_config" },
		owner,
		template: "lifecycle_template",
		extensions: [],
		ownerParameters: ["deadlock_timeout", "session_replication_role"],
		peerLogins: [],
		durability: life.durability,
		sizing:
			life.sizedBy.kind === "sessions"
				? { kind: "sessions", sessions: caseSessions }
				: {
						kind: "leased",
						family:
							life.sizedBy.members === 1
								? { kind: "one" }
								: { kind: "spread", workersPerMember: Math.ceil(testWorkers / 2) },
						connections: casePerWorker,
						replication: { kind: "default" },
						sharedBuffers: { kind: "default" }
					}
	})

/** The postmaster's process of each member, from its data directory's lock file's first line. */
export const postmasters = (root: string, ports: ReadonlyArray<number>) =>
	Effect.flatMap(FileSystem.FileSystem, (fs) =>
		Effect.forEach(ports, (port) =>
			Effect.map(fs.readFileString(`${root}/${port}/data/postmaster.pid`), (text) =>
				Option.getOrElse(Arr.head(Str.split(text, "\n")), () => "")
			)
		)
	)

/**
 * What a cluster another maker made holds of a spec's owner, template and owner's database before it is adopted
 * (make.ts heldOf): nothing; the owner role; the role and the template; or all three, as grizzle's old init.sh left
 * edullm's.
 */
export const adoptedHoldings = [
	"nothing",
	"the owner",
	"the owner and template",
	"all three"
] as const

export type Holding = (typeof adoptedHoldings)[number]

/** Each holding, one case each. */
export const holdings = finite((source): Holding => source.draw(element(adoptedHoldings)))

/** The statements the foreign cluster's superuser runs in `postgres` to hold `holding` of `spec`'s, none for nothing. */
const holdingStatements = (spec: LocalCluster, holding: Holding): ReadonlyArray<string> => [
	...(holding === "nothing" ? [] : [`CREATE ROLE ${spec.owner} LOGIN PASSWORD 'another maker''s'`]),
	...(holding === "the owner and template" || holding === "all three"
		? [
				`CREATE DATABASE ${spec.template} OWNER ${spec.owner} TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER builtin BUILTIN_LOCALE 'C.UTF-8' LOCALE 'C.UTF-8'`
			]
		: []),
	...(holding === "all three"
		? [`CREATE DATABASE ${spec.owner} OWNER ${spec.owner} TEMPLATE template0`]
		: [])
]

/** The bin directory of the machine's PostgreSQL, as its pg_config names it: every spec of these properties runs it. */
export const machineBin = Effect.map(
	succeeded(
		{ cluster: 0, doing: "reading pg_config --bindir" },
		ChildProcess.make("pg_config", ["--bindir"])
	),
	Str.trim
)

/**
 * A cluster another maker made, at `data`: initdb's data directory of the machine's PostgreSQL (pg_config), started on
 * its socket alone at `socket` on `port`, given `holding` of `spec`'s by its superuser, and stopped, as adoptFrom takes
 * a cluster; the oids of every database it then holds, by name, which an adoption keeps.
 */
export const foreignCluster = (
	spec: LocalCluster,
	holding: Holding,
	data: string,
	socket: string,
	port: number
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const step = { cluster: port, doing: "making a cluster to adopt" }
		const bin = yield* machineBin
		const ran = (name: "initdb" | "pg_ctl" | "psql", args: ReadonlyArray<string>) =>
			succeeded(step, program(bin, name, args, {}))
		yield* fs.makeDirectory(socket, { recursive: true })
		yield* ran("initdb", [
			"-D",
			data,
			"-U",
			"postgres",
			"-E",
			"UTF8",
			"--locale-provider=builtin",
			"--builtin-locale=C.UTF-8",
			"--locale=C.UTF-8",
			"--auth=trust"
		])
		yield* ran("pg_ctl", [
			"-D",
			data,
			"-o",
			`-p ${port} -k ${socket} -c listen_addresses=''`,
			"-l",
			`${data}.log`,
			"-w",
			"start"
		])
		const psql = (statement: string) =>
			ran("psql", [
				"-X",
				"-q",
				"-A",
				"-t",
				"-v",
				"ON_ERROR_STOP=1",
				"-h",
				socket,
				"-p",
				`${port}`,
				"-U",
				"postgres",
				"-d",
				"postgres",
				"-c",
				statement
			])
		yield* Effect.forEach(holdingStatements(spec, holding), psql, { discard: true })
		const oids = yield* psql("SELECT datname || '=' || oid FROM pg_catalog.pg_database ORDER BY 1")
		yield* ran("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"])
		return Arr.filter(Str.split(oids, "\n"), Str.isNonEmpty)
	})

/**
 * The programs a bring-up runs only to do something to a cluster: perl holds its lock, pg_ctl and openssl read, start
 * or issue a member's postmaster and TLS. Taking a running cluster runs none of them.
 */
export const TAKING_WORK: ReadonlyArray<string> = ["perl", "pg_ctl", "openssl"]

/** The program a command runs, by its file's name: a pipe's first. */
const programOf = (command: ChildProcess.Command): string => {
	switch (command._tag) {
		case "StandardCommand":
			return Arr.lastNonEmpty(Str.split("/")(command.command))
		case "PipedCommand":
			return programOf(command.left)
	}
}

/** `effect`'s result and the programs it ran, in the order it started them. */
export const spawnedBy = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const real = yield* ChildProcessSpawner.ChildProcessSpawner
		const spawned: Array<string> = []
		const recording = ChildProcessSpawner.make((command) =>
			Effect.andThen(
				Effect.sync(() => spawned.push(programOf(command))),
				real.spawn(command)
			)
		)
		yield* Effect.provideService(effect, ChildProcessSpawner.ChildProcessSpawner, recording)
		return spawned
	})

/**
 * What madeMembers reads of `spec`'s cluster under `environment`, run as a repository's config runs it, synchronously
 * (Effect.runSyncExit): a reader that waited on anything asynchronous would die here, where its callers run it.
 */
export const madeSynchronously = (
	spec: LocalCluster,
	environment: ConfigProvider.ConfigProvider
): Exit.Exit<Arr.NonEmptyReadonlyArray<MadeMember>, ClusterFailed | ClusterUnmade> =>
	Effect.runSyncExit(
		Effect.provideService(madeMembers(spec), ConfigProvider.ConfigProvider, environment)
	)

/** How a narrower run meets a family made wider: by bringing it up (clusterUp) or by adopting it (`init --adopt`). */
export const narrowings = finite((source) =>
	source.draw(element(["brought up", "adopted"] as const))
)
