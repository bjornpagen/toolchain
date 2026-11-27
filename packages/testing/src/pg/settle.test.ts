/**
 * A cluster's family at a checkout as units of the workbench's PostgreSQL (pg/settle.ts): a settle starts a member's
 * unit and gives it what its spec states, and a read, what a run reads, then answers every member, over its socket or
 * over TLS at a port its family claims; a member a setting of which was changed behind the spec's back, or that ALTER
 * SYSTEM gave a setting the spec does not state, is refused, naming `toolchain-pg settle`, and settled again, the
 * unstated setting reset; a settled member promotes a relation's predicate locks where production does, whatever its
 * room, and its predicate lock table stays one a read of pg_locks can copy (settings.ts lockStatusConnections); a read
 * starts nothing, a family never settled refused at once with no unit started and no state written, and a worker's
 * first need starts only its own member (memberBroughtUp); a member whose port another listener took while it was
 * stopped is refused by its settle before its unit starts, the settle naming that listener's process, and settled once
 * the listener is gone; and a case cluster the process that drew it left as it ended is removed as the next case draws
 * its own, where one a live case holds is kept; a family settled for one run's width and reached by a run of another is
 * refused by every read until that run's first need settles it at its own width, its state and each member it reaches,
 * where it would have been refused for good or read as the other width's, and a family's settle unit settles at the
 * width it is given, never at the width of its own place; and every session of a settled member loads each library its
 * cluster preloads, inert, a database that sets session_preload_libraries off opening its sessions without the libraries
 * loaded by session, and the owner's database holds the extension of each that has one. Each case holds its family while it reads it (hold.ts
 * familyHeld), as a run's worker does, so the members its settles start stay up for its reads. Each case's cluster is a
 * unit name of its own, its family at a checkout of the case's own, its units stopped and its data, claims and state
 * removed when the case ends. Oracle: the specification, stated in the checks.
 */
import {
	Array as Arr,
	Effect,
	Exit,
	FileSystem,
	Option,
	Order,
	Record as Rec,
	Scope,
	String as Str
} from "effect"
import { assert } from "#assert.ts"
import { boolean, finite, int } from "#gen.ts"
import { Checkout } from "#mutate/checkout.ts"
import { familyOf, memberNames, portsHeld, stateWidth } from "#pg/family.ts"
import { familyHeld } from "#pg/hold.ts"
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
	postmasterOf,
	presenceOf,
	joinedSettler,
	keptCases,
	keptCluster,
	keptLocks,
	loadedProbes,
	preloadCluster,
	preloads,
	removedAtEnd,
	settledAsItsUnit,
	settledWhole,
	shapes,
	unitActive,
	widthCases,
	widthCluster,
	widths
} from "#pg/settle.fixtures.ts"
import {
	familySettled,
	memberAtPort,
	memberBroughtUp,
	memberRead,
	memberSettled,
	membersRunning,
	processSettler,
	settled
} from "#pg/settle.ts"
import { factsOf, type PreloadedLibrary } from "#pg/spec.ts"
import { property } from "#property.ts"
import { testWorkers } from "#workers.ts"

export const settledAsItsSpec = property.exhaust(finite(shapes), {
	box: "a cluster's family over its socket or over TLS, of one member or two, its predicate room production's a backend or its workers'",
	needs: {},
	situations: [],
	check: () => (shape) =>
		Effect.scoped(
			Effect.gen(function* () {
				const cluster = yield* clusterOf(shape)
				yield* removedAtEnd(cluster)
				const family = yield* familyIn(cluster, testWorkers)
				const members = yield* settledWhole(family)
				const read = yield* membersRunning(family)
				const atPorts = yield* Effect.forEach(read, (member) => memberAtPort(family, member.port))
				const claims = yield* portsHeld(family)
				const first = Arr.headNonEmpty(members)
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
				const refusedAfterChange = yield* failedOf(memberRead(family, 0))
				yield* settled(family, processSettler)
				const readAgain = yield* membersRunning(family)
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
				const refusedAfterUnstated = yield* failedOf(memberRead(family, 0))
				yield* settled(family, processSettler)
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
						atPorts: Arr.map(atPorts, (member) => member.name),
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
						atPorts: Arr.map(memberNames(family), (name) =>
							network.kind === "tls" ? name : Arr.headNonEmpty(memberNames(family))
						),
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
		name: "a settled cluster's members are read as its spec states them, each its unit's, at its port, and each read alone by its port; one changed behind the spec's back, or given a setting its spec does not state, is refused, and settled again, the unstated setting reset; and its predicate lock table, copied whole by a read of pg_locks, a SERIALIZABLEXACT of 168 bytes an entry, stays within PostgreSQL's 1 GB allocation"
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
			original:
				"\t\t\tEffect.fromOption(Arr.findFirstIndex(state.members, ([, held]) => held === port)),\n",
			replacement: "\t\t\tEffect.fromOption(Arr.findFirstIndex(state.members, () => true)),\n",
			why: "A process lent a member by its port reaches the family's first member whatever the port, so a command line child of a case on member 1 opens its sessions on member 0, under another worker's budget; the property fails, the second member's port answered by the first."
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

export const eachPreloadedLibraryLoadsItsWay = property.exhaust(finite(preloads), {
	box: "a cluster of one member over its socket preloading each subset of the libraries a cluster may preload",
	needs: {},
	situations: [],
	check: () => (preload) =>
		Effect.scoped(
			Effect.gen(function* () {
				const cluster = yield* preloadCluster(preload)
				yield* removedAtEnd(cluster)
				const family = yield* familyIn(cluster, testWorkers)
				const members = yield* settledWhole(family)
				const first = Arr.headNonEmpty(members)
				const bin = yield* serverBin({ cluster: family.name, doing: "the property" })
				const at = { socket: first.socket, port: first.port }
				const probes = Rec.toEntries(loadedProbes)
				const probed = (database: string) =>
					adminSql(
						bin,
						at,
						database,
						Arr.prepend(
							Arr.map(probes, ([, probe]) => `SELECT coalesce(${probe.read}, '(absent)')`),
							"SELECT pg_catalog.current_database()"
						),
						{ cluster: family.name, doing: `reading what a session in ${database} loaded` }
					)
				const everywhere = yield* probed("postgres")
				yield* adminSql(
					bin,
					at,
					"postgres",
					[
						"CREATE DATABASE toolchain_preload_off",
						"ALTER DATABASE toolchain_preload_off SET session_preload_libraries = NULL"
					],
					{ cluster: family.name, doing: "making a database that sets its sessions' libraries off" }
				)
				const sessionsOff = yield* probed("toolchain_preload_off")
				const extensions = yield* adminSql(
					bin,
					at,
					cluster.owner,
					[
						"SELECT coalesce(pg_catalog.string_agg(extname, ',' ORDER BY extname), '(none)') FROM pg_catalog.pg_extension WHERE extname <> 'plpgsql'"
					],
					{ cluster: family.name, doing: "reading the owner's database's extensions" }
				)
				const chosen = (library: PreloadedLibrary) => Arr.contains(preload, library)
				assert.deepEqual(
					{ everywhere, sessionsOff, extensions },
					{
						everywhere: Arr.prepend(
							Arr.map(probes, ([library, probe]) => (chosen(library) ? probe.value : "(absent)")),
							"postgres"
						),
						sessionsOff: Arr.prepend(
							Arr.map(probes, ([library, probe]) =>
								chosen(library) && factsOf(library).loading === "shared" ? probe.value : "(absent)"
							),
							"toolchain_preload_off"
						),
						extensions: [
							Arr.match(
								Arr.sort(
									Arr.filter(preload, (library) => factsOf(library).extension),
									Order.String
								),
								{ onEmpty: () => "(none)", onNonEmpty: Arr.join(",") }
							)
						]
					}
				)
			})
		),
	oracle: {
		kind: "specification",
		name: "a settled member's every session loads each library its cluster preloads, at the value that keeps it inert, and no other; a database that sets session_preload_libraries off for its sessions opens them without each library loaded by session, and with each loaded at the postmaster's start; and the owner's database holds the extension of each preloaded library that has one, and no other"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/pg/settings.ts",
			original:
				"\t\t\tArr.filter(cluster.preload, (library) => factsOf(library).loading === loading),\n",
			replacement: '\t\t\tArr.filter(cluster.preload, () => loading === "shared"),\n',
			why: "Every preloaded library is loaded at the postmaster's start, so no database can open a session without pg_plan_advice, and no test can reach the refusal of a session without it; the property fails, the library loaded in the database that set its sessions' libraries off."
		},
		{
			file: "packages/testing/src/pg/settings.ts",
			original: "\t...Arr.flatMap(cluster.preload, (library) => factsOf(library).inert)\n",
			replacement: "",
			why: "A preloaded library runs at its defaults: pg_stat_statements tracks every top-level statement of every database, the cost a member that preloads it inert never pays; the property fails, its track read as `top`."
		},
		{
			file: "packages/testing/src/pg/settle.ts",
			original: "\t\t\t\t\tArr.filter(cluster.preload, (library) => factsOf(library).extension),\n",
			replacement: "\t\t\t\t\tcluster.preload,\n",
			why: "Settle makes an extension of every preloaded library, and pg_plan_advice, which has no SQL interface, fails its CREATE EXTENSION, so no member preloading it settles; the property fails."
		}
	]
})

export const aReadStartsNothingANeedItsOwnMember = property.exhaust(finite(shapes), {
	box: "a cluster's family over its socket or over TLS, of one member or two: read never settled, then settled, every member stopped, and its last member reached by a worker's first need",
	needs: {},
	situations: [],
	check: () => (shape) =>
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const cluster = yield* clusterOf(shape)
				yield* removedAtEnd(cluster)
				const family = yield* familyIn(cluster, testWorkers)
				const held = yield* familyHeld(family)
				const names = memberNames(family)
				const refused = yield* Effect.forEach(names, (_, index) =>
					failedOf(memberRead(family, index))
				)
				const active = yield* Effect.forEach(names, unitActive)
				const data = yield* Effect.forEach(names, (name) =>
					Effect.flatMap(dataOf(name), (directory) => fs.exists(directory))
				)
				yield* settled(family, processSettler)
				yield* Effect.forEach(names, memberStopped, { discard: true })
				const last = names.length - 1
				yield* memberBroughtUp(held, last, processSettler)
				const activeAfterNeed = yield* Effect.forEach(names, unitActive)
				assert.deepEqual(
					{ refused, active, data, activeAfterNeed },
					{
						refused: Arr.map(names, () => true),
						active: Arr.map(names, () => false),
						data: Arr.map(names, () => false),
						activeAfterNeed: Arr.map(names, (_, index) => index === last)
					}
				)
			})
		),
	oracle: {
		kind: "specification",
		name: "a read starts nothing: a member of a family never settled is refused, and no member's unit is started or made; and a worker's first need starts only the member it reaches, the family's others left stopped"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/pg/settle.ts",
			original:
				"\t\tconst recorded = yield* stateWidth(family)\n\t\tif (Option.isNone(recorded)) {\n",
			replacement:
				"\t\tyield* Effect.forEach(memberNames(family), (name) => leaseStarted(family, name, step), { discard: true })\n\t\tconst recorded = yield* stateWidth(family)\n\t\tif (Option.isNone(recorded)) {\n",
			why: "A read starts each member's unit, as the old harness's need made and started its cluster, so a run changes a server every run shares; the property fails, the units started."
		},
		{
			file: "packages/testing/src/pg/settle.ts",
			original: "\t\t\tconst ofMember = yield* Effect.result(settle.member(family, index))\n",
			replacement:
				"\t\t\tconst ofMember = yield* Effect.result(Effect.forEach(memberNames(family), (_, other) => settle.member(family, other)))\n",
			why: "A worker's first need brings up every member of its family, as a settle of the whole family did, so a run of one worker starts every server of it (FAMILYFREE, 2026-11-23: grizzle's union-import by path, one worker, 32 members and 2.2 GiB of /dev/shm); the property fails, the member no worker reached started."
		}
	]
})

export const runsOfTwoWidthsKeepTheirOwnFamilies = property.exhaust(finite(widthCases), {
	box: "a family settled whole for a run of one worker and a run of two reaching its own, or the other way, spread a member a worker over TLS or of one member over its socket, each member brought up as a worker that found the family's settle unit running and joined it",
	needs: {},
	situations: [],
	check: () => (width) =>
		Effect.scoped(
			Effect.gen(function* () {
				const cluster = yield* widthCluster(width.family)
				yield* removedAtEnd(cluster)
				const [before, after] =
					width.move === "wider" ? [widths.narrow, widths.wide] : [widths.wide, widths.narrow]
				const settledFor = yield* familyIn(cluster, before)
				yield* settledWhole(settledFor)
				yield* familyHeld(settledFor)
				const first = yield* memberRead(settledFor, 0)
				const postmasterBefore = yield* postmasterOf(first)
				const reached = familyOf(cluster, settledFor.checkout, settledFor.homes, after)
				const names = memberNames(reached)
				const held = yield* familyHeld(reached)
				const refusedBefore = yield* Effect.forEach(names, (_, index) =>
					failedOf(memberRead(reached, index))
				)
				const brought = yield* Effect.forEach(names, (_, index) =>
					memberBroughtUp(held, index, joinedSettler)
				)
				const recorded = yield* stateWidth(reached)
				const recordedBefore = yield* stateWidth(settledFor)
				const refusedAfter = yield* Effect.forEach(names, (_, index) =>
					failedOf(memberRead(reached, index))
				)
				const otherRefused = yield* failedOf(memberRead(settledFor, 0))
				const postmasterAfter = yield* postmasterOf(first)
				assert.deepEqual(
					{
						own: reached.name !== settledFor.name,
						refusedBefore,
						brought: Arr.map(brought, (member) => member.name),
						recorded,
						recordedBefore,
						refusedAfter,
						otherRefused,
						restarted: postmasterAfter !== postmasterBefore
					},
					{
						own: true,
						refusedBefore: Arr.map(names, () => true),
						brought: Arr.copy(names),
						recorded: Option.some(after),
						recordedBefore: Option.some(before),
						refusedAfter: Arr.map(names, () => false),
						otherRefused: false,
						restarted: false
					}
				)
			})
		),
	oracle: {
		kind: "specification",
		name: "a run of another width reaches a family of its own (its name covers the checkout, the width and the spec, family.ts familyNameOf), settles it at its width, its state recording it, and each member it reaches as its width's spec states, though its own start of the family's settle was refused as another asker's ran; the family the other width settled is untouched: its state records its own width, its member is read, and its server was never restarted (STOREDERIVE4's soundness gate, 2026-11-25: two runs of one checkout at two widths shared a family and restarted each other's members, 57P01)"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/pg/family.ts",
			original: `\t\t\treturn \`\${naming.checkout}\\n\${String(naming.width)}\\n\${Formatter.format(naming.cluster)}\`\n`,
			replacement: `\t\t\treturn \`\${naming.checkout}\\n\${Formatter.format(naming.cluster)}\`\n`,
			why: "A family is named by its checkout alone, as it was: runs of one checkout at two widths share it, and each run's settle sizes its members for its own width and restarts them under the other's connections, which the server ends (57P01, STOREDERIVE4's soundness gate, 2026-11-25); the property fails, the other width's family settled over."
		},
		{
			file: "packages/testing/src/pg/settle.ts",
			original: "\t\t\tconst ofState = Option.isSome(recorded)\n",
			replacement: "\t\t\tconst ofState = true\n",
			why: "A worker's first need settles only the member it reaches, never its family's state, so a family no run of its width settled is refused for good, as a member's settle requires its family's state (lane METISREDS, 2026-11-24: settled in metis.slice, refused in grizzle.slice); the property fails, the bring-up refused."
		},
		{
			file: "packages/testing/src/pg/settle.ts",
			original: "\t\t\tconst ofMember = yield* Effect.result(settle.member(family, index))\n",
			replacement:
				"\t\t\tconst ofMember = Result.isFailure(ofState) ? ofState : yield* Effect.result(settle.member(family, index))\n",
			why: "A worker whose start of its family's settle unit was refused settles no member, as when its two steps were one chain: every worker but the first finds the unit running and joins it, its own start refused, so only one worker's member is ever settled (a grizzle pg run of 8 workers, 2026-11-24: 62 of 63 properties failed, their members never settled); the property fails, the member's read refused."
		}
	]
})

export const aSettleUnitSettlesAtTheWidthItIsGiven = property.exhaust(finite(int(0, 1)), {
	box: "each member of a family spread a member a worker over TLS, its state settled for a run of two workers, settled by its settle unit's own command and environment under the CPU allowance of a run of three",
	needs: { checkout: Checkout.dir },
	situations: [],
	check: () => (index) =>
		Effect.scoped(
			Effect.gen(function* () {
				const cluster = yield* widthCluster("spread")
				yield* removedAtEnd(cluster)
				const family = yield* familyIn(cluster, widths.wide)
				yield* familySettled(family)
				yield* familyHeld(family)
				yield* settledAsItsUnit(family, index, 2 * (widths.wide + 1))
				const read = yield* memberRead(family, index)
				assert.deepEqual(read.name, Arr.getUnsafe(memberNames(family), index))
			})
		),
	oracle: {
		kind: "specification",
		name: "a member settled by its settle unit's command, given the width of the run that started it, is settled for that width whatever CPU allowance the unit itself runs under, and a run of that width reads it as its spec states"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/pg/cli.ts",
			original: "\t\t\t\t\t\tOption.getOrElse(given, () => testWorkers)\n",
			replacement: "\t\t\t\t\t\ttestWorkers\n",
			why: "A settle unit sizes its family for its own CPU allowance, the slice it runs in, rather than the width it was given, so a run narrowed by its affinity or its slice's quota finds members sized for another run (2026-11-24: a run of 4 workers under CPUAffinity=0-7 against members settled for 32, max_connections 211 where it expects 835); the property fails, the unit's settle refused, its family's state of the width it was given."
		}
	]
})

export const aHeldPortRefusesItsSettle = property.exhaust(finite(boolean), {
	box: "a settled family over TLS of one member or two, its last member stopped and its port taken by a listener of the case's process, then its first member, running, settled again at the port its own server holds",
	needs: {},
	situations: [],
	check: () => (spread) =>
		Effect.scoped(
			Effect.gen(function* () {
				const cluster = yield* clusterOf({ tls: true, spread, room: true })
				yield* removedAtEnd(cluster)
				const family = yield* familyIn(cluster, testWorkers)
				yield* settledWhole(family)
				const names = memberNames(family)
				const name = Arr.lastNonEmpty(names)
				const last = names.length - 1
				const claims = yield* portsHeld(family)
				const port = Arr.getUnsafe(claims, last)
				yield* memberStopped(name)
				const refusal = yield* Effect.scoped(
					Effect.andThen(portHeldHere(port), Effect.flip(memberSettled(family, last)))
				)
				const startedUnder = yield* unitActive(name)
				const read = yield* settledWhole(family)
				const ownPortSettles = yield* Effect.isSuccess(memberSettled(family, 0))
				assert.deepEqual(
					{
						namesThePort: Str.includes(`its port ${port}`)(refusal.message),
						namesTheHolder: Str.includes(`(pid ${process.pid})`)(refusal.message),
						startedUnder,
						ownPortSettles,
						settledOnceGone: Arr.map(read, (member) => [member.name, member.port])
					},
					{
						namesThePort: true,
						namesTheHolder: true,
						startedUnder: false,
						ownPortSettles: true,
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
		name: "a member whose claimed port another listener holds is refused by its settle before its unit starts, the refusal naming the port and the holder's process, and its family settled at the same ports once the listener is gone, the stopped member, whose data in memory went with its stop, made again; a running member's settle, its port held by its own server, is no refusal"
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
		},
		{
			file: "packages/testing/src/pg/settle.ts",
			original: "\t\tyield* freedForgotten(family.homes.data, name, at)\n",
			replacement: "",
			why: "A settle starts a stopped member as its stop left it, its data directory a link to data in memory that went with the stop, which the workbench's postgres@ unit refuses to start bare (TESTRESET3, 2026-11-23: a freed member started with a plain systemctl start came up as initdb leaves a cluster, at PostgreSQL's port with its own hba file), so a family stopped once never settles again; the property fails, the stopped member never settled."
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

export const aKeptFamilyKeepsItsDataThroughItsSettings = property.exhaust(finite(keptCases), {
	box: "a kept cluster settled over TLS or over its socket, a row written in its maintenance database, its member stopped as a person stops it, then its spec's lock table grown or shrunk and its family settled again",
	needs: {},
	situations: [],
	check: () => (kept) =>
		Effect.scoped(
			Effect.gen(function* () {
				const at = yield* keptCluster(kept.tls)
				const [before, after] =
					kept.move === "more" ? [keptLocks.few, keptLocks.many] : [keptLocks.many, keptLocks.few]
				yield* removedAtEnd(at(before))
				const family = yield* familyIn(at(before), widths.narrow)
				const step = { cluster: family.name, doing: "the property" }
				const bin = yield* serverBin(step)
				const holding = yield* Scope.make()
				const settledFirst = yield* Scope.provide(holding)(settledWhole(family))
				const first = Arr.headNonEmpty(settledFirst)
				yield* adminSql(
					bin,
					{ socket: first.socket, port: first.port },
					"postgres",
					["CREATE TABLE kept (note text)", "INSERT INTO kept VALUES ('kept')"],
					step
				)
				const [locksBefore = ""] = yield* adminSql(
					bin,
					{ socket: first.socket, port: first.port },
					"postgres",
					["SHOW max_locks_per_transaction"],
					step
				)
				yield* Scope.close(holding, Exit.void)
				yield* memberStopped(Arr.headNonEmpty(memberNames(family)))
				const resized = familyOf(at(after), family.checkout, family.homes, family.width)
				const settledAgain = yield* settledWhole(resized)
				const again = Arr.headNonEmpty(settledAgain)
				const [note = ""] = yield* adminSql(
					bin,
					{ socket: again.socket, port: again.port },
					"postgres",
					["SELECT note FROM kept"],
					step
				)
				const [locksAfter = ""] = yield* adminSql(
					bin,
					{ socket: again.socket, port: again.port },
					"postgres",
					["SHOW max_locks_per_transaction"],
					step
				)
				assert.deepEqual(
					{
						sameFamily: resized.name === family.name,
						note,
						lockTableMoved: locksAfter !== locksBefore
					},
					{ sameFamily: true, note: "kept", lockTableMoved: true }
				)
			})
		),
	oracle: {
		kind: "specification",
		name: "a kept family is named by its checkout alone (family.ts Naming), so a change of its spec's lock table reaches the same member and its data, the change applied by the restart its settle makes; a family named by its spec opened an empty member at the change (METIS-DBOPT, 2026-11-26: metis's development family's name, computed at 4096 locks and at 4097, was two names)"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/pg/family.ts",
			original: '\tcluster.durability === "kept"\n',
			replacement: "\tcluster.durability !== cluster.durability\n",
			why: "A kept family is named by its spec, as every family was once a family was named by its settings: a change of its lock table opens an empty member, a person's development data left under the old name; the property fails, the row gone."
		}
	]
})
