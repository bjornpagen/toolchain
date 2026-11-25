import { Array as Arr, String as Str } from "effect"
import type { Durability, LocalCluster, PredicateRoom, SessionLocks, Sizing } from "#pg/spec.ts"
import { widthOf } from "#workers.ts"

/**
 * How long a backend runs a statement between two polls of its client's socket, PostgreSQL's
 * client_connection_check_interval, which every member holds (fixedSettings). A backend polls only while it runs a
 * statement (the timer start_xact_command arms, REL_19_0 src/backend/tcop/postgres.c#L2818), so an idle session is
 * never woken; a poll that finds the socket closed (pq_check_connection, src/backend/libpq/pqcomm.c#L2057) ends the
 * backend with FATAL "connection to client lost" (postgres.c#L3465), and with it the transaction id and the locks it
 * holds. Without it PostgreSQL notices a dead client only when it next reads from or writes to the socket, which a
 * statement that never ends never does: a test process ended mid-statement (its hang guard, a SIGKILL, a statement that
 * never ends) leaves its backend running and holding its transaction id, and every logical slot's creation on the
 * member (CREATE_REPLICATION_SLOT, a live source's) waits for every transaction id running when it starts.
 *
 * @limitKind measured
 * @owner the toolchain's local clusters (pg/settle.ts), from grizzle's (packages/pg/src/settings.ts at a5dd3588d) and
 *   superstarter's test cluster (packages/database/src/postgres/test-cluster.ts at 90f266e), whose evidence is this
 *   number's
 * @unit milliseconds
 * @scope one backend of a member while it runs a statement: the time between two polls of its client's socket, and so
 *   the longest it outlives its client's death before its next poll
 * @evidence one psql session's \timing (psql -X -At -f) on a throwaway postmaster: `SET client_connection_check_interval
 *   = 0` and `= 1000` in turn, each followed by `WITH RECURSIVE r(i) AS (SELECT 1::int8 UNION ALL SELECT i + 1 FROM r
 *   WHERE i < 20000000) SELECT count(*) FROM r`, eight times each after one warm run, its output at
 *   ~/.cache/grizzle-release/ORPHAN/out/cost.txt on cassowary; and on superstarter's PostgreSQL 18.6 test cluster, a
 *   psql client SIGKILLed in `SELECT pg_sleep(600)` inside a transaction holding a transaction id, at the interval and
 *   at 0, at ~/.cache/grizzle-release/SS-CLUSTERS/out/kill-proof-5446.txt
 * @observed 2026-11-15 14:14:02 to 14:15:40 UTC (PostgreSQL 19rc2), one run; 2026-11-17 (PostgreSQL 18.6), two kills
 * @environment cassowary, Ubuntu 26.04 on arm64 in AWS, 64 cores, load average 16 to 22 from other sessions; the
 *   pinned PostgreSQL 19rc2 build at initdb's defaults with no other session on it (grizzle 17b28413); Ubuntu's
 *   PostgreSQL 18.6 on port 5446
 * @workload one backend running a CPU-bound statement of 20,000,000 recursive steps, about 5.7 s, which polls five
 *   times a run at 1,000 ms and never at 0, the two in alternation; one backend in pg_sleep whose client is SIGKILLed
 * @result at 0: median 5,762.8 ms, 5,751.8 to 6,018.1; at 1,000: median 5,754.7 ms, 5,727.0 to 5,811.3, the polls'
 *   cost below the runs' own spread. Backends of SIGKILLed clients, each holding a transaction id, left
 *   pg_stat_activity 1,000 to 1,017 ms after the kill on 19rc2 and 995 and 1,009 ms on 18.6; at 0 an orphan ran on (the
 *   incident's for 44 minutes to 5.7 hours, 18.6's still 10 s after the kill, ended by hand)
 * @decision 1,000 ms: its polls cost nothing measurable on a statement of seconds, and an orphan then holds its
 *   transaction id at most about a second past its client's death, against hours without. No shorter value is
 *   measured: the polls' cost grows as one over the interval, and a slot creation waiting a second behind an orphan
 *   waits far less than any case's own hang limit
 * @revalidate a PostgreSQL repin or major version; a poll's cost measured above the runs' spread; a test that waits
 *   behind an orphan for less than the interval; another machine
 */
export const clientCheckInterval = 1000

/**
 * The predicate locks PostgreSQL's table holds for each connection a member admits, max_pred_locks_per_transaction:
 * grizzle's recommendation to an operator, which production holds. A member whose room is `perBackend` (spec.ts
 * PredicateRoom) holds it; every member's relation promotion is derived from it (relationPromotion).
 *
 * @limitKind published
 * @owner grizzle, the operator's PostgreSQL settings its README recommends
 * @unit predicate locks
 * @scope max_pred_locks_per_transaction of every member of every local cluster
 * @constraint advisory threshold
 * @source https://github.com/bjornpagen/grizzle/blob/a5dd3588dded8ae8f28b51f5605643322f4000ca/README.md#L1323
 * @quote **`max_pred_locks_per_transaction = 2048`**, recommended: a server-start setting, about 115 MB of shared
 *   memory at 200 connections.
 * @verified 2026-11-18
 */
const predicateLocksPerTransaction = 2048

/**
 * PostgreSQL's default max_pred_locks_per_relation: negative, so a relation's page and tuple locks promote to one
 * relation lock past max_pred_locks_per_transaction over its magnitude, less one (predicate.c MaxPredicateChildLocks,
 * https://github.com/postgres/postgres/blob/REL_19_0/src/backend/storage/lmgr/predicate.c#L2223).
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit a divisor of max_pred_locks_per_transaction, negated
 * @scope the relation promotion production holds at grizzle's recommendation (relationPromotion)
 * @constraint configurable default
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/misc/guc_parameters.dat#L2094
 * @quote boot_val => '-2',
 * @verified 2026-11-22
 */
const defaultRelationPromotion = -2

/**
 * The page and tuple locks of one relation a SERIALIZABLE transaction holds before PostgreSQL promotes them to one lock
 * of the relation, max_pred_locks_per_relation, which every member holds: production's, what PostgreSQL's default
 * derives from grizzle's recommended max_pred_locks_per_transaction, stated so it no longer moves with a member's
 * max_pred_locks_per_transaction, which its room sizes (sizedSettings). Every member promotes as production does, and
 * as every member did when each held 2048.
 *
 * @limitKind derived
 * @owner the toolchain's local clusters (pg/settings.ts), after PostgreSQL 19.0's promotion
 * @unit page and tuple locks of one relation
 * @scope max_pred_locks_per_relation of every member of every local cluster
 * @derivation predicate.c#L2223 (REL_19_0, verified 2026-11-22): `max_predicate_locks_per_xact /
 *   (-max_predicate_locks_per_relation) - 1`, in C's integer division, at grizzle's 2048 and PostgreSQL's default -2:
 *   1023
 * @from {@link predicateLocksPerTransaction}, {@link defaultRelationPromotion}
 */
const relationPromotion = Math.trunc(predicateLocksPerTransaction / -defaultRelationPromotion) - 1

/**
 * The least max_pred_locks_per_transaction PostgreSQL accepts, which a member whose room needs fewer a backend holds.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit predicate locks per server process or prepared transaction
 * @scope a perWorker member's max_pred_locks_per_transaction (predicateLocksFor)
 * @constraint hard quota
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/misc/guc_parameters.dat#L2104
 * @quote min => '10',
 * @verified 2026-11-22
 */
const minimumPredicateLocks = 10

/**
 * The connections PostgreSQL keeps for superusers alone, at its default, which a member leaves as it is.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0 (18's postgresql.conf.sample states the same default)
 * @unit connections
 * @scope a member's superuser_reserved_connections, out of its max_connections
 * @constraint configurable default
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/misc/guc_parameters.dat#L2941
 * @quote boot_val => '3',
 * @verified 2026-11-20
 */
const superuserReservedConnections = 3

/**
 * The connections PostgreSQL keeps for pg_use_reserved_connections, at its default, which a member leaves as it is.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0 (18's postgresql.conf.sample states the same default)
 * @unit connections
 * @scope a member's reserved_connections, out of its max_connections
 * @constraint configurable default
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/misc/guc_parameters.dat#L2552
 * @quote boot_val => '0',
 * @verified 2026-11-20
 */
const reservedConnections = 0

/**
 * The heavyweight locks PostgreSQL's lock table holds for each process it admits, max_locks_per_transaction, at its
 * default: a member's table never holds fewer, whatever its demand.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit locks per server process or prepared transaction
 * @scope a member's max_locks_per_transaction, which sizes its shared lock table (locksPerTransaction)
 * @constraint configurable default
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/misc/guc_parameters.dat#L2026
 * @quote boot_val => '128',
 * @verified 2026-11-20
 */
const defaultLocksPerTransaction = 128

/**
 * The backend slots PostgreSQL keeps for autovacuum's workers, at its default, which a member leaves as it is.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit server processes
 * @scope a member's autovacuum_worker_slots, part of the processes its lock table is sized by (locksPerTransaction)
 * @constraint configurable default
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/misc/guc_parameters.dat#L306
 * @quote boot_val => '16',
 * @verified 2026-11-20
 */
const autovacuumWorkerSlots = 16

/**
 * The background worker processes PostgreSQL admits, at its default, which a member leaves as it is.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit server processes
 * @scope a member's max_worker_processes, part of the processes its lock table is sized by (locksPerTransaction)
 * @constraint configurable default
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/misc/guc_parameters.dat#L2207
 * @quote boot_val => '8',
 * @verified 2026-11-20
 */
const workerProcesses = 8

/**
 * The WAL senders PostgreSQL admits, at its default: a member whose replication is not sized holds it.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit server processes
 * @scope a member's max_wal_senders when its replication is PostgreSQL's default, part of the processes its lock table
 *   is sized by (locksPerTransaction)
 * @constraint configurable default
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/misc/guc_parameters.dat#L2189
 * @quote boot_val => '10',
 * @verified 2026-11-20
 */
const defaultWalSenders = 10

/**
 * The prepared transactions PostgreSQL admits, at its default, which a member leaves as it is.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit prepared transactions
 * @scope a member's max_prepared_transactions, part of what its lock table is sized by (locksPerTransaction)
 * @constraint configurable default
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/backend/utils/misc/guc_parameters.dat#L2112
 * @quote boot_val => '0',
 * @verified 2026-11-20
 */
const preparedTransactions = 0

/**
 * The backends PostgreSQL adds beside those its settings count: the autovacuum launcher and the slot sync worker.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit server processes
 * @scope every member's MaxBackends, part of what its lock table is sized by (locksPerTransaction)
 * @constraint protocol constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/storage/proc.h#L520
 * @quote #define NUM_SPECIAL_WORKER_PROCS	2
 * @verified 2026-11-20
 */
const specialWorkerProcesses = 2

/**
 * The predicate locks PostgreSQL's table holds for each predicate lock target it sizes: its PREDICATELOCK hash holds
 * twice as many entries as its PREDICATELOCKTARGET hash, max_pred_locks_per_transaction for each backend and prepared
 * transaction, a fixed size it never grows past (HASH_FIXED_SIZE).
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit predicate locks per predicate lock target
 * @scope every member's predicate lock table, which a read of pg_locks copies whole (lockStatusConnections)
 * @constraint protocol constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/backend/storage/lmgr/predicate.c#L1146
 * @quote max_predicate_locks = max_predicate_lock_targets * 2;
 * @verified 2026-11-21
 */
const predicateLocksPerTarget = 2

/**
 * The bytes a read of pg_locks copies for each predicate lock the member holds: pg_lock_status calls
 * GetPredicateLockStatusData, which pallocs one SERIALIZABLEXACT for every entry of the PREDICATELOCK hash at once
 * (predicate.c#L1399 `data->xacts = palloc_array(SERIALIZABLEXACT, els)`), beside a 16-byte target tag each in an
 * array of its own.
 *
 * @limitKind measured
 * @owner PostgreSQL 19.0 (src/include/storage/predicate_internals.h, SERIALIZABLEXACT)
 * @unit bytes
 * @scope every member's read of pg_locks (lockStatusConnections)
 * @evidence ~/.cache/grizzle-release/TOOLCHAIN6-work/probe/sizes.c, compiled with gcc against the server headers of
 *   the PostgreSQL every member runs (pg_config --includedir-server): sizeof(SERIALIZABLEXACT) 168,
 *   sizeof(PREDICATELOCKTARGETTAG) 16, sizeof(LockInstanceData) 56, MaxAllocSize 1073741823; and the workbench's shared
 *   server at max_connections 10000 refusing `SELECT count(*) FROM pg_locks` with "invalid memory alloc request size
 *   1528354968", which is 168 times 9,097,351, the predicate locks it held then
 * @observed 2026-11-21 13:55 UTC
 * @environment cassowary, Ubuntu 26.04 on arm64 (64-bit pointers), PostgreSQL 19.0 (~/.local/opt/postgresql/19.0)
 * @workload sizeof of the struct; the shared server under every lane's SERIALIZABLE tests
 * @result 168 bytes
 * @decision the size as it is
 * @revalidate a PostgreSQL repin or major version; another architecture; an upstream fix that allocates the arrays
 *   huge (MCXT_ALLOC_HUGE), which lifts the bound
 */
const serializableXactBytes = 168

/**
 * The most a single allocation of PostgreSQL's may ask for, MaxAllocSize: a palloc past it fails ("invalid memory
 * alloc request size"), as GetPredicateLockStatusData's array of SERIALIZABLEXACT does past it.
 *
 * @limitKind published
 * @owner PostgreSQL 19.0
 * @unit bytes
 * @scope every member's read of pg_locks (lockStatusConnections)
 * @constraint protocol constant
 * @source https://github.com/postgres/postgres/blob/REL_19_0/src/include/utils/memutils.h#L40
 * @quote #define MaxAllocSize	((Size) 0x3fffffff)
 * @verified 2026-11-21
 */
const maxAllocBytes = 0x3fffffff

/** A setting as postgresql.conf, ALTER SYSTEM and pg_settings spell it: its name and its value's text. */
export type Setting = readonly [name: string, value: string]

/**
 * The settings every member of every cluster holds exactly, whatever the machine and the repository, each as
 * pg_settings spells it, which `toolchain-pg settle` writes into every member and a run requires of each
 * (pg/settle.ts):
 *
 * - client_connection_check_interval: a running statement polls its client's socket, so a backend whose client died
 *   mid-statement ends at its next poll and lets go of its transaction id (clientCheckInterval).
 * - max_pred_locks_per_relation: production's relation promotion (relationPromotion), whatever the member's room.
 * - track_io_timing: a plan's buffers come with their read times, as the benchmarks read them.
 * - timezone and log_timezone UTC: the machine's time zone never reaches a member, which initdb would take it from.
 * - password_encryption and ssl_min_protocol_version: SCRAM, and TLS 1.3, as every client signs in over TLS (settle.ts's hba).
 */
const everyMember: Arr.NonEmptyReadonlyArray<Setting> = [
	["client_connection_check_interval", `${clientCheckInterval}`],
	["max_pred_locks_per_relation", `${relationPromotion}`],
	["track_io_timing", "on"],
	["TimeZone", "UTC"],
	["log_timezone", "UTC"],
	["password_encryption", "scram-sha-256"],
	["ssl_min_protocol_version", "TLSv1.3"]
]

/**
 * A throwaway member's log_min_messages, as pg_settings spells it (PostgreSQL 19's list: a default level, then a level
 * a process type): client backends from LOG, every other process from PostgreSQL's default, WARNING.
 */
const throwawayLogLevels = "warning, backend:log"

/**
 * The settings a cluster's durability adds (Durability): a throwaway cluster's members never wait for the disk, fsync
 * off, and log what no test provoked; a kept one's keep PostgreSQL's fsync and logging.
 *
 * fsync off: a test database is a clone made for one case and dropped after it (resources/database.ts), and every
 * DROP DATABASE forces a checkpoint it waits for inside its transaction (dbcommands.c dropdb, RequestCheckpoint with
 * CHECKPOINT_WAIT), which with fsync on syncs every file the member wrote since the last one: under a full grizzle run
 * the toolchain's pool measured its take wait at 27 to 47 s at the 90th percentile with fsync on, and 2 ms with it off
 * at a pool depth of 4 (~/.cache/grizzle-release/TESTSYS/RESOURCES/measure/pool); superstarter's network suite took 5.5
 * to 5.6 s with it on and 3.7 to 4.0 s off (2026-11-17, three runs each). No answer a test reads changes: the WAL is
 * still written and its flush pointer still advances past every commit (xlog.c XLogWrite), unlike synchronous_commit =
 * off. What it gives up is a member's survival of a crash of the machine, which a throwaway cluster, made again by its
 * next need, never needs, and a kept one's data does.
 *
 * log_min_messages (throwawayLogLevels) and log_checkpoints off: a throwaway member's log is its unit's journal, and
 * what filled it was a run's own doing, which journald's rate limit then answered by dropping other units' lines (a
 * unit-wait could miss a FAILED line). A client backend's ERROR, WARNING and NOTICE go to its client, the test that
 * provoked it (a refused write, a violated key) and reads it, so the log holds them no longer; every other process keeps
 * PostgreSQL's warning, so a checkpointer's, autovacuum's or WAL sender's error, which no client reads, is still logged,
 * and so are every FATAL and PANIC, a backend's with its statement, and the postmaster's LOG of a child that crashed.
 * Each forced checkpoint (a clone's, by FILE_COPY at fsync off, resources/template.ts) logged two lines;
 * pg_stat_checkpointer counts them still. A kept cluster's log is a person's, who reads their own errors there.
 */
const ofDurability = (durability: Durability): ReadonlyArray<Setting> =>
	durability === "throwaway"
		? [
				["fsync", "off"],
				["log_min_messages", throwawayLogLevels],
				["log_checkpoints", "off"]
			]
		: []

/**
 * The settings a cluster's preloaded libraries add (LocalCluster `preload`), each library inert in every database until
 * one turns it on: shared_preload_libraries names them, in their roster's order; for pg_stat_statements,
 * compute_query_id off, so no statement is jumbled into a query id, and its track `none` and track_planning off, so
 * each of its hooks returns at its first test and it counts nothing. A database that turns it on sets compute_query_id
 * `on`, track `all` and track_planning `on` for itself (ALTER DATABASE ... SET, which the owner may where the cluster's
 * `ownerParameters` name the three), so only the backends of that database count their statements' plans and calls.
 *
 * What a member with it inert costs a test that never turns it on, measured as two same-moment pairs of one ordinary
 * grizzle test file, test/pg/laws/plain-native.test.ts under TEST_SEED=2219874524, run at once from two checkouts of one
 * tree, one family preloading pg_stat_statements inert and one preloading nothing (grizzle lane PROLOGUE, 2026-11-23,
 * cassowary, PostgreSQL 19.0, load average 66 to 136): 18.2 s wall and 16.8 s on the workers beside 18.3 s and 16.9 s,
 * then 30.9 s and 27.7 s beside 30.2 s and 27.2 s. The pairs differ by 0.1 s and 0.7 s (2.5%), while one checkout's two
 * runs differ by 70% with the machine's load: nothing a run can tell.
 */
const preloadSettings = (cluster: LocalCluster): ReadonlyArray<Setting> =>
	Arr.match(cluster.preload, {
		onEmpty: () => [],
		onNonEmpty: (libraries) => [
			["shared_preload_libraries", Arr.join(libraries, ",")],
			["compute_query_id", "off"],
			["pg_stat_statements.track", "none"],
			["pg_stat_statements.track_planning", "off"]
		]
	})

/** The settings every member of `cluster` holds exactly (everyMember, its durability's and its preloads'). */
export const fixedSettings = (cluster: LocalCluster): Arr.NonEmptyReadonlyArray<Setting> =>
	Arr.appendAll(everyMember, [...ofDurability(cluster.durability), ...preloadSettings(cluster)])

/**
 * The members a cluster sized by `sizing` has among `workers` workers: a family's, one or the workers over a member's
 * share, rounded up; a cluster sized by its sessions, one, since it serves no worker.
 */
export const membersOf = (sizing: Sizing, workers: number): number =>
	sizing.kind === "sessions" || sizing.family.kind === "one"
		? 1
		: Math.ceil(workers / sizing.family.workersPerMember)

/**
 * The workers of one run a member serves among `workers` workers on `members` members: the workers over the members,
 * rounded up, worker i on member i mod their count (resources/cluster.ts memberOf).
 */
export const shareOf = (workers: number, members: number): number => Math.ceil(workers / members)

/** The locks a member sized by its sessions holds at once (SessionLocks): none at PostgreSQL's default. */
const heldCount = (locks: SessionLocks): ReadonlyArray<number> =>
	locks.kind === "default" ? [] : [locks.locks]

/** max_connections for `count` connections of the member's users: theirs, and the slots PostgreSQL reserves at their defaults. */
const connectionsFor = (count: number): number =>
	count + superuserReservedConnections + reservedConnections

/** max_connections for `count` connections of the member's users (connectionsFor). */
const maxConnections = (count: number): Setting => ["max_connections", `${connectionsFor(count)}`]

/**
 * max_locks_per_transaction for a lock table that holds `demand` locks at once, on a member of `connections`
 * max_connections and `walSenders` max_wal_senders: PostgreSQL sizes its shared lock table at max_locks_per_transaction
 * entries for each of its backends and prepared transactions (REL_19_0 src/backend/storage/lmgr/lock.c#L59 NLOCKENTS,
 * MaxBackends + max_prepared_transactions; src/backend/utils/init/postinit.c#L571 InitializeMaxBackends, max_connections
 * + autovacuum_worker_slots + max_worker_processes + max_wal_senders + its special workers), so the least count whose
 * table holds the demand, and never fewer than its default.
 */
const locksForDemand = (demand: number, connections: number, walSenders: number): Setting => [
	"max_locks_per_transaction",
	`${Math.max(
		defaultLocksPerTransaction,
		Math.ceil(
			demand /
				(connections +
					autovacuumWorkerSlots +
					workerProcesses +
					walSenders +
					specialWorkerProcesses +
					preparedTransactions)
		)
	)}`
]

/**
 * The most predicate locks a member's table holds for each of its backends, whatever their count: a `perBackend`
 * member's 2048; a `perWorker` member's room is its own, the same at any count, so past the backends that share it a
 * backend's is the least PostgreSQL accepts (predicateLocksFor).
 */
const locksPerBackendOf = (room: PredicateRoom): number =>
	room.kind === "perBackend" ? predicateLocksPerTransaction : minimumPredicateLocks

/**
 * The most connections a member can admit and still answer pg_locks in every state of its predicate lock table: the
 * table holds predicateLocksPerTarget times max_pred_locks_per_transaction entries for each of its backends and prepared
 * transactions (predicate.c NPREDICATELOCKTARGETENTS, MaxBackends + max_prepared_xacts; MaxBackends max_connections +
 * autovacuum_worker_slots + max_worker_processes + max_wal_senders + its special workers), and a read of pg_locks copies
 * a SERIALIZABLEXACT for each entry in one allocation (serializableXactBytes), which must stay within MaxAllocSize
 * (maxAllocBytes); `locksPerBackend` is the most a backend's share of the table is (locksPerBackendOf).
 * `sendersPerConnection` is 1 where every connection is also a WAL sender (replication sized as a capacity) and 0 where
 * the member keeps PostgreSQL's default senders. At grizzle's 2048 predicate locks a member holds 1,560 backends at
 * most: 765 connections with a sender each, 1,521 without; at a room's 10 a backend, 319,566, which no memory's capacity
 * reaches. A room's own targets stay within what a read copies while 2 times them, times 168 bytes, is under 1 GB: 3.19
 * million targets. A cluster sized by its sessions states its own few (a developer's), which this bound leaves as they
 * are.
 */
const lockStatusConnections = (locksPerBackend: number, sendersPerConnection: 0 | 1): number => {
	const backends = Math.floor(
		maxAllocBytes / (predicateLocksPerTarget * locksPerBackend * serializableXactBytes)
	)
	const others =
		superuserReservedConnections +
		reservedConnections +
		autovacuumWorkerSlots +
		workerProcesses +
		(sendersPerConnection === 1 ? 0 : defaultWalSenders) +
		specialWorkerProcesses +
		preparedTransactions
	return widthOf((backends - others) / (1 + sendersPerConnection))
}

/**
 * The connections a member admits as a capacity of the machine (spec.ts Capacity): the machine's memory, `machineBytes`,
 * over a busy backend's, `backendBytes`, shared among the cluster's `members`, rounded down, one at least, and never more
 * than a read of pg_locks can hold at the member's room (lockStatusConnections), `sendersPerConnection` saying whether
 * each is a WAL sender too.
 */
const capacityOf = (
	machineBytes: number,
	backendBytes: number,
	members: number,
	room: PredicateRoom,
	sendersPerConnection: 0 | 1
): number =>
	Math.min(
		lockStatusConnections(locksPerBackendOf(room), sendersPerConnection),
		widthOf(machineBytes / (backendBytes * members))
	)

/**
 * max_pred_locks_per_transaction of a member of `room` serving `share` workers and sizing its predicate lock table for
 * `backends` backends and prepared transactions (PostgreSQL sizes it at max_pred_locks_per_transaction targets for each,
 * predicate.c NPREDICATELOCKTARGETENTS): a `perBackend` member's 2048; a `perWorker` member's, the least count whose table
 * holds its room, `share` times the room a worker, and never fewer than PostgreSQL accepts.
 */
const predicateLocksFor = (room: PredicateRoom, share: number, backends: number): Setting => [
	"max_pred_locks_per_transaction",
	`${
		room.kind === "perBackend"
			? predicateLocksPerTransaction
			: Math.max(minimumPredicateLocks, Math.ceil((share * room.targets) / backends))
	}`
]

/**
 * The settings that size a member of `cluster`, one of `members`, on a machine of `machineBytes` of memory and a server
 * of `blockSize` bytes a page. A member sized for workers admits connections up to its capacity (capacityOf), every
 * one of them also a replication slot and a WAL sender where its replication is a capacity, and never more than a read
 * of pg_locks holds (lockStatusConnections); holds a predicate lock table of its room (predicateLocksFor) for the
 * backends its connections and senders make; holds shared_buffers in pages for every page a run's workers on it read,
 * `share` workers (shareOf); and holds max_locks_per_transaction at the most one transaction takes, never fewer than
 * PostgreSQL's default, since its table holds that many for every backend at once. A count the repository states no
 * evidence for stays PostgreSQL's default. A member sized by its sessions holds max_connections for them alone,
 * production's predicate locks for each, a lock table for the locks they hold at once, and the rest at PostgreSQL's
 * defaults.
 */
export const sizedSettings = (
	cluster: LocalCluster,
	members: number,
	share: number,
	machineBytes: number,
	blockSize: number
): ReadonlyArray<Setting> => {
	const { sizing } = cluster
	if (sizing.kind === "sessions") {
		return [
			maxConnections(sizing.sessions),
			["max_pred_locks_per_transaction", `${predicateLocksPerTransaction}`],
			...Arr.map(heldCount(sizing.locks), (demand) =>
				locksForDemand(demand, connectionsFor(sizing.sessions), defaultWalSenders)
			)
		]
	}
	const { connections, replication, sharedBuffers, locks, predicateLocks } = sizing
	const admitted = capacityOf(
		machineBytes,
		connections.backendBytes,
		members,
		predicateLocks,
		replication.kind === "capacity" ? 1 : 0
	)
	const backends =
		connectionsFor(admitted) +
		autovacuumWorkerSlots +
		workerProcesses +
		(replication.kind === "capacity" ? admitted : defaultWalSenders) +
		specialWorkerProcesses +
		preparedTransactions
	return [
		maxConnections(admitted),
		predicateLocksFor(predicateLocks, share, backends),
		...(replication.kind === "capacity"
			? ([
					["max_replication_slots", `${admitted}`],
					["max_wal_senders", `${admitted}`]
				] satisfies ReadonlyArray<Setting>)
			: []),
		...(sharedBuffers.kind === "default"
			? []
			: [
					[
						"shared_buffers",
						`${share * Math.ceil(sharedBuffers.bytes / blockSize)}`
					] satisfies Setting
				]),
		...(locks.kind === "default"
			? []
			: [
					[
						"max_locks_per_transaction",
						`${Math.max(defaultLocksPerTransaction, locks.locks)}`
					] satisfies Setting
				])
	]
}

/** A setting as postgresql.conf and ALTER SYSTEM write it: its value quoted, which PostgreSQL reads for every type. */
export const settingLine = ([name, value]: Setting): string =>
	`${name} = '${Str.replaceAll("'", "''")(value)}'`
