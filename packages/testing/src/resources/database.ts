import {
	Cause,
	Deferred,
	Effect,
	Exit,
	Option,
	Queue,
	Record as Rec,
	Ref,
	Result,
	Scope
} from "effect"
import { failureText } from "#failure.ts"
import type { Need, NeedContext } from "#property.ts"
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
 * How many clones of one template a worker's Database.fresh pool may hold (packages/testing/src/resources/database.ts):
 * each slot clones, offers its clone to the next case, waits for that case to end, drops it and clones again, so a
 * worker holds at most this many clones of a template and the next cases' clones are made while the current one runs.
 * A pool opens one slot and adds one each time a case finds no clone ready, so it reaches this many only while its
 * cases outrun its clones. Fewer, and a case waits for a clone; more, and a worker holds clones no case waits for.
 *
 * @limitKind measured
 * @owner the testing library's per-case resources (resources/database.ts, Database.fresh)
 * @unit clones of one template per worker
 * @scope one worker's pool of one template's clones; every worker holds its own, so a run holds up to this many clones
 *   of a template per worker that served it
 * @evidence ~/.cache/grizzle-release/TESTSYS/RESOURCES/measure/pool/ on cassowary, the uncommitted record of lane
 *   RESOURCES's probe: pool.ts, which runs the library's own Database.fresh (toolchain at 15bdf33 with the resources
 *   of slice 2) in 64 fibers of one process, each with a PgCluster service of its own (its own owner session, as a
 *   runner worker has) on member index mod 4 of a private family, one case after another: take a clone (the wait
 *   timed), connect, CREATE TABLE, then INSERT and count for the case's time; depth.jsonl and depth-on.jsonl, one row
 *   per case; env-fsync-off.txt and env-fsync-on.txt; summarize.cjs, which leaves out each run's first 8 s (the pools
 *   filling) and prints throughput and the take wait's quantiles
 * @observed 2026-11-16 08:25:00 to 08:30:54 UTC with fsync off; 2026-11-16 08:32:55 to 08:36:26 UTC with fsync on
 * @environment cassowary, Ubuntu 26.04 (Linux 7.0.0-1016-aws) on an AWS Graviton3 (arm64) instance with 64 logical
 *   CPUs and 247 GiB on one EBS volume, Node 26.13.1; a private family of four PostgreSQL 19rc2 members (grizzle's
 *   scripts/pg/init.sh at ac71cfbb, each sized for 16 workers) on that volume; load average 366 to 457 from other
 *   sessions during the fsync-off runs, 351 to 372 during the fsync-on ones
 * @workload 64 workers, one a core, each its own pool over one template (two statements: a table and its seed row, 8
 *   MB as cloned), 40 s a run; cases of 100 ms and of 25 ms of read-write work in their clone; depths 1, 2, 3 and 4
 *   with fsync off, the clones FILE_COPY; depths 2 and 4 with fsync on at 100 ms, the clones WAL_LOG
 * @result fsync off, 100 ms cases (take wait p50 / p90 / p99, ms; share of takes that waited under 5 ms): depth 1 892
 *   / 3,322 / 9,049, 0.00; 2 261 / 1,684 / 3,144, 0.43; 3 0 / 539 / 2,744, 0.84; 4 0 / 2 / 2,504, 0.90; 33 to 39 cases
 *   a second at every depth. 25 ms cases: depth 1 855 / 1,388 / 1,845, 0.00; 2 17 / 938 / 1,776, 0.49; 3 0 / 508 /
 *   1,326, 0.82; 4 0 / 0 / 1,555, 0.90; 47 to 79 cases a second. fsync on, 100 ms cases: depth 2 25,737 / 47,184 /
 *   48,789, 0.25, 3.4 cases a second; depth 4 0 / 27,444 / 84,054, 0.53, 1.7 cases a second: each DROP DATABASE waited
 *   on checkpoints it forces, which synced thousands of files on the loaded volume, so no depth hid a clone there. No
 *   errors; the cases' own run time rose with depth (more clones in flight on the cluster), not measured apart from it
 * @decision 4: the smallest depth at which nine takes in ten wait for no clone (p90 2 ms and 0 ms) at full width, at
 *   both case times; at 3 the p90 wait is still half a second. Each slot past it adds a clone held per worker and in
 *   flight on the cluster, and the throughput did not rise with depth: the cluster, not the pool, bounds a run's cases
 *   a second. No headroom added; 5 and above are unmeasured
 * @revalidate a PostgreSQL repin; another machine or disk; a family of another size, or clusters with fsync on (the
 *   clones then WAL_LOG); a template much larger than 8 MB; cases much shorter than 25 ms; a run whose takes wait past
 *   their p90 here
 */
const freshPoolDepth = 4

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
 * worker keeps a pool for each template it has served, whose slots (slot) clone as its cases ask: one slot opened with
 * the need, cloning for the first case while its property readies, and one more each time a case asks for a clone and
 * finds none ready, up to freshPoolDepth. So a worker keeps as many clones ahead as its cases outrun its slots, and
 * never more: one whose cases take longer than a clone, or are few, holds one clone ahead of them, not freshPoolDepth,
 * where every slot opened with the need made a clone at once, and made it again after each case it served, for cases
 * that may never come (SS-CONV: four standby clones and their drops at 19.2 ms of PostgreSQL's CPU each, for a worker
 * of one property's few batches). A clone a case takes was made while earlier cases ran wherever the cases leave a
 * slot the time to, and its drop runs after the case, in the slot, never in the case's time.
 */
const fresh = (template: DatabaseTemplate): DatabaseNeed<Database> => ({
	key: `@bjornpagen/testing/resources Database.fresh ${template.key}`,
	template,
	open: Effect.map(
		Effect.gen(function* () {
			const opened = yield* template.open
			const scope = yield* Effect.scope
			const ready = yield* Queue.unbounded<Ready>()
			const slots = yield* Ref.make(0)
			const grown = Effect.flatMap(
				Ref.modify(slots, (open): readonly [boolean, number] =>
					open < freshPoolDepth ? [true, open + 1] : [false, open]
				),
				(started) =>
					started ? Effect.asVoid(Effect.forkIn(slot(opened, ready), scope)) : Effect.void
			)
			yield* grown
			return { ready, grown }
		}),
		({ ready, grown }) =>
			Effect.andThen(
				Effect.flatMap(Queue.size(ready), (waiting) => (waiting === 0 ? grown : Effect.void)),
				takeReady(ready)
			)
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
 * database's catalog writes (none when it has no relation to read). A materialized view created WITH NO DATA refuses
 * to be read (55000), so its line is whether it is populated, which a case's REFRESH changes (GZ-PG-WRITE, GZ-LAWS:
 * a seat over grizzle's docs world and rule-seeding's viewed shape failed to open). Written once, from the clone as
 * cloned: a relation a case adds is in the catalog half, and one it drops fails the statement.
 */
const contentsQuery = `SELECT 'SELECT pg_catalog.md5(pg_catalog.string_agg(line, E''\\n'' ORDER BY line)) FROM (' || pg_catalog.string_agg(
	CASE WHEN c.relkind = 'S'
		THEN pg_catalog.format('SELECT %L || '' '' || last_value::text || '' '' || is_called::text FROM %s', c.oid::regclass::text, c.oid::regclass)
		WHEN c.relkind = 'm' AND NOT c.relispopulated
		THEN pg_catalog.format('SELECT %L || '' '' || (SELECT CASE WHEN relispopulated THEN ''populated'' ELSE ''unpopulated'' END FROM pg_catalog.pg_class WHERE oid = %s)', c.oid::regclass::text, c.oid)
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
 * A worker's own clone of a template, held across its cases: the clone, kept in a scope of its own; the statement that
 * puts its sequences back; and its fingerprint as cloned, which it must have again after every case. It holds no
 * session: each settle opens its own and closes it, so a worker serving many templates holds no connection for any of
 * them between cases.
 */
type Held = Readonly<{
	database: Database
	scope: Scope.Closeable
	sequences: string | null
	contents: string | null
	baseline: Fingerprint
}>

/** Clones the template into a scope of its own under `parent` and reads its baseline on a session closed after. */
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
				const read = yield* Effect.scoped(
					Effect.gen(function* () {
						const session = yield* cluster.connect(database.member, database.name)
						const sequences = yield* single(session, sequencesQuery, [])
						const contents = yield* single(session, contentsQuery, [])
						const baseline = yield* fingerprintOf(session, contents)
						return { sequences, contents, baseline }
					})
				)
				return { database, scope, ...read }
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
		const cluster = yield* PgCluster
		const settled = yield* Effect.result(
			Effect.scoped(
				Effect.gen(function* () {
					const session = yield* cluster.connect(current.database.member, current.database.name)
					yield* Effect.forEach(reset, (statement) => run(session, statement, []), {
						discard: true
					})
					if (current.sequences !== null) {
						yield* run(session, current.sequences, [])
					}
					return yield* fingerprintOf(session, current.contents)
				})
			)
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
 * `need` as a choice's member: opened on a process the first time a case there takes it, never when its property is
 * readied, since a case may never take it. Readying gives only the taker; the first take runs `need`'s open (its
 * template's build, the clone it holds) once, with the services and in the need's own scope that readying gave it, on a
 * fiber of its own, so the case that first takes it cannot cut it short and a later take reuses what it opened. Every
 * take awaits that open: one that fails, or dies (its defect's text the failure's message), fails every take with
 * NeedFailed, as a need that does not open when readied fails its property once, never a case. Opened when readied,
 * every member of a choice built its template at once on the worker's one connection lease: grizzle's
 * test/pg/fin/capacity-table.test.ts, whose nine seat templates are one choice, died LeaseBudgetExhausted while its
 * needs opened, before any case, though each of its cases takes one (lane LAND-GZ-B): nine template builds at once
 * outgrow the lease a worker holds, testPoolMax + 3 connections, whatever the machine's width.
 */
const chosen = <A>(need: DatabaseNeed<A>): DatabaseNeed<A> => ({
	key: need.key,
	template: need.template,
	open: Effect.map(Effect.context<NeedContext>(), (context) => {
		const opened = Deferred.makeUnsafe<Effect.Effect<A, NeedFailed, Scope.Scope>, NeedFailed>()
		let started = false
		const open = Effect.catchCauseIf(
			Effect.provideContext(need.open, context),
			(cause) => !Cause.hasInterruptsOnly(cause),
			(cause) =>
				Effect.fail(
					Option.getOrElse(Cause.findErrorOption(cause), () =>
						NeedFailed.make({ need: need.key, message: failureText(cause) })
					)
				)
		)
		return Effect.suspend(() => {
			const awaited = Effect.flatten(Deferred.await(opened))
			if (started) {
				return awaited
			}
			started = true
			return Effect.andThen(Effect.forkDetach(Deferred.into(open, opened)), awaited)
		})
	})
})

/**
 * A case's choice among a closed set of templates: one need per key, each of the form `form` over its template and
 * opened the first time a case takes it (chosen), to spread into a property's needs; a case takes only the one it draws
 * (`yield* resources[key]`), since a case takes a resource the first time its check yields it, so a process opens only
 * the members its cases drew.
 */
const oneOf = <K extends string, A>(
	templates: Readonly<Record<K, DatabaseTemplate>>,
	form: (template: DatabaseTemplate) => DatabaseNeed<A>
): Readonly<Record<K, DatabaseNeed<A>>> => Rec.map(templates, (template) => chosen(form(template)))

/**
 * A database a case reaches: the member it lives on, its name there, and the template it was cloned from, by that
 * template's name on the member (names.ts templateName: the prefix, `tpl_` and the template's identity digest), so what a
 * template's build made outside the database, such as cluster-wide roles named from its digest, is reachable from
 * every clone of it.
 */
export type Database = Readonly<{ member: PgMember; name: DatabaseName; template: DatabaseName }>

/** A template's database while its build runs: the member it is built on and its name there (names.ts templateName). */
export type TemplateDatabase = Readonly<{ member: PgMember; name: DatabaseName }>

/**
 * The database forms a case's needs take: fresh (a clone a case), seat, transaction, oneOf, and chosen, the form of a
 * choice's member that a repository's own choice of needs over templates gives each member.
 */
export const Database = { fresh, seat, transaction, oneOf, chosen } as const
