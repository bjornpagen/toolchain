import { localCluster } from "#pg/pg.ts"

/**
 * One busy backend's proportional share of memory at the package's real work, the denominator of a member's
 * connection capacity (spec.ts Capacity): as many backends as the machine's memory holds of it.
 *
 * @limitKind measured
 * @owner the testing package's own cluster (pg.config.ts)
 * @unit bytes
 * @scope one client backend of the package's resource properties, at its peak
 * @evidence the backend's own /proc/self/smaps_rollup, read by it (pg_read_file, as the bootstrap superuser) right after
 *   its work: Rss 153,708 kB, Pss 36,427 kB (Pss_Anon 9,628 kB, Pss_Shmem 26,565 kB)
 * @observed 2026-11-21 11:29:55 UTC, one backend
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GiB; the workbench's shared PostgreSQL 19.0
 *   (postgres.service), the machine under load from other lanes
 * @workload a fresh database: a 200,000-row table built, indexed and joined with itself, heavier than any one case of
 *   the package's resource properties (a clone, its fingerprint, a few rows)
 * @result Pss 36,427 kB, 37,301,248 bytes
 * @decision the Pss as it is: a backend that touches more shared buffers has a larger Pss_Shmem, so a busier run's
 *   capacity is met as a refusal ("too many clients") and measured again, never padded here
 * @revalidate a 53300 refusal in a run; a resource property that works a much larger database; another machine
 */
const busyBackendBytes = 37_301_248

/**
 * The first port the package's families claim their members' from (@bjornpagen/testing/pg family.ts portsClaimed),
 * each the lowest from it that no family claims and nothing listens at: above every fixed port of the clusters made
 * before families (5432 to 5999 on cassowary, 2026-11-22), so a family never takes one a cluster of before was given
 * and is down, and below the kernel's ephemeral range (from 32768, /proc/sys/net/ipv4/ip_local_port_range), whose
 * ports an outgoing connection takes unasked.
 */
const firstPort = 20_000

/**
 * The testing package's own local cluster, which its resource properties clone from (resources.fixtures.ts): at each
 * checkout, its family's one member, the unit postgres@toolchain-test-<key>-0, reached over verify-full TLS at
 * localhost at a port it claims from firstPort, owned by toolchain_dev, who may set session_replication_role, which a
 * reset between a caller's cases sets (resources/database.ts rowsEmptied), its template carrying no extension,
 * throwaway, its connections a capacity of the machine, production's predicate locks for each backend until the
 * package measures its room (CONTRIBUTING.md, "A family's predicate lock room"), and the rest at PostgreSQL's
 * defaults. `toolchain-pg settle` from this directory gives the checkout's family this spec; a run only reads it.
 */
export default localCluster({
	unit: "toolchain-test",
	network: { kind: "tls", from: firstPort },
	owner: "toolchain_dev",
	template: "toolchain_template",
	extensions: [],
	ownerParameters: ["session_replication_role"],
	durability: "throwaway",
	sizing: {
		kind: "workers",
		family: { kind: "one" },
		connections: { kind: "capacity", backendBytes: busyBackendBytes },
		replication: { kind: "default" },
		sharedBuffers: { kind: "default" },
		locks: { kind: "default" },
		predicateLocks: { kind: "perBackend" }
	}
})
