import testingCluster from "#pg.config.ts"
import { pgOwnerSession } from "#pg/session.ts"
import { localCluster } from "#pg/spec.ts"
import { DatabasePrefix, PgCluster } from "#resources/cluster.ts"

/**
 * The type tier of a runner's cluster, checked by the package's typecheck: each `accepted` layer compiles, over a
 * leased cluster, and each `refused` one is a type error its directive names, so a change that lets a runner's layer
 * take a cluster sized by its sessions, which states no worker's demand for its lease to divide, fails here before any
 * test runs. The layers are values, never built.
 */
const connect = pgOwnerSession("cluster types")

const prefix = DatabasePrefix("tc_types")

/** A cluster's fields but its sizing, as the testing package's own states them (pg.config.ts). */
const fields = {
	port: 5441,
	bin: { kind: "pg_config" },
	owner: "toolchain_dev",
	template: "toolchain_template",
	extensions: [],
	ownerParameters: [],
	peerLogins: [],
	durability: "throwaway"
} as const

/** A cluster sized by its sessions: what a development cluster nothing leases states. */
const sessionsCluster = localCluster({ ...fields, sizing: { kind: "sessions", sessions: 1 } })

export const accepted = Object.freeze([
	PgCluster.layer({ prefix, cluster: testingCluster, connect }),
	PgCluster.layer({
		prefix,
		cluster: localCluster({
			...fields,
			sizing: {
				kind: "leased",
				family: { kind: "spread", workersPerMember: 1 },
				connections: { perWorker: 1, outside: 0 },
				replication: { kind: "perWorker", perWorker: 1, outside: 0 },
				sharedBuffers: { kind: "default" }
			}
		}),
		connect
	})
])

export const refused = Object.freeze([
	PgCluster.layer({
		prefix,
		// @ts-expect-error -- a cluster sized by its sessions is leased by no run: a runner's layer takes a leased one
		cluster: sessionsCluster,
		connect
	})
])
