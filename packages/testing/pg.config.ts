import { localCluster } from "#pg/pg.ts"

/**
 * The connections one worker of a full run of the package's properties holds at once: its owner session on the member,
 * held for its life, and what its case holds beside it (a template's gate and build, a clone's own session).
 *
 * @limitKind measured
 * @owner the testing package's own cluster (pg.config.ts)
 * @unit connections
 * @scope the client backends one runner worker of `toolchain-test run` in packages/testing holds on the member at once
 * @evidence the member's pg_stat_activity, its client backends counted every 0.2 s as the bootstrap superuser
 *   (~/.cache/grizzle-release/CLUSTERPORT-measure/sample.sh) through a whole `toolchain-test run` at max_connections
 *   1000, so no connection was refused; its samples, output and machine readings in tc-full.samples, tc-full.out and
 *   tc-full.machine there
 * @observed 2026-11-19 04:21:16 to 04:29:08 UTC, one run
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores and 247 GB, 1-minute load 108 to 140 from other
 *   lanes; Ubuntu's PostgreSQL 18.6 as this cluster made it (pg/make.ts); toolchain fd9ef83 with this cluster's change,
 *   Node 26.13.1
 * @workload every property of the package, 186, on 64 workers, its 12 resource properties' cases spread over them
 * @result 1,940 samples; at most 125 client backends at once (the sampler's own among them), 9 samples at 100 or more,
 *   all in the run's second minute, when the resource properties ran; no connection refused
 * @decision 2: the most at once, 124 without the sampler, over the run's 64 workers is 1.94 a worker, rounded up to a
 *   whole connection, 128 at this width with the outside's beside them. No headroom past the rounding; an instant
 *   between two samples is unmeasured
 * @revalidate a "too many clients" refusal in a run; a resource property that opens more sessions at once; another
 *   machine or width
 */
const connectionsPerWorker = 2

/**
 * The sessions on the member outside any worker, one each: the run's collection in the runner's parent, a doctor's,
 * and an operator's psql.
 */
const outsideSessions = ["the run's collection", "the doctor", "an operator's psql"] as const

/**
 * The testing package's own local cluster, which its resource properties clone from (resources.fixtures.ts) and the
 * runner's layer makes and starts the first time a need reaches it: on port 5441, run by whichever PostgreSQL the
 * machine installed (its pg_config on PATH), owned by toolchain_dev, its template carrying no extension, throwaway, one
 * member, its connections sized for a full run and the rest at PostgreSQL's defaults. `toolchain-pg <command>` from
 * this directory reaches it.
 */
export default localCluster({
	port: 5441,
	bin: { kind: "pg_config" },
	owner: "toolchain_dev",
	template: "toolchain_template",
	extensions: [],
	peerLogins: [],
	durability: "throwaway",
	family: { kind: "one" },
	sizing: {
		connections: {
			kind: "perWorker",
			perWorker: connectionsPerWorker,
			outside: outsideSessions.length
		},
		replication: { kind: "default" },
		sharedBuffers: { kind: "default" }
	}
})
