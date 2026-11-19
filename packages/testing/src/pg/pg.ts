/**
 * A repository's local PostgreSQL cluster, made by one implementation for every repository: its spec (localCluster,
 * the default export of the package's pg.config.ts, which `toolchain-pg` reads), and its life as Effects, which the
 * runner's PgCluster layer (@bjornpagen/testing/resources) and a repository's own scripts run: up (made when missing,
 * started when stopped, taken as it is when it runs), init, stop, status, reset, destroy, and the doctor's checks.
 */
export { doctor, type Verdict } from "#pg/doctor.ts"
export {
	clusterStatus,
	clusterUp,
	clusterVariable,
	destroyCluster,
	type InitMode,
	initCluster,
	type MemberStatus,
	type PgMember,
	type Platform,
	resetCluster,
	stopCluster
} from "#pg/make.ts"
export { ClusterFailed } from "#pg/server.ts"
export {
	ClusterPort,
	type Durability,
	type Family,
	LocalCluster,
	type LocalClusterFields,
	localCluster,
	type ServerBin,
	type Sized,
	type SizedBuffers,
	type Sizing,
	type TemplateExtension
} from "#pg/spec.ts"
