/**
 * A repository's local PostgreSQL cluster as units of the workbench's PostgreSQL, one implementation for every
 * repository: its spec (localCluster, the default export of the package's pg.config.ts, which `toolchain-pg` reads),
 * its settling (settled: each member's unit started and given what the spec states, which `toolchain-pg settle` runs
 * as a unit of its own) and its reading (membersRead: what a run reads, writing nothing); and the client check interval
 * every member holds (clientCheckInterval), which bounds how long a backend outlives its client.
 */
export { ClusterFailed, bootstrapSuperuser } from "#pg/server.ts"
export { clientCheckInterval } from "#pg/settings.ts"
export {
	caVariable,
	type MemberTls,
	memberNames,
	membersRead,
	type PgMember,
	type Platform,
	settled,
	unitOf
} from "#pg/settle.ts"
export {
	type Capacity,
	ClusterPort,
	type Durability,
	type Family,
	LocalCluster,
	type LocalClusterFields,
	localCluster,
	type Network,
	type Replication,
	type SessionsSizing,
	type SizedBuffers,
	type Sizing,
	type TemplateExtension,
	type TransactionLocks,
	UnitName,
	type WorkerSizing
} from "#pg/spec.ts"
