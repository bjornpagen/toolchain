/**
 * A cluster as units of the workbench's PostgreSQL (pg/settle.ts): `settled` starts each member's unit and gives it what
 * its spec states, and `membersRead`, what a run reads, then answers every member, over its socket or over TLS at its
 * port; a member a setting of which was changed behind the spec's back, or that ALTER SYSTEM gave a setting the spec
 * does not state, is refused, naming `toolchain-pg settle`, and settled again, the unstated setting reset; a settled
 * member's predicate lock table stays one a read of pg_locks can copy (settings.ts lockStatusConnections); and a run
 * that reads a cluster never settled is refused at once, starting no unit and writing no state.
 * Each case's cluster is a unit name of its own, its units stopped and its data removed when the case ends. Oracle: the
 * specification, stated in the checks.
 */
import { Array as Arr, Effect, FileSystem } from "effect"
import { assert } from "#assert.ts"
import { finite } from "#gen.ts"
import { adminSql, serverBin } from "#pg/server.ts"
import {
	clusterOf,
	dataOf,
	failedOf,
	removedAtEnd,
	shapes,
	unitActive
} from "#pg/settle.fixtures.ts"
import { memberNames, membersRead, settled } from "#pg/settle.ts"
import { property } from "#property.ts"

export const settledAsItsSpec = property.exhaust(finite(shapes), {
	box: "a cluster over its socket or over TLS, of one member or two",
	needs: {},
	situations: [],
	check: () => (shape) =>
		Effect.scoped(
			Effect.gen(function* () {
				const cluster = yield* clusterOf(shape)
				yield* removedAtEnd(cluster)
				const members = yield* settled(cluster)
				const read = yield* membersRead(cluster)
				const first = Arr.headNonEmpty(read)
				const bin = yield* serverBin({ cluster: cluster.unit, doing: "the property" })
				yield* adminSql(
					bin,
					{ socket: first.socket, port: first.port },
					"postgres",
					[
						"ALTER SYSTEM SET client_connection_check_interval = '2000'",
						"SELECT pg_catalog.pg_reload_conf()"
					],
					{ cluster: cluster.unit, doing: "changing a setting behind the spec's back" }
				)
				const refusedAfterChange = yield* failedOf(membersRead(cluster))
				yield* settled(cluster)
				const readAgain = yield* membersRead(cluster)
				yield* adminSql(
					bin,
					{ socket: first.socket, port: first.port },
					"postgres",
					["ALTER SYSTEM SET work_mem = '7MB'", "SELECT pg_catalog.pg_reload_conf()"],
					{ cluster: cluster.unit, doing: "writing a setting its spec does not state" }
				)
				const [lockStatus = ""] = yield* adminSql(
					bin,
					{ socket: first.socket, port: first.port },
					"postgres",
					[
						"SELECT 2 * current_setting('max_pred_locks_per_transaction')::bigint * (current_setting('max_connections')::bigint + current_setting('autovacuum_worker_slots')::bigint + current_setting('max_worker_processes')::bigint + current_setting('max_wal_senders')::bigint + 2 + current_setting('max_prepared_transactions')::bigint) * 168 <= 1073741823"
					],
					{ cluster: cluster.unit, doing: "reading its predicate lock table's size" }
				)
				const refusedAfterUnstated = yield* failedOf(membersRead(cluster))
				yield* settled(cluster)
				const unstatedLeft = yield* adminSql(
					bin,
					{ socket: first.socket, port: first.port },
					"postgres",
					[
						"SELECT name FROM pg_catalog.pg_file_settings WHERE sourcefile = pg_catalog.current_setting('data_directory') || '/postgresql.auto.conf' AND name = 'work_mem'"
					],
					{ cluster: cluster.unit, doing: "reading what ALTER SYSTEM holds" }
				)
				assert.deepEqual(
					{
						settled: Arr.map(members, (member) => [member.name, member.port, member.tls.kind]),
						read: Arr.map(read, (member) => [member.name, member.port, member.tls.kind]),
						names: memberNames(cluster).length,
						refusedAfterChange,
						readAgain: readAgain.length,
						refusedAfterUnstated,
						unstatedLeft,
						lockStatusFits: lockStatus
					},
					{
						settled: Arr.map(memberNames(cluster), (name, index) => [
							name,
							cluster.network.kind === "tls" ? cluster.network.port + index : 5432,
							cluster.network.kind
						]),
						read: Arr.map(memberNames(cluster), (name, index) => [
							name,
							cluster.network.kind === "tls" ? cluster.network.port + index : 5432,
							cluster.network.kind
						]),
						names: shape.spread ? 2 : 1,
						refusedAfterChange: true,
						readAgain: shape.spread ? 2 : 1,
						refusedAfterUnstated: true,
						unstatedLeft: [],
						lockStatusFits: "t"
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
			original: "\t\tlockStatusConnections(sendersPerConnection),\n",
			replacement: "\t\tNumber.POSITIVE_INFINITY,\n",
			why: "A member admits as many connections as the machine's memory holds, as it did: the test cluster's member, at thousands of connections, holds a predicate lock table a read of pg_locks cannot copy in one allocation (the shared server at 10,000 refused pg_locks, 2026-11-21: 168 bytes times 9,097,351 predicate locks); the property fails."
		}
	]
})

export const unsettledStartsNothing = property.exhaust(finite(shapes), {
	box: "a cluster never settled, over its socket or over TLS, of one member or two",
	needs: {},
	situations: [],
	check: () => (shape) =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const cluster = yield* clusterOf(shape)
				yield* removedAtEnd(cluster)
				const refused = yield* failedOf(membersRead(cluster))
				const active = yield* Effect.forEach(memberNames(cluster), unitActive)
				const data = yield* Effect.forEach(memberNames(cluster), (name) =>
					Effect.flatMap(dataOf(name), (directory) => fs.exists(directory))
				)
				assert.deepEqual(
					{ refused, active, data },
					{
						refused: true,
						active: Arr.map(memberNames(cluster), () => false),
						data: Arr.map(memberNames(cluster), () => false)
					}
				)
			})
		),
	oracle: {
		kind: "specification",
		name: "a run that reads a cluster never settled is refused, and no member's unit is started or made"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/pg/settle.ts",
			original: "\t\tconst keptPassword = yield* readIfThere(files.password)\n",
			replacement:
				'\t\tyield* Effect.forEach(memberNames(cluster), (name) => systemctl("start", name, step), { discard: true })\n\t\tconst keptPassword = yield* readIfThere(files.password)\n',
			why: "A run's read starts each member's unit, as the old harness's need made and started its cluster, so a run changes a server every run shares; the property fails, the units started."
		}
	]
})
