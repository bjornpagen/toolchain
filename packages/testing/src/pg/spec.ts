import { regex } from "arkregex"
import { Brand } from "effect"

/**
 * A cluster's name: the PostgreSQL units its members run as, `postgres@<unit>-<i>` (the workbench's `postgres@`
 * template, ~/Documents/beefy-workspace/workbench/parts/postgres), whose data and socket the unit owns. A unit name is
 * a systemd instance name a slice and a journal read back: lowercase letters, digits and hyphens, a letter first.
 */
export type UnitName = string & Brand.Brand<"UnitName">

/** A unit name's text: what systemd keeps of an instance name as it is, with room for a member's suffix. */
const unitPattern = regex("^[a-z][a-z0-9-]{0,47}$")

/** A unit name: a lowercase letter, then lowercase letters, digits and hyphens, at most 48 characters (UnitName). */
export const UnitName = Brand.make<UnitName>((name) => unitPattern.test(name))

/**
 * A TCP port a member listens on at localhost.
 *
 * @formatConstant a TCP port: 16 bits, 1 to 65,535 (0 asks the system for one)
 */
export type ClusterPort = number & Brand.Brand<"ClusterPort">

/** A port a member listens on: an integer from 1 to 65,535 (ClusterPort). */
export const ClusterPort = Brand.make<ClusterPort>(
	(port) => Number.isInteger(port) && port >= 1 && port <= 65_535
)

/**
 * How a cluster's clients reach its members: `socket`, over each member's Unix socket alone (the unit's own, which
 * only this account reaches), for a repository whose clients need nothing else; or `tls`, over verify-full TLS at
 * localhost too, member i on `port` + i, with the server certificate the workbench's PostgreSQL part installs, for a
 * repository whose client refuses anything else (grizzle's).
 */
export type Network = Readonly<{ kind: "socket" }> | Readonly<{ kind: "tls"; port: ClusterPort }>

/**
 * An extension the template database carries, created by the bootstrap superuser in a schema the owner owns, so a
 * migration identity that is no superuser finds an untrusted extension (pgvector) present where its schema reads it.
 */
export type TemplateExtension = Readonly<{ name: string; schema: string }>

/**
 * What a cluster's data is worth past a run: `throwaway`, a test cluster's, whose clones a run makes again (fsync off);
 * or `kept`, a development cluster's, a person's own data (PostgreSQL's fsync).
 */
export type Durability = "throwaway" | "kept"

/**
 * How many members a cluster sized for workers has, each a unit of its own, its workers spread over them: `one`, a
 * single member serving every worker of a run; or `spread`, as many members as a run's workers (one a core, testing's
 * testWorkers) over the workers one member serves at once, rounded up, for a repository whose measurement shows a
 * member's shared costs (SSI's LWLocks, the checkpointer) grow with the workers on it. `workersPerMember` is the
 * repository's measured number, never this library's.
 */
export type Family =
	| Readonly<{ kind: "one" }>
	| Readonly<{ kind: "spread"; workersPerMember: number }>

/**
 * The shared buffers a member sized for workers is sized for: PostgreSQL's own default, or every page each worker the member
 * serves reads held at once, `bytes` being the largest database one worker works in.
 */
export type SizedBuffers =
	| Readonly<{ kind: "default" }>
	| Readonly<{ kind: "perWorker"; bytes: number }>

/**
 * A member's connections as a capacity of the machine: as many as its memory holds of backends at the suite's real
 * work, `backendBytes` being one busy backend's proportional share of memory (its /proc/<pid>/smaps_rollup Pss at its
 * peak), the repository's measurement with its evidence beside its spec. Nothing admits or queues a connection: a
 * member past it refuses one ("too many clients", 53300), a problem met, measured and fixed where it happens.
 */
export type Capacity = Readonly<{ kind: "capacity"; backendBytes: number }>

/**
 * A member's replication: PostgreSQL's defaults, or `capacity`, a replication slot and a WAL sender for every
 * connection the member admits (a live source's leader holds one of each).
 */
export type Replication = Readonly<{ kind: "default" }> | Readonly<{ kind: "capacity" }>

/**
 * The heavyweight locks a member's lock table holds: PostgreSQL's default per transaction, or `locks`, the most one
 * transaction of the repository's takes at once, measured (a migration's largest), which PostgreSQL's table holds for
 * every backend at once (max_locks_per_transaction entries for each).
 */
export type TransactionLocks =
	| Readonly<{ kind: "default" }>
	| Readonly<{ kind: "perTransaction"; locks: number }>

/**
 * A cluster a run's workers reach (resources/cluster.ts PgCluster.layer), nothing admitting or queueing them: its
 * family, the members its workers spread over, worker i on member i mod their count; its connections, a capacity of
 * the machine (Capacity); its replication; its shared buffers, every page a run's workers on a member read held at
 * once; and its lock table (TransactionLocks).
 */
export type WorkerSizing = Readonly<{
	kind: "workers"
	family: Family
	connections: Capacity
	replication: Replication
	sharedBuffers: SizedBuffers
	locks: TransactionLocks
}>

/**
 * The heavyweight locks a cluster sized by its sessions holds at once: PostgreSQL's own default, for a repository that
 * has no evidence of them; or `locks`, what its known users' transactions hold at most at once, all of them together
 * (a migration's largest transaction beside the application's), the repository's number with its evidence beside its
 * spec.
 */
export type SessionLocks = Readonly<{ kind: "default" }> | Readonly<{ kind: "held"; locks: number }>

/**
 * A cluster no run reaches (a development cluster that `pnpm dev` and its tools reach, never a runner's layer): one
 * member, its max_connections the sessions its known users hold at most at once (an application's pool, a doctor, an
 * operator's psql), the superuser's and reserved slots added, each user's number stated in the repository's own code
 * beside the user it bounds; its lock table sized for the locks they hold at once (SessionLocks); its replication and
 * shared buffers at PostgreSQL's defaults. It has no workers, so nothing of it is sized per worker.
 */
export type SessionsSizing = Readonly<{ kind: "sessions"; sessions: number; locks: SessionLocks }>

/** How a cluster is sized: for the runs' workers that reach it (WorkerSizing), or for its known users' sessions. */
export type Sizing = WorkerSizing | SessionsSizing

/**
 * A repository's local PostgreSQL cluster, as it states it once: its unit name (the members' units, UnitName), how its
 * clients reach it (Network), the owner role (which owns every database it makes, signs in with a password the
 * cluster's state holds, and whose own database holds the runner's sessions), the template database every database is
 * made from and the extensions it carries, the server parameters the owner may set though only a superuser may by
 * default (`ownerParameters`, each granted as `GRANT SET ON PARAMETER`: grizzle's installation sets deadlock_timeout and
 * session_replication_role), its durability and its sizing (`S`: for a run's workers or for its sessions, so only a
 * cluster sized for workers is handed to a runner's layer). The server runs as the workbench's units; `toolchain-pg
 * settle` (settle.ts) gives each member what the spec states, and a run only reads it. `toolchain-pg` reads the spec as
 * the default export of the package's pg.config.ts; its class is how the command tells it from any other export.
 */
export class LocalCluster<S extends Sizing = Sizing> {
	readonly unit: UnitName
	readonly network: Network
	readonly owner: string
	readonly template: string
	readonly extensions: ReadonlyArray<TemplateExtension>
	readonly ownerParameters: ReadonlyArray<string>
	readonly durability: Durability
	readonly sizing: S

	constructor(fields: LocalClusterFields<S>) {
		this.unit = UnitName(fields.unit)
		this.network =
			fields.network.kind === "tls"
				? { kind: "tls", port: ClusterPort(fields.network.port) }
				: { kind: "socket" }
		this.owner = fields.owner
		this.template = fields.template
		this.extensions = fields.extensions
		this.ownerParameters = fields.ownerParameters
		this.durability = fields.durability
		this.sizing = fields.sizing
	}
}

/** What a repository writes of its cluster (LocalCluster), its unit name and port as plain values. */
export type LocalClusterFields<S extends Sizing = Sizing> = Readonly<{
	unit: string
	network: Readonly<{ kind: "socket" }> | Readonly<{ kind: "tls"; port: number }>
	owner: string
	template: string
	extensions: ReadonlyArray<TemplateExtension>
	ownerParameters: ReadonlyArray<string>
	durability: Durability
	sizing: S
}>

/** A repository's cluster: `export default localCluster({ ... })` in its pg.config.ts. A name or port that is none fails. */
export const localCluster = <S extends Sizing>(fields: LocalClusterFields<S>): LocalCluster<S> =>
	new LocalCluster(fields)
