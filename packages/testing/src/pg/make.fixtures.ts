import { Array as Arr, Effect, FileSystem, Option, String as Str } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { element, finite } from "#gen.ts"
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
