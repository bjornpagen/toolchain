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
 * The testing package's own local cluster, which its resource properties clone from (resources.fixtures.ts): the unit
 * postgres@toolchain-test-0, reached over verify-full TLS at localhost:5441, owned by toolchain_dev, its template
 * carrying no extension, throwaway, one member, its connections a capacity of the machine and the rest at PostgreSQL's
 * defaults. `toolchain-pg settle` from this directory gives it this spec; a run only reads it.
 */
export default localCluster({
	unit: "toolchain-test",
	network: { kind: "tls", port: 5441 },
	owner: "toolchain_dev",
	template: "toolchain_template",
	extensions: [],
	ownerParameters: [],
	durability: "throwaway",
	sizing: {
		kind: "workers",
		family: { kind: "one" },
		connections: { kind: "capacity", backendBytes: busyBackendBytes },
		replication: { kind: "default" },
		sharedBuffers: { kind: "default" },
		locks: { kind: "default" }
	}
})
