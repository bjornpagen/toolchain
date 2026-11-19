import { Array as Arr, Effect, FileSystem, Option, String as Str } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { element, finite } from "#gen.ts"
import { program, succeeded } from "#pg/server.ts"
import { localCluster, type LocalCluster } from "#pg/spec.ts"
import { testWorkers } from "#workers.ts"

/** What the lifecycle property (make.test.ts) draws, and the helpers its check runs. */

/** A case's cluster: its durability, its family, and how many bring it up at once. */
export type Life = Readonly<{
	durability: "throwaway" | "kept"
	members: 1 | 2
	atOnce: 1 | 2 | 3
}>

/** Every case: both durabilities, a family of one and of two, brought up by one to three at once. */
export const lives = finite((source): Life => ({
	durability: source.draw(element(["throwaway", "kept"] as const)),
	members: source.draw(element([1, 2] as const)),
	atOnce: source.draw(element([1, 2, 3] as const))
}))

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

/** The spec of a case's cluster on `port`, owned by `owner`, at PostgreSQL's default sizes. */
export const specOf = (life: Life, port: number, owner: string): LocalCluster =>
	localCluster({
		port,
		bin: { kind: "pg_config" },
		owner,
		template: "lifecycle_template",
		extensions: [],
		peerLogins: [],
		durability: life.durability,
		family:
			life.members === 1
				? { kind: "one" }
				: { kind: "spread", workersPerMember: Math.ceil(testWorkers / 2) },
		sizing: {
			connections: { kind: "default" },
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
