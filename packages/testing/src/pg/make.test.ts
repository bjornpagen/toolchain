/**
 * A local cluster's life (pg/make.ts): however many processes bring a cluster up at once, one makes it, under its lock,
 * and the rest take what it made, every member of its family on a port of its own and the manifest recording them; what
 * it made passes the doctor's quick checks on every member, TLS, SCRAM and the settings every member holds among them;
 * a second bring-up takes the running cluster as it is, its postmasters the same processes; a spec of another owner on
 * the same port is refused, never taken; and a throwaway cluster is destroyed whole while a kept one's destroy is
 * refused. Each case's cluster is its own: its state under a home of the case's own and its name a port free when the
 * case began (TOOLCHAIN_PG_CLUSTER). Oracle: the specification, stated in the check.
 */
import { Array as Arr, ConfigProvider, Effect, Exit, FileSystem, Schema } from "effect"
import { assertTrue, deepStrictEqual, strictEqual } from "#assert.ts"
import { doctor } from "#pg/doctor.ts"
import { lives, postmasters, specOf, stopEvery } from "#pg/make.fixtures.ts"
import { clusterUp, destroyCluster, stopCluster } from "#pg/make.ts"
import { freePort } from "#pg/ports.ts"
import { ManifestFile } from "#pg/state.ts"
import { property } from "#property.ts"

type Feature =
	| "made by one of several at once"
	| "a family of two members"
	| "a throwaway cluster destroyed"
	| "a kept cluster's destroy refused"

export const lifeOfACluster = property.exhaust(lives, {
	box: "both durabilities, a family of one and of two members, brought up by one to three at once",
	needs: {},
	situations: [
		"made by one of several at once",
		"a family of two members",
		"a throwaway cluster destroyed",
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
			strictEqual(ports.length, life.members, "the family has the members its spec asks")
			strictEqual(ports[0], port, "its first member is its name's")
			strictEqual(new Set(ports).size, ports.length, "each member is on a port of its own")
			deepStrictEqual(manifest.members, ports, "the manifest records the members in member order")
			Arr.forEach(brought, (members) => {
				deepStrictEqual(
					Arr.map(members, (member) => member.port),
					ports,
					"every bring-up at once reaches the one cluster"
				)
			})
			const checked = yield* inCase(doctor(spec, true))
			Arr.forEach(checked, ({ port: member, verdicts }) => {
				deepStrictEqual(
					Arr.filter(verdicts, (verdict) => verdict.kind === "failed"),
					[],
					`member ${member} passes the doctor's quick checks`
				)
			})
			const before = yield* postmasters(root, ports)
			yield* inCase(clusterUp(spec))
			const after = yield* postmasters(root, ports)
			deepStrictEqual(after, before, "a running cluster is taken as it is")
			const other = yield* Effect.exit(inCase(clusterUp(specOf(life, port, "another_owner"))))
			assertTrue(Exit.isFailure(other), "a spec of another owner on the same port is refused")
			const destroyed = yield* Effect.exit(inCase(destroyCluster(spec)))
			if (life.durability === "throwaway") {
				assertTrue(Exit.isSuccess(destroyed), "a throwaway cluster is destroyed")
				const left = yield* fs.exists(root)
				strictEqual(left, false, "nothing of it is left")
				c.note("a throwaway cluster destroyed")
			} else {
				assertTrue(Exit.isFailure(destroyed), "a kept cluster's destroy is refused")
				const throwawaySpec = yield* Effect.exit(
					inCase(
						destroyCluster(specOf({ ...life, durability: "throwaway" }, port, "lifecycle_owner"))
					)
				)
				assertTrue(
					Exit.isFailure(throwawaySpec),
					"a throwaway spec on a kept cluster's port destroys nothing"
				)
				const stays = yield* fs.exists(`${root}/cluster.json`)
				strictEqual(stays, true, "the kept cluster stays")
				yield* inCase(stopCluster(spec))
				c.note("a kept cluster's destroy refused")
			}
			if (life.atOnce > 1) {
				c.note("made by one of several at once")
			}
			if (life.members === 2) {
				c.note("a family of two members")
			}
		}).pipe(Effect.scoped),
	oracle: {
		kind: "specification",
		name: "a cluster brought up at once is made once and passes the doctor, is taken as it is when it runs, refuses another spec, and is destroyed only when throwaway"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/pg/make.ts",
			original: 'flock($lock, LOCK_EX) or die "$!"; ',
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
			original: 'life.cluster.durability === "throwaway"\n		? Effect.flatMap(manifestOf(life)',
			replacement: "true\n		? Effect.flatMap(manifestOf(life)",
			why: "A kept cluster, a person's data, is destroyed; the property fails."
		},
		{
			file: "packages/testing/src/pg/make.ts",
			original: "onSome: (manifest) => Effect.asVoid(agreeingMade(life, manifest))",
			replacement: "onSome: () => Effect.void",
			why: "A throwaway spec naming a kept cluster's port destroys it, a person's data; the property fails."
		},
		{
			file: "packages/testing/src/pg/make.ts",
			original: '"hostssl all   all        127.0.0.1/32  scram-sha-256",',
			replacement: '"hostssl all   all        127.0.0.1/32  trust",',
			why: "Every role signs in over TCP with no password, which the doctor's SCRAM check refuses; the property fails."
		}
	]
})
