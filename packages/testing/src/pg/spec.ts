import { regex } from "arkregex"
import { Brand } from "effect"

/**
 * A cluster's name, the first part of its families' (family.ts familyOf, `<unit>-<key>`), and so of the PostgreSQL units
 * their members run as, `postgres@<unit>-<key>-<i>` (the workbench's `postgres@` template,
 * ~/Documents/beefy-workspace/workbench/parts/postgres), whose data and socket the unit owns. A unit name is a systemd
 * instance name a slice and a journal read back: lowercase letters, digits and hyphens, a letter first.
 */
export type UnitName = string & Brand.Brand<"UnitName">

/**
 * A unit name's text: what systemd keeps of an instance name as it is.
 *
 * @formatConstant at most 48 characters, so a member's unit instance, its family's name and `-<i>` after it, names its
 * socket's directory (`$XDG_RUNTIME_DIR/postgresql-<member>/.s.PGSQL.<port>`) well within a Unix socket's 107 bytes
 */
const unitPattern = regex("^[a-z][a-z0-9-]{0,47}$")

/** A unit name: a lowercase letter, then lowercase letters, digits and hyphens, at most 48 characters (UnitName). */
export const UnitName = Brand.make<UnitName>((name) => unitPattern.test(name))

/**
 * A spec's unit name, which a family's key and a member's index follow (family.ts familyOf): at most 36 characters, so
 * a member's name, `<unit>-<8 hex digits>-<index>`, stays a UnitName.
 *
 * @formatConstant a unit name's 48 characters (unitPattern) less a family's `-<8 hex digits>` and a member's `-<index>`
 * of two digits
 */
const specUnitPattern = regex("^[a-z][a-z0-9-]{0,35}$")

/** A spec's unit name (specUnitPattern), a UnitName its families' names extend. */
const SpecUnitName = Brand.make<UnitName>((name) => specUnitPattern.test(name))

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
 * localhost too, with the server certificate the workbench's PostgreSQL part installs, for a repository whose client
 * refuses anything else (grizzle's), each member at a port its family claims (family.ts portsClaimed), the lowest
 * from `from` that no family claims and nothing listens at.
 */
export type Network = Readonly<{ kind: "socket" }> | Readonly<{ kind: "tls"; from: ClusterPort }>

/**
 * An extension the template database carries, created by the bootstrap superuser in a schema the owner owns, so a
 * migration identity that is no superuser finds an untrusted extension (pgvector) present where its schema reads it.
 */
export type TemplateExtension = Readonly<{ name: string; schema: string }>

/**
 * How a member loads a library it preloads: `shared`, once as the postmaster starts (shared_preload_libraries), for a
 * library that sizes shared memory then; or `session`, as each backend starts (session_preload_libraries), which a
 * database or a role sets otherwise for its own sessions (`ALTER DATABASE ... SET session_preload_libraries = NULL`,
 * PostgreSQL's empty list, by an owner the cluster's `ownerParameters` grant it), so a test makes sessions without the
 * library in a database of its own while every other database's load it.
 */
export type Loading = "shared" | "session"

/**
 * What a member needs of a library it preloads: how it loads it (Loading), the settings that keep it inert in every
 * database until a database turns it on (settings.ts preloadSettings), each as pg_settings spells it, and whether its
 * SQL interface is an extension, which settle makes in the owner's own database (settle.ts owned), so no clone a test
 * works in carries an object of it.
 */
export type PreloadedLibraryFacts = Readonly<{
	loading: Loading
	inert: ReadonlyArray<readonly [name: string, value: string]>
	extension: boolean
}>

/**
 * The libraries a cluster's members may preload, each with its facts (PreloadedLibraryFacts):
 *
 * - `pg_stat_statements`, whose counts of each statement's plans and calls a test of what a backend plans reads:
 *   shared, as it sizes its table in shared memory; inert at compute_query_id off, so no statement is jumbled into a
 *   query id, and at track `none` and track_planning off, so each of its hooks returns at its first test and it counts
 *   nothing; its extension in the owner's database, so its counts are the cluster's, read from there.
 * - `pg_plan_advice`, PostgreSQL 19's planner module, which plans each statement by the advice in force where it is
 *   planned (pg_plan_advice.advice, set by a routine's own SET clause or by a transaction) and makes no state of its own
 *   where none is (pgpa_planner.c pgpa_planner_setup): grizzle carries every statement's plan as advice and refuses a
 *   session without the library. Loaded by each session, so a test of that refusal opens its sessions in a database
 *   of its own that sets it off; inert with no setting; no SQL interface.
 * - `pg_overexplain`, PostgreSQL 19's EXPLAIN options module, whose EXPLAIN (RANGE_TABLE) prints each scan's range
 *   table index and each range table entry's alias and the subplan it was planned in: the target an advice item names
 *   a scan by (pg_plan_advice's pgpa_identifier.c), where EXPLAIN's display names are made unique past it. It hooks
 *   EXPLAIN alone, so it changes no plan; loaded by each session, as LOAD of it is a superuser's; inert with no
 *   setting; no SQL interface. Tests read plans with it; no production session loads it.
 */
const preloadedLibraries = {
	pg_stat_statements: {
		loading: "shared",
		inert: [
			["compute_query_id", "off"],
			["pg_stat_statements.track", "none"],
			["pg_stat_statements.track_planning", "off"]
		],
		extension: true
	},
	pg_plan_advice: { loading: "session", inert: [], extension: false },
	pg_overexplain: { loading: "session", inert: [], extension: false }
} as const satisfies Readonly<Record<string, PreloadedLibraryFacts>>

/** A library of `preloadedLibraries`. */
export type PreloadedLibrary = keyof typeof preloadedLibraries

/** A preloaded library's facts (PreloadedLibraryFacts). */
export const factsOf = (library: PreloadedLibrary): PreloadedLibraryFacts =>
	preloadedLibraries[library]

/**
 * What a cluster's data is worth past a run: `throwaway`, a test cluster's, whose clones a run makes again (fsync off);
 * or `kept`, a development cluster's, a person's own data (PostgreSQL's fsync).
 */
export type Durability = "throwaway" | "kept"

/**
 * How many members a cluster sized for workers has, each a unit of its own, its workers spread over them: `one`, a
 * single member serving every worker of a run; or `spread`, as many members as a run's workers (one for every two CPUs of its allowance, testing's
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
 * The room a member's predicate lock table holds for the SIREAD locks its SERIALIZABLE transactions take, committed ones
 * PostgreSQL keeps among them: `perBackend`, max_pred_locks_per_transaction at grizzle's recommendation to production
 * (2048, settings.ts) for every backend the member admits, a table that grows with its connections and WAL senders; or
 * `perWorker`, `targets` for each worker of a run the member serves, the repository's measured peak, its evidence beside
 * its spec (how to measure it: CONTRIBUTING.md, "A family's predicate lock room"). Every non-concurrent DROP INDEX in a
 * member, each index of a DROP TABLE or DROP SCHEMA CASCADE among them, while any SERIALIZABLE transaction of the member
 * runs, walks the whole target table under every SSI LWLock held exclusive (PostgreSQL 19.0 predicate.c
 * DropAllPredicateLocksFromTable), so its size is a cost every SERIALIZABLE transaction of the member waits on: 5.6 ms a
 * drop at grizzle's 3.19 million targets, 0.3 ms at 100,000 (2026-11-22). A smaller room only fails earlier ("out of
 * shared memory", 53200), never passes where a larger fails; the relation promotion is the same at every room.
 */
export type PredicateRoom =
	| Readonly<{ kind: "perBackend" }>
	| Readonly<{ kind: "perWorker"; targets: number }>

/**
 * A cluster a run's workers reach (resources/cluster.ts PgCluster.layer), nothing admitting or queueing them: its
 * family's members, which its workers spread over, worker i on member i mod their count; its connections, a capacity
 * of the machine (Capacity); its replication; its shared buffers, every page a run's workers on a member read held at
 * once; its lock table (TransactionLocks); and its predicate lock table's room (PredicateRoom).
 */
export type WorkerSizing = Readonly<{
	kind: "workers"
	family: Family
	connections: Capacity
	replication: Replication
	sharedBuffers: SizedBuffers
	locks: TransactionLocks
	predicateLocks: PredicateRoom
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
 * A repository's local PostgreSQL cluster, as it states it once: its unit name (the members' units, UnitName), how
 * its clients reach it (Network), the owner role (which owns every database it makes, signs in with a password the
 * cluster's state holds, and whose own database holds the runner's sessions), the template database every database is
 * made from and the extensions it carries, the libraries every member preloads, each loaded its way and inert until a
 * database turns it on (`preload`, PreloadedLibraryFacts), the server parameters the owner may set though only a
 * superuser may by default (`ownerParameters`, each granted as `GRANT SET ON PARAMETER`: grizzle's installation sets
 * deadlock_timeout and session_replication_role, a test of planning turns pg_stat_statements on in its own database,
 * and a test of a session without pg_plan_advice sets session_preload_libraries off in its own), its durability and
 * its sizing (`S`: for a run's workers or for its sessions, so only a cluster sized for workers is handed to a
 * runner's layer). The server runs as the workbench's units; `toolchain-pg settle` (settle.ts) gives each member what
 * the spec states, and a run only reads it. `toolchain-pg` reads the spec as the default export of the package's
 * pg.config.ts; its class is how the command tells it from any other export.
 */
export class LocalCluster<S extends Sizing = Sizing> {
	readonly unit: UnitName
	readonly network: Network
	readonly owner: string
	readonly template: string
	readonly extensions: ReadonlyArray<TemplateExtension>
	readonly preload: ReadonlyArray<PreloadedLibrary>
	readonly ownerParameters: ReadonlyArray<string>
	readonly durability: Durability
	readonly sizing: S

	constructor(fields: LocalClusterFields<S>) {
		this.unit = SpecUnitName(fields.unit)
		this.network =
			fields.network.kind === "tls"
				? { kind: "tls", from: ClusterPort(fields.network.from) }
				: { kind: "socket" }
		this.owner = fields.owner
		this.template = fields.template
		this.extensions = fields.extensions
		this.preload = fields.preload
		this.ownerParameters = fields.ownerParameters
		this.durability = fields.durability
		this.sizing = fields.sizing
	}
}

/** What a repository writes of its cluster (LocalCluster), its unit name and first port as plain values. */
export type LocalClusterFields<S extends Sizing = Sizing> = Readonly<{
	unit: string
	network: Readonly<{ kind: "socket" }> | Readonly<{ kind: "tls"; from: number }>
	owner: string
	template: string
	extensions: ReadonlyArray<TemplateExtension>
	preload: ReadonlyArray<PreloadedLibrary>
	ownerParameters: ReadonlyArray<string>
	durability: Durability
	sizing: S
}>

/** A repository's cluster: `export default localCluster({ ... })` in its pg.config.ts. A name or port that is none fails. */
export const localCluster = <S extends Sizing>(fields: LocalClusterFields<S>): LocalCluster<S> =>
	new LocalCluster(fields)
