/**
 * A repository's local PostgreSQL cluster as units of the workbench's PostgreSQL, one implementation for every
 * repository: its spec (localCluster, the default export of the package's pg.config.ts, which `toolchain-pg` reads);
 * its family at a checkout (familyOf, of the checkout a process's boundary reads, checkoutHere), the members every run
 * and command of the checkout reaches, and no other checkout's; the family's settling (settled: every family of a
 * checkout gone removed, then its state and its first member, which `toolchain-pg settle` runs as a unit of its own;
 * memberBroughtUp: the member a worker reaches, settled by its own unit where it is absent) and its reading (memberRead:
 * what a run reads, writing nothing; memberAtPort: the one at a port; membersRunning: every member that runs); and the
 * client check interval every member holds (clientCheckInterval), which bounds how long a backend outlives its client.
 */
export {
	type Checkout,
	type CheckoutFamily,
	checkoutHere,
	checkoutVariable,
	familyOf,
	familyRemoved,
	type Homes,
	homesHere,
	unitOf
} from "#pg/family.ts"
export { ClusterFailed, bootstrapSuperuser } from "#pg/server.ts"
export { clientCheckInterval } from "#pg/settings.ts"
export {
	caVariable,
	type MemberTls,
	type MemberSettle,
	memberAtPort,
	memberBroughtUp,
	memberNames,
	memberRead,
	membersRunning,
	memberSettled,
	type PgMember,
	type Platform,
	settled,
	unitSettled
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
	type PredicateRoom,
	type PreloadedLibrary,
	type Replication,
	type SessionsSizing,
	type SizedBuffers,
	type Sizing,
	type TemplateExtension,
	type TransactionLocks,
	UnitName,
	type WorkerSizing
} from "#pg/spec.ts"
