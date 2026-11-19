import { Brand } from "effect"

/**
 * A cluster's name: the port its first member listens on at localhost, which every command and need that reaches the
 * cluster names it by, and which its state directory, its lock and its manifest are keyed by (state.ts).
 *
 * @formatConstant a TCP port: 16 bits, 1 to 65,535 (0 asks the system for one)
 */
export type ClusterPort = number & Brand.Brand<"ClusterPort">

/** A port that names a cluster: an integer from 1 to 65,535 (ClusterPort). */
export const ClusterPort = Brand.make<ClusterPort>(
	(port) => Number.isInteger(port) && port >= 1 && port <= 65_535
)

/**
 * Where the programs of the PostgreSQL server that runs a cluster are (initdb, pg_ctl, postgres, psql, pg_isready): a
 * directory the repository names by its absolute path (grizzle's pinned build, `<prefix>/bin`), or the one the
 * `pg_config` on PATH names (`pg_config --bindir`), for a repository that runs whichever server the machine installed,
 * since Debian and Ubuntu put no server's bin directory on PATH and Homebrew's keg-only formulae keep their own.
 */
export type ServerBin =
	| Readonly<{ kind: "directory"; directory: string }>
	| Readonly<{ kind: "pg_config" }>

/**
 * An extension the template database carries, created by the bootstrap superuser in a schema the owner owns, so a
 * migration identity that is no superuser finds an untrusted extension (pgvector) present where its schema reads it.
 */
export type TemplateExtension = Readonly<{ name: string; schema: string }>

/**
 * What a cluster's data is worth past a run: `throwaway`, a test cluster's, which a full run makes again (fsync off,
 * reset and destroy admitted); or `kept`, a development cluster's, a person's own data (PostgreSQL's fsync, never reset
 * or destroyed by these commands).
 */
export type Durability = "throwaway" | "kept"

/**
 * How many members a cluster has, each a postmaster of its own on a port of its own, its workers spread over them:
 * `one`, a single member serving every worker of a run; or `spread`, as many members as a run's workers (one a core,
 * testing's testWorkers) over the workers one member serves at once, rounded up, for a repository whose measurement
 * shows a member's shared costs (SSI's LWLocks, the checkpointer) grow with the workers on it. `workersPerMember` is
 * the repository's measured number, never this library's.
 */
export type Family =
	| Readonly<{ kind: "one" }>
	| Readonly<{ kind: "spread"; workersPerMember: number }>

/**
 * A count a member is sized for: PostgreSQL's own default, for a repository that has no evidence of what a full run
 * of its needs; or what each worker the member serves holds at most, `perWorker`, and what is held outside any worker,
 * `outside` (a global setup, a doctor, an operator's psql), each the repository's number with its evidence beside its
 * spec. A member holds the sum over the workers it serves and the outside.
 */
export type Sized = Readonly<{ kind: "default" }> | PerWorker

/**
 * What each worker a member serves holds at most, `perWorker`, and what is held outside any worker, `outside`, each the
 * repository's number with its evidence beside its spec: a member's connections are always sized so, since its lease
 * divides the member's capacity by what a lessee holds (lease.ts leaseOn), and a demand never stated could not be
 * divided.
 */
export type PerWorker = Readonly<{ kind: "perWorker"; perWorker: number; outside: number }>

/**
 * The shared buffers a member is sized for: PostgreSQL's own default, or every page each worker the member serves
 * reads held at once, `bytes` being the largest database one worker works in.
 */
export type SizedBuffers =
	| Readonly<{ kind: "default" }>
	| Readonly<{ kind: "perWorker"; bytes: number }>

/**
 * What a member is sized for, a full-width run of the repository's needs: its connections (max_connections, the
 * superuser's and reserved slots added), its replication (max_replication_slots and max_wal_senders, each a live
 * source's slot and walsender), and its shared buffers.
 */
export type Sizing = Readonly<{
	connections: PerWorker
	replication: Sized
	sharedBuffers: SizedBuffers
}>

/**
 * A repository's local PostgreSQL cluster, as it states it once: its name (the port), the server that runs it, the
 * owner role (which owns every database it makes, signs in over verify-full TLS with a password the cluster's state
 * holds, and whose own database holds the runner's sessions), the template database every database is made from and
 * the extensions it carries, the server parameters the owner may set though only a superuser may by default
 * (`ownerParameters`, each granted as `GRANT SET ON PARAMETER`: grizzle's installation sets deadlock_timeout and
 * session_replication_role), the roles this user signs in as over a member's Unix socket by peer authentication
 * beside the bootstrap superuser (`peerLogins`: an application's login, whose local sign-in then needs no secret),
 * its durability, its family and its sizing. Everything else of the cluster (TLS, SCRAM,
 * the settings every member holds, its state directory) is the same for every repository (make.ts), and the
 * cluster's facts a client reaches it by are its members' (PgMember). `toolchain-pg` reads it as the default export
 * of the package's pg.config.ts; its class is how the command tells it from any other default export.
 */
export class LocalCluster {
	readonly port: ClusterPort
	readonly bin: ServerBin
	readonly owner: string
	readonly template: string
	readonly extensions: ReadonlyArray<TemplateExtension>
	readonly ownerParameters: ReadonlyArray<string>
	readonly peerLogins: ReadonlyArray<string>
	readonly durability: Durability
	readonly family: Family
	readonly sizing: Sizing

	constructor(fields: LocalClusterFields) {
		this.port = ClusterPort(fields.port)
		this.bin = fields.bin
		this.owner = fields.owner
		this.template = fields.template
		this.extensions = fields.extensions
		this.ownerParameters = fields.ownerParameters
		this.peerLogins = fields.peerLogins
		this.durability = fields.durability
		this.family = fields.family
		this.sizing = fields.sizing
	}
}

/** What a repository writes of its cluster (LocalCluster), its port as a plain number. */
export type LocalClusterFields = Readonly<{
	port: number
	bin: ServerBin
	owner: string
	template: string
	extensions: ReadonlyArray<TemplateExtension>
	ownerParameters: ReadonlyArray<string>
	peerLogins: ReadonlyArray<string>
	durability: Durability
	family: Family
	sizing: Sizing
}>

/** A repository's cluster: `export default localCluster({ ... })` in its pg.config.ts. A port that is none fails. */
export const localCluster = (fields: LocalClusterFields): LocalCluster => new LocalCluster(fields)
