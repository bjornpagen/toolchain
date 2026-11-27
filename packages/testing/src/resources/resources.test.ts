/**
 * The per-case resources (resources/): a fresh clone holds its template's rows and its case's alone; a template is
 * built once however many open it at once; a template whose module's closure changed is a new one and the old is
 * collected, with the clones of a worker that ended; a pool never hands one clone twice, and clones only as its cases
 * ask, one ahead of its first case where every slot it may have made one at its open; a scratch directory is the case's
 * own and gone after it. Run against the PostgreSQL
 * libpq's environment names (resources.fixtures.ts). Oracle: the specification, stated in each check.
 */
import {
	Array as Arr,
	Context,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FileSystem,
	Layer,
	Number as Num,
	Option,
	Ref,
	Scope,
	String as Str
} from "effect"
import { ChildProcessSpawner } from "effect/process"
import { assert } from "#assert.ts"
import { awaitFact } from "#fact.ts"
import type { Reached } from "#features.ts"
import { array, boolean, element, finite, int } from "#gen.ts"
import { overrun, ownWorkNow } from "#live.ts"
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
import { templateKeyOf } from "#resources/names.ts"
import {
	BUILD_READ_CASES,
	BUILD_READ_CHANGES,
	type BuildReadChange,
	claimedBy,
	claimsGone,
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
	services,
	backendCpuOf,
	backendShapes,
	HOLDER_BUSY_MILLIS,
	busyFor,
	outsideSession,
	superuserSessionIn,
	superuserSessions,
	fixturesModule,
	freshHex,
	removedElsewhere,
	templateNameOf,
	tokenTemplate,
	UTF8_COLLATIONS,
	undeclaredSession,
	writtenElsewhere
} from "#resources/resources.fixtures.ts"
import type { DatabaseTemplate } from "#resources/template.ts"
import { UNRUN_BUDGET } from "#runner/budgets.fixtures.ts"
import { collectedOf } from "#runner/collected.ts"
import { defineRunner, noMutation } from "#runner/config.ts"
import { collectedAround } from "#runner/run.ts"
import { runValuesOf } from "#runner/runs.ts"
import { ModuleClosure, RunValues, WorkerIndex } from "#runner/services.ts"
import { deadlocks, heldFor, pollOfWaits } from "#runner/work.fixtures.ts"
import { deadlineBound, overrunText, readingOf } from "#runner/work.ts"

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
						const member = yield* cluster.memberAt(0)
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
			original:
				"\t\t\t\t\tEffect.flatMap(replayOf(owner, origin.name), (inherited) =>\n\t\t\t\t\t\treplayedOn(cluster, member, gate, inherited(quoteIdent(building)))\n\t\t\t\t\t)\n",
			replacement: "\t\t\t\t\tEffect.void\n",
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
						const member = yield* cluster.memberAt(0)
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
						const built = yield* Effect.flatMap(cluster.memberAt(0), (first) =>
							Effect.scoped(
								Effect.flatMap(cluster.connect(first, cluster.maintenance), (session) =>
									single(
										session,
										"SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_database WHERE datistemplate AND pg_catalog.shobj_description(oid, 'pg_database') LIKE $1",
										[`%token ${token ?? ""}%`]
									)
								)
							)
						)
						const templateName = yield* Effect.flatMap(cluster.memberAt(0), (first) =>
							Effect.scoped(
								Effect.flatMap(cluster.connect(first, cluster.maintenance), (session) =>
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
						const member = yield* cluster.memberAt(0)
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
						const member = yield* cluster.memberAt(0)
						return yield* Effect.scoped(
							Effect.flatMap(cluster.connect(member, cluster.maintenance), (session) =>
								single(session, freshHex, [])
							)
						)
					}),
					ctx
				)
				const prefix = `tcr${token ?? ""}_`
				const template = tokenTemplate(prefix, () => Effect.void)
				const runnerClosures = Context.get(ctx, ModuleClosure)
				const config = defineRunner({
					budget: { kind: "cpu", run: UNRUN_BUDGET, import: UNRUN_BUDGET },
					include: [],
					smallStack: [],
					conditions: [],
					environment: [],
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
										root: runnerClosures.root,
										hashOf: () => runnerClosures.hashOf(fixturesModule)
									}),
									Context.make(WorkerIndex, worker).pipe(Context.add(RunValues, runValuesOf([])))
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
					budget: marksTemplate.budget,
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
									yield* heldFor(holdMillis)
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
								const member = yield* cluster.memberAt(0)
								return yield* Effect.scoped(
									Effect.flatMap(cluster.connect(member, cluster.maintenance), (session) =>
										single(session, freshHex, [])
									)
								)
							}),
							ctx
						)
						const prefix = `tcs${prefixToken ?? ""}_`
						const template = tokenTemplate(prefix, () => Effect.void)
						const runnerClosures = Context.get(ctx, ModuleClosure)
						const closure = (module: string) =>
							Context.make(ModuleClosure, {
								root: runnerClosures.root,
								hashOf: () => runnerClosures.hashOf(module)
							}).pipe(Context.add(RunValues, runValuesOf([])))
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
						const collected = yield* inLive(collect)
						const gone = yield* inLive(
							Effect.forEach(left, (database) => Effect.map(exists(database), (found) => !found))
						)
						const kept = yield* inLive(exists(current))
						yield* Scope.close(alive, Exit.void)
						const after = yield* Layer.build(ownCluster(prefix))
						yield* Effect.provideContext(
							Effect.andThen(claimsGone(current.member, prefix), collect),
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
		name: "collection drops the clones of an ended worker and the template its checkout claims no longer, having claimed a new closure's, and keeps the claimed one"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/resources/template.ts",
			original: `\t\t\t\`WITH superseded AS (DELETE FROM public.\${templateClaimsTable} WHERE checkout = $1 AND runner = $4 AND logical = $2 AND template <> $3) INSERT INTO public.\${templateClaimsTable} (template, checkout, runner, logical) VALUES ($3, $1, $4, $2) ON CONFLICT (template, checkout, runner) DO UPDATE SET claimed = pg_catalog.clock_timestamp()\`,\n`,
			replacement: `\t\t\t\`INSERT INTO public.\${templateClaimsTable} (template, checkout, runner, logical) VALUES ($3, $1, $4, $2) ON CONFLICT (template, checkout, runner) DO UPDATE SET claimed = pg_catalog.clock_timestamp()\`,\n`,
			why: "A checkout that claims a new closure's template keeps its claim of the old one, so a closure it moved past is never collected while the checkout exists, one more template every closure; the property fails, the stale template kept."
		}
	]
})

export const runnersKeepTheirOwnTemplates = property.exhaust(finite(boolean), {
	box: "two runners of one checkout opening one logical template in turn, twice each, then a collection: their closures alike, or one module of theirs resolved otherwise",
	needs: { services },
	situations: [],
	check:
		({ services: context }) =>
		(alike) =>
			Effect.gen(function* () {
				const ctx = yield* context
				const worker = Context.get(ctx, WorkerIndex)
				const runnerClosures = Context.get(ctx, ModuleClosure)
				const outcome = yield* Effect.scoped(
					Effect.gen(function* () {
						const prefixToken = yield* Effect.provideContext(
							Effect.gen(function* () {
								const cluster = yield* PgCluster
								const member = yield* cluster.memberAt(0)
								return yield* Effect.scoped(
									Effect.flatMap(cluster.connect(member, cluster.maintenance), (session) =>
										single(session, freshHex, [])
									)
								)
							}),
							ctx
						)
						const prefix = `tcr${prefixToken ?? ""}_`
						const builds = { count: 0 }
						const template = tokenTemplate(prefix, () =>
							Effect.sync(() => {
								builds.count += 1
							})
						)
						/**
						 * A runner of the checkout, at `root`, whose closures of the template's module are `module`'s, on a
						 * cluster of its own for the effect's life, so the template it opened is in use by no one once it ends
						 * and only claims keep it (holdInUse, collect.ts).
						 */
						const asRunner =
							(root: string, module: string) =>
							<A, E, R>(effect: Effect.Effect<A, E, R>) =>
								Effect.scoped(
									Effect.flatMap(Layer.build(ownCluster(prefix)), (cluster) =>
										Effect.provide(
											effect,
											Context.merge(
												cluster,
												Context.make(ModuleClosure, {
													root,
													hashOf: () => runnerClosures.hashOf(module)
												}).pipe(
													Context.add(WorkerIndex, worker),
													Context.add(RunValues, runValuesOf([]))
												)
											)
										)
									)
								)
						const first = asRunner("/runners/first", fixturesModule)
						const second = asRunner("/runners/second", alike ? fixturesModule : import.meta.url)
						const opened = Effect.flatMap(template.open, (open) => Effect.scoped(open.clone))
						yield* first(opened)
						yield* second(opened)
						yield* first(opened)
						yield* second(opened)
						yield* first(collect)
						const kept = yield* Effect.all([first(opened), second(opened)])
						yield* first(Effect.andThen(claimsGone(Arr.getUnsafe(kept, 0).member, prefix), collect))
						return {
							builds: builds.count,
							templates: Arr.dedupe(Arr.map(kept, (one) => one.template)).length
						}
					})
				)
				assert.deepEqual(outcome, alike ? { builds: 1, templates: 1 } : { builds: 2, templates: 2 })
			}),
	oracle: {
		kind: "specification",
		name: "each runner of a checkout keeps the template its closure gives: one template built once where their closures are alike, two built once each and both kept through alternating opens and a collection where they differ"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/resources/template.ts",
			original: "WHERE checkout = $1 AND runner = $4 AND logical = $2 AND template <> $3",
			replacement: "WHERE checkout = $1 AND logical = $2 AND template <> $3",
			why: "A claim supersedes every other digest of its logical template in the checkout, whichever runner claimed it, so two runners whose closures differ drop each other's template, which the next collection removes and the runner rebuilds (metis, 2026-11-25); the differing case builds three times."
		}
	]
})

export const aTemplateStandsWhileWhatItsBuildReadStands = property.exhaust(
	finite((source): BuildReadChange => source.draw(element(BUILD_READ_CHANGES))),
	{
		box: "a template whose build reads a file another process wrote, opened by one runner, the file then left as it was, rewritten alike or otherwise, or rewritten while the first build ran, and opened by a second runner on a cluster scope of its own",
		needs: { services },
		situations: [],
		check:
			({ services: context }) =>
			(change) =>
				Effect.gen(function* () {
					const ctx = yield* context
					const worker = Context.get(ctx, WorkerIndex)
					const runnerClosures = Context.get(ctx, ModuleClosure)
					const made = BUILD_READ_CASES[change]
					const outcome = yield* Effect.scoped(
						Effect.gen(function* () {
							const prefixToken = yield* Effect.provideContext(
								Effect.gen(function* () {
									const cluster = yield* PgCluster
									const member = yield* cluster.memberAt(0)
									return yield* Effect.scoped(
										Effect.flatMap(cluster.connect(member, cluster.maintenance), (session) =>
											single(session, freshHex, [])
										)
									)
								}),
								ctx
							)
							const prefix = `tbr${prefixToken ?? ""}_`
							const directory = `${process.getBuiltinModule("node:os").tmpdir()}/toolchain-build-reads-${prefix}`
							const file = `${directory}/read.txt`
							yield* Effect.acquireRelease(writtenElsewhere(file, "first"), () =>
								Effect.ignore(removedElsewhere(directory))
							)
							const builds = { first: 0, second: 0 }
							const opening: { by: "first" | "second" } = { by: "first" }
							const template = tokenTemplate(prefix, () =>
								Effect.gen(function* () {
									builds[opening.by] += 1
									process.getBuiltinModule("node:fs").readFileSync(file, "utf8")
									if (made.whileBuilt && opening.by === "first" && builds.first === 1) {
										yield* writtenElsewhere(file, "rewritten while it was built")
									}
								})
							)
							/**
							 * An open of the template by a runner of the checkout on a cluster scope of its own for the effect's
							 * life, as a worker of another run opens it: its own owner session, holds and claims.
							 */
							const asRunner = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
								Effect.scoped(
									Effect.flatMap(Layer.build(ownCluster(prefix)), (cluster) =>
										Effect.provide(
											effect,
											Context.merge(
												cluster,
												Context.make(ModuleClosure, {
													root: runnerClosures.root,
													hashOf: () => runnerClosures.hashOf(fixturesModule)
												}).pipe(
													Context.add(WorkerIndex, worker),
													Context.add(RunValues, runValuesOf([]))
												)
											)
										)
									)
								)
							const opened = Effect.flatMap(template.open, (open) => Effect.scoped(open.clone))
							const first = yield* asRunner(opened)
							yield* Effect.forEach(made.rewrites, (text) => writtenElsewhere(file, text), {
								discard: true
							})
							opening.by = "second"
							const [second, collected] = yield* opened.pipe(collectedOf, asRunner)
							yield* asRunner(Effect.andThen(claimsGone(first.member, prefix), collect))
							return {
								builds,
								same: first.template === second.template,
								read: Arr.some(
									collected.reads,
									(read) => read.kind === "file" && read.path === file
								)
							}
						})
					)
					assert.deepEqual(
						{
							rebuiltWhileRead: !made.whileBuilt || outcome.builds.first > 1,
							builtAgain: outcome.builds.second > 0,
							same: outcome.same,
							read: outcome.read
						},
						{
							rebuiltWhileRead: true,
							builtAgain: made.builtAgain,
							same: !made.builtAgain,
							read: true
						}
					)
				}),
		oracle: {
			kind: "specification",
			name: "a template stands exactly while every file its build read reads alike: an open after the file was left or rewritten alike builds nothing and takes the first build, one after it was rewritten otherwise builds anew under another name, a build whose read changed while it ran is built again, and every open that did not build it is given its build's reads"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/resources/template.ts",
				original: "\t\t\t\t\t\t\treads: Arr.map(reads.reads, (read) => ({ ...read })),\n",
				replacement: "\t\t\t\t\t\t\treads: [],\n",
				why: "A template keeps none of its build's reads, so it stands whatever its build read: a schema's SQL rewritten leaves its old template in use, and the open after the file was rewritten otherwise takes the stale template; the property fails."
			},
			{
				file: "packages/testing/src/runner/observe.ts",
				original:
					'\t\t\ttraced(read.kind, read.path, "a database template\'s build", guard.collecting())\n',
				replacement: "\t\t\tvoid read\n",
				why: "An open that finds its template standing is given none of its build's reads, so a verdict cached over a template another worker or run built answers after a file its build read changed; the open after the file was left is given no read of it, and the property fails."
			},
			{
				file: "packages/testing/src/runner/observe.ts",
				original: "\t\tinto?.reads.push({ kind, path: file })\n",
				replacement: "",
				why: "A build's reads are collected from none of its acts, so its template keeps no read and stands whatever its build read; the property fails."
			},
			{
				file: "packages/testing/src/resources/template.ts",
				original: "\t\t\t\tchanged = changed || standing.changed >= began\n",
				replacement: "\t\t\t\tchanged = changed && standing.changed >= began\n",
				why: "A build one of whose reads changed while it ran is kept, under the digest of what the file holds after, which its database may not hold; the file rewritten while the first build ran is built once, and the property fails."
			}
		]
	}
)

/**
 * A template and the database it was built in share their build's key (names.ts templateKeyOf), and every build of one
 * identity has a key of its own: a template whose build reads a file another process wrote, and notes the name of the
 * database it builds in, is opened by a runner, then the file is rewritten otherwise and the template opened again, once
 * or twice; each open builds it anew, the key of each build is the key its clone names its template by, and no two
 * builds share one, so a name a consumer derives from a template's (a role prefix its build creates roles under) is one
 * at the build and at every clone, and never another build's of the same identity, whose roles the first template still
 * owns (metis's installed template, 2026-11-27: dropLeftRoles refused, 2BP01, once its build's reads changed).
 */
export const aBuildAndItsTemplateShareAKey = property.exhaust(finite(int(1, 2)), {
	box: "a template whose build reads a file another process wrote, opened by a runner, then rebuilt once or twice by the file rewritten otherwise and the template opened again",
	needs: { services },
	situations: [],
	check:
		({ services: context }) =>
		(rebuilds) =>
			Effect.gen(function* () {
				const ctx = yield* context
				const worker = Context.get(ctx, WorkerIndex)
				const runnerClosures = Context.get(ctx, ModuleClosure)
				const outcome = yield* Effect.scoped(
					Effect.gen(function* () {
						const prefixToken = yield* Effect.provideContext(
							Effect.gen(function* () {
								const cluster = yield* PgCluster
								const member = yield* cluster.memberAt(0)
								return yield* Effect.scoped(
									Effect.flatMap(cluster.connect(member, cluster.maintenance), (session) =>
										single(session, freshHex, [])
									)
								)
							}),
							ctx
						)
						const prefix = `tbk${prefixToken ?? ""}_`
						const directory = `${process.getBuiltinModule("node:os").tmpdir()}/toolchain-build-keys-${prefix}`
						const file = `${directory}/read.txt`
						yield* Effect.acquireRelease(writtenElsewhere(file, "0"), () =>
							Effect.ignore(removedElsewhere(directory))
						)
						const builtIn: Array<string> = []
						const template = tokenTemplate(prefix, (target) =>
							Effect.sync(() => {
								process.getBuiltinModule("node:fs").readFileSync(file, "utf8")
								builtIn.push(target.name)
							})
						)
						const asRunner = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
							Effect.scoped(
								Effect.flatMap(Layer.build(ownCluster(prefix)), (cluster) =>
									Effect.provide(
										effect,
										Context.merge(
											cluster,
											Context.make(ModuleClosure, {
												root: runnerClosures.root,
												hashOf: () => runnerClosures.hashOf(fixturesModule)
											}).pipe(
												Context.add(WorkerIndex, worker),
												Context.add(RunValues, runValuesOf([]))
											)
										)
									)
								)
							)
						const opened = Effect.flatMap(template.open, (open) => Effect.scoped(open.clone))
						const clones = yield* Effect.forEach(
							Array.from({ length: rebuilds + 1 }, (_, round) => round),
							(round) =>
								Effect.andThen(
									round === 0 ? Effect.void : writtenElsewhere(file, String(round)),
									asRunner(opened)
								)
						)
						yield* asRunner(
							Effect.andThen(claimsGone(Arr.getUnsafe(clones, 0).member, prefix), collect)
						)
						return { built: builtIn, cloned: Arr.map(clones, (clone) => clone.template) }
					})
				)
				const keys = Arr.map(outcome.built, templateKeyOf)
				assert.deepEqual(
					{
						builds: outcome.built.length,
						shared: Arr.map(outcome.cloned, templateKeyOf),
						distinct: new Set(keys).size
					},
					{ builds: rebuilds + 1, shared: keys, distinct: rebuilds + 1 }
				)
			}),
	oracle: {
		kind: "specification",
		name: "every build of an identity is a template of its own, whose key its build database and every clone of it name alike"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/resources/template.ts",
			original: "\t\t\t\tconst name = templateName(cluster.prefix, digest, key)\n",
			replacement:
				"\t\t\t\tconst name = templateName(cluster.prefix, digest, Str.slice(16, 32)(digest))\n",
			why: "A template named by its identity alone shares its name with every other build of the identity, so the key its clones name differs from the one its build was given, and a consumer's per-template role prefix is one for every build, whose roles a former template still owns; the property fails."
		}
	]
})

export const claimedTemplatesKept = property.exhaust(finite(boolean), {
	box: "a template no live worker holds, claimed by another checkout that exists or was removed",
	needs: { services },
	situations: [],
	check:
		({ services: context }) =>
		(removed) =>
			Effect.gen(function* () {
				const ctx = yield* context
				const fs = yield* FileSystem.FileSystem
				const runner = Context.make(ModuleClosure, Context.get(ctx, ModuleClosure)).pipe(
					Context.add(WorkerIndex, Context.get(ctx, WorkerIndex)),
					Context.add(RunValues, Context.get(ctx, RunValues))
				)
				const outcome = yield* Effect.scoped(
					Effect.gen(function* () {
						const cluster = Context.get(ctx, PgCluster)
						const member = yield* cluster.memberAt(0)
						const prefixToken = yield* Effect.scoped(
							Effect.flatMap(cluster.connect(member, cluster.maintenance), (session) =>
								Effect.flatMap(single(session, freshHex, []), (drawn) =>
									Effect.fromOption(Option.fromNullishOr(drawn))
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
						yield* Scope.close(opener, Exit.void)
						const other = yield* fs.makeTempDirectoryScoped({ prefix: "toolchain-claims-" })
						const collectingCluster = yield* Layer.build(ownCluster(prefix))
						const collecting = Context.merge(collectingCluster, runner)
						const built = { member: clone.member, name: clone.template }
						yield* Effect.provideContext(claimedBy(clone.member, clone.template, other), collecting)
						if (removed) {
							yield* fs.remove(other, { recursive: true })
						}
						yield* Effect.provideContext(collect, collecting)
						const kept = yield* Effect.provideContext(exists(built), collecting)
						yield* Effect.provideContext(
							Effect.andThen(claimsGone(clone.member, prefix), collect),
							collecting
						)
						return { kept, left: yield* Effect.provideContext(exists(built), collecting) }
					})
				)
				assert.deepEqual(outcome, { kept: !removed, left: false })
			}),
	oracle: {
		kind: "specification",
		name: "another run's collection keeps a template no live worker holds while a checkout that exists claims it, and drops it once that checkout is gone"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/resources/collect.ts",
			original: '\t\t\t\t\t(database.kind === "template" && claimed.has(database.name))\n',
			replacement: '\t\t\t\t\t(database.kind === "template" && false)\n',
			why: "Collection keeps only what a live worker holds, whatever checkout claims a template, as it kept only what its own run declared: a lane's run drops trunk's builds and trunk the lane's, each paying them cold again (metis's SLOP-FIXER: ten digests of one template built over); the property fails, the claimed template dropped."
		},
		{
			file: "packages/testing/src/resources/collect.ts",
			original: "\t\t\tEffect.map(collector.exists(checkout), (present) => !present)\n",
			replacement: "\t\t\tEffect.succeed(false)\n",
			why: "A claim outlives its checkout, so a deleted lane's or a removed worker tree's templates stay on the cluster for good; the property fails, the template of a removed checkout kept."
		}
	]
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
						Context.add(WorkerIndex, worker),
						Context.add(RunValues, Context.get(ctx, RunValues))
					)
					const outcome = yield* Effect.scoped(
						Effect.gen(function* () {
							const cluster = Context.get(ctx, PgCluster)
							const member = yield* cluster.memberAt(0)
							const prefixToken = yield* Effect.scoped(
								Effect.flatMap(cluster.connect(member, cluster.maintenance), (session) =>
									Effect.flatMap(single(session, freshHex, []), (drawn) =>
										Effect.fromOption(Option.fromNullishOr(drawn))
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
							yield* Effect.provideContext(
								claimsGone(member, prefix),
								Context.merge(collector, runner)
							)
							yield* Effect.provideContext(collect, Context.merge(collector, runner))
							const kept = yield* templates
							yield* Scope.close(opener, Exit.void)
							yield* Effect.provideContext(collect, Context.merge(collector, runner))
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
					'\t\t\t\t\t!(yield* took(collector, lockKey("$1"), digest)) ||\n\t\t\t\t\t(database.kind === "template" && !(yield* took(collector, useKey("$1"), digest)))',
				replacement: '\t\t\t\t\t!(yield* took(collector, lockKey("$1"), digest))',
				why: "Collection drops a template whatever worker holds it in use; this property fails."
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
						Context.add(WorkerIndex, Context.get(ctx, WorkerIndex)),
						Context.add(RunValues, Context.get(ctx, RunValues))
					)
					const outcome = yield* Effect.scoped(
						Effect.gen(function* () {
							const cluster = Context.get(ctx, PgCluster)
							const member = yield* cluster.memberAt(0)
							const prefixToken = yield* Effect.scoped(
								Effect.flatMap(cluster.connect(member, cluster.maintenance), (session) =>
									Effect.flatMap(single(session, freshHex, []), (drawn) =>
										Effect.fromOption(Option.fromNullishOr(drawn))
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
							yield* Effect.provideContext(
								claimsGone(clone.member, prefix),
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
								])(clone.member),
								collector
							)
							const after = yield* present
							yield* Effect.provideContext(collect, collector)
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
						const member = yield* cluster.memberAt(0)
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

/**
 * A clone's drop held behind a working holder is a declared wait the case's guard judges none of. The guard here reads
 * the stall and waited legs alone, its CPU leg unbounded, as lockedStatementIsDeclared's is: this property's subject is
 * how a wait is classed, a runaway is runawayIsHung's, and its stall and waited legs still end a case that classes
 * wrongly; with its CPU leg at its 150 ms deadline, the clone, the sessions and the claim checks spent it under
 * trunk@toolchain's load at 93f4cedc, a verdict on the case's CPU, never on its wait (2026-11-22).
 */
export const cloneDropBehindAWorkingHolder = property.exhaust(finite(backendShapes), {
	box: "a clone's drop held for four deadlines by a lock a session in the clone holds while it works, under a deadline of 1 or 2 s",
	needs: { services },
	situations: [],
	check:
		({ services: context }) =>
		(shape) =>
			Effect.flatMap(context, (ctx) =>
				Effect.provideContext(
					Effect.scoped(
						Effect.gen(function* () {
							const opened = yield* marksTemplate.open
							const outer = yield* Effect.scope
							const holding = yield* Scope.make()
							const survivedHold = yield* Deferred.make<boolean>()
							const held = shape.deadline * shape.deadlines
							const dropped = Effect.scoped(
								Effect.gen(function* () {
									const clone = yield* opened.clone
									const holder = yield* Scope.provide(
										undeclaredSession(clone.member, clone.name),
										holding
									)
									yield* holder("BEGIN")
									yield* holder(`COMMENT ON DATABASE ${quoteIdent(clone.name)} IS 'held'`)
									const released = Effect.gen(function* () {
										yield* holder(busyFor(held))
										yield* holder("COMMIT")
										const survived = yield* Effect.isSuccess(holder("SELECT 1"))
										yield* Deferred.succeed(survivedHold, survived)
										yield* Scope.close(holding, Exit.void)
									})
									yield* Effect.forkIn(Effect.orDie(released), outer)
								})
							)
							const work = yield* ownWorkNow
							const verdict = yield* Effect.raceFirst(
								Effect.as(dropped, "passed"),
								Effect.map(
									overrun(work, {
										...deadlineBound(shape.deadline),
										cpu: Number.POSITIVE_INFINITY,
										waited: Number.POSITIVE_INFINITY
									}),
									overrunText
								)
							)
							const survived = yield* Deferred.await(survivedHold)
							assert.deepEqual({ verdict, survived }, { verdict: "passed", survived: true })
						})
					),
					ctx
				)
			),
	oracle: {
		kind: "specification",
		name: "a clone's drop that waits on the member past its case's deadline, behind a lock a session in the clone holds while it works, is its tree's work: the case's guard judges none of it, and the drop ends no session in the clone"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/resources/template.ts",
			original: 'databaseDroppedOn(owner.session, made, "awaited")',
			replacement: 'databaseDroppedOn(owner.session, made, "ended")',
			why: "A clone's drop ends the sessions still in it, as it did, so a session of the case's dies under the client that holds it once the drop has its lock, where only the run's collection should end one; the property fails, the session ended."
		}
	]
})

export const statementWorkIsTheCases = property.exhaust(finite(backendShapes), {
	box: "a statement of a case's own session whose backend works four deadlines, under a deadline of 1 or 2 s",
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
							const clone = yield* opened.clone
							const session = yield* cluster.connect(clone.member, clone.name)
							const work = yield* ownWorkNow
							const verdict = yield* Effect.raceFirst(
								Effect.as(session.query(busyFor(shape.deadline * shape.deadlines), []), "passed"),
								Effect.map(
									overrun(work, {
										...deadlineBound(shape.deadline),
										cpu: Number.POSITIVE_INFINITY
									}),
									overrunText
								)
							)
							assert.equal(verdict, "passed")
						})
					),
					ctx
				)
			),
	oracle: {
		kind: "specification",
		name: "a statement whose backend works past its case's deadline, spending no CPU of the case's process, is the case's work: its backend, the peer of a socket the process holds, is counted, and the guard judges none of it"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/work.ts",
			original: "\t\treturn { cpu: own.cpu, stir: own.stir, carried: carrying.cpu }\n",
			replacement: "\t\treturn { cpu: 0, stir: noStir, carried: carrying.cpu }\n",
			why: "A backend's CPU is not counted, as no client's statement was: a statement the member works on past the deadline is the case's silence, and its guard judges a live case hung under load (RECORDS-ATTACH, 2026-11-21: 25 ms of CPU over 60 s; qti-pie's pantry run a1b, 2026-11-25: false 60 s failures); the property fails, the work judged stalled."
		}
	]
})

export const siblingWorkIsNoCases = property.exhaust(finite(backendShapes), {
	box: "a case whose own session sits idle while another process's session in the same database works, under a deadline of 1 or 2 s",
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
							const clone = yield* opened.clone
							const sibling = yield* outsideSession(clone.member, clone.name)
							yield* sibling(busyFor(shape.deadline * 40))
							const session = yield* cluster.connect(clone.member, clone.name)
							yield* runIn(session, "SELECT '1'", [])
							const work = yield* ownWorkNow
							const verdict = yield* Effect.map(
								overrun(work, deadlineBound(shape.deadline)),
								(judged) => judged.kind
							)
							assert.equal(verdict, "stalled")
						})
					),
					ctx
				)
			),
	oracle: {
		kind: "specification",
		name: "a case's backends are those whose client is its own process tree, never a database's: another process's session working in the case's database lends the case nothing, and a case whose own session sits idle is judged a stall"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/backends.ts",
			original:
				"\t\t\t\t? Option.toArray(Option.fromUndefinedOr(ledger.served.get(client.peer)))\n",
			replacement: "\t\t\t\t? Arr.fromIterable(ledger.served.values())\n",
			why: "Every backend a server serves is counted, as a database's name would count them: a sibling case's work on the shared server moves a hung case, so it is never judged (QP-GATE, 2026-11-25: vitest's sibling files share the lease databases); the property fails, never judged."
		}
	]
})

export const pollLoopIsHung = property.exhaust(finite(deadlocks), {
	box: "a case whose declared waits follow one another for good, each of them ending, under a deadline of 150 or 300 ms",
	needs: {},
	situations: [],
	check: () => (shape) =>
		Effect.scoped(
			Effect.gen(function* () {
				const work = yield* ownWorkNow
				yield* Effect.forkScoped(pollOfWaits("the poll's wait"))
				const verdict = yield* Effect.map(
					overrun(work, { ...deadlineBound(shape.deadline), cpu: Number.POSITIVE_INFINITY }),
					(judged) => ({
						kind: judged.kind,
						named: judged.kind === "waited" && Arr.contains(judged.on, "the poll's wait")
					})
				)
				assert.deepEqual(verdict, { kind: "waited", named: true })
			})
		),
	oracle: {
		kind: "specification",
		name: "a case whose declared waits follow one another for good, each ending, is judged once they have held it its bound's waited wall time in all, its leg the waits, and the waits open then are named"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/work.ts",
			original: "\tif (waitedAll >= bound.waited) {\n",
			replacement: "\tif (waitedAll < 0) {\n",
			why: "Declared waits hold a case for as long as they follow one another, so a poll of waits with nothing between them never makes a stall window whole and never spends the case's CPU, and the case is never judged (trunk@grizzle's pg tier at f1bf91a2f, 2026-11-22: three hours in budget.test.ts's barrier, ended by hand); the property fails, never judged."
		},
		{
			file: "packages/testing/src/runner/work.ts",
			original: "\tledger.open = [...ledger.open, { id, on }]\n",
			replacement: '\tledger.open = [...ledger.open, { id, on: "" }]\n',
			why: "A declared wait names nothing, so a verdict on a case inside one says only that it waited, not on what; the property fails, the poll's wait unnamed."
		}
	]
})

export const lockedBehindAWorkingHolderIsWork = property.exhaust(finite(backendShapes), {
	box: "a statement of a case's session behind a lock another process's session holds while it works four deadlines, under a deadline of 1 or 2 s",
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
							const clone = yield* opened.clone
							const waiter = yield* cluster.connect(clone.member, clone.name)
							yield* runIn(waiter, "CREATE TABLE held (x int)", [])
							const holder = yield* outsideSession(clone.member, clone.name)
							yield* holder("BEGIN")
							yield* holder("LOCK TABLE held IN ACCESS EXCLUSIVE MODE")
							yield* holder(busyFor(shape.deadline * shape.deadlines))
							yield* holder("COMMIT")
							yield* awaitFact(
								Effect.map(
									single(
										waiter,
										"SELECT count(*)::text FROM pg_catalog.pg_locks WHERE relation = 'held'::regclass AND granted",
										[]
									),
									(granted) => (granted === "1" ? Option.some(true) : Option.none())
								)
							)
							const work = yield* ownWorkNow
							const verdict = yield* Effect.raceFirst(
								Effect.as(waiter.query("SELECT count(*)::text FROM held", []), "passed"),
								Effect.map(overrun(work, deadlineBound(shape.deadline)), overrunText)
							)
							assert.equal(verdict, "passed")
						})
					),
					ctx
				)
			),
	oracle: {
		kind: "specification",
		name: "a statement the member holds behind a lock whose holder, another process's session, works is carried by the holder's CPU (runner/backends.ts Carriers): the case's guard judges none of it, and the holder's CPU spends none of the case's budget"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/pg/session.ts",
			original:
				"\t\tWHERE blockers.waiter = asked.pid AND h.state = 'active' AND h.wait_event_type IS DISTINCT FROM 'Lock'\n",
			replacement: "\t\tWHERE false\n",
			why: "A backend behind a lock is carried by no holder, as a statement was its client's silence: a case whose statement waits behind another session's work is stalled, as RECORDS-ATTACH's live cases were judged hung behind SSI waits (2026-11-21); the property fails, the locked read judged."
		},
		{
			file: "packages/testing/src/resources/cluster.ts",
			original: "\t\t\t\t\t\t\t\t\t\t\t\t\t\tmemberRegistered(member)\n",
			replacement: "",
			why: "The cluster registers no member it brings up, so only a client that registers its own server is asked what its backends wait on, and a repository's own sessions never are (grizzle's, 2026-11-26): a case behind an outside holder that works is judged stalled; the property fails, the locked read judged."
		}
	]
})

/**
 * A deferrable read of a case's session waits out another process's working serializable writer as the member's work:
 * a SERIALIZABLE READ ONLY DEFERRABLE read waits for a safe snapshot (wait event SafeSnapshot) until every serializable
 * transaction concurrent with it that is not read only has ended, and while the one it waits out works, its backend's
 * CPU carries the read (pg/session.ts CARRIERS: every working writer whose transaction began before the read), so the
 * case's guard judges none of the
 * wait a stall, however long the writer works past the case's deadline.
 */
export const deferredBehindAWorkingWriterIsWork = property.exhaust(finite(backendShapes), {
	box: "a deferrable read of a case's session behind another process's serializable writer that works four deadlines, under a deadline of 1 or 2 s",
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
							const clone = yield* opened.clone
							const reader = yield* cluster.connect(clone.member, clone.name)
							yield* runIn(reader, "CREATE TABLE written (x int)", [])
							const writer = yield* outsideSession(clone.member, clone.name)
							yield* writer("BEGIN ISOLATION LEVEL SERIALIZABLE")
							yield* writer("SELECT count(*) FROM written")
							yield* writer("INSERT INTO written VALUES (1)")
							yield* writer(busyFor(shape.deadline * shape.deadlines))
							yield* writer("COMMIT")
							yield* awaitFact(
								Effect.map(
									single(
										reader,
										"SELECT count(*)::text FROM pg_catalog.pg_locks WHERE relation = 'written'::regclass AND mode = 'SIReadLock'",
										[]
									),
									(held) => (held === "0" ? Option.none() : Option.some(true))
								)
							)
							const readerPid = yield* single(
								reader,
								"SELECT pg_catalog.pg_backend_pid()::text",
								[]
							)
							const watcher = yield* cluster.connect(clone.member, clone.name)
							yield* runIn(reader, "BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY DEFERRABLE", [])
							const read = yield* Effect.forkScoped(
								reader.query("SELECT count(*)::text FROM written", [])
							)
							yield* awaitFact(
								Effect.map(
									single(
										watcher,
										"SELECT wait_event FROM pg_catalog.pg_stat_activity WHERE pid = $1::int4",
										[readerPid ?? ""]
									),
									(event) => (event === "SafeSnapshot" ? Option.some(true) : Option.none())
								)
							)
							const work = yield* ownWorkNow
							const verdict = yield* Effect.raceFirst(
								Effect.as(Fiber.join(read), "passed"),
								Effect.map(overrun(work, deadlineBound(shape.deadline)), overrunText)
							)
							yield* runIn(reader, "COMMIT", [])
							assert.equal(verdict, "passed")
						})
					),
					ctx
				)
			),
	oracle: {
		kind: "specification",
		name: "a deferrable read waiting out another process's working serializable writer is carried by the writer's CPU (runner/backends.ts Carriers): the case's guard judges none of it, and the read passes once the writer commits"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/pg/session.ts",
			original: "\tWHERE asked.wait_event = 'SafeSnapshot'\n",
			replacement: "\tWHERE false\n",
			why: "A deferrable read waiting for a safe snapshot is carried by no writer, as a den step's read on a shared member was its client's silence (trunk@metis b35b5a76): a case whose read waits out another session's working writer is stalled; the property fails."
		}
	]
})

/**
 * A carrier counts from the ask that names it: a case's statement waits behind a lock another process's session holds
 * while it works; the case's work, begun once the wait is in place, asks its server (its refresh, a guard's opening ask)
 * and so names the holder; read once, after the holder's own CPU (off its /proc stat) has moved a quarter or half second
 * past that ask, the work's carried CPU holds it but for two ticks of slack, so a guard judges such a wait moving in the very
 * window its carrier is first named in, however little its processes waited to run (runner/work.ts keptServed).
 */
export const carriedFromItsNaming = property.exhaust(finite(int(1, 2)), {
	box: "a statement of a case's session behind a lock another process's working session holds, the case's work read once a quarter or half second of the holder's CPU after its first ask",
	needs: { services },
	situations: [],
	check:
		({ services: context }) =>
		(quarters) =>
			Effect.flatMap(context, (ctx) =>
				Effect.provideContext(
					Effect.scoped(
						Effect.gen(function* () {
							const cluster = yield* PgCluster
							const opened = yield* marksTemplate.open
							const clone = yield* opened.clone
							const waiter = yield* cluster.connect(clone.member, clone.name)
							const watcher = yield* cluster.connect(clone.member, clone.name)
							yield* runIn(waiter, "CREATE TABLE named (x int)", [])
							const holder = yield* outsideSession(clone.member, clone.name)
							yield* holder("BEGIN")
							yield* holder("LOCK TABLE named IN ACCESS EXCLUSIVE MODE")
							yield* holder(busyFor(HOLDER_BUSY_MILLIS))
							yield* holder("COMMIT")
							const holderPid = yield* awaitFact(
								Effect.map(
									single(
										watcher,
										"SELECT pg_catalog.min(pid)::text FROM pg_catalog.pg_locks WHERE relation = 'named'::regclass AND granted",
										[]
									),
									Option.fromNullishOr
								)
							)
							const read = yield* Effect.forkScoped(
								waiter.query("SELECT count(*)::text FROM named", [])
							)
							yield* awaitFact(
								Effect.map(
									single(
										watcher,
										"SELECT count(*)::text FROM pg_catalog.pg_locks WHERE relation = 'named'::regclass AND NOT granted",
										[]
									),
									(waiting) => (waiting === "0" ? Option.none() : Option.some(true))
								)
							)
							const work = yield* ownWorkNow
							yield* work.refresh
							const named = yield* backendCpuOf(holderPid)
							yield* awaitFact(
								Effect.map(backendCpuOf(holderPid), (now) =>
									now >= named + 250 * quarters ? Option.some(true) : Option.none()
								)
							)
							const carried = readingOf(work, work.began.wall).carried
							const superuser = yield* cluster.superuser(clone.member, clone.name)
							yield* single(superuser, "SELECT pg_catalog.pg_cancel_backend($1::int4)::text", [
								holderPid
							])
							yield* Fiber.join(read)
							assert.deepEqual(
								{
									carried:
										carried >= 200 ? "the holder's CPU since its naming" : `${String(carried)} ms`
								},
								{ carried: "the holder's CPU since its naming" }
							)
						})
					),
					ctx
				)
			),
	oracle: {
		kind: "specification",
		name: "the holder's own CPU off /proc, read at the work's first ask and again a quarter second of it later: the work's carried CPU holds it"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/work.ts",
			original:
				"\t\t},\n\t\trefresh: Effect.andThen(\n\t\t\trefreshBackends(tree),\n\t\t\tEffect.sync(() => {\n\t\t\t\tbackends(tree())\n\t\t\t})\n\t\t)\n",
			replacement: "\t\t},\n\t\trefresh: refreshBackends(tree)\n",
			why: "A carrier counts only from the first reading that sees it, so a carried wait shows no progress in the window its carrier is first named in, and a case whose statement waits behind a working holder just after a reading is judged stalled; the property fails."
		}
	]
})

/**
 * A carrier counts from the refresh that names it, never from its start, however recently it started: a holder whose
 * session opened after the work began works half a second or a second of its own CPU holding the lock before the case's
 * statement asks behind it, and the work's carried CPU, read just after the refresh, is no more than the holder spent
 * from just before that refresh to just after the reading.
 */
export const aFreshCarrierCountsFromItsNaming = property.exhaust(finite(int(1, 2)), {
	box: "a statement of a case's session behind a lock held by another process's session opened after the case's work began, which worked a half or a whole second of CPU before the statement asked, the work read once just after its refresh",
	needs: { services },
	situations: [],
	check:
		({ services: context }) =>
		(halves) =>
			Effect.flatMap(context, (ctx) =>
				Effect.provideContext(
					Effect.scoped(
						Effect.gen(function* () {
							const cluster = yield* PgCluster
							const opened = yield* marksTemplate.open
							const clone = yield* opened.clone
							const waiter = yield* cluster.connect(clone.member, clone.name)
							const watcher = yield* cluster.connect(clone.member, clone.name)
							yield* runIn(waiter, "CREATE TABLE named (x int)", [])
							const work = yield* ownWorkNow
							const holder = yield* outsideSession(clone.member, clone.name)
							yield* holder("BEGIN")
							yield* holder("LOCK TABLE named IN ACCESS EXCLUSIVE MODE")
							yield* holder(busyFor(HOLDER_BUSY_MILLIS))
							yield* holder("COMMIT")
							const holderPid = yield* awaitFact(
								Effect.map(
									single(
										watcher,
										"SELECT pg_catalog.min(pid)::text FROM pg_catalog.pg_locks WHERE relation = 'named'::regclass AND granted",
										[]
									),
									Option.fromNullishOr
								)
							)
							yield* awaitFact(
								Effect.map(backendCpuOf(holderPid), (spent) =>
									spent >= 500 * halves ? Option.some(true) : Option.none()
								)
							)
							const read = yield* Effect.forkScoped(
								waiter.query("SELECT count(*)::text FROM named", [])
							)
							yield* awaitFact(
								Effect.map(
									single(
										watcher,
										"SELECT count(*)::text FROM pg_catalog.pg_locks WHERE relation = 'named'::regclass AND NOT granted",
										[]
									),
									(waiting) => (waiting === "0" ? Option.none() : Option.some(true))
								)
							)
							const named = yield* backendCpuOf(holderPid)
							yield* work.refresh
							const carried = readingOf(work, work.began.wall).carried
							const after = yield* backendCpuOf(holderPid)
							const superuser = yield* cluster.superuser(clone.member, clone.name)
							yield* single(superuser, "SELECT pg_catalog.pg_cancel_backend($1::int4)::text", [
								holderPid
							])
							yield* Fiber.join(read)
							assert.deepEqual(
								{
									carried:
										carried <= after - named
											? "no more than the holder's CPU since its naming"
											: `${String(carried)} ms, the holder's CPU since its naming ${String(after - named)} ms`
								},
								{ carried: "no more than the holder's CPU since its naming" }
							)
						})
					),
					ctx
				)
			),
	oracle: {
		kind: "specification",
		name: "the holder's own CPU off /proc, read just before the refresh that names it and just after the work's reading: the work's carried CPU is at most their difference"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/work.ts",
			original: "\tconst carriers = keptServed(Option.none())\n",
			replacement: "\tconst carriers = keptServed(since)\n",
			why: "A carrier started since the work began counts all of its CPU, what it spent before it carried the wait among it, so a wait reads as moved by work that moved nothing of it; the property fails."
		}
	]
})

export const lockedByAnIdleHolderIsHung = property.exhaust(finite(backendShapes), {
	box: "a statement of a case's session behind a lock a session holds idle in its transaction, while another process's session works on the same server, under a deadline of 1 or 2 s",
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
							const clone = yield* opened.clone
							const sibling = yield* outsideSession(clone.member, clone.name)
							yield* sibling(busyFor(shape.deadline * 40))
							const holder = yield* undeclaredSession(clone.member, clone.name)
							const waiter = yield* cluster.connect(clone.member, clone.name)
							yield* runIn(waiter, "CREATE TABLE held (x int)", [])
							yield* holder("BEGIN")
							yield* holder("LOCK TABLE held IN ACCESS EXCLUSIVE MODE")
							const work = yield* ownWorkNow
							const verdict = yield* Effect.raceFirst(
								Effect.as(waiter.query("SELECT count(*)::text FROM held", []), "answered"),
								Effect.map(overrun(work, deadlineBound(shape.deadline)), (judged) => judged.kind)
							).pipe(Effect.ensuring(Effect.orDie(holder("ROLLBACK"))))
							assert.equal(verdict, "stalled")
						})
					),
					ctx
				)
			),
	oracle: {
		kind: "specification",
		name: "a statement behind a lock that only a session idle in its transaction holds waits on a client, not on the member: no holder carries it, the server's other work lends it nothing, and it is judged a stall"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/pg/session.ts",
			original:
				"\t\tSELECT h.pid::text FROM blockers JOIN pg_catalog.pg_stat_activity AS h ON h.pid = blockers.pid\n",
			replacement:
				"\t\tSELECT h.pid::text FROM pg_catalog.pg_stat_activity AS h CROSS JOIN (SELECT asked.pid AS waiter) AS blockers\n",
			why: "A backend behind a lock is carried by every working backend of its server, whoever holds the lock, as a claim read a lock wait as work: a case whose own session holds the lock idle in its transaction while its client awaits the statement behind it is moved by others' work and never judged (grizzle's budget.test.ts under its first kill, 2026-11-22: 14 to 73 minutes and more with no verdict); the property fails, never judged."
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
						const member = yield* cluster.memberAt(0)
						const token = yield* Effect.scoped(
							Effect.flatMap(cluster.connect(member, cluster.maintenance), (session) =>
								single(session, freshHex, [])
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

/**
 * Every clone is copied by FILE_COPY (resources/template.ts strategy), which writes none of its template's blocks into
 * WAL: a clone of a template of one to three tables, made on the worker's owner session, writes fewer page images into
 * WAL than half its template's blocks, read from that session's own counters (pg_stat_get_backend_wal), where WAL_LOG
 * writes a page image of every block it copies, all but the few of a database's files that are no relation's.
 */
export const aCloneCopiesNoBlockThroughWal = property.exhaust(finite(int(1, 3)), {
	box: "a template of one to three tables of 2,000 rows, built and then cloned on the worker's owner session",
	needs: { services },
	situations: [],
	check:
		({ services: context }) =>
		(tables) =>
			Effect.flatMap(context, (ctx) =>
				Effect.provideContext(
					Effect.scoped(
						Effect.gen(function* () {
							const cluster = yield* PgCluster
							const member = yield* cluster.memberAt(0)
							const token = yield* Effect.scoped(
								Effect.flatMap(cluster.connect(member, cluster.maintenance), (session) =>
									single(session, freshHex, [])
								)
							)
							const inBuild = yield* Effect.context<PgCluster>()
							const template = tokenTemplate(`copied ${token ?? ""}`, (target) =>
								Effect.provideContext(
									Effect.forEach(
										Array.from({ length: tables }, (_, at) => at),
										(at) =>
											inDatabase(
												target,
												`CREATE TABLE copied_${String(at)} AS SELECT g, pg_catalog.repeat('x', 40) AS m FROM pg_catalog.generate_series(1, 2000) AS g`,
												[]
											),
										{ discard: true }
									),
									inBuild
								)
							)
							const built = yield* template.open
							const owner = yield* cluster.owner(member)
							const pid = yield* single(
								owner.session,
								"SELECT pg_catalog.pg_backend_pid()::text",
								[]
							)
							const imagesNow = Effect.andThen(
								runIn(owner.session, "SELECT pg_catalog.pg_stat_force_next_flush()", []),
								single(
									owner.session,
									"SELECT wal_fpi::text FROM pg_catalog.pg_stat_get_backend_wal($1::int)",
									[pid ?? ""]
								)
							)
							const before = yield* imagesNow
							const clone = yield* built.clone
							const after = yield* imagesNow
							const blocks = yield* single(
								owner.session,
								"SELECT (pg_catalog.pg_database_size($1) / pg_catalog.current_setting('block_size')::int)::text",
								[clone.template]
							)
							yield* dropTemplate({ member, name: clone.template })
							const images = Number(after) - Number(before)
							assert.deepEqual(
								{
									images:
										images * 2 < Number(blocks)
											? "under half its template's blocks"
											: String(images)
								},
								{ images: "under half its template's blocks" },
								`a clone of a template of ${String(blocks)} blocks wrote ${String(images)} page images into WAL`
							)
						})
					),
					ctx
				)
			),
	oracle: {
		kind: "postgresql",
		name: "the clone's session's own WAL counters (PostgreSQL 19 pg_stat_get_backend_wal), against its template's size"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/resources/template.ts",
			original: 'const strategy = "FILE_COPY"\n',
			replacement: 'const strategy = "WAL_LOG"\n',
			why: "Every template and clone copied by WAL_LOG writes its source's every block into WAL, a page image each, at two to four times the member's CPU of FILE_COPY for clones at once and six to eight times the wall at metis's 248 MB template (METIS-DBOPT, 2026-11-26); the property fails, the clone's page images about its template's blocks."
		}
	]
})

export const buildLeftSessionsEmptied = property.exhaust(finite(int(1, 3)), {
	box: "a template whose build leaves one to three sessions of the bootstrap superuser open in its build database past its end",
	needs: { services },
	situations: [],
	check:
		({ services: context }) =>
		(leftOpen) =>
			Effect.flatMap(context, (ctx) =>
				Effect.provideContext(
					Effect.scoped(
						Effect.gen(function* () {
							const outer = yield* Effect.scope
							const cluster = yield* PgCluster
							const member = yield* cluster.memberAt(0)
							const token = yield* Effect.scoped(
								Effect.flatMap(cluster.connect(member, cluster.maintenance), (session) =>
									single(session, freshHex, [])
								)
							)
							const inBuild = yield* Effect.context<
								ChildProcessSpawner.ChildProcessSpawner | PgCluster
							>()
							const template = tokenTemplate(`left open ${token ?? ""}`, (target) =>
								Effect.provideContext(
									Effect.asVoid(
										Effect.andThen(
											Effect.forEach(
												Array.from({ length: leftOpen }),
												() => Effect.orDie(Scope.provide(outer)(superuserSessionIn(target))),
												{ discard: true }
											),
											awaitFact(
												Effect.map(superuserSessions(target), (held) =>
													held >= leftOpen ? Option.some(held) : Option.none()
												)
											)
										)
									),
									inBuild
								)
							)
							const opened = yield* Effect.result(
								Effect.scoped(
									Effect.gen(function* () {
										const built = yield* template.open
										const clone = yield* built.clone
										return clone.template
									})
								)
							)
							if (opened._tag === "Success") {
								yield* dropTemplate({ member, name: opened.success })
							}
							assert.deepEqual(
								{ opened: opened._tag },
								{ opened: "Success" },
								`a template whose build left ${leftOpen} sessions in its build database opens: ${opened._tag === "Failure" ? opened.failure.message : ""}`
							)
						})
					),
					ctx
				)
			),
	oracle: {
		kind: "specification",
		name: "a template whose build leaves sessions open in its build database is copied into its template: every backend still there is ended before the copy, which PostgreSQL refuses while any is"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/resources/template.ts",
			original: "\t\t\t\tyield* emptied(cluster, member, building, template)\n",
			replacement: "",
			why: "The build database is copied with the build's sessions still in it, so CREATE DATABASE waits its five seconds and refuses the copy (55006, grizzle's network tier, 2026-11-22: fin/scale.test, source database gz_tpb_... is being accessed by other users); the property fails."
		}
	]
})
