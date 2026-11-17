import { Array as Arr, Effect, Option, Predicate, Record as Rec, String as Str } from "effect"
import type { Needs } from "#property.ts"
import {
	lockKey,
	PgCluster,
	type PgMember,
	quoteIdent,
	run,
	single,
	useKey
} from "#resources/cluster.ts"
import { namedOf } from "#resources/names.ts"
import { DatabaseTemplate, type Identified, identify } from "#resources/template.ts"
import { ModuleClosure, type NeedFailed } from "#runner/services.ts"

/** The database templates a property's needs declare: each need over one (database.ts DatabaseNeed). */
export const templatesOf = (needs: Needs): ReadonlyArray<DatabaseTemplate> =>
	Arr.flatMap(Rec.values(needs), (need) =>
		Predicate.hasProperty(need, "template") && need.template instanceof DatabaseTemplate
			? [need.template]
			: []
	)

/** What collection dropped on one member, by name. */
export type Collected = Readonly<{ member: string; dropped: ReadonlyArray<string> }>

/** Every name an identified template's chain holds: its own and its origins'. */
const chainNames = (identified: Identified): ReadonlyArray<string> => [
	identified.name,
	...Option.match(identified.origin, { onNone: () => [], onSome: chainNames })
]

/**
 * Drops, on one member, what no run may use again: every clone whose owner's lock is free (its worker has ended:
 * cluster.ts Owner), and every template no declared template's chain names (stale: its declaration, its content or its
 * module's closure changed), unless a builder holds its gate or a live worker holds it in use (template.ts holdInUse:
 * another run's, of other properties or other code, a kill trial's among them). A template is first made no template,
 * which DROP DATABASE requires; a database a drop left invalid (dbcommands.c dropdb, interrupted after it marked the database) is no
 * template, and PostgreSQL lets nothing but a drop touch it, so it is dropped as it is. Each lock is tried on the collector's own session in the
 * owner's database, and held until collection ends, so a key it found free stays free while it drops.
 */
const collectMember = (
	member: PgMember,
	declared: ReadonlySet<string>
): Effect.Effect<Collected, NeedFailed, PgCluster> =>
	Effect.scoped(
		Effect.gen(function* () {
			const cluster = yield* PgCluster
			const admin = yield* cluster.connect(member, cluster.maintenance)
			const rows = yield* run(
				admin,
				"SELECT datname::text, datistemplate::text FROM pg_catalog.pg_database ORDER BY 1",
				[]
			)
			const named = Arr.flatMap(rows, ([name, template]) =>
				Option.toArray(
					Option.map(namedOf(cluster.prefix, name ?? ""), (database) => ({
						database,
						template: template === "true"
					}))
				)
			)
			const free = (key: string): Effect.Effect<boolean, NeedFailed> =>
				Effect.map(
					single(admin, `SELECT pg_catalog.pg_try_advisory_lock(${lockKey("$1")})::text`, [key]),
					(taken) => taken === "true"
				)
			const unused = (key: string): Effect.Effect<boolean, NeedFailed> =>
				Effect.map(
					single(admin, `SELECT pg_catalog.pg_try_advisory_lock(${useKey("$1")})::text`, [key]),
					(taken) => taken === "true"
				)
			const dropped = yield* Effect.forEach(named, ({ database, template }) =>
				Effect.gen(function* () {
					switch (database.kind) {
						case "clone": {
							if (!(yield* free(database.owner))) {
								return Option.none<string>()
							}
							yield* run(
								admin,
								`DROP DATABASE IF EXISTS ${quoteIdent(database.name)} WITH (FORCE)`,
								[]
							)
							return Option.some<string>(database.name)
						}
						case "template": {
							const digest = Str.slice(
								cluster.prefix.length + 4,
								cluster.prefix.length + 20
							)(database.name)
							if (
								declared.has(database.name) ||
								!(yield* free(digest)) ||
								!(yield* unused(digest))
							) {
								return Option.none<string>()
							}
							if (template) {
								yield* run(
									admin,
									`ALTER DATABASE ${quoteIdent(database.name)} IS_TEMPLATE false`,
									[]
								)
							}
							yield* run(
								admin,
								`DROP DATABASE IF EXISTS ${quoteIdent(database.name)} WITH (FORCE)`,
								[]
							)
							return Option.some<string>(database.name)
						}
					}
				})
			)
			return { member: member.name, dropped: Arr.getSomes(dropped) }
		})
	)

/**
 * Collection, on every member of the cluster: the clones of workers that have ended (a crashed worker's included) and
 * the templates no declared template names, which `toolchain-test` runs with every template its properties declare
 * (templatesOf over each property's needs). A template's name is computed, never built (template.ts identify), so
 * collecting builds nothing.
 */
export const collect = (
	declared: ReadonlyArray<DatabaseTemplate>
): Effect.Effect<ReadonlyArray<Collected>, NeedFailed, PgCluster | ModuleClosure> =>
	Effect.gen(function* () {
		const cluster = yield* PgCluster
		const closures = yield* ModuleClosure
		const members = yield* cluster.members
		const identified = yield* Effect.scoped(
			Effect.flatMap(cluster.connect(Arr.headNonEmpty(members), cluster.maintenance), (session) =>
				Effect.forEach(declared, (template) => identify(cluster, closures, session, template))
			)
		)
		const names = new Set(Arr.flatMap(identified, chainNames))
		return yield* Effect.forEach(members, (member) => collectMember(member, names))
	})
