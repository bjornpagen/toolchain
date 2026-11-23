import {
	Array as Arr,
	Cause,
	Deferred,
	Effect,
	Option,
	Queue,
	Record as Rec,
	Ref,
	Result,
	type Scope
} from "effect"
import { failureText } from "#failure.ts"
import type { Need, NeedContext } from "#property.ts"
import type { DatabaseName, PgMember } from "#resources/cluster.ts"
import type { DatabaseTemplate, Opened } from "#resources/template.ts"
import { needStallMillis } from "#runner/limits.ts"
import { judgedGroup } from "#runner/opening.ts"
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
	budget: template.budget,
	runNeeds: [],
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
 * The statements that empty `tables` (each schema-qualified and quoted) of every row: one READ COMMITTED transaction of
 * their own, under the replica role, deleting each table's rows in one DO block; none for no table. The reset a caller
 * runs between the cases it commits to one database, never a TRUNCATE. A
 * TRUNCATE gives each table and each of its indexes a new relation file, and its commit drops the old files' pages by a
 * scan of every shared buffer: 16 clients on one server reset 117 cases a second by TRUNCATE, 2,662 by this deletion
 * and 18,517 by a rollback (grizzle's factory, 2026-11-23, over grizzle's pg tier at f87b2aaab). Under the replica role no trigger fires, neither a foreign key's nor any of the schema's own, so
 * no order of deletion is refused and none of the tables' rules judges a reset, as none judges a TRUNCATE, which fires
 * no row trigger; each table of `tables` is emptied, so no reference among them is left dangling, and a table outside
 * them that references one is the caller's to name. A READ COMMITTED transaction holds no SIREAD lock and is no
 * serializable transaction's, so no SERIALIZABLE transaction after it counts a conflict with what it deleted, and its
 * DELETE never fails with 40001. The deleted versions stay until a vacuum: a case meets them as dead rows, which change
 * what a plan reads, never what a statement answers. The session's role must be able to SET session_replication_role:
 * a cluster owner holds it where its spec's ownerParameters name it (pg/spec.ts).
 */
export const rowsEmptied = (tables: ReadonlyArray<string>): ReadonlyArray<string> =>
	Arr.match(tables, {
		onEmpty: () => [],
		onNonEmpty: (named) => [
			"BEGIN ISOLATION LEVEL READ COMMITTED",
			"SET LOCAL session_replication_role = replica",
			`DO $reset$\nBEGIN\n${Arr.join(
				Arr.map(named, (table) => `\tDELETE FROM ${table};`),
				"\n"
			)}\nEND\n$reset$`,
			"COMMIT"
		]
	})

/**
 * `need` as a choice's member: opened on a process the first time a case there takes it, never when its property is
 * readied, since a case may never take it. Readying gives only the taker; the first take runs `need`'s open (its
 * template's build, the clone it holds) once, with the services and in the need's own scope that readying gave it, on a
 * fiber of its own, so the case that first takes it cannot cut it short and a later take reuses what it opened; that
 * open is judged alone, by `need`'s budget and the stall window (runner/opening.ts judgedGroup), as a need opened alone
 * when readied is. Its budget is `need`'s, so a readying that opens it among others counts what its first take may
 * spend. Every take awaits that open: one that fails, or dies (its defect's text the failure's message), fails every
 * take with NeedFailed, as a need that does not open when readied fails its property once, never a case. Opened when readied,
 * every member of a choice built its template at once on the worker's one connection lease: grizzle's
 * test/pg/fin/capacity-table.test.ts, whose nine seat templates are one choice, died LeaseBudgetExhausted while its
 * needs opened, before any case, though each of its cases takes one (lane LAND-GZ-B): nine template builds at once
 * outgrow the lease a worker holds, testPoolMax + 3 connections, whatever the machine's width.
 */
const chosen = <A>(need: DatabaseNeed<A>): DatabaseNeed<A> => ({
	key: need.key,
	template: need.template,
	budget: need.budget,
	runNeeds: need.runNeeds,
	open: Effect.map(Effect.context<NeedContext>(), (context) => {
		const opened = Deferred.makeUnsafe<Effect.Effect<A, NeedFailed, Scope.Scope>, NeedFailed>()
		let started = false
		const open = Effect.catchCauseIf(
			Effect.flatMap(judgedGroup([need], needStallMillis), (judged) =>
				Effect.ensuring(
					judged.within(need.key, Effect.provideContext(need.open, context)),
					judged.ended
				)
			),
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
 * The database forms a case's needs take: fresh (a clone a case), oneOf, and chosen, the form of a choice's member that
 * a repository's own choice of needs over templates gives each member.
 */
export const Database = { fresh, oneOf, chosen } as const
