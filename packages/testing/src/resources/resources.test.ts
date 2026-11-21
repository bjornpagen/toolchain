/**
 * The per-case resources (resources/): a fresh clone holds its template's rows and its case's alone; a template is
 * built once however many open it at once; a template whose module's closure changed is a new one and the old is
 * collected, with the clones of a worker that ended; a pool never hands one clone twice, and clones only as its cases
 * ask, one ahead of its first case where every slot it may have made one at its open; a seat comes back to its
 * template after every case or is replaced, failing the case that left something; a transaction case is rolled back
 * and one that commits fails; a scratch directory is the case's own and gone after it. Run against the PostgreSQL
 * libpq's environment names (resources.fixtures.ts). Oracle: the specification, stated in each check.
 */
import {
	Array as Arr,
	Cause,
	Context,
	Deferred,
	Duration,
	Effect,
	Exit,
	Layer,
	Number as Num,
	Option,
	Ref,
	Scope,
	String as Str
} from "effect"
import { assert } from "#assert.ts"
import { awaitFact } from "#fact.ts"
import type { Reached } from "#features.ts"
import { array, boolean, finite, int } from "#gen.ts"
import { liveMillis, liveSleep, overrun } from "#live.ts"
import { Checkout } from "#mutate/checkout.ts"
import { type Case, property } from "#property.ts"
import { PgCluster, quoteIdent, run as runIn, single } from "#resources/cluster.ts"
import {
	type CollectionPhase,
	collect,
	collectMemberBy,
	collectionPhases
} from "#resources/collect.ts"
import { Database } from "#resources/database.ts"
import {
	countedConnections,
	derivedMarksTemplate,
	derivedTemplate,
	dropTemplate,
	exists,
	freshTemplate,
	inDatabase,
	localeCases,
	marksTemplate,
	ownCluster,
	runsOf,
	seatReset,
	seatTemplate,
	services,
	superuserSessionIn,
	superuserSessions,
	fixturesModule,
	templateNameOf,
	tokenTemplate,
	UTF8_COLLATIONS,
	unpopulatedViewTemplate
} from "#resources/resources.fixtures.ts"
import type { DatabaseTemplate } from "#resources/template.ts"
import { defineRunner, noMutation } from "#runner/config.ts"
import { collectedAround } from "#runner/run.ts"
import { ModuleClosure, WorkerIndex } from "#runner/services.ts"
import { deadlocks } from "#runner/work.fixtures.ts"
import { overrunText, ownCpu, ownWork, waitedOnNow } from "#runner/work.ts"

export const freshIsolation = property.explore(array(int(-5, 5), { min: 0, max: 6 }), {
	needs: { db: Database.fresh(marksTemplate), services },
	situations: ["a case writing no row", "a case writing several rows"],
	check:
		({ db, services: context }, c) =>
		(values) =>
			Effect.gen(function* () {
				c.note(values.length === 0 ? "a case writing no row" : "a case writing several rows")
				const ctx = yield* context
				const database = yield* db
				const seen = yield* Effect.provideContext(
					Effect.gen(function* () {
						const [[token] = []] = yield* inDatabase(
							database,
							"SELECT pg_catalog.gen_random_uuid()::text",
							[]
						)
						yield* Effect.forEach(
							values,
							(value) =>
								inDatabase(database, "INSERT INTO public.marks VALUES ($1, $2::int4)", [
									token ?? "",
									String(value)
								]),
							{ discard: true }
						)
						const rows = yield* inDatabase(
							database,
							"SELECT m.token, m.value::text FROM public.marks AS m WHERE m.token <> 'seed' ORDER BY m.value, m.token",
							[]
						)
						const settings = yield* inDatabase(
							database,
							"SELECT pg_catalog.current_setting('default_transaction_isolation'), pg_catalog.current_setting('search_path'), pg_catalog.has_database_privilege('pg_monitor', pg_catalog.current_database(), 'TEMPORARY')::text, pg_catalog.has_database_privilege('public', pg_catalog.current_database(), 'TEMPORARY')::text",
							[]
						)
						const origin = yield* inDatabase(
							database,
							"SELECT datistemplate::text, (NOT datallowconn)::text FROM pg_catalog.pg_database WHERE datname = $1::name",
							[database.template]
						)
						const seeds = yield* inDatabase(
							database,
							"SELECT pg_catalog.count(*)::text FROM public.marks WHERE token = 'seed'",
							[]
						)
						return { rows, token: token ?? "", seeds, settings, origin }
					}),
					ctx
				)
				assert.deepEqual(seen.seeds, [["1"]])
				assert.deepEqual(seen.origin, [["true", "true"]])
				assert.deepEqual(seen.settings, [
					["serializable", '"$user", public, pg_catalog', "true", "false"]
				])
				assert.deepEqual(
					seen.rows,
					Arr.map(Arr.sort(values, Num.Order), (value) => [seen.token, String(value)])
				)
			}),
	oracle: {
		kind: "specification",
		name: "a fresh clone holds its template's seed and the rows its own case wrote, and no other case's"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/resources/database.ts",
			original: "\t\t\t\tyield* Queue.offer(ready, { made, done })\n",
			replacement:
				"\t\t\t\tyield* Queue.offer(ready, { made, done })\n\t\t\t\tyield* Queue.offer(ready, { made, done })\n",
			why: "A slot offers each clone twice, so a second case is handed the database a first case wrote to, or already dropped; the property fails."
		},
		{
			file: "packages/testing/src/resources/template.ts",
			original: "yield* replayedOn(cluster, member, owner.session, replay(quoteIdent(made)))",
			replacement: "yield* Effect.void",
			why: "A clone is not given its template's settings and privileges, which CREATE DATABASE does not copy, so it serializes nothing by default and PUBLIC may create temporary tables in it; the property fails."
		},
		{
			file: "packages/testing/src/resources/template.ts",
			original: "return { member, name: made, template: name }",
			replacement: "return { member, name: made, template: made }",
			why: "A clone names itself as its template, so what a template's build made outside the database (roles named from its digest) cannot be found from a clone; the property fails."
		}
	]
})

export const derivedKeepsItsOrigin = property.explore(int(0, 3), {
	needs: { services },
	situations: [],
	check:
		({ services: context }) =>
		() =>
			Effect.gen(function* () {
				const ctx = yield* context
				const seen = yield* Effect.provideContext(
					Effect.gen(function* () {
						const cluster = yield* PgCluster
						const member = yield* Effect.map(cluster.members, Arr.headNonEmpty)
						const token = yield* Effect.scoped(
							Effect.flatMap(cluster.connect(member, cluster.maintenance), (session) =>
								single(session, "SELECT pg_catalog.gen_random_uuid()::text", [])
							)
						)
						const template = derivedMarksTemplate(token ?? "")
						const read = yield* Effect.scoped(
							Effect.gen(function* () {
								const opened = yield* template.open
								const clone = yield* opened.clone
								const session = yield* cluster.connect(clone.member, clone.name)
								const settings = yield* runIn(
									session,
									"SELECT pg_catalog.current_setting('default_transaction_isolation'), pg_catalog.current_setting('search_path'), pg_catalog.has_database_privilege('pg_monitor', pg_catalog.current_database(), 'TEMPORARY')::text, pg_catalog.has_database_privilege('public', pg_catalog.current_database(), 'TEMPORARY')::text",
									[]
								)
								const tables = yield* single(
									session,
									"SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename IN ('marks', 'derived')",
									[]
								)
								return { settings, tables, template: clone.template }
							})
						)
						yield* dropTemplate({ member, name: read.template })
						return { settings: read.settings, tables: read.tables }
					}),
					ctx
				)
				assert.deepEqual(seen, {
					settings: [["serializable", '"$user", public, pg_catalog', "true", "false"]],
					tables: "2"
				})
			}),
	oracle: {
		kind: "specification",
		name: "a template built from another keeps its origin's database settings and privileges, which CREATE DATABASE does not copy, and so does every clone of it"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/resources/template.ts",
			original: "\t\t\t\t\tonSome: (origin) => replayed(origin.name, building)\n",
			replacement: "\t\t\t\t\tonSome: () => Effect.void\n",
			why: "A template built from another is copied without its origin's settings and privileges, as before: grizzle's installTemplate over its base lost default_transaction_isolation and deadlock_timeout, and a build that writes failed (GZ-PG-RUNTIME); this property fails."
		}
	]
})

export const builtOnce = property.explore(int(2, 8), {
	needs: { services },
	situations: ["two builders at once", "many builders at once"],
	check:
		({ services: context }, c) =>
		(builders) =>
			Effect.gen(function* () {
				c.note(builders === 2 ? "two builders at once" : "many builders at once")
				const ctx = yield* context
				const builds = yield* Ref.make(0)
				const outcome = yield* Effect.provideContext(
					Effect.gen(function* () {
						const cluster = yield* PgCluster
						const member = yield* Effect.map(cluster.members, Arr.headNonEmpty)
						const token = yield* Effect.scoped(
							Effect.flatMap(cluster.connect(member, cluster.maintenance), (session) =>
								single(session, "SELECT pg_catalog.gen_random_uuid()::text", [])
							)
						)
						const template = tokenTemplate(token ?? "", () => Ref.update(builds, (n) => n + 1))
						const names = yield* Effect.forEach(
							Array.from({ length: builders }, () => template.open),
							(open) =>
								Effect.scoped(
									Effect.flatMap(open, (opened) => Effect.map(opened.clone, (clone) => clone.name))
								),
							{ concurrency: "unbounded" }
						)
						const built = yield* Effect.flatMap(cluster.members, (all) =>
							Effect.scoped(
								Effect.flatMap(
									cluster.connect(Arr.headNonEmpty(all), cluster.maintenance),
									(session) =>
										single(
											session,
											"SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_database WHERE datistemplate AND pg_catalog.shobj_description(oid, 'pg_database') LIKE $1",
											[`%token ${token ?? ""}%`]
										)
								)
							)
						)
						const templateName = yield* Effect.flatMap(cluster.members, (all) =>
							Effect.scoped(
								Effect.flatMap(
									cluster.connect(Arr.headNonEmpty(all), cluster.maintenance),
									(session) =>
										single(
											session,
											"SELECT datname::text FROM pg_catalog.pg_database WHERE pg_catalog.shobj_description(oid, 'pg_database') LIKE $1",
											[`%token ${token ?? ""}%`]
										)
								)
							)
						)
						yield* dropTemplate({ member, name: templateNameOf(templateName ?? "") })
						return { names, built }
					}),
					ctx
				)
				const buildsRun = yield* Ref.get(builds)
				assert.equal(buildsRun, 1)
				assert.equal(outcome.built, "1")
				assert.equal(new Set(outcome.names).size, builders)
			}),
	oracle: {
		kind: "specification",
		name: "concurrent openers of one template on one member build it once, each then cloning its own database"
	},
	kept: [],
	kills: []
})

export const templatesTakeNoSession = property.exhaust(finite(int(2, 8)), {
	box: "two to eight openers at once of one template whose build wrote",
	needs: { services },
	situations: [],
	check:
		({ services: context }) =>
		(cloners) =>
			Effect.gen(function* () {
				const ctx = yield* context
				const outcome = yield* Effect.provideContext(
					Effect.gen(function* () {
						const cluster = yield* PgCluster
						const member = yield* Effect.map(cluster.members, Arr.headNonEmpty)
						const inMaintenance = (statement: string, params: ReadonlyArray<string>) =>
							Effect.scoped(
								Effect.flatMap(cluster.connect(member, cluster.maintenance), (session) =>
									single(session, statement, params)
								)
							)
						const token = yield* inMaintenance("SELECT pg_catalog.gen_random_uuid()::text", [])
						const template = tokenTemplate(token ?? "", (target) =>
							Effect.flatMap(cluster.connect(target.member, target.name), (session) =>
								runIn(
									session,
									"CREATE TABLE rows AS SELECT g AS id FROM pg_catalog.generate_series(1, 100) AS g",
									[]
								)
							)
						)
						const names = yield* Effect.forEach(
							Array.from({ length: cloners }, () => template.open),
							(open) =>
								Effect.scoped(
									Effect.flatMap(open, (opened) => Effect.map(opened.clone, (clone) => clone.name))
								),
							{ concurrency: "unbounded" }
						)
						const templateName =
							(yield* inMaintenance(
								"SELECT datname::text FROM pg_catalog.pg_database WHERE datistemplate AND pg_catalog.shobj_description(oid, 'pg_database') LIKE $1",
								[`%token ${token ?? ""}%`]
							)) ?? ""
						const statistics = yield* inMaintenance(
							"SELECT pg_catalog.pg_stat_get_db_sessions(oid)::text FROM pg_catalog.pg_database WHERE datname = $1",
							[templateName]
						)
						const building = yield* inMaintenance(
							"SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_database WHERE datname = $1",
							[`${Str.slice(0, -36)(templateName)}tpb_${Str.slice(-32)(templateName)}`]
						)
						yield* dropTemplate({ member, name: templateNameOf(templateName) })
						return { cloned: new Set(names).size, statistics, building }
					}),
					ctx
				)
				assert.deepEqual(outcome, { cloned: cloners, statistics: "0", building: "0" })
			}),
	oracle: {
		kind: "specification",
		name: "a template whose build wrote is copied by concurrent openers, each its own clone, and no session has ever been in it, so PostgreSQL keeps no statistics of it and autovacuum never enters it; its build's database is gone"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/resources/template.ts",
			original: `\t\t\t\t\t\`CREATE DATABASE \${quoteIdent(name)} TEMPLATE \${quoteIdent(building)} STRATEGY \${strategy}\`,\n`,
			replacement: `\t\t\t\t\t\`ALTER DATABASE \${quoteIdent(building)} RENAME TO \${quoteIdent(name)}\`,\n`,
			why: "The template is the database its build ran in, as it was: PostgreSQL keeps its statistics, so autovacuum enters it and holds up every copy of it, which CREATE DATABASE refuses when the worker has not left in five seconds (metis's 5451, 2026-11-20: sixteen copies refused); the property fails."
		}
	]
})

export const refusedDropCollected = property.exhaust(finite(int(1, 3)), {
	box: "one to three clones whose drop is refused at their case's end, in one run",
	needs: { services, checkout: Checkout.dir },
	situations: [],
	check:
		({ services: context, checkout }) =>
		(clones) =>
			Effect.gen(function* () {
				const ctx = yield* context
				const root = yield* checkout
				const worker = Context.get(ctx, WorkerIndex)
				const token = yield* Effect.provideContext(
					Effect.gen(function* () {
						const cluster = yield* PgCluster
						const member = yield* Effect.map(cluster.members, Arr.headNonEmpty)
						return yield* Effect.scoped(
							Effect.flatMap(cluster.connect(member, cluster.maintenance), (session) =>
								single(
									session,
									"SELECT pg_catalog.substr(pg_catalog.md5(pg_catalog.gen_random_uuid()::text), 1, 12)",
									[]
								)
							)
						)
					}),
					ctx
				)
				const prefix = `tcr${token ?? ""}_`
				const template = tokenTemplate(prefix, () => Effect.void)
				const runnerClosures = Context.get(ctx, ModuleClosure)
				const config = defineRunner({
					include: [],
					smallStack: [],
					conditions: [],
					layer: ownCluster(prefix),
					mutation: noMutation
				})
				const run = Effect.scoped(
					Effect.gen(function* () {
						const cluster = yield* Layer.build(ownCluster(prefix))
						return yield* Effect.provideContext(
							Effect.gen(function* () {
								const opened = yield* template.open
								return yield* Effect.forEach(
									Array.from({ length: clones }, (_, at) => at),
									() =>
										Effect.gen(function* () {
											const holding = yield* Scope.make()
											const made = yield* Effect.scoped(
												Effect.gen(function* () {
													const clone = yield* opened.clone
													yield* Scope.provide(superuserSessionIn(clone), holding)
													yield* awaitFact(
														Effect.map(superuserSessions(clone), (sessions) =>
															sessions > 0 ? Option.some(true) : Option.none()
														)
													)
													return clone
												})
											)
											const refused = yield* exists(made)
											yield* Scope.close(holding, Exit.void)
											yield* awaitFact(
												Effect.map(superuserSessions(made), (sessions) =>
													sessions === 0 ? Option.some(true) : Option.none()
												)
											)
											return { made, refused }
										})
								)
							}),
							Context.merge(
								cluster,
								Context.merge(
									Context.make(ModuleClosure, {
										hashOf: () => runnerClosures.hashOf(fixturesModule)
									}),
									Context.make(WorkerIndex, worker)
								)
							)
						)
					})
				)
				const ran = yield* collectedAround(config, root, [template])(run)
				const after = yield* Effect.scoped(
					Effect.flatMap(Layer.build(ownCluster(prefix)), (cluster) =>
						Effect.provideContext(
							Effect.forEach(ran, ({ made }) => exists(made)),
							cluster
						)
					)
				)
				assert.deepEqual(
					{ refused: Arr.map(ran, ({ refused }) => refused), survived: after },
					{
						refused: Array.from({ length: clones }, () => true),
						survived: Array.from({ length: clones }, () => false)
					}
				)
			}),
	oracle: {
		kind: "specification",
		name: "a clone whose drop the server refused when its case ended, a session the owner cannot end still in it, does not fail the case, and the collection at its run's end drops it once that session has gone"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/run.ts",
			original: "\t\t\tEffect.ensuring(effect, collected(config, root, templates))\n",
			replacement: "\t\t\teffect\n",
			why: "A run collects the cluster only before it, as it did: a clone whose drop was refused at its case's end outlives the run, and every such clone a run leaves stays until another run (metis's 5451, 2026-11-20: a clone's DROP refused under autovacuum, its clones and templates left by the thousand); the property fails."
		}
	]
})

export const pooledOnce = property.explore(array(boolean, { min: 1, max: 12 }), {
	needs: { services },
	situations: ["takers one after another", "takers at once"],
	check:
		({ services: context }, c) =>
		(atOnce) =>
			Effect.gen(function* () {
				c.note(Arr.some(atOnce, (b) => b) ? "takers at once" : "takers one after another")
				const ctx = yield* context
				const held = yield* Ref.make<ReadonlySet<string>>(new Set())
				const taken = yield* Ref.make<ReadonlyArray<string>>([])
				const twice = yield* Ref.make(false)
				yield* Effect.provideContext(
					Effect.scoped(
						Effect.gen(function* () {
							const take = yield* Database.fresh(marksTemplate).open
							const takeOne = Effect.scoped(
								Effect.gen(function* () {
									const database = yield* take
									const already = yield* Ref.modify(
										held,
										(names): readonly [boolean, ReadonlySet<string>] => [
											names.has(database.name),
											new Set([...names, database.name])
										]
									)
									if (already) {
										yield* Ref.set(twice, true)
									}
									yield* Ref.update(taken, (names) => [...names, database.name])
									yield* Effect.yieldNow
									yield* Ref.update(
										held,
										(names) => new Set(Arr.filter([...names], (name) => name !== database.name))
									)
								})
							)
							yield* Effect.forEach(
								runsOf(atOnce),
								(run) =>
									Effect.forEach(run, () => takeOne, { concurrency: "unbounded", discard: true }),
								{ discard: true }
							)
						})
					),
					ctx
				)
				const names = yield* Ref.get(taken)
				const handedTwice = yield* Ref.get(twice)
				assert.ok(!handedTwice)
				assert.equal(new Set(names).size, names.length)
			}),
	oracle: { kind: "specification", name: "a pool hands each clone to one case, never to two" },
	kept: [],
	kills: []
})

export const clonedAsAsked = property.explore(int(0, 50), {
	needs: { services },
	situations: [],
	check:
		({ services: context }) =>
		(holdMillis) =>
			Effect.gen(function* () {
				const ctx = yield* context
				const started = yield* Ref.make(0)
				const counted: DatabaseTemplate = {
					kind: marksTemplate.kind,
					key: marksTemplate.key,
					declaredIn: marksTemplate.declaredIn,
					name: marksTemplate.name,
					content: marksTemplate.content,
					from: marksTemplate.from,
					build: marksTemplate.build,
					open: Effect.map(marksTemplate.open, (opened) => ({
						clone: Effect.andThen(
							Ref.update(started, (clones) => clones + 1),
							opened.clone
						)
					}))
				}
				const startedInCase = yield* Effect.provideContext(
					Effect.scoped(
						Effect.gen(function* () {
							const take = yield* Database.fresh(counted).open
							return yield* Effect.scoped(
								Effect.gen(function* () {
									yield* take
									yield* liveSleep(`${holdMillis} millis`)
									return yield* Ref.get(started)
								})
							)
						})
					),
					ctx
				)
				assert.ok(startedInCase <= 2)
			}),
	oracle: {
		kind: "specification",
		name: "a pool clones as its cases ask: by its first case's end it has started that case's clone and at most one more"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/resources/database.ts",
			original: "\t\t\tyield* grown\n\t\t\treturn { ready, grown }",
			replacement:
				"\t\t\tyield* grown\n\t\t\tyield* grown\n\t\t\tyield* grown\n\t\t\tyield* grown\n\t\t\treturn { ready, grown }",
			why: "A pool opens every slot it may have with its need, as before, each making a clone at once and again after each case it serves, for cases that may never come (SS-CONV: four standby clones at 19.2 ms of PostgreSQL's CPU each for a worker of a few batches); this property fails."
		}
	]
})

export const staleCollected = property.explore(int(1, 3), {
	needs: { services },
	situations: ["one clone of an ended worker", "several clones of an ended worker"],
	check:
		({ services: context }, c) =>
		(clones) =>
			Effect.gen(function* () {
				c.note(clones === 1 ? "one clone of an ended worker" : "several clones of an ended worker")
				const ctx = yield* context
				const worker = Context.get(ctx, WorkerIndex)
				const outcome = yield* Effect.scoped(
					Effect.gen(function* () {
						const prefixToken = yield* Effect.provideContext(
							Effect.gen(function* () {
								const cluster = yield* PgCluster
								const member = yield* Effect.map(cluster.members, Arr.headNonEmpty)
								return yield* Effect.scoped(
									Effect.flatMap(cluster.connect(member, cluster.maintenance), (session) =>
										single(
											session,
											"SELECT pg_catalog.substr(pg_catalog.md5(pg_catalog.gen_random_uuid()::text), 1, 12)",
											[]
										)
									)
								)
							}),
							ctx
						)
						const prefix = `tcs${prefixToken ?? ""}_`
						const template = tokenTemplate(prefix, () => Effect.void)
						const runnerClosures = Context.get(ctx, ModuleClosure)
						const closure = (module: string) =>
							Context.make(ModuleClosure, { hashOf: () => runnerClosures.hashOf(module) })
						const ended = yield* Scope.make()
						const endedCluster = yield* Scope.provide(Layer.build(ownCluster(prefix)), ended)
						const left = yield* Effect.provideContext(
							Effect.gen(function* () {
								const opened = yield* template.open
								return yield* Effect.forEach(
									Array.from({ length: clones }, () => opened.clone),
									(clone) => clone
								)
							}),
							Context.merge(
								endedCluster,
								Context.merge(closure(fixturesModule), Context.make(WorkerIndex, worker))
							)
						)
						yield* Scope.close(ended, Exit.void)
						const alive = yield* Scope.make()
						const live = yield* Scope.provide(Layer.build(ownCluster(prefix)), alive)
						const inLive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
							Effect.provideContext(
								effect,
								Context.merge(
									live,
									Context.merge(closure(import.meta.url), Context.make(WorkerIndex, worker))
								)
							)
						const current = yield* Scope.provide(
							inLive(Effect.flatMap(template.open, (opened) => opened.clone)),
							alive
						)
						const collected = yield* inLive(collect([template]))
						const gone = yield* inLive(
							Effect.forEach(left, (database) => Effect.map(exists(database), (found) => !found))
						)
						const kept = yield* inLive(exists(current))
						yield* Scope.close(alive, Exit.void)
						const after = yield* Layer.build(ownCluster(prefix))
						yield* Effect.provideContext(
							collect([]),
							Context.merge(after, closure(import.meta.url))
						)
						return { collected, gone, kept }
					})
				)
				assert.ok(Arr.every(outcome.gone, (gone) => gone))
				assert.ok(outcome.kept)
				assert.equal(Arr.flatMap(outcome.collected, (member) => member.dropped).length, clones + 1)
			}),
	oracle: {
		kind: "specification",
		name: "collection drops the clones of an ended worker and the template no declaration names, and keeps the declared one"
	},
	kept: [],
	kills: []
})

export const inUseKept = property.exhaust(
	finite((source) => ({ derived: source.draw(boolean), ended: source.draw(boolean) })),
	{
		box: "a template alone or built from another, its opener's worker alive or ended",
		needs: { services },
		situations: ["a live opener", "an ended opener", "a template built from another"],
		check:
			({ services: context }, c) =>
			({ derived, ended }) =>
				Effect.gen(function* () {
					c.note(ended ? "an ended opener" : "a live opener")
					if (derived) {
						c.note("a template built from another")
					}
					const ctx = yield* context
					const worker = Context.get(ctx, WorkerIndex)
					const runner = Context.make(ModuleClosure, Context.get(ctx, ModuleClosure)).pipe(
						Context.add(WorkerIndex, worker)
					)
					const outcome = yield* Effect.scoped(
						Effect.gen(function* () {
							const cluster = Context.get(ctx, PgCluster)
							const member = yield* Effect.map(cluster.members, Arr.headNonEmpty)
							const prefixToken = yield* Effect.scoped(
								Effect.flatMap(cluster.connect(member, cluster.maintenance), (session) =>
									Effect.flatMap(
										single(
											session,
											"SELECT pg_catalog.substr(pg_catalog.md5(pg_catalog.gen_random_uuid()::text), 1, 12)",
											[]
										),
										(drawn) => Effect.fromOption(Option.fromNullishOr(drawn))
									)
								)
							)
							const prefix = `tcs${prefixToken}_`
							const own = tokenTemplate(prefix, () => Effect.void)
							const template = derived ? derivedTemplate(own, prefix) : own
							const templates = Effect.scoped(
								Effect.flatMap(cluster.connect(member, cluster.maintenance), (session) =>
									single(
										session,
										"SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_database WHERE pg_catalog.starts_with(datname, $1)",
										[`${prefix}tpl_`]
									)
								)
							)
							const opener = yield* Scope.make()
							const openers = yield* Scope.provide(Layer.build(ownCluster(prefix)), opener)
							yield* Effect.provideContext(
								Scope.provide(
									Effect.flatMap(template.open, (opened) => opened.clone),
									opener
								),
								Context.merge(openers, runner)
							)
							const built = yield* templates
							if (ended) {
								yield* Scope.close(opener, Exit.void)
							}
							const collector = yield* Layer.build(ownCluster(prefix))
							yield* Effect.provideContext(collect([]), Context.merge(collector, runner))
							const kept = yield* templates
							yield* Scope.close(opener, Exit.void)
							yield* Effect.provideContext(collect([]), Context.merge(collector, runner))
							const left = yield* templates
							return { built, kept, left }
						})
					)
					const chain = derived ? "2" : "1"
					assert.deepEqual(outcome, { built: chain, kept: ended ? "0" : chain, left: "0" })
				}),
		oracle: {
			kind: "specification",
			name: "another run's collection keeps a template a live worker opened, and every origin it was built from, and drops them once that worker has ended"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/resources/template.ts",
				original: "\t\tyield* holdInUse(owner, identified)\n",
				replacement: "",
				why: "An opener holds nothing in use, as before: another run's collection drops a template a live worker still clones from (and a kill trial's, once its identity is its own); this property fails."
			},
			{
				file: "packages/testing/src/resources/collect.ts",
				original:
					'\t\t\t\t\t\t!(yield* took(collector, lockKey("$1"), digest)) ||\n\t\t\t\t\t\t(database.kind === "template" && !(yield* took(collector, useKey("$1"), digest)))',
				replacement: '\t\t\t\t\t\t!(yield* took(collector, lockKey("$1"), digest))',
				why: "Collection drops a template whatever worker holds it in use; this property fails."
			},
			{
				file: "packages/testing/src/resources/template.ts",
				original: "\t\t\tonSome: (origin) => holdInUse(owner, origin)",
				replacement: "\t\t\tonSome: () => Effect.void",
				why: "An opener holds its template in use but not the origin it was built from, which another run's collection then drops under a live worker; this property fails."
			}
		]
	}
)

export const cloneOutlivesNoTemplate = property.exhaust(
	finite((source) => source.draw(int(0, collectionPhases.length))),
	{
		box: "where among a collection's phases the worker that cloned a template ends, its clone left behind",
		needs: { services },
		situations: [
			"the opener ends before the collection",
			"the opener ends between its phases",
			"the opener ends after it"
		],
		check:
			({ services: context }, c) =>
			(at) =>
				Effect.gen(function* () {
					c.note(
						at === 0
							? "the opener ends before the collection"
							: at === collectionPhases.length
								? "the opener ends after it"
								: "the opener ends between its phases"
					)
					const ctx = yield* context
					const runner = Context.make(ModuleClosure, Context.get(ctx, ModuleClosure)).pipe(
						Context.add(WorkerIndex, Context.get(ctx, WorkerIndex))
					)
					const outcome = yield* Effect.scoped(
						Effect.gen(function* () {
							const cluster = Context.get(ctx, PgCluster)
							const member = yield* Effect.map(cluster.members, Arr.headNonEmpty)
							const prefixToken = yield* Effect.scoped(
								Effect.flatMap(cluster.connect(member, cluster.maintenance), (session) =>
									Effect.flatMap(
										single(
											session,
											"SELECT pg_catalog.substr(pg_catalog.md5(pg_catalog.gen_random_uuid()::text), 1, 12)",
											[]
										),
										(drawn) => Effect.fromOption(Option.fromNullishOr(drawn))
									)
								)
							)
							const prefix = `tcs${prefixToken}_`
							const template = tokenTemplate(prefix, () => Effect.void)
							const opener = yield* Scope.make()
							const openers = yield* Scope.provide(Layer.build(ownCluster(prefix)), opener)
							const clone = yield* Effect.provideContext(
								Effect.flatMap(template.open, (opened) => opened.clone),
								Context.merge(openers, runner)
							)
							const ending: CollectionPhase = () => Effect.as(Scope.close(opener, Exit.void), [])
							const collecting = yield* Layer.build(ownCluster(prefix))
							const collector = Context.merge(collecting, runner)
							const present = Effect.provideContext(
								Effect.all({
									template: exists({ member: clone.member, name: clone.template }),
									clone: exists(clone)
								}),
								collector
							)
							yield* Effect.provideContext(
								collectMemberBy([
									...Arr.take(collectionPhases, at),
									ending,
									...Arr.drop(collectionPhases, at)
								])(clone.member, new Set()),
								collector
							)
							const after = yield* present
							yield* Effect.provideContext(collect([]), collector)
							return { after, left: yield* present }
						})
					)
					assert.ok(outcome.after.template || !outcome.after.clone)
					assert.deepEqual(outcome.left, { template: false, clone: false })
				}),
		oracle: {
			kind: "specification",
			name: "a collection never leaves a clone of a template it drops, whenever the worker that cloned it ends, and the next drops both"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/resources/collect.ts",
				original: "\ttemplatesCollected,\n\tclonesCollected\n]",
				replacement: "\tclonesCollected,\n\ttemplatesCollected\n]",
				why: "Collection drops clones before templates, as before: a worker that ends between the steps keeps its clone (its owner lock held at the clone step) and loses its template (its use key free at the template step), and the next build of the template meets its former build's roles still owned in that clone (grizzle's forms#seated: 2BP01); this property fails."
			}
		]
	}
)

export const seatOverUnpopulatedView = property.exhaust(finite(boolean), {
	box: "a case that refreshes the view and one that leaves it",
	needs: { services },
	situations: [],
	check:
		({ services: context }) =>
		(refreshes) =>
			Effect.gen(function* () {
				const ctx = yield* context
				const seen = yield* Effect.provideContext(
					Effect.scoped(
						Effect.gen(function* () {
							const take = yield* Database.seat(unpopulatedViewTemplate, seatReset).open
							const first = yield* Scope.make()
							const database = yield* Scope.provide(take, first)
							yield* inDatabase(database, "INSERT INTO public.items (value) VALUES (1)", [])
							if (refreshes) {
								yield* inDatabase(database, "REFRESH MATERIALIZED VIEW public.tallies", [])
							}
							const closed = yield* Effect.exit(Scope.close(first, Exit.void))
							const populated = yield* Effect.scoped(
								Effect.gen(function* () {
									const next = yield* take
									return yield* inDatabase(
										next,
										"SELECT relispopulated::text FROM pg_catalog.pg_class WHERE oid = 'public.tallies'::regclass",
										[]
									)
								})
							)
							return { left: Exit.isFailure(closed), populated }
						})
					),
					ctx
				)
				assert.deepEqual(seen, { left: refreshes, populated: [["false"]] })
			}),
	oracle: {
		kind: "specification",
		name: "a seat opens on a template whose materialized view holds no data; a case's REFRESH of it leaves the seat unlike its template, which fails that case, and never reaches the next"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/resources/database.ts",
			original: "\t\tWHEN c.relkind = 'm' AND NOT c.relispopulated\n",
			replacement: "\t\tWHEN false\n",
			why: "A seat's fingerprint reads every materialized view's rows, as before, and an unpopulated one refuses the read (55000), so a seat over grizzle's docs world or rule-seeding's viewed shape cannot open; this property fails."
		}
	]
})

export const seatSettles = property.explore(
	(source) => ({
		values: source.draw(array(int(0, 9), { min: 0, max: 5 })),
		leaks: source.draw(boolean)
	}),
	{
		needs: { services },
		situations: ["a seat reset after rows", "a seat replaced after a leak"],
		check:
			({ services: context }, c) =>
			({ values, leaks }) =>
				Effect.gen(function* () {
					c.note(leaks ? "a seat replaced after a leak" : "a seat reset after rows")
					const shared = yield* context
					const open = yield* Ref.make(0)
					const ctx = Context.add(
						shared,
						PgCluster,
						countedConnections(Context.get(shared, PgCluster), open)
					)
					const outcome = yield* Effect.provideContext(
						Effect.scoped(
							Effect.gen(function* () {
								const take = yield* Database.seat(seatTemplate, seatReset).open
								const first = yield* Scope.make()
								const database = yield* Scope.provide(take, first)
								yield* Effect.forEach(
									values,
									(value) =>
										inDatabase(database, "INSERT INTO public.items (value) VALUES ($1::int4)", [
											String(value)
										]),
									{ discard: true }
								)
								yield* inDatabase(database, "SELECT pg_catalog.nextval('public.tickets')::text", [])
								if (leaks) {
									yield* inDatabase(database, "INSERT INTO public.ledger VALUES ('leak')", [])
								}
								const closed = yield* Effect.exit(Scope.close(first, Exit.void))
								const between = yield* Ref.get(open)
								const again = yield* Effect.scoped(
									Effect.gen(function* () {
										const next = yield* take
										const items = yield* inDatabase(
											next,
											"SELECT pg_catalog.count(*)::text FROM public.items",
											[]
										)
										const ledger = yield* inDatabase(
											next,
											"SELECT entry FROM public.ledger ORDER BY 1",
											[]
										)
										const ticket = yield* inDatabase(
											next,
											"SELECT pg_catalog.nextval('public.tickets')::text",
											[]
										)
										const id = yield* inDatabase(
											next,
											"INSERT INTO public.items (value) VALUES (0) RETURNING id::text",
											[]
										)
										return { name: next.name, items, ledger, ticket, id }
									})
								)
								return { closed, between, again, first: database.name }
							})
						),
						ctx
					)
					assert.equal(Exit.isFailure(outcome.closed), leaks)
					assert.equal(outcome.between, 0)
					assert.equal(outcome.again.name !== outcome.first, leaks)
					assert.deepEqual(outcome.again.items, [["0"]])
					assert.deepEqual(outcome.again.ledger, [["seed"]])
					assert.deepEqual(outcome.again.ticket, [["2"]])
					assert.deepEqual(outcome.again.id, [["1"]])
				}),
		oracle: {
			kind: "specification",
			name: "a seat is its template again after every case (reset, sequences put back), or is replaced and the case fails"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/resources/database.ts",
				original: "const read = yield* Effect.scoped(",
				replacement: "const read = yield* Scope.provide(scope)(",
				why: "A held clone keeps the session its baseline was read on for its life, so a worker holds a connection per seat template between cases, against its lease; the property fails."
			}
		]
	}
)

export const transactionsRollBack = property.explore(
	(source) => ({
		values: source.draw(array(int(0, 9), { min: 0, max: 5 })),
		commits: source.draw(boolean)
	}),
	{
		needs: { services },
		situations: ["a case rolled back", "a case that commits"],
		check:
			({ services: context }, c) =>
			({ values, commits }) =>
				Effect.gen(function* () {
					c.note(commits ? "a case that commits" : "a case rolled back")
					const ctx = yield* context
					const outcome = yield* Effect.provideContext(
						Effect.scoped(
							Effect.gen(function* () {
								const take = yield* Database.transaction(seatTemplate).open
								const first = yield* Scope.make()
								const transaction = yield* Scope.provide(take, first)
								yield* Effect.forEach(
									values,
									(value) =>
										transaction.session.query(
											"INSERT INTO public.items (value) VALUES ($1::int4)",
											[String(value)]
										),
									{ discard: true }
								)
								if (commits) {
									yield* transaction.session.query("COMMIT", [])
								}
								const closed = yield* Effect.exit(Scope.close(first, Exit.void))
								const items = yield* Effect.scoped(
									Effect.flatMap(take, (next) =>
										next.session.query("SELECT pg_catalog.count(*)::text FROM public.items", [])
									)
								)
								return { closed, items }
							})
						),
						ctx
					)
					assert.equal(Exit.isFailure(outcome.closed), commits)
					assert.equal(
						Exit.match(outcome.closed, { onFailure: Cause.hasDies, onSuccess: () => false }),
						commits
					)
					assert.deepEqual(outcome.items, [["0"]])
				}),
		oracle: {
			kind: "specification",
			name: "a transaction case leaves nothing behind, and one that commits fails and leaves nothing either"
		},
		kept: [],
		kills: []
	}
)

type LocaleFeature = "orders unlike code points" | "refused"

/**
 * A template built fresh (Template.fresh) is template0 copied in its locale, which its clones keep: a clone's default
 * collation is that locale, and orders two texts as the member's libc collation of that locale orders them, unlike their
 * code points where the locale says so (`a` before `B` in en_US.UTF-8); the same declaration in two locales is two
 * templates, since the locale is part of the identity; and a locale the member has not is refused, as the template's
 * open failing with its own NeedFailed, before any database is made.
 */
export const freshInItsLocale = property.explore(localeCases, {
	needs: { services },
	situations: ["orders unlike code points", "refused"] satisfies ReadonlyArray<
		Reached<LocaleFeature>
	>,
	check:
		({ services: context }, c: Case<LocaleFeature>) =>
		(asked) =>
			Effect.gen(function* () {
				const ctx = yield* context
				yield* Effect.provideContext(
					Effect.gen(function* () {
						const cluster = yield* PgCluster
						const member = yield* Effect.map(cluster.members, Arr.headNonEmpty)
						const facts = yield* Effect.scoped(
							Effect.flatMap(cluster.connect(member, cluster.maintenance), (session) =>
								Effect.all({
									token: single(session, "SELECT pg_catalog.gen_random_uuid()::text", []),
									collations: runIn(session, UTF8_COLLATIONS, [])
								})
							)
						)
						const token = facts.token ?? ""
						const collation = Arr.get(
							facts.collations,
							asked.pick % Math.max(1, facts.collations.length)
						)
						if (!asked.known || Option.isNone(collation)) {
							c.note("refused")
							const refused = yield* Effect.flip(
								Effect.scoped(freshTemplate(asked.unknown, token).open)
							)
							assert.equal(
								refused.need,
								freshTemplate(asked.unknown, token).key,
								`a template in ${asked.unknown}, which the member has not, is refused as its own need's failure`
							)
							return
						}
						const [name = "", given = ""] = collation.value
						const locale = given ?? ""
						const template = freshTemplate(locale, token)
						assert.notEqual(
							template.key,
							freshTemplate(`${locale}-other`, token).key,
							"the locale is part of a template's identity"
						)
						const read = yield* Effect.scoped(
							Effect.gen(function* () {
								const opened = yield* template.open
								const clone = yield* opened.clone
								const session = yield* cluster.connect(clone.member, clone.name)
								const ordered = yield* runIn(
									session,
									"SELECT ($1 < $2)::text, d.datcollate, d.datlocprovider::text FROM pg_catalog.pg_database AS d WHERE d.datname = pg_catalog.current_database()",
									[asked.left, asked.right]
								)
								return { ordered, template: clone.template }
							})
						)
						const reference = yield* Effect.scoped(
							Effect.flatMap(cluster.connect(member, cluster.maintenance), (session) =>
								single(session, `SELECT ($1 COLLATE ${quoteIdent(name ?? "")} < $2)::text`, [
									asked.left,
									asked.right
								])
							)
						)
						yield* dropTemplate({ member, name: read.template })
						if (reference !== `${asked.left < asked.right}`) {
							c.note("orders unlike code points")
						}
						assert.deepEqual(
							read.ordered,
							[[reference, locale, "c"]],
							`a clone of a template in ${locale} collates in it and orders text as its libc collation does`
						)
					}),
					ctx
				)
			}),
	oracle: {
		kind: "postgresql",
		name: "the member's own libc collation of the locale, against the clone's default collation"
	},
	kept: [],
	kills: []
})

export const cloneDropWaitIsDeclared = property.exhaust(finite(deadlocks), {
	box: "a clone's drop held for six deadlines by a lock its case's own session holds on the clone, under a deadline of 150 or 300 ms",
	needs: { services },
	situations: [],
	check:
		({ services: context }) =>
		(shape) =>
			Effect.flatMap(context, (ctx) =>
				Effect.provideContext(
					Effect.scoped(
						Effect.gen(function* () {
							const cluster = yield* PgCluster
							const opened = yield* marksTemplate.open
							const outer = yield* Effect.scope
							const holding = yield* Scope.make()
							const named = yield* Deferred.make<string>()
							const seen =
								yield* Deferred.make<Readonly<{ open: ReadonlyArray<string>; survived: boolean }>>()
							const held = Duration.millis(shape.deadline * shape.deadlines)
							const dropped = Effect.scoped(
								Effect.gen(function* () {
									const clone = yield* opened.clone
									yield* Deferred.succeed(named, clone.name)
									const session = yield* Scope.provide(
										cluster.connect(clone.member, clone.name),
										holding
									)
									yield* runIn(session, "BEGIN", [])
									yield* runIn(
										session,
										`COMMENT ON DATABASE ${quoteIdent(clone.name)} IS 'held'`,
										[]
									)
									const released = Effect.gen(function* () {
										yield* liveSleep(held)
										const open = waitedOnNow()
										yield* runIn(session, "COMMIT", [])
										const survived = yield* Effect.isSuccess(
											runIn(session, "SELECT pg_catalog.pg_backend_pid()::text", [])
										)
										yield* Deferred.succeed(seen, { open, survived })
										yield* Scope.close(holding, Exit.void)
									})
									yield* Effect.forkIn(Effect.orDie(released), outer)
								})
							)
							const wall = yield* liveMillis
							const verdict = yield* Effect.raceFirst(
								Effect.as(dropped, "passed"),
								Effect.map(overrun(ownWork(wall, ownCpu()), shape.deadline), overrunText)
							)
							const clone = yield* Deferred.await(named)
							const after = yield* Deferred.await(seen)
							assert.deepEqual(
								{
									verdict,
									named: Arr.contains(after.open, `DROP DATABASE IF EXISTS ${quoteIdent(clone)}`),
									survived: after.survived
								},
								{ verdict: "passed", named: true, survived: true }
							)
						})
					),
					ctx
				)
			),
	oracle: {
		kind: "specification",
		name: "a clone's drop that waits on the member past its case's deadline, behind a lock its case's own session holds on the clone, is a declared wait named by its statement: the case's guard judges none of it, this process's open waits name it while it waits, and it ends no session of the case's"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/resources/cluster.ts",
			original:
				"\twaitingOn(sql)(Effect.flatMap(session.query(sql, params), (rows) => textRows(sql, rows)))\n",
			replacement: "\tEffect.flatMap(session.query(sql, params), (rows) => textRows(sql, rows))\n",
			why: "The library's statements are no declared waits, as its clone DDL was: a clone's drop behind the member's work is the case's silence, and its guard judges it hung (metis's 5451, 2026-11-20: hung at 22 ms of CPU over 60 s inside a clone's DROP DATABASE); the property fails, the drop judged."
		},
		{
			file: "packages/testing/src/runner/work.ts",
			original: "\tledger.on = [...ledger.on, on]\n",
			replacement: "\tledger.on = ledger.on\n",
			why: "A declared wait names nothing, so a verdict on a case inside one says only that it waited, not on what; the property fails, the drop's wait unnamed."
		},
		{
			file: "packages/testing/src/resources/template.ts",
			original: `run(owner.session, \`DROP DATABASE IF EXISTS \${quoteIdent(made)}\`, [])`,
			replacement: `run(owner.session, \`DROP DATABASE IF EXISTS \${quoteIdent(made)} WITH (FORCE)\`, [])`,
			why: "A clone's drop ends the sessions still in it, as it did, so a session of the case's dies under the client that holds it once the drop has its lock, where only the run's collection should end one; the property fails, the session ended."
		}
	]
})

export const roleSettingCloned = property.explore(int(0, 3), {
	needs: { services },
	situations: [],
	check:
		({ services: context }) =>
		() =>
			Effect.flatMap(context, (ctx) =>
				Effect.provideContext(
					Effect.gen(function* () {
						const cluster = yield* PgCluster
						const member = yield* Effect.map(cluster.members, Arr.headNonEmpty)
						const token = yield* Effect.scoped(
							Effect.flatMap(cluster.connect(member, cluster.maintenance), (session) =>
								single(
									session,
									"SELECT pg_catalog.substr(pg_catalog.md5(pg_catalog.gen_random_uuid()::text), 1, 12)",
									[]
								)
							)
						)
						const login = `tcl_${token ?? ""}`
						const asSuperuser = (statements: ReadonlyArray<string>) =>
							Effect.scoped(
								Effect.flatMap(cluster.superuser(member, cluster.maintenance), (superuser) =>
									Effect.forEach(statements, (statement) => runIn(superuser, statement, []), {
										discard: true
									})
								)
							)
						const template = tokenTemplate(`role setting ${login}`, (target) =>
							asSuperuser([
								`CREATE ROLE ${quoteIdent(login)} LOGIN`,
								`ALTER ROLE ${quoteIdent(login)} IN DATABASE ${quoteIdent(target.name)} SET search_path = ${quoteIdent(login)}, public`
							])
						)
						const read = yield* Effect.ensuring(
							Effect.scoped(
								Effect.gen(function* () {
									const opened = yield* template.open
									const clone = yield* opened.clone
									const session = yield* cluster.connect(clone.member, cluster.maintenance)
									const set = yield* single(
										session,
										"SELECT pg_catalog.array_to_string(s.setconfig, ',') FROM pg_catalog.pg_db_role_setting AS s JOIN pg_catalog.pg_database AS d ON d.oid = s.setdatabase WHERE d.datname = $1::name AND s.setrole = $2::regrole",
										[clone.name, login]
									)
									return { set, template: clone.template }
								})
							),
							Effect.ignore(asSuperuser([`DROP ROLE IF EXISTS ${quoteIdent(login)}`]))
						)
						yield* dropTemplate({ member, name: read.template })
						assert.equal(read.set, `search_path=${login}, public`)
					}),
					ctx
				)
			),
	oracle: {
		kind: "specification",
		name: "a template whose build sets a role's setting in it, on a login the bootstrap superuser made, clones with the setting in place"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/resources/template.ts",
			original:
				"\t\t\t\t\tEffect.flatMap(cluster.superuser(member, cluster.maintenance), (superuser) =>\n",
			replacement: "\t\t\t\t\tEffect.flatMap(Effect.succeed(session), (superuser) =>\n",
			why: "A clone's role settings are made again on the owner's session, as they were: a role the build's superuser made is none the owner holds the ADMIN option on, and the server refuses its setting, so every clone of the template fails (5442, 2026-11-20: grizzle's laws/families and laws/projections, 42501); the property fails."
		}
	]
})
