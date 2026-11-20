/**
 * A local cluster's life (pg/make.ts): however many processes bring a cluster up at once, one makes it, under its lock,
 * and the rest take what it made, every member of its family on a port of its own and the manifest recording them; each
 * member admits the connections its sizing states beside those its server reserves, a leased member its share of the
 * run's workers' and the outside's, a member sized by its sessions those sessions whatever the run's width; each
 * member's lock table holds the heavyweight locks its sizing states at once, and is no larger than it must be to
 * (PostgreSQL's table: max_locks_per_transaction entries for each of its backends and prepared transactions, REL_19_0
 * src/backend/storage/lmgr/lock.c NLOCKENTS, its backends max_connections, autovacuum_worker_slots,
 * max_worker_processes, max_wal_senders and its two special workers, src/backend/utils/init/postinit.c
 * InitializeMaxBackends, src/include/storage/proc.h NUM_SPECIAL_WORKER_PROCS); what it
 * made passes the doctor's quick checks on every member, TLS, SCRAM and the settings every member holds among them;
 * a second bring-up takes the running cluster as it is, its postmasters the same processes; a spec of another owner on
 * the same port is refused, never taken; and a throwaway cluster is destroyed whole while a kept one's destroy is
 * refused. Each case's cluster is its own: its state under a home of the case's own and its name a port free when the
 * case began (TOOLCHAIN_PG_CLUSTER). Oracle: the specification, stated in the check.
 */
import {
	Array as Arr,
	ConfigProvider,
	Effect,
	Exit,
	FileSystem,
	Option,
	Schema,
	Struct
} from "effect"
import { assert } from "#assert.ts"
import { doctor } from "#pg/doctor.ts"
import {
	admittedOf,
	adoptedHoldings,
	foreignCluster,
	type Holding,
	holdings,
	lives,
	lockDemandOf,
	machineBin,
	madeSynchronously,
	membersOfLife,
	narrowings,
	postmasters,
	spawnedBy,
	specOf,
	stopEvery,
	TAKING_WORK
} from "#pg/make.fixtures.ts"
import { clusterUp, destroyCluster, initCluster, stopCluster } from "#pg/make.ts"
import { freePort } from "#pg/ports.ts"
import { adminSql } from "#pg/server.ts"
import { clusterState } from "#pg/state.ts"
import { ManifestFile } from "#pg/state.ts"
import { property } from "#property.ts"

type Feature =
	| "made by one of several at once"
	| "a family of two members"
	| "a cluster sized by its sessions"
	| "a throwaway cluster destroyed"
	| "a throwaway cluster of an older manifest made again"
	| "a kept cluster's destroy refused"

export const lifeOfACluster = property.exhaust(lives, {
	box: "both durabilities, a leased family of one and of two members and a cluster sized by its sessions, brought up by one to three at once",
	needs: {},
	situations: [
		"made by one of several at once",
		"a family of two members",
		"a cluster sized by its sessions",
		"a throwaway cluster destroyed",
		"a throwaway cluster of an older manifest made again",
		"a kept cluster's destroy refused"
	] satisfies ReadonlyArray<Feature>,
	check: (_resources, c) => (life) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const home = yield* fs.makeTempDirectoryScoped({ prefix: "tpg-" })
			const port = yield* freePort([])
			const spec = specOf(life, port, "lifecycle_owner")
			const root = `${home}/.local/var/toolchain-pg/${port}`
			yield* Effect.addFinalizer(() => stopEvery(root))
			const environment = ConfigProvider.fromEnvRecord({
				HOME: home,
				TOOLCHAIN_PG_CLUSTER: `${port}`
			})
			const inCase = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
				Effect.provideService(effect, ConfigProvider.ConfigProvider, environment)
			const unmade = madeSynchronously(spec, environment)
			assert.ok(
				Exit.isFailure(unmade) && Exit.hasFails(unmade),
				"an unmade cluster's members are refused"
			)
			assert.deepEqual(
				Option.map(Exit.findErrorOption(unmade), (error) => error._tag),
				Option.some("ClusterUnmade" as const),
				"an unmade cluster's members are refused as unmade"
			)
			const brought = yield* inCase(
				Effect.all(
					[clusterUp(spec), ...Array.from({ length: life.atOnce - 1 }, () => clusterUp(spec))],
					{ concurrency: "unbounded" }
				)
			)
			const manifest = yield* Effect.flatMap(
				fs.readFileString(`${root}/cluster.json`),
				Schema.decodeEffect(ManifestFile)
			)
			const ports = Arr.map(Arr.headNonEmpty(brought), (member) => member.port)
			assert.equal(ports.length, membersOfLife(life), "the family has the members its spec asks")
			assert.equal(ports[0], port, "its first member is its name's")
			assert.equal(new Set(ports).size, ports.length, "each member is on a port of its own")
			assert.deepEqual(manifest.members, ports, "the manifest records the members in member order")
			Arr.forEach(brought, (members) => {
				assert.deepEqual(
					Arr.map(members, (member) => member.port),
					ports,
					"every bring-up at once reaches the one cluster"
				)
			})
			const made = madeSynchronously(spec, environment)
			assert.ok(Exit.isSuccess(made), "a made cluster's members are read synchronously")
			assert.deepEqual(
				Arr.map(made.value, (member) => ({
					name: member.name,
					port: member.port,
					socket: member.socket,
					owner: member.owner,
					template: member.template,
					passwordFile: member.passwordFile,
					caFile: member.caFile,
					lease: member.lease
				})),
				Arr.map(Arr.headNonEmpty(brought), (member) => ({
					name: member.name,
					port: member.port,
					socket: member.socket,
					owner: member.owner,
					template: spec.template,
					passwordFile: member.passwordFile,
					caFile: member.caFile,
					lease: member.lease
				})),
				"a made cluster's members are read as clusterUp reads them"
			)
			const checked = yield* inCase(doctor(spec, true))
			Arr.forEach(checked, ({ port: member, verdicts }) => {
				assert.deepEqual(
					Arr.filter(verdicts, (verdict) => verdict.kind === "failed"),
					[],
					`member ${member} passes the doctor's quick checks`
				)
			})
			const bin = yield* machineBin
			const state = yield* inCase(clusterState(spec.port))
			const admitted = yield* Effect.forEach(ports, (member) =>
				adminSql(
					bin,
					state.member(member),
					"postgres",
					[
						"SELECT pg_catalog.current_setting('max_connections')::int4 - pg_catalog.current_setting('superuser_reserved_connections')::int4 - pg_catalog.current_setting('reserved_connections')::int4"
					],
					{ cluster: port, doing: "reading the connections a member admits" }
				)
			)
			assert.deepEqual(
				admitted,
				Arr.map(ports, () => [`${admittedOf(life)}`]),
				`every member admits the connections its sizing states (${life.sizedBy.kind})`
			)
			const demand = lockDemandOf(life)
			const tables = yield* Effect.forEach(ports, (member) =>
				adminSql(
					bin,
					state.member(member),
					"postgres",
					[
						`SELECT (locks * processes >= ${demand})::text || ' ' || (locks = 128 OR (locks - 1) * processes < ${demand})::text FROM (SELECT pg_catalog.current_setting('max_locks_per_transaction')::int8 AS locks, pg_catalog.current_setting('max_connections')::int8 + pg_catalog.current_setting('autovacuum_worker_slots')::int8 + pg_catalog.current_setting('max_worker_processes')::int8 + pg_catalog.current_setting('max_wal_senders')::int8 + 2 + pg_catalog.current_setting('max_prepared_transactions')::int8 AS processes) AS member`
					],
					{ cluster: port, doing: "reading the lock table a member holds" }
				)
			)
			assert.deepEqual(
				tables,
				Arr.map(ports, () => ["true true"]),
				`every member's lock table holds the locks its sizing states at once, and no more than it must (${life.sizedBy.kind})`
			)
			const before = yield* postmasters(root, ports)
			const spawned = yield* clusterUp(spec).pipe(inCase, spawnedBy)
			const after = yield* postmasters(root, ports)
			assert.deepEqual(after, before, "a running cluster is taken as it is")
			assert.deepEqual(
				Arr.filter(spawned, (program) => Arr.contains(TAKING_WORK, program)),
				[],
				"a running cluster is taken with no lock taken and no member's program run"
			)
			const other = yield* Effect.exit(inCase(clusterUp(specOf(life, port, "another_owner"))))
			assert.ok(Exit.isFailure(other), "a spec of another owner on the same port is refused")
			if (life.durability === "throwaway") {
				const written = yield* Effect.flatMap(
					fs.readFileString(`${root}/cluster.json`),
					Schema.decodeEffect(ManifestFile)
				)
				const older = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
					Struct.omit(written, ["ownerParameters"])
				)
				yield* fs.writeFileString(`${root}/cluster.json`, older)
				const remade = yield* Effect.exit(inCase(initCluster(spec, { kind: "force" })))
				assert.ok(
					Exit.isSuccess(remade),
					"init --force makes a throwaway cluster again whose manifest predates its owner's parameters"
				)
				const rewritten = yield* Effect.flatMap(
					fs.readFileString(`${root}/cluster.json`),
					Schema.decodeEffect(ManifestFile)
				)
				assert.deepEqual(
					rewritten.ownerParameters,
					spec.ownerParameters,
					"the cluster made again records its owner's parameters"
				)
				const rechecked = yield* inCase(doctor(spec, true))
				Arr.forEach(rechecked, ({ port: member, verdicts }) => {
					assert.deepEqual(
						Arr.filter(verdicts, (verdict) => verdict.kind === "failed"),
						[],
						`member ${member} of the cluster made again passes the doctor's quick checks`
					)
				})
				c.note("a throwaway cluster of an older manifest made again")
			}
			const destroyed = yield* Effect.exit(inCase(destroyCluster(spec)))
			if (life.durability === "throwaway") {
				assert.ok(Exit.isSuccess(destroyed), "a throwaway cluster is destroyed")
				const left = yield* fs.exists(root)
				assert.equal(left, false, "nothing of it is left")
				c.note("a throwaway cluster destroyed")
			} else {
				assert.ok(Exit.isFailure(destroyed), "a kept cluster's destroy is refused")
				const throwawaySpec = yield* Effect.exit(
					inCase(
						destroyCluster(specOf({ ...life, durability: "throwaway" }, port, "lifecycle_owner"))
					)
				)
				assert.ok(
					Exit.isFailure(throwawaySpec),
					"a throwaway spec on a kept cluster's port destroys nothing"
				)
				const stays = yield* fs.exists(`${root}/cluster.json`)
				assert.equal(stays, true, "the kept cluster stays")
				yield* inCase(stopCluster(spec))
				c.note("a kept cluster's destroy refused")
			}
			if (life.atOnce > 1) {
				c.note("made by one of several at once")
			}
			if (life.sizedBy.kind === "leased" && life.sizedBy.members === 2) {
				c.note("a family of two members")
			}
			if (life.sizedBy.kind === "sessions") {
				c.note("a cluster sized by its sessions")
			}
		}).pipe(Effect.scoped),
	oracle: {
		kind: "specification",
		name: "a cluster brought up at once is made once, admits the connections its sizing states and passes the doctor, is taken as it is when it runs, refuses another spec, and is destroyed only when throwaway"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/pg/make.ts",
			original: "			yield* Effect.mapError(lockHeld(life.state.lock), lockFailed)\n",
			replacement: "",
			why: "The lock is never taken, so several bring-ups at once each make the cluster in the same directory on the same port; the property fails."
		},
		{
			file: "packages/testing/src/pg/make.ts",
			original: "		if (!up) {\n			yield* Effect.catchTag(start(life.bin, member, step)",
			replacement:
				"		if (up || !up) {\n			yield* Effect.catchTag(start(life.bin, member, step)",
			why: "A running member is started again, which pg_ctl refuses while its postmaster runs; the property fails."
		},
		{
			file: "packages/testing/src/pg/state.ts",
			original: "		...(manifest.owner === expected.owner",
			replacement: "		...(true",
			why: "A cluster made for another owner is taken as this spec's; the property fails."
		},
		{
			file: "packages/testing/src/pg/make.ts",
			original:
				'life.cluster.durability === "throwaway"\n		? Effect.flatMap(madeForRead(life.state)',
			replacement: "true\n		? Effect.flatMap(madeForRead(life.state)",
			why: "A kept cluster, a person's data, is destroyed; the property fails."
		},
		{
			file: "packages/testing/src/pg/make.ts",
			original: "onSome: (madeFor) => Effect.asVoid(agreeingMade(life, madeFor))",
			replacement: "onSome: () => Effect.void",
			why: "A throwaway spec naming a kept cluster's port destroys it, a person's data; the property fails."
		},
		{
			file: "packages/testing/src/pg/make.ts",
			original: '"hostssl all   all        127.0.0.1/32  scram-sha-256",',
			replacement: '"hostssl all   all        127.0.0.1/32  trust",',
			why: "Every role signs in over TCP with no password, which the doctor's SCRAM check refuses; the property fails."
		},
		{
			file: "packages/testing/src/pg/make.ts",
			original: `(name) => \`GRANT SET ON PARAMETER \${ident(name)} TO \${owner}\``,
			replacement: "() => `SELECT 1`",
			why: "The owner is granted none of the parameters its spec names, which the doctor checks; the property fails."
		},
		{
			file: "packages/testing/src/pg/make.ts",
			original: "\t\t\tdescribedMember(cluster, state.member(member))\n",
			replacement: `\t\t\t({ ...describedMember(cluster, state.member(member)), caFile: \`\${state.member(member).state}/ca.crt\` })\n`,
			why: "The synchronous reader spells a member's CA file itself, beside the one description every reader takes it from, so a config built on it names a file the maker never wrote; the property fails."
		},
		{
			file: "packages/testing/src/pg/make.ts",
			original: "\t\t? Effect.flatMap(madeForRead(life.state), (recorded) =>",
			replacement: "\t\t? Effect.flatMap(manifestRead(life.state), (recorded) =>",
			why: "init --force and destroy read the whole manifest to tell whose cluster it is, so a throwaway cluster whose manifest predates a field (its owner's parameters) is refused, never made again: the documented migration cannot run; the property fails."
		},
		{
			file: "packages/testing/src/pg/settings.ts",
			original: "\t\t\tmaxConnections(sizing.sessions),\n",
			replacement: "\t\t\tmaxConnections(share * sizing.sessions),\n",
			why: "A cluster sized by its sessions is read as though each were a worker's, its sessions times the run's share, so a development cluster's max_connections grows with the machine's width; the property fails."
		},
		{
			file: "packages/testing/src/pg/settings.ts",
			original: "\tconst admitted = perWorkerCount(connections, share)\n",
			replacement: "\tconst admitted = perWorkerCount(connections, 1)\n",
			why: "A leased member is sized for one worker whatever its share of the run's, so its lease admits one worker and the run's others wait; the property fails."
		},
		{
			file: "packages/testing/src/pg/settings.ts",
			original: "\t\t...Arr.map(sizedCount(locks, share), (demand) =>\n",
			replacement: '\t\t...Arr.map(sizedCount({ kind: "default" }, share), (demand) =>\n',
			why: "A leased member's lock table stays at PostgreSQL's default whatever its workers hold, so concurrent installs on a shared family exhaust it (5447's 53200, 2026-11-20); the property fails."
		},
		{
			file: "packages/testing/src/pg/settings.ts",
			original: "\t\t\t...Arr.map(heldCount(sizing.locks), (demand) =>\n",
			replacement: '\t\t\t...Arr.map(heldCount({ kind: "default" }), (demand) =>\n',
			why: "A cluster sized by its sessions keeps PostgreSQL's default lock table whatever its users hold, so a development migration's largest transaction runs out of locks; the property fails."
		},
		{
			file: "packages/testing/src/pg/settings.ts",
			original:
				"\t\t\t\t(connections +\n\t\t\t\t\tautovacuumWorkerSlots +\n\t\t\t\t\tworkerProcesses +\n\t\t\t\t\twalSenders +\n",
			replacement: "\t\t\t\t(connections +\n",
			why: "The lock table is sized as though only the member's connections held its entries, so it is sized past what it must hold: autovacuum's slots, the background workers and the WAL senders each hold max_locks_per_transaction entries of it too (lock.c NLOCKENTS); the property fails."
		},
		{
			file: "packages/testing/src/pg/make.ts",
			original: "takenRunning(life),",
			replacement: "Effect.succeedNone,",
			why: "A running cluster is taken under its lock, every member's pg_ctl status and TLS checked by programs, so every test file and worker opening it waits on the others in turn; the property fails."
		}
	]
})

/**
 * A cluster another maker made is adopted whatever it already holds of the spec's owner role, template and owner's
 * database (`init --adopt-from`, make.ts adoptMember and owned): its data kept where it lies, each database it held the
 * same database after (its oid kept), and every member then passing the doctor's every check, the owner signing in
 * with the password the adoption gave it, a database made from the template carrying its extensions. Each case's
 * clusters are its own, under a home of the case's own, on ports free when the case began.
 */
export const adoptingACluster = property.exhaust(holdings, {
	box: "a cluster another maker made holding nothing of the spec's, its owner role, the role and its template, or all three with the owner's database",
	needs: {},
	situations: adoptedHoldings satisfies ReadonlyArray<Holding>,
	check: (_resources, c) => (holding) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const home = yield* fs.makeTempDirectoryScoped({ prefix: "tpg-" })
			const port = yield* freePort([])
			const foreignPort = yield* freePort([port])
			const spec = specOf(
				{ durability: "kept", sizedBy: { kind: "leased", members: 1 }, atOnce: 1 },
				port,
				"adopted_owner"
			)
			const root = `${home}/.local/var/toolchain-pg/${port}`
			const data = `${home}/foreign`
			yield* Effect.addFinalizer(() => stopEvery(root))
			const before = yield* foreignCluster(spec, holding, data, `${home}/sock`, foreignPort)
			const environment = ConfigProvider.fromEnvRecord({
				HOME: home,
				TOOLCHAIN_PG_CLUSTER: `${port}`
			})
			const inCase = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
				Effect.provideService(effect, ConfigProvider.ConfigProvider, environment)
			const [member] = yield* inCase(initCluster(spec, { kind: "adoptFrom", data }))
			const checked = yield* inCase(doctor(spec, false))
			Arr.forEach(checked, ({ port: at, verdicts }) => {
				assert.deepEqual(
					Arr.filter(verdicts, (verdict) => verdict.kind === "failed"),
					[],
					`member ${at} of a cluster adopted holding ${holding} passes the doctor`
				)
			})
			const state = yield* inCase(clusterState(spec.port))
			const bin = yield* machineBin
			const after = yield* adminSql(
				bin,
				state.member(member.port),
				"postgres",
				["SELECT datname || '=' || oid FROM pg_catalog.pg_database ORDER BY 1"],
				{ cluster: port, doing: "reading its databases" }
			)
			assert.ok(
				Arr.every(before, (database) => Arr.contains(after, database)),
				`every database the adopted cluster held is kept: ${Arr.join(before, ", ")} against ${Arr.join(after, ", ")}`
			)
			yield* inCase(stopCluster(spec))
			c.note(holding)
		}).pipe(Effect.scoped),
	oracle: {
		kind: "specification",
		name: "an adopted cluster keeps every database it held and passes the doctor, whatever it held of the spec's owner, template and owner's database"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/pg/make.ts",
			original: `held.role ? \`ALTER ROLE \${owner} \${attributes}\` : \`CREATE ROLE \${owner} \${attributes}\``,
			replacement: `\`CREATE ROLE \${owner} \${attributes}\``,
			why: "An owner role the adopted cluster holds is created again, which PostgreSQL refuses (42710); the property fails."
		},
		{
			file: "packages/testing/src/pg/make.ts",
			original: "				...(held.template\n",
			replacement: "				...(false\n",
			why: "A template the adopted cluster holds is created again, which PostgreSQL refuses (42P04); the property fails."
		},
		{
			file: "packages/testing/src/pg/make.ts",
			original: `held.database ? [] : [\`CREATE DATABASE \${owner} OWNER \${owner} TEMPLATE \${template}\`]`,
			replacement: `[\`CREATE DATABASE \${owner} OWNER \${owner} TEMPLATE \${template}\`]`,
			why: "The owner's database the adopted cluster holds is created again, which PostgreSQL refuses (42P04); the property fails."
		}
	]
})

/**
 * A family recorded larger than a run's width asks serves that run from its first members, as it is (make.ts servedOf):
 * a throwaway family made at two members (workersPerMember half the machine's workers), met by a spec that asks one
 * (every worker on one member, as a run of half the width meets a family made at the full width), is brought up or
 * adopted and serves its first member, while its manifest keeps both members for a wider run. Each case's cluster is its own, under a home of the case's own, on a port free when it began.
 */
export const familyServesNarrowerRun = property.exhaust(narrowings, {
	box: "a family of two members brought up or adopted by a spec that asks one",
	needs: {},
	situations: ["brought up", "adopted"],
	check: (_resources, c) => (narrowing) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const home = yield* fs.makeTempDirectoryScoped({ prefix: "tpg-" })
			const port = yield* freePort([])
			const root = `${home}/.local/var/toolchain-pg/${port}`
			yield* Effect.addFinalizer(() => stopEvery(root))
			const environment = ConfigProvider.fromEnvRecord({
				HOME: home,
				TOOLCHAIN_PG_CLUSTER: `${port}`
			})
			const inCase = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
				Effect.provideService(effect, ConfigProvider.ConfigProvider, environment)
			const wide = specOf(
				{ durability: "throwaway", sizedBy: { kind: "leased", members: 2 }, atOnce: 1 },
				port,
				"narrowed_owner"
			)
			const narrow = specOf(
				{ durability: "throwaway", sizedBy: { kind: "leased", members: 1 }, atOnce: 1 },
				port,
				"narrowed_owner"
			)
			const made = yield* inCase(clusterUp(wide))
			assert.equal(made.length, 2, "the wide spec makes a family of two")
			const served = yield* inCase(
				narrowing === "adopted"
					? Effect.andThen(initCluster(narrow, { kind: "adopt" }), clusterUp(narrow))
					: clusterUp(narrow)
			)
			assert.deepEqual(
				Arr.map(served, (member) => member.port),
				[Arr.headNonEmpty(made).port],
				"a run asking one member is served by the family's first"
			)
			const manifest = yield* Effect.flatMap(
				fs.readFileString(`${root}/cluster.json`),
				Schema.decodeEffect(ManifestFile)
			)
			assert.deepEqual(
				manifest.members,
				Arr.map(made, (member) => member.port),
				"the manifest keeps every member for a wider run"
			)
			yield* inCase(stopCluster(wide))
			c.note(narrowing)
		}).pipe(Effect.scoped),
	oracle: {
		kind: "specification",
		name: "a family recorded larger than a run's width asks serves it from its first members, keeping the rest"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/pg/make.ts",
			original: "\tif (manifest.members.length < familySize(life)) {",
			replacement: "\tif (manifest.members.length !== familySize(life)) {",
			why: "A family recorded larger than the width asks is refused, as it was: a run at half the machine's width could not take grizzle's four-member family without a re-make that would end the runs on it; the property fails."
		}
	]
})
