import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	Predicate,
	Record as Rec,
	String as Str
} from "effect"
import { templateClaimsTable } from "#pg/settle.ts"
import type { Needs } from "#property.ts"
import {
	type DatabasePrefix,
	lockKey,
	PgCluster,
	type PgMember,
	type PgSession,
	quoteIdent,
	run,
	single,
	useKey
} from "#resources/cluster.ts"
import { type Named, namedOf } from "#resources/names.ts"
import { DatabaseTemplate } from "#resources/template.ts"
import type { NeedFailed } from "#runner/services.ts"

/** The database templates a property's needs declare: each need over one (database.ts DatabaseNeed). */
export const templatesOf = (needs: Needs): ReadonlyArray<DatabaseTemplate> =>
	Arr.flatMap(Rec.values(needs), (need) =>
		Predicate.hasProperty(need, "template") && need.template instanceof DatabaseTemplate
			? [need.template]
			: []
	)

/** What collection dropped on one member, by name. */
export type Collected = Readonly<{ member: string; dropped: ReadonlyArray<string> }>

/**
 * A member's collection as it runs: its session in the owner's database, on which it tries every lock it reads (each
 * held until the collection ends, so a key it found free stays free while it drops), the cluster's prefix, and whether a
 * checkout a claim names still exists on this machine.
 */
export type Collector = Readonly<{
	admin: PgSession
	prefix: DatabasePrefix
	exists: (checkout: string) => Effect.Effect<boolean>
}>

/** One step of a member's collection (collectionPhases): what it dropped, by name. */
export type CollectionPhase = (
	collector: Collector
) => Effect.Effect<ReadonlyArray<string>, NeedFailed>

/** The databases this library made on the collector's member, as they are now, each with whether it is a template. */
const listed = (
	collector: Collector
): Effect.Effect<ReadonlyArray<Readonly<{ database: Named; template: boolean }>>, NeedFailed> =>
	Effect.map(
		run(
			collector.admin,
			"SELECT datname::text, datistemplate::text FROM pg_catalog.pg_database ORDER BY 1",
			[]
		),
		(rows) =>
			Arr.flatMap(rows, ([name, template]) =>
				Option.toArray(
					Option.map(namedOf(collector.prefix, name ?? ""), (database) => ({
						database,
						template: template === "true"
					}))
				)
			)
	)

/** Whether the collector took the advisory lock `key` (SQL over the 16 hex digits in $1) on its session: it was free. */
const took = (
	collector: Collector,
	key: string,
	digits: string
): Effect.Effect<boolean, NeedFailed> =>
	Effect.map(
		single(collector.admin, `SELECT pg_catalog.pg_try_advisory_lock(${key})::text`, [digits]),
		(taken) => taken === "true"
	)

/**
 * The templates under the collector's prefix some existing checkout claims (template.ts claimed), once the claims of
 * every checkout that no longer exists (a lane's workspace deleted, a worker tree removed) are dropped, of the
 * collector's prefix alone, as it drops nothing of another's: a template is kept while any live checkout
 * still uses that digest, whichever run collects, and a checkout's moving to another digest of the same logical
 * template gave up its claim of this one when it claimed the other. A workspace parked but kept keeps its claims, one
 * digest per logical template it used.
 */
const claimedNow = (collector: Collector): Effect.Effect<ReadonlySet<string>, NeedFailed> =>
	Effect.gen(function* () {
		const listedCheckouts = yield* run(
			collector.admin,
			`SELECT DISTINCT checkout FROM public.${templateClaimsTable} WHERE pg_catalog.starts_with(template, $1)`,
			[collector.prefix]
		)
		const checkouts = Arr.getSomes(
			Arr.map(listedCheckouts, ([checkout]) => Option.fromNullishOr(checkout))
		)
		const gone = yield* Effect.filter(checkouts, (checkout) =>
			Effect.map(collector.exists(checkout), (present) => !present)
		)
		yield* Effect.forEach(
			gone,
			(checkout) =>
				run(
					collector.admin,
					`DELETE FROM public.${templateClaimsTable} WHERE checkout = $1 AND pg_catalog.starts_with(template, $2)`,
					[checkout, collector.prefix]
				),
			{ discard: true }
		)
		const claimed = yield* run(
			collector.admin,
			`SELECT DISTINCT template FROM public.${templateClaimsTable} WHERE pg_catalog.starts_with(template, $1)`,
			[collector.prefix]
		)
		return new Set(Arr.getSomes(Arr.map(claimed, ([template]) => Option.fromNullishOr(template))))
	})

/**
 * Drops every template no existing checkout claims (claimedNow), unless a builder holds its gate or a live worker holds
 * it in use (template.ts holdInUse: another run's, of other properties or other code, a kill trial's among them), and
 * every template's build database (names.ts buildName) unless a builder holds its gate: one outside its build is a
 * builder's that ended mid-build. Where a template some other run's properties do not declare was dropped by that run,
 * so a lane and trunk on one cluster, at two closures, each dropped the other's builds and paid them cold again
 * (metis's SLOP-FIXER, 2026-11-21: "syzkaller metis world" built ten times over on metis-test-0, grizzle's base six
 * times on grizzle-test-0, the disk 6 TB free), a template now goes once no checkout that exists claims it. A template
 * is first made no template, which DROP DATABASE requires; a database a drop left invalid (dbcommands.c dropdb,
 * interrupted after it marked the database) is no template, and PostgreSQL lets nothing but a drop touch it, so it is
 * dropped as it is.
 */
const templatesCollected: CollectionPhase = (collector) =>
	Effect.gen(function* () {
		const claimed = yield* claimedNow(collector)
		const named = yield* listed(collector)
		const dropped = yield* Effect.forEach(named, ({ database, template }) =>
			Effect.gen(function* () {
				if (
					database.kind === "clone" ||
					(database.kind === "template" && claimed.has(database.name))
				) {
					return Option.none<string>()
				}
				const digest = Str.slice(
					collector.prefix.length + 4,
					collector.prefix.length + 20
				)(database.name)
				if (
					!(yield* took(collector, lockKey("$1"), digest)) ||
					(database.kind === "template" && !(yield* took(collector, useKey("$1"), digest)))
				) {
					return Option.none<string>()
				}
				if (template) {
					yield* run(
						collector.admin,
						`ALTER DATABASE ${quoteIdent(database.name)} IS_TEMPLATE false`,
						[]
					)
				}
				yield* run(
					collector.admin,
					`DROP DATABASE IF EXISTS ${quoteIdent(database.name)} WITH (FORCE)`,
					[]
				)
				return Option.some<string>(database.name)
			})
		)
		return Arr.getSomes(dropped)
	})

/** Drops every clone whose owner's lock is free: its worker has ended (cluster.ts Owner), a crashed one's included. */
const clonesCollected: CollectionPhase = (collector) =>
	Effect.map(
		Effect.flatMap(listed(collector), (named) =>
			Effect.forEach(named, ({ database }) =>
				Effect.gen(function* () {
					if (
						database.kind !== "clone" ||
						!(yield* took(collector, lockKey("$1"), database.owner))
					) {
						return Option.none<string>()
					}
					yield* run(
						collector.admin,
						`DROP DATABASE IF EXISTS ${quoteIdent(database.name)} WITH (FORCE)`,
						[]
					)
					return Option.some<string>(database.name)
				})
			)
		),
		Arr.getSomes
	)

/**
 * The order of a member's collection: its templates, then its clones, each read afresh. So no collection leaves a clone
 * of a template it drops, whatever worker ends while it runs: a clone is made only by a worker holding its template in
 * use (template.ts holdInUse), which it holds until it ends, so a template whose use key was free at its step has no
 * worker left that cloned it, and the clone step, reading the clones after, finds each such clone's owner lock free and
 * drops it; and while the collection holds a dropped template's gate and use key, no worker builds or opens it again.
 * Clones first would keep the clone of a worker still running at its step and drop its template once that worker ended,
 * and a later build of the template, which meets the cluster-wide objects its former build left (grizzle's template
 * roles), would meet them still owned in that clone (GZ: 2BP01 on gzt_3087783172732785_install__reader, its objects in
 * six clones of an ended worker whose template another run's collection had dropped).
 */
export const collectionPhases: ReadonlyArray<CollectionPhase> = [
	templatesCollected,
	clonesCollected
]

/** Drops, on one member, what no run may use again, by `phases` in order on one session (Collector). */
export const collectMemberBy =
	(phases: ReadonlyArray<CollectionPhase>) =>
	(member: PgMember): Effect.Effect<Collected, NeedFailed, PgCluster | FileSystem.FileSystem> =>
		Effect.scoped(
			Effect.gen(function* () {
				const cluster = yield* PgCluster
				const fs = yield* FileSystem.FileSystem
				const admin = yield* cluster.connect(member, cluster.maintenance)
				const collector: Collector = {
					admin,
					prefix: cluster.prefix,
					exists: (checkout) => Effect.orElseSucceed(fs.exists(checkout), () => true)
				}
				const dropped = yield* Effect.forEach(phases, (phase) => phase(collector))
				return { member: member.name, dropped: Arr.flatten(dropped) }
			})
		)

/**
 * Collection, on every member of the cluster: the clones of workers that have ended (a crashed worker's included) and
 * the templates no existing checkout claims (templatesCollected), which `toolchain-test` runs before and after a run
 * whose properties declare a template (runner/run.ts collected).
 */
export const collect: Effect.Effect<
	ReadonlyArray<Collected>,
	NeedFailed,
	PgCluster | FileSystem.FileSystem
> = Effect.gen(function* () {
	const cluster = yield* PgCluster
	const members = yield* cluster.members
	return yield* Effect.forEach(members, (member) => collectMemberBy(collectionPhases)(member))
})
