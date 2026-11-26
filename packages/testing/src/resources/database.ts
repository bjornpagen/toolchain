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
 * @limitKind provisional
 * @owner the testing library's per-case resources (resources/database.ts, Database.fresh)
 * @unit clones of one template per worker
 * @scope one worker's pool of one template's clones; every worker holds its own, so a run holds up to this many clones
 *   of a template per worker that served it
 * @guards without a most, a pool whose cases outrun its clones adds a slot for every case that finds none ready, so a
 *   worker holds a clone in flight for every such case at once, each a database on its member and a drop after it
 * @measure on a family of grizzle's spec, the 13-file laws subset at 32 workers under TEST_SEED=2219874524 (lane
 *   PGFAMILY's arms), depths 2, 4 and 8 at once, the clones WAL_LOG: the take wait's p50 and p90, the runner's time and
 *   the members' forced checkpoints; keep the smallest depth past which neither falls
 * @origin measured at 4 on 2026-11-16 with the clones FILE_COPY (fsync off) on a private family of four idle members
 *   (~/.cache/grizzle-release/TESTSYS/RESOURCES/measure/pool/, lane RESOURCES's probe: at depth 4 nine takes in ten
 *   waited for no clone, p90 2 ms; at 3 the p90 was half a second); its revalidation fired when every clone became
 *   WAL_LOG (resources/template.ts strategy, lane PGFAMILY)
 * @recorded 2026-11-23
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
