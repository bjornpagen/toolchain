import { Config, Effect, FileSystem, Result } from "effect"
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

/** A TCP port the machine has free at localhost now: one the kernel hands a listener on port 0, closed again. */
const freePort = Effect.callback<number>((resume) => {
	const server = process.getBuiltinModule("node:net").createServer()
	server.listen(0, "localhost", () => {
		const address = server.address()
		const port = typeof address === "object" && address !== null ? address.port : 0
		server.close(() => {
			resume(Effect.succeed(port))
		})
	})
})

/**
 * A case's cluster of `shape`: a unit name of its own (`tcs-` and 8 random hex digits), its workers' capacity sized by
 * a busy backend of the package's own (pg.config.ts's), two members when `spread` (a family whose members serve half
 * the run's workers each), and over TLS a free port and the one after it.
 */
export const clusterOf = (shape: Shape): Effect.Effect<LocalCluster<WorkerSizing>> =>
	Effect.gen(function* () {
		const port = shape.tls ? yield* freePort : 0
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
