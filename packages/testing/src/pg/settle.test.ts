/**
 * A cluster's family at a checkout as units of the workbench's PostgreSQL (pg/settle.ts): `settled` starts each
 * member's unit and gives it what its spec states, and `membersRead`, what a run reads, then answers every member, over
 * its socket or over TLS at a port its family claims; a member a setting of which was changed behind the spec's back,
 * or that ALTER SYSTEM gave a setting the spec does not state, is refused, naming `toolchain-pg settle`, and settled
 * again, the unstated setting reset; a settled member promotes a relation's predicate locks where production does,
 * whatever its room, and its predicate lock table stays one a read of pg_locks can copy (settings.ts
 * lockStatusConnections); a run that reads a family never settled is refused at once, starting no unit and writing no
 * state; a member whose port another listener took while it was stopped is refused by its settle before its unit
 * starts, the settle naming that listener's process, and settled once the listener is gone; and a case cluster the
 * process that drew it left as it ended is removed as the next case draws its own, where one a live case holds is
 * kept. Each case's cluster is a unit name of its own, its family at a checkout of the case's own, its units stopped
 * and its data, claims and state removed when the case ends. Oracle: the specification, stated in the checks.
 */
import { Array as Arr, Effect, FileSystem, Option, String as Str } from "effect"
import { assert } from "#assert.ts"
import { boolean, finite } from "#gen.ts"
import { portsHeld } from "#pg/family.ts"
import { adminSql, serverBin } from "#pg/server.ts"
import {
	clusterOf,
	dataOf,
	failedOf,
	familyIn,
	holdTaken,
	leftCluster,
	lefts,
	memberStopped,
	portHeldHere,
	presenceOf,
	removedAtEnd,
	shapes,
	unitActive
} from "#pg/settle.fixtures.ts"
import { memberNames, membersRead, settled } from "#pg/settle.ts"
import { property } from "#property.ts"

export const settledAsItsSpec = property.exhaust(finite(shapes), {
	box: "a cluster's family over its socket or over TLS, of one member or two, its predicate room production's a backend or its workers'",
	needs: {},
	situations: [],
	check: () => (shape) =>
		Effect.scoped(
			Effect.gen(function* () {
				const cluster = yield* clusterOf(shape)
				yield* removedAtEnd(cluster)
				const family = yield* familyIn(cluster)
				const members = yield* settled(family)
				const read = yield* membersRead(family)
				const claims = yield* portsHeld(family)
				const first = Arr.headNonEmpty(read)
				const bin = yield* serverBin({ cluster: family.name, doing: "the property" })
				yield* adminSql(
					bin,
					{ socket: first.socket, port: first.port },
					"postgres",
					[
						"ALTER SYSTEM SET client_connection_check_interval = '2000'",
						"SELECT pg_catalog.pg_reload_conf()"
					],
					{ cluster: family.name, doing: "changing a setting behind the spec's back" }
				)
				const refusedAfterChange = yield* failedOf(membersRead(family))
				yield* settled(family)
				const readAgain = yield* membersRead(family)
				yield* adminSql(
					bin,
					{ socket: first.socket, port: first.port },
					"postgres",
					["ALTER SYSTEM SET work_mem = '7MB'", "SELECT pg_catalog.pg_reload_conf()"],
					{ cluster: family.name, doing: "writing a setting its spec does not state" }
				)
				const [lockStatus = ""] = yield* adminSql(
					bin,
					{ socket: first.socket, port: first.port },
					"postgres",
					[
						"SELECT 2 * current_setting('max_pred_locks_per_transaction')::bigint * (current_setting('max_connections')::bigint + current_setting('autovacuum_worker_slots')::bigint + current_setting('max_worker_processes')::bigint + current_setting('max_wal_senders')::bigint + 2 + current_setting('max_prepared_transactions')::bigint) * 168 <= 1073741823"
					],
					{ cluster: family.name, doing: "reading its predicate lock table's size" }
				)
				const [promotion = ""] = yield* adminSql(
					bin,
					{ socket: first.socket, port: first.port },
					"postgres",
					[
						"SELECT CASE WHEN current_setting('max_pred_locks_per_relation')::int >= 0 THEN current_setting('max_pred_locks_per_relation')::int ELSE current_setting('max_pred_locks_per_transaction')::int / -current_setting('max_pred_locks_per_relation')::int - 1 END"
					],
					{ cluster: family.name, doing: "reading its relation promotion" }
				)
				const refusedAfterUnstated = yield* failedOf(membersRead(family))
				yield* settled(family)
				const unstatedLeft = yield* adminSql(
					bin,
					{ socket: first.socket, port: first.port },
					"postgres",
					[
						"SELECT name FROM pg_catalog.pg_file_settings WHERE sourcefile = pg_catalog.current_setting('data_directory') || '/postgresql.auto.conf' AND name = 'work_mem'"
					],
					{ cluster: family.name, doing: "reading what ALTER SYSTEM holds" }
				)
				const { network } = cluster
				const ports = Arr.map(memberNames(family), (_, index) =>
					network.kind === "tls" ? Arr.get(claims, index) : Option.some(5432)
				)
				assert.deepEqual(
					{
						settled: Arr.map(members, (member) => [
							member.name,
							Option.some(member.port),
							member.tls.kind
						]),
						read: Arr.map(read, (member) => [
							member.name,
							Option.some(member.port),
							member.tls.kind
						]),
						claims: claims.length,
						claimedFromItsFirst: Arr.every(
							claims,
							(port) => network.kind === "tls" && port >= network.from
						),
						names: memberNames(family).length,
						refusedAfterChange,
						readAgain: readAgain.length,
						refusedAfterUnstated,
						unstatedLeft,
						lockStatusFits: lockStatus,
						promotion
					},
					{
						settled: Arr.map(memberNames(family), (name, index) => [
							name,
							Arr.getUnsafe(ports, index),
							network.kind
						]),
						read: Arr.map(memberNames(family), (name, index) => [
							name,
							Arr.getUnsafe(ports, index),
							network.kind
						]),
						claims: network.kind === "tls" ? memberNames(family).length : 0,
						claimedFromItsFirst: true,
						names: shape.spread ? 2 : 1,
						refusedAfterChange: true,
						readAgain: shape.spread ? 2 : 1,
						refusedAfterUnstated: true,
						unstatedLeft: [],
						lockStatusFits: "t",
						promotion: "1023"
					}
				)
			})
		),
	oracle: {
		kind: "specification",
		name: "a settled cluster's members are read as its spec states them, each its unit's, at its port; one changed behind the spec's back, or given a setting its spec does not state, is refused, and settled again, the unstated setting reset; and its predicate lock table, copied whole by a read of pg_locks, a SERIALIZABLEXACT of 168 bytes an entry, stays within PostgreSQL's 1 GB allocation"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/pg/settle.ts",
			original:
				'\t\t\t\t\treturn actual === value ? [] : [{ kind: "held", name, expected: value, actual }]\n',
			replacement: "\t\t\t\t\treturn []\n",
			why: "A run reads a member whatever its settings, so one a person changed behind the spec's back serves the run as if it held its spec; the property fails, the changed member read."
		},
		{
			file: "packages/testing/src/pg/settle.ts",
			original: "\t\t? `ALTER SYSTEM SET ${settingLine(\n",
			replacement: "\t\t? `SELECT 1 -- ${settingLine(\n",
			why: "Settling writes none of the spec's settings, so its members keep the unit's defaults and a run refuses them; the property fails, the settle's own read refused."
		},
		{
			file: "packages/testing/src/pg/settle.ts",
			original: `\t\t: \`ALTER SYSTEM RESET \${settingName(drift.name)}\`\n`,
			replacement: `\t\t: \`SELECT 1 -- \${settingName(drift.name)}\`\n`,
			why: "Settling leaves a setting ALTER SYSTEM wrote that the spec no longer states, so a reused member keeps what a spec of before or a person gave it (GRIZZLEPG, 2026-11-21: a kill that dropped a setting from the spec survived on a long-lived cluster); the property fails, the settle's own read refused."
		},
		{
			file: "packages/testing/src/pg/settings.ts",
			original: "\t\tlockStatusConnections(locksPerBackendOf(room), sendersPerConnection),\n",
			replacement: "\t\tNumber.POSITIVE_INFINITY,\n",
			why: "A member admits as many connections as the machine's memory holds, as it did: the test cluster's member, at thousands of connections, holds a predicate lock table a read of pg_locks cannot copy in one allocation (the shared server at 10,000 refused pg_locks, 2026-11-21: 168 bytes times 9,097,351 predicate locks); the property fails."
		}
	]
})

export const unsettledStartsNothing = property.exhaust(finite(shapes), {
	box: "a cluster's family never settled, over its socket or over TLS, of one member or two",
	needs: {},
	situations: [],
	check: () => (shape) =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const cluster = yield* clusterOf(shape)
				yield* removedAtEnd(cluster)
				const family = yield* familyIn(cluster)
				const refused = yield* failedOf(membersRead(family))
				const active = yield* Effect.forEach(memberNames(family), unitActive)
				const data = yield* Effect.forEach(memberNames(family), (name) =>
					Effect.flatMap(dataOf(name), (directory) => fs.exists(directory))
				)
				assert.deepEqual(
					{ refused, active, data },
					{
						refused: true,
						active: Arr.map(memberNames(family), () => false),
						data: Arr.map(memberNames(family), () => false)
					}
				)
			})
		),
	oracle: {
		kind: "specification",
		name: "a run that reads a family never settled is refused, and no member's unit is started or made"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/pg/settle.ts",
			original: "\t\tconst keptPassword = yield* readIfThere(files.password)\n",
			replacement:
				'\t\tyield* Effect.forEach(memberNames(family), (name) => systemctl("start", name, step), { discard: true })\n\t\tconst keptPassword = yield* readIfThere(files.password)\n',
			why: "A run's read starts each member's unit, as the old harness's need made and started its cluster, so a run changes a server every run shares; the property fails, the units started."
		}
	]
})

export const aHeldPortRefusesItsSettle = property.exhaust(finite(boolean), {
	box: "a settled family over TLS of one member or two, its last member stopped and its port taken by a listener of the case's process",
	needs: {},
	situations: [],
	check: () => (spread) =>
		Effect.scoped(
			Effect.gen(function* () {
				const cluster = yield* clusterOf({ tls: true, spread, room: true })
				yield* removedAtEnd(cluster)
				const family = yield* familyIn(cluster)
				yield* settled(family)
				const name = Arr.lastNonEmpty(memberNames(family))
				const claims = yield* portsHeld(family)
				const port = Arr.getUnsafe(claims, claims.length - 1)
				yield* memberStopped(name)
				const refusal = yield* Effect.scoped(
					Effect.andThen(portHeldHere(port), Effect.flip(settled(family)))
				)
				const startedUnder = yield* unitActive(name)
				const read = yield* settled(family)
				assert.deepEqual(
					{
						namesThePort: Str.includes(`its port ${port}`)(refusal.message),
						namesTheHolder: Str.includes(`(pid ${process.pid})`)(refusal.message),
						startedUnder,
						settledOnceGone: Arr.map(read, (member) => [member.name, member.port])
					},
					{
						namesThePort: true,
						namesTheHolder: true,
						startedUnder: false,
						settledOnceGone: Arr.map(memberNames(family), (member, index) => [
							member,
							Arr.getUnsafe(claims, index)
						])
					}
				)
			})
		),
	oracle: {
		kind: "specification",
		name: "a member whose claimed port another listener holds is refused by its settle before its unit starts, the refusal naming the port and the holder's process, and its family settled at the same ports once the listener is gone"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/pg/settle.ts",
			original: '\t\t\t(holder) => holder.kind === "unseen" || holder.unit !== unitOf(name)\n',
			replacement: "\t\t\t() => false\n",
			why: "A settle starts a member whatever holds its port, as before families' claims were checked, so its server fails to bind the port another listener took and the settle reports only that its unit failed to start, naming no holder; the property fails, the holder unnamed."
		},
		{
			file: "packages/testing/src/pg/settle.ts",
			original: '\t\t\t(holder) => holder.kind === "unseen" || holder.unit !== unitOf(name)\n',
			replacement: "\t\t\t() => true\n",
			why: "A settle counts its member's own server as another holder, so every settle of a running family refuses it; the property fails, the family never settled again once the listener is gone."
		}
	]
})

export const leftClustersSwept = property.exhaust(finite(lefts), {
	box: "a settled cluster of one member or two, over its socket, the process that drew it alive or ended",
	needs: {},
	situations: [],
	check: () => (left) =>
		Effect.scoped(
			Effect.gen(function* () {
				const family = yield* leftCluster(left)
				yield* clusterOf({ tls: false, spread: left.spread, room: true })
				const hold = yield* holdTaken(family.cluster.unit)
				const claimed = Option.isNone(hold)
				const present = yield* presenceOf(family)
				assert.deepEqual(
					{
						leftUnheld: Arr.some(present, Boolean) && !claimed,
						keptWhole: left.alive && Arr.every(present, Boolean)
					},
					{ leftUnheld: false, keptWhole: left.alive }
				)
			})
		),
	oracle: {
		kind: "specification",
		name: "once the next case draws its cluster, no case cluster is left that no process holds (gone, or held by a sweep still removing it), and one its live case holds is kept whole: each member's unit active and its data there"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/pg/settle.fixtures.ts",
			original:
				"\t\t\t\t\tEffect.when(clusterRemoved(unit), Effect.succeed(Option.isSome(hold)))\n",
			replacement: "\t\t\t\t\tEffect.when(Effect.void, Effect.succeed(Option.isSome(hold)))\n",
			why: "Drawing a cluster removes none a process left, so a worker ended mid-case leaves its servers running until a person stops them (lane TOOLCHAIN6's stopped runs left four, 2026-11-21); the property fails, the ended case's cluster left."
		},
		{
			file: "packages/testing/src/pg/settle.fixtures.ts",
			original:
				"\t\t\t\t\tEffect.when(clusterRemoved(unit), Effect.succeed(Option.isSome(hold)))\n",
			replacement: "\t\t\t\t\tclusterRemoved(unit)\n",
			why: "A sweep removes every case cluster it finds, held or not, so a case's draw stops another live case's servers under it; the property fails, the live case's cluster removed."
		},
		{
			file: "packages/testing/src/pg/settle.fixtures.ts",
			original: "\t\tconst hold = yield* holdTaken(unit)\n",
			replacement: "\t\tconst hold = Option.some(unit)\n",
			why: "A case's cluster is held by no process, so the next case's sweep takes it for one left and removes it while its case runs; the property fails, the live case's cluster removed."
		}
	]
})
