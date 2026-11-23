import testingCluster from "#pg.config.ts"
import { pgOwnerSession, pgSuperuserSession } from "#pg/session.ts"
import { localCluster } from "#pg/spec.ts"
import { DatabasePrefix, PgCluster } from "#resources/cluster.ts"

/**
 * The type tier of a runner's cluster, checked by the package's typecheck: each `accepted` layer compiles, over a
 * cluster sized for workers, and each `refused` one is a type error its directive names, so a change that lets a
 * runner's layer take a cluster sized by its sessions, which states no workers' capacity, fails here before any test
 * runs. The layers are values, never built.
 */
const connect = pgOwnerSession("cluster types")

const superuser = pgSuperuserSession("cluster types superuser")

const prefix = DatabasePrefix("tc_types")

/** A cluster's fields but its sizing, as the testing package's own states them (pg.config.ts). */
const fields = {
	unit: "toolchain-test",
	network: { kind: "tls", from: 20_000 },
	owner: "toolchain_dev",
	template: "toolchain_template",
	extensions: [],
	preload: [],
	ownerParameters: [],
	durability: "throwaway"
} as const

/** A cluster sized by its sessions: what a development cluster no run reaches states. */
const sessionsCluster = localCluster({
	...fields,
	sizing: { kind: "sessions", sessions: 1, locks: { kind: "default" } }
})

export const accepted = Object.freeze([
	PgCluster.layer({ prefix, cluster: testingCluster, connect, superuser }),
	PgCluster.layer({
		prefix,
		cluster: localCluster({
			...fields,
			sizing: {
				kind: "workers",
				family: { kind: "spread", workersPerMember: 1 },
				connections: { kind: "capacity", backendBytes: 1 },
				replication: { kind: "capacity" },
				sharedBuffers: { kind: "default" },
				locks: { kind: "perTransaction", locks: 1 },
				predicateLocks: { kind: "perWorker", targets: 1 }
			}
		}),
		connect,
		superuser
	})
])

export const refused = Object.freeze([
	PgCluster.layer({
		prefix,
		// @ts-expect-error -- a cluster sized by its sessions is reached by no run: a runner's layer takes one sized for workers
		cluster: sessionsCluster,
		connect,
		superuser
	})
])
