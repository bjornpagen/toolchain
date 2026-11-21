import { Array as Arr, String as Str } from "effect"
import type { Durability, LocalCluster, SessionLocks, Sizing } from "#pg/spec.ts"

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
 * @owner the toolchain's local clusters (pg/make.ts), from grizzle's (packages/pg/src/settings.ts at a5dd3588d) and
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
 * grizzle's recommendation to an operator, which production holds, so a test's SERIALIZABLE transactions promote and
 * run out of room where production's would.
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

/** A setting as postgresql.conf, ALTER SYSTEM and pg_settings spell it: its name and its value's text. */
export type Setting = readonly [name: string, value: string]

/**
 * The settings every member of every cluster holds exactly, whatever the machine and the repository, each as
 * pg_settings spells it, which make.ts writes into every member, `init --adopt` gives each it keeps, and the doctor
 * requires of each:
 *
 * - client_connection_check_interval: a running statement polls its client's socket, so a backend whose client died
 *   mid-statement ends at its next poll and lets go of its transaction id (clientCheckInterval).
 * - max_pred_locks_per_transaction: production's predicate locks, whose relation promotion PostgreSQL's default
 *   max_pred_locks_per_relation of -2 derives from it as production's does (2048 / 2 - 1, predicate.c
 *   MaxPredicateChildLocks).
 * - track_io_timing: a plan's buffers come with their read times, as the benchmarks read them.
 * - timezone and log_timezone UTC: the machine's time zone never reaches a member, which initdb would take it from.
 * - password_encryption and ssl_min_protocol_version: SCRAM, and TLS 1.3, as every client signs in (make.ts's hba).
 */
const everyMember: Arr.NonEmptyReadonlyArray<Setting> = [
	["client_connection_check_interval", `${clientCheckInterval}`],
	["max_pred_locks_per_transaction", `${predicateLocksPerTransaction}`],
	["track_io_timing", "on"],
	["TimeZone", "UTC"],
	["log_timezone", "UTC"],
	["password_encryption", "scram-sha-256"],
	["ssl_min_protocol_version", "TLSv1.3"]
]

/**
 * The settings a cluster's durability adds (Durability): a throwaway cluster's members never wait for the disk, fsync
 * off; a kept one's keep PostgreSQL's fsync.
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
 */
const ofDurability = (durability: Durability): ReadonlyArray<Setting> =>
	durability === "throwaway" ? [["fsync", "off"]] : []

/** The settings every member of `cluster` holds exactly (everyMember, and its durability's). */
export const fixedSettings = (cluster: LocalCluster): Arr.NonEmptyReadonlyArray<Setting> =>
	Arr.appendAll(everyMember, ofDurability(cluster.durability))

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
 * The connections a member admits as a capacity of the machine (spec.ts Capacity): the machine's memory, `machineBytes`,
 * over a busy backend's, `backendBytes`, shared among the cluster's `members`, rounded down, one at least.
 */
const capacityOf = (machineBytes: number, backendBytes: number, members: number): number =>
	Math.max(1, Math.floor(machineBytes / (backendBytes * members)))

/**
 * The settings that size a member of `cluster`, one of `members`, on a machine of `machineBytes` of memory and a server
 * of `blockSize` bytes a page. A member sized for workers admits connections up to its capacity (capacityOf), every
 * one of them also a replication slot and a WAL sender where its replication is a capacity; holds shared_buffers in
 * pages for every page a run's workers on it read, `share` workers (shareOf); and holds max_locks_per_transaction at
 * the most one transaction takes, never fewer than PostgreSQL's default, since its table holds that many for every
 * backend at once. A count the repository states no evidence for stays PostgreSQL's default. A member sized by its
 * sessions holds max_connections for them alone, a lock table for the locks they hold at once, and the rest at
 * PostgreSQL's defaults.
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
			...Arr.map(heldCount(sizing.locks), (demand) =>
				locksForDemand(demand, connectionsFor(sizing.sessions), defaultWalSenders)
			)
		]
	}
	const { connections, replication, sharedBuffers, locks } = sizing
	const admitted = capacityOf(machineBytes, connections.backendBytes, members)
	return [
		maxConnections(admitted),
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
