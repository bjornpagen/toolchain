import { freshPoolDepth } from "@bjornpagen/limits"
import { Deferred, Effect, Exit, Queue, Record as Rec, Ref, Result, Scope } from "effect"
import type { Need } from "#property.ts"
import {
	type DatabaseName,
	PgCluster,
	type PgMember,
	type PgSession,
	required,
	run,
	single
} from "#resources/cluster.ts"
import { canonicalText, type DatabaseTemplate, type Opened } from "#resources/template.ts"
import { NeedFailed } from "#runner/services.ts"

/**
 * A need over a database template, which names its template, so collection (collect.ts templatesOf) can read the
 * templates a property declares from its needs.
 */
export type DatabaseNeed<A> = Need<A> & Readonly<{ template: DatabaseTemplate }>

/** A clone a pool slot made, or why it could not, and the signal the case that takes it gives when it ends. */
type Ready = Readonly<{ made: Result.Result<Database, NeedFailed>; done: Deferred.Deferred<void> }>

/**
 * One slot of a worker's pool, for the worker's life: it clones the template, offers the clone (or the failure) to the
 * next case, waits for that case to end, then drops the clone (the iteration's scope) and clones again. A worker of d
 * slots holds at most d clones of a template, and the next case's clone is made while the current case runs. A failed
 * clone is offered too, so exactly one case fails with it and the slot tries again only for the next.
 */
const slot = (opened: Opened<Database>, ready: Queue.Queue<Ready>): Effect.Effect<never> =>
	Effect.forever(
		Effect.scoped(
			Effect.gen(function* () {
				const made = yield* Effect.result(opened.clone)
				const done = yield* Deferred.make<void>()
				yield* Queue.offer(ready, { made, done })
				yield* Deferred.await(done)
			})
		)
	)

/**
 * Each case its own database, a clone of `template`, dropped once the case ends; no case ever sees another's rows. Each
 * worker keeps a pool of freshPoolDepth slots for each template it has served (slot), opened with the need, so the
 * clone a case takes was made while earlier cases ran, and its drop runs after the case, in the slot, never in the
 * case's time.
 */
const fresh = (template: DatabaseTemplate): DatabaseNeed<Database> => ({
	key: `@bjornpagen/testing/resources Database.fresh ${template.key}`,
	template,
	open: Effect.map(
		Effect.gen(function* () {
			const opened = yield* template.open
			const scope = yield* Effect.scope
			const ready = yield* Queue.unbounded<Ready>()
			yield* Effect.forEach(
				Array.from({ length: freshPoolDepth.value }, () => slot(opened, ready)),
				(filling) => Effect.forkIn(filling, scope),
				{ discard: true }
			)
			return ready
		}),
		takeReady
	)
})

/** One case's clone from a worker's pool: the next ready clone, handed back to its slot when the case ends. */
const takeReady = (ready: Queue.Queue<Ready>): Effect.Effect<Database, NeedFailed, Scope.Scope> =>
	Effect.gen(function* () {
		const { made, done } = yield* Queue.take(ready)
		yield* Effect.addFinalizer(() => Deferred.succeed(done, undefined))
		return yield* Effect.fromResult(made)
	})

/**
 * The catalog half of a database's fingerprint: one digest over every schema, relation and column outside PostgreSQL's
 * own, with owners and privileges; routines, constraints, indexes, triggers, rules, policies, types and enum labels,
 * extensions, publications, event triggers, default privileges, statistics objects, comments and large objects; and
 * the database's own privileges and settings. Roles are the cluster's, not the database's, and are not in it. The rows
 * are the other half (contentsQuery).
 */
const fingerprintQuery = `WITH user_namespace AS (
	SELECT oid FROM pg_catalog.pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'
), line AS (
	SELECT 'schema ' || n.nspname || ' ' || n.nspowner::regrole::text || ' ' || COALESCE(n.nspacl::text, '') AS text
	FROM pg_catalog.pg_namespace AS n WHERE n.oid IN (SELECT oid FROM user_namespace)
	UNION ALL SELECT 'relation ' || c.oid::regclass::text || ' ' || c.relkind::text || ' ' || c.relowner::regrole::text || ' '
		|| COALESCE(c.relacl::text, '') || ' ' || c.relrowsecurity::text || ' ' || c.relforcerowsecurity::text
	FROM pg_catalog.pg_class AS c WHERE c.relnamespace IN (SELECT oid FROM user_namespace)
	UNION ALL SELECT 'column ' || a.attrelid::regclass::text || ' ' || a.attnum::text || ' ' || a.attname || ' '
		|| pg_catalog.format_type(a.atttypid, a.atttypmod) || ' ' || a.attnotnull::text || ' ' || a.attisdropped::text || ' '
		|| a.attidentity::text || a.attgenerated::text || ' ' || COALESCE(pg_catalog.pg_get_expr(d.adbin, d.adrelid), '') || ' '
		|| COALESCE(a.attacl::text, '')
	FROM pg_catalog.pg_attribute AS a JOIN pg_catalog.pg_class AS c ON c.oid = a.attrelid
		LEFT JOIN pg_catalog.pg_attrdef AS d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
	WHERE a.attnum > 0 AND c.relnamespace IN (SELECT oid FROM user_namespace)
	UNION ALL SELECT 'routine ' || p.oid::regprocedure::text || ' ' || p.proowner::regrole::text || ' ' || p.prokind::text || ' '
		|| p.provolatile::text || ' ' || p.prosecdef::text || ' ' || COALESCE(p.proacl::text, '') || ' '
		|| COALESCE(pg_catalog.array_to_string(p.proconfig, ','), '') || ' ' || pg_catalog.md5(COALESCE(p.prosrc, ''))
	FROM pg_catalog.pg_proc AS p WHERE p.pronamespace IN (SELECT oid FROM user_namespace)
	UNION ALL SELECT 'constraint ' || con.conrelid::text || ' ' || con.contypid::text || ' ' || con.conname || ' '
		|| pg_catalog.pg_get_constraintdef(con.oid) || ' ' || con.convalidated::text
	FROM pg_catalog.pg_constraint AS con WHERE con.connamespace IN (SELECT oid FROM user_namespace)
	UNION ALL SELECT 'index ' || pg_catalog.pg_get_indexdef(i.indexrelid)
	FROM pg_catalog.pg_index AS i JOIN pg_catalog.pg_class AS c ON c.oid = i.indexrelid
	WHERE c.relnamespace IN (SELECT oid FROM user_namespace)
	UNION ALL SELECT 'trigger ' || pg_catalog.pg_get_triggerdef(t.oid) || ' ' || t.tgenabled::text
	FROM pg_catalog.pg_trigger AS t WHERE NOT t.tgisinternal
	UNION ALL SELECT 'rule ' || r.ev_class::regclass::text || ' ' || r.rulename || ' ' || pg_catalog.md5(pg_catalog.pg_get_ruledef(r.oid))
	FROM pg_catalog.pg_rewrite AS r JOIN pg_catalog.pg_class AS c ON c.oid = r.ev_class
	WHERE c.relnamespace IN (SELECT oid FROM user_namespace)
	UNION ALL SELECT 'policy ' || p.polrelid::regclass::text || ' ' || p.polname || ' ' || p.polcmd::text || ' ' || p.polpermissive::text || ' '
		|| p.polroles::text || ' ' || COALESCE(pg_catalog.pg_get_expr(p.polqual, p.polrelid), '') || ' '
		|| COALESCE(pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid), '')
	FROM pg_catalog.pg_policy AS p
	UNION ALL SELECT 'type ' || t.oid::regtype::text || ' ' || t.typtype::text || ' ' || t.typowner::regrole::text || ' '
		|| COALESCE(t.typacl::text, '') || ' ' || COALESCE(t.typdefault, '')
	FROM pg_catalog.pg_type AS t WHERE t.typnamespace IN (SELECT oid FROM user_namespace)
	UNION ALL SELECT 'label ' || e.enumtypid::regtype::text || ' ' || e.enumsortorder::text || ' ' || e.enumlabel
	FROM pg_catalog.pg_enum AS e
	UNION ALL SELECT 'extension ' || x.extname || ' ' || x.extversion || ' ' || x.extnamespace::regnamespace::text
	FROM pg_catalog.pg_extension AS x
	UNION ALL SELECT 'publication ' || p.pubname || ' ' || p.puballtables::text || ' ' || COALESCE((
		SELECT pg_catalog.string_agg(r.prrelid::regclass::text, ',' ORDER BY r.prrelid::regclass::text)
		FROM pg_catalog.pg_publication_rel AS r WHERE r.prpubid = p.oid), '')
	FROM pg_catalog.pg_publication AS p
	UNION ALL SELECT 'event trigger ' || v.evtname || ' ' || v.evtevent || ' ' || v.evtenabled::text || ' ' || v.evtfoid::regproc::text
	FROM pg_catalog.pg_event_trigger AS v
	UNION ALL SELECT 'default ' || d.defaclrole::regrole::text || ' ' || d.defaclnamespace::text || ' ' || d.defaclobjtype::text || ' '
		|| d.defaclacl::text
	FROM pg_catalog.pg_default_acl AS d
	UNION ALL SELECT 'statistics ' || s.stxrelid::regclass::text || ' ' || s.stxname
	FROM pg_catalog.pg_statistic_ext AS s
	UNION ALL SELECT 'comment ' || c.classoid::text || ' ' || c.objoid::text || ' ' || c.objsubid::text || ' ' || pg_catalog.md5(c.description)
	FROM pg_catalog.pg_description AS c WHERE c.objoid >= 16384
	UNION ALL SELECT 'large objects ' || pg_catalog.count(*)::text FROM pg_catalog.pg_largeobject_metadata
	UNION ALL SELECT 'database ' || COALESCE(d.datacl::text, '')
	FROM pg_catalog.pg_database AS d WHERE d.datname = pg_catalog.current_database()
	UNION ALL SELECT 'setting ' || s.setrole::text || ' ' || pg_catalog.array_to_string(s.setconfig, ',')
	FROM pg_catalog.pg_db_role_setting AS s JOIN pg_catalog.pg_database AS d ON d.oid = s.setdatabase
	WHERE d.datname = pg_catalog.current_database()
)
SELECT pg_catalog.md5(COALESCE(pg_catalog.string_agg(text, E'\\n' ORDER BY text), '')) FROM line`

/**
 * The statement that puts every sequence of a database back as it stands now: a setval for each, to its last value
 * handed out, or to its start with is_called false when none has been; none when the database has no sequence.
 */
const sequencesQuery = `SELECT pg_catalog.format('SELECT %s', pg_catalog.string_agg(pg_catalog.format('pg_catalog.setval(%L::regclass, %s, %s)',
		c.oid::regclass::text, COALESCE(pg_catalog.pg_sequence_last_value(c.oid), s.seqstart)::text,
		(pg_catalog.pg_sequence_last_value(c.oid) IS NOT NULL)::text), ', '))
FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_sequence AS s ON s.seqrelid = c.oid
WHERE c.relkind = 'S' AND c.relnamespace IN (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema')`

/**
 * The statement that digests a database's rows as they stand: every table's and materialized view's rows, and every
 * sequence's state, each a line of the relation's name and the digest of its rows' text, read in one statement the
 * database's catalog writes (none when it has no relation to read). Written once, from the clone as cloned: a relation
 * a case adds is in the catalog half, and one it drops fails the statement.
 */
const contentsQuery = `SELECT 'SELECT pg_catalog.md5(pg_catalog.string_agg(line, E''\\n'' ORDER BY line)) FROM (' || pg_catalog.string_agg(
	CASE WHEN c.relkind = 'S'
		THEN pg_catalog.format('SELECT %L || '' '' || last_value::text || '' '' || is_called::text FROM %s', c.oid::regclass::text, c.oid::regclass)
		ELSE pg_catalog.format('SELECT %L || '' '' || (SELECT pg_catalog.md5(COALESCE(pg_catalog.string_agg(t::text, E''\\n'' ORDER BY t::text), '''')) FROM %s AS t)', c.oid::regclass::text, c.oid::regclass)
	END, ' UNION ALL ') || ') AS lines(line)'
FROM pg_catalog.pg_class AS c
WHERE c.relkind IN ('r', 'p', 'm', 'S')
	AND c.relnamespace IN (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema')`

/** A database's fingerprint as it stands: its catalog half and its rows half, read with row security off. */
type Fingerprint = Readonly<{ catalog: string | null; contents: string | null }>

/**
 * The fingerprint of the database `session` is in, by `contents` (contentsQuery's statement for it), row security off,
 * so a table the owner cannot read in full fails the fingerprint rather than hide rows.
 */
const fingerprintOf = (
	session: PgSession,
	contents: string | null
): Effect.Effect<Fingerprint, NeedFailed> =>
	Effect.gen(function* () {
		yield* run(session, "SET row_security = off", [])
		const catalog = yield* single(session, fingerprintQuery, [])
		const rows = contents === null ? null : yield* single(session, contents, [])
		return { catalog, contents: rows }
	})

/**
 * A worker's own clone of a template, held across its cases: the clone, kept in a scope of its own; an owner session
 * into it; the statement that puts its sequences back; and its fingerprint as cloned, which it must have again after
 * every case.
 */
type Held = Readonly<{
	database: Database
	scope: Scope.Closeable
	session: PgSession
	sequences: string | null
	contents: string | null
	baseline: Fingerprint
}>

/** Clones the template into a scope of its own under `parent`, with a session into the clone, and reads its baseline. */
const hold = (
	opened: Opened<Database>,
	parent: Scope.Scope
): Effect.Effect<Held, NeedFailed, PgCluster> =>
	Effect.gen(function* () {
		const cluster = yield* PgCluster
		const scope = yield* Scope.fork(parent)
		return yield* Effect.onError(
			Effect.gen(function* () {
				const database = yield* Scope.provide(opened.clone, scope)
				const session = yield* Scope.provide(cluster.connect(database.member, database.name), scope)
				const sequences = yield* single(session, sequencesQuery, [])
				const contents = yield* single(session, contentsQuery, [])
				const baseline = yield* fingerprintOf(session, contents)
				return { database, scope, session, sequences, contents, baseline }
			}),
			() => Scope.close(scope, Exit.void)
		)
	})

/**
 * After a case on a held clone: the form's reset, the sequences put back, and the fingerprint read again. A clone whose
 * fingerprint is its baseline is kept for the next case. Any other is dropped and a new clone held in its place (or the
 * failure to hold one, which the next case meets and tries again), and the case fails: it left behind what its form
 * does not let a case leave, and no later case sees it.
 */
const settle = (
	held: Ref.Ref<Result.Result<Held, NeedFailed>>,
	opened: Opened<Database>,
	parent: Scope.Scope,
	reset: ReadonlyArray<string>,
	form: string
): Effect.Effect<void, never, PgCluster> =>
	Effect.gen(function* () {
		const holding = yield* Ref.get(held)
		if (Result.isFailure(holding)) {
			return
		}
		const current = holding.success
		const settled = yield* Effect.result(
			Effect.gen(function* () {
				yield* Effect.forEach(reset, (statement) => run(current.session, statement, []), {
					discard: true
				})
				if (current.sequences !== null) {
					yield* run(current.session, current.sequences, [])
				}
				return yield* fingerprintOf(current.session, current.contents)
			})
		)
		if (
			Result.isSuccess(settled) &&
			settled.success.catalog === current.baseline.catalog &&
			settled.success.contents === current.baseline.contents
		) {
			return
		}
		yield* Scope.close(current.scope, Exit.void)
		const replaced = yield* Effect.result(hold(opened, parent))
		yield* Ref.set(held, replaced)
		return yield* Effect.die(
			NeedFailed.make({
				need: form,
				message: Result.match(settled, {
					onFailure: (failure) =>
						`${current.database.name} could not be reset after the case: ${failure.message}`,
					onSuccess: () =>
						`the case left ${current.database.name} unlike its template after ${form}'s reset: it is dropped, and the next case gets a new clone`
				})
			})
		)
	})

/**
 * A need whose cases share one clone per worker, one case at a time (a worker evaluates its cases one after another),
 * each case's clone checked back to its template after the case (settle). The worker holds its clone, or why it could
 * not hold a new one, which the next case meets by trying once more. `take` gives one case its resource over the held
 * clone, in the case's scope.
 */
const heldNeed = <A>(
	key: string,
	template: DatabaseTemplate,
	reset: ReadonlyArray<string>,
	take: (held: Held) => Effect.Effect<A, NeedFailed, Scope.Scope | PgCluster>
): DatabaseNeed<A> => ({
	key,
	template,
	open: Effect.map(
		Effect.gen(function* () {
			const cluster = yield* required(
				PgCluster,
				"a held clone is cloned on the cluster the runner config's layer provides (PgCluster.layer)"
			)
			const opened = yield* template.open
			const parent = yield* Effect.scope
			const first = yield* Effect.provideService(hold(opened, parent), PgCluster, cluster)
			const holding: Result.Result<Held, NeedFailed> = Result.succeed(first)
			const held = yield* Ref.make(holding)
			return { cluster, opened, parent, held }
		}),
		({ cluster, opened, parent, held }) =>
			Effect.provideService(
				Effect.gen(function* () {
					const holding = yield* Ref.get(held)
					const current = Result.isSuccess(holding)
						? holding.success
						: yield* Effect.tap(hold(opened, parent), (again) =>
								Ref.set(held, Result.succeed(again))
							)
					yield* Effect.addFinalizer(() => settle(held, opened, parent, reset, key))
					return yield* take(current)
				}),
				PgCluster,
				cluster
			)
	)
})

/**
 * Each case on the worker's own clone of `template`, which it may commit to, `reset` (statements run on an owner
 * session in the clone after the case, such as TRUNCATE ... RESTART IDENTITY over the tables the case writes) returning
 * it to the template: after the reset, every sequence is put back and the clone must have its template's fingerprint
 * again, or it is replaced and the case fails. For many fast cases that commit into one installed schema, where a clone
 * per case would cost more than the cases.
 */
const seat = (template: DatabaseTemplate, reset: ReadonlyArray<string>): DatabaseNeed<Database> =>
	heldNeed(
		`@bjornpagen/testing/resources Database.seat ${template.key} ${canonicalText(reset)}`,
		template,
		reset,
		(held) => Effect.succeed(held.database)
	)

/**
 * One case's transaction on the worker's own clone: a session the cluster opens in the clone, inside a transaction that
 * is rolled back when the case ends. The resource has no commit; a case that ends its transaction anyway (a COMMIT sent
 * as SQL) fails, and anything it left in the clone fails the fingerprint check and replaces the clone.
 */
export type Transaction = Readonly<{ database: Database; session: PgSession }>

/** The transaction a case runs in, checked still open (the same transaction id) before it is rolled back. */
const transactionOf = (
	held: Held
): Effect.Effect<Transaction, NeedFailed, Scope.Scope | PgCluster> =>
	Effect.gen(function* () {
		const cluster = yield* PgCluster
		const session = yield* cluster.connect(held.database.member, held.database.name)
		yield* run(session, "BEGIN", [])
		const xid = yield* single(session, "SELECT pg_catalog.pg_current_xact_id()::text", [])
		yield* Effect.addFinalizer(() =>
			Effect.gen(function* () {
				const still = yield* single(
					session,
					"SELECT pg_catalog.pg_current_xact_id_if_assigned()::text",
					[]
				)
				yield* run(session, "ROLLBACK", [])
				if (still !== xid) {
					return yield* Effect.die(
						NeedFailed.make({
							need: "Database.transaction",
							message: `the case ended its transaction ${xid ?? "?"} on ${held.database.name} (its transaction is now ${still ?? "none"}): a transaction case is rolled back, never committed`
						})
					)
				}
			}).pipe(Effect.orDie)
		)
		return { database: held.database, session }
	})

/** Each case in one owner transaction on the worker's own clone of `template`, rolled back when the case ends. */
const transaction = (template: DatabaseTemplate): DatabaseNeed<Transaction> =>
	heldNeed(
		`@bjornpagen/testing/resources Database.transaction ${template.key}`,
		template,
		[],
		transactionOf
	)

/**
 * A case's choice among a closed set of templates: one need per key, each of the form `form` over its template, to
 * spread into a property's needs; a case takes only the one it draws (`yield* resources[key]`), since a case takes a
 * resource the first time its check yields it.
 */
const oneOf = <K extends string, A>(
	templates: Readonly<Record<K, DatabaseTemplate>>,
	form: (template: DatabaseTemplate) => DatabaseNeed<A>
): Readonly<Record<K, DatabaseNeed<A>>> => Rec.map(templates, form)

/** A database a case reaches: the member it lives on and its name there. */
export type Database = Readonly<{ member: PgMember; name: DatabaseName }>

/** The database forms a case's needs take: fresh (a clone a case), seat, transaction and oneOf. */
export const Database = { fresh, seat, transaction, oneOf } as const
