import {
	Array as Arr,
	Effect,
	Option,
	Predicate,
	Record as Rec,
	type Scope,
	String as Str
} from "effect"
import type { NeedContext } from "#property.ts"
import {
	type Owner,
	PgCluster,
	type PgClusterShape,
	type PgMember,
	type PgSession,
	type DatabaseName,
	lockKey,
	quoteIdent,
	quoteLiteral,
	required,
	run,
	single,
	useKey
} from "#resources/cluster.ts"
import type { Database, TemplateDatabase } from "#resources/database.ts"
import { buildName, cloneName, templateName } from "#resources/names.ts"
import { ModuleClosure, NeedFailed, WorkerIndex } from "#runner/services.ts"

/**
 * What determines what a template's build makes, besides its code: data, never a function or an instance, so it has
 * one canonical text (canonicalText) whose digest is part of the template's identity.
 */
export type Content =
	| string
	| number
	| boolean
	| null
	| ReadonlyArray<Content>
	| { readonly [key: string]: Content }

/**
 * The canonical text of `content`: JSON with every object's keys in code-unit order, and every number in its shortest
 * round-trip form, -0, NaN and the infinities kept apart from 0 and null, so two contents share a text exactly when
 * they are the same data.
 */
export const canonicalText = (content: Content): string => {
	if (Predicate.isString(content)) {
		return quoted(content)
	}
	if (Predicate.isBoolean(content) || content === null) {
		return String(content)
	}
	if (Predicate.isNumber(content)) {
		return Object.is(content, -0) ? "-0" : String(content)
	}
	if (isList(content)) {
		return `[${Arr.join(Arr.map(content, canonicalText), ",")}]`
	}
	const entries = Arr.sortWith(Rec.toEntries(content), ([key]) => key, Str.Order)
	return `{${Arr.join(
		Arr.map(entries, ([key, value]) => `${quoted(key)}:${canonicalText(value)}`),
		","
	)}}`
}

/** A text in double quotes, each backslash and double quote escaped by a backslash: one text, one quoted form. */
const quoted = (text: string): string =>
	`"${Str.replaceAll('"', '\\"')(Str.replaceAll("\\", "\\\\")(text))}"`

/** Whether content is a list: its arrays are the only arrays a Content holds. */
const isList = (
	content: ReadonlyArray<Content> | { readonly [key: string]: Content }
): content is ReadonlyArray<Content> => Arr.isArray(content)

/** A template opened on a worker's side: all it offers is a clone, the caller's own for the caller's scope. */
export type Opened<T> = Readonly<{ clone: Effect.Effect<T, NeedFailed, Scope.Scope> }>

/**
 * A shared immutable value, built once where it lives and never changed after, of which a case only ever gets a clone:
 * opening it (once per worker, inside a need's open) builds it if it is not yet built and gives its Opened handle.
 */
export type Template<T> = Readonly<{
	key: string
	open: Effect.Effect<Opened<T>, NeedFailed, NeedContext>
}>

/**
 * Where a database template is built from: the cluster's own base database; a fresh database, template0 copied in a
 * libc `locale` of the member's (the locale a code under test runs in, where it is not the cluster's), the locale part
 * of the template's identity; or another template, whose identity is then part of this one's.
 */
export type Origin =
	| Readonly<{ kind: "cluster" }>
	| Readonly<{ kind: "fresh"; locale: string }>
	| DatabaseTemplate

/** A database template built from the cluster's base database (PgClusterSpec.base). */
const clusterBase: Origin = { kind: "cluster" }

/** A database template built from template0 in the libc locale `locale`, which the member must have. */
const freshIn = (locale: string): Origin => ({ kind: "fresh", locale })

/**
 * A template of databases: built once per cluster member, stored there as a database named by its identity's digest
 * (names.ts templateName), then marked a template that refuses connections, so it is immutable; a case gets a clone of
 * it. Its identity is the module that declares it (`declaredIn`, whose import-closure hash the runner gives), its
 * `name`, its `content`'s canonical text and its origin's identity: a change to any of them is a new template, and the
 * old one is stale, collectable and never reused. `build` gets the database being built and makes in it what `content`
 * describes; it may connect to it as it likes, and must leave no session connected when it ends.
 */
export class DatabaseTemplate implements Template<Database> {
	readonly kind = "database-template"
	readonly key: string
	readonly declaredIn: string
	readonly name: string
	readonly content: string
	readonly from: Origin
	readonly build: (target: TemplateDatabase) => Effect.Effect<void, NeedFailed, NeedContext>
	readonly open: Effect.Effect<Opened<Database>, NeedFailed, NeedContext>

	constructor(spec: DatabaseTemplateSpec) {
		this.declaredIn = spec.declaredIn.url
		this.name = spec.name
		this.content = canonicalText(spec.content)
		this.from = spec.from
		this.build = spec.build
		this.key = canonicalText([
			"database-template",
			this.declaredIn,
			this.name,
			this.content,
			originKey(spec.from)
		])
		this.open = Effect.suspend(() =>
			Effect.map(openDatabaseTemplate(this), (built) => ({ clone: built.clone }))
		)
	}
}

/** What a database template states: the declaring module's `import.meta`, a name, the content, the origin and the build. */
export type DatabaseTemplateSpec = Readonly<{
	declaredIn: ImportMeta
	name: string
	content: Content
	from: Origin
	build: (target: TemplateDatabase) => Effect.Effect<void, NeedFailed, NeedContext>
}>

/** An origin's key, as a template's key reads it. */
const originKey = (origin: Origin): string => {
	switch (origin.kind) {
		case "cluster":
			return "cluster"
		case "fresh":
			return `fresh ${origin.locale}`
		case "database-template":
			return origin.key
	}
}

/**
 * The clone strategies PostgreSQL offers (CREATE DATABASE ... STRATEGY), and the one a member clones with, by its
 * fsync: WAL_LOG where fsync is on, FILE_COPY where it is off. Measured on cassowary's PostgreSQL 19rc2 (a private
 * family of four members of grizzle's scripts/pg/init.sh, 2026-11-16 00:53 to 01:35 UTC; the probe and every sample in
 * ~/.cache/grizzle-release/TESTSYS/RESOURCES/measure/: clone.mjs, its rows in rate*.jsonl, family*.jsonl,
 * crossover.jsonl and nofsync*.jsonl, summarize.cjs): with fsync on, FILE_COPY's checkpoints before and after each copy
 * hold the whole machine at 27 to 30 create-and-drop cycles a second at 64 clients, one member or four, while WAL_LOG,
 * whose WAL is the template's size, made 113 to 131 a second of an 8 MB template over the family and 47 of a 26 MB one,
 * ahead at every size measured; with fsync off a checkpoint flushes nothing, and FILE_COPY made 1,335 a second over the
 * family against WAL_LOG's 760, and led at every size from 8 MB to 119 MB on one member.
 */
type Strategy = "WAL_LOG" | "FILE_COPY"

const strategyOf = (fsync: string | null): Strategy => (fsync === "off" ? "FILE_COPY" : "WAL_LOG")

/** The settings whose stored value is a list of quoted names, which a replay writes as it is stored (pg_dump's own list). */
const listQuoted: ReadonlySet<string> = new Set([
	"local_preload_libraries",
	"oauth_validator_libraries",
	"output_plugin_libraries",
	"search_path",
	"session_preload_libraries",
	"shared_preload_libraries",
	"temp_tablespaces",
	"unix_socket_directories"
])

/**
 * What CREATE DATABASE does not copy from a template, which every clone gets again: the database's privileges (its
 * datacl, which a clone starts without, dbcommands.c createdb) and its settings, database-wide and per role
 * (pg_db_role_setting, keyed by the database), each made by the identity that may make it. The database's privileges
 * and its own settings are its owner's to make (`owner`), as the owner made the template's in its build; a role's
 * setting in it is the bootstrap superuser's (`superuser`): making one takes the ADMIN option on the role, which only
 * the role's maker and a superuser hold, and a role the build's own superuser made (grizzle's owner login, made by its
 * substrate as the superuser) is no role of the owner's (5442, 2026-11-20 17:51 to 17:55Z: every clone of such a
 * template refused, 42501 "Only roles with CREATEROLE and ADMIN option"). Read from the built template once per
 * opening, as statements over the clone's quoted name.
 */
type Replay = (clone: string) => Replayed

/** A replay's statements on one database, by the identity that makes them. */
type Replayed = Readonly<{ owner: ReadonlyArray<string>; superuser: ReadonlyArray<string> }>

const aclQuery = `SELECT a.privilege_type::text,
	CASE WHEN a.grantee = 0::oid THEN 'PUBLIC' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) END,
	a.is_grantable::text
FROM pg_catalog.pg_database AS d CROSS JOIN LATERAL pg_catalog.aclexplode(d.datacl) WITH ORDINALITY AS a(grantor, grantee, privilege_type, is_grantable, n)
WHERE d.datname = $1::name ORDER BY a.n`

const settingsQuery = `SELECT CASE WHEN s.setrole = 0::oid THEN '' ELSE pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(s.setrole)) END,
	pg_catalog.split_part(c.item, '=', 1), pg_catalog.substr(c.item, pg_catalog.strpos(c.item, '=') + 1)
FROM pg_catalog.pg_db_role_setting AS s JOIN pg_catalog.pg_database AS d ON d.oid = s.setdatabase
	CROSS JOIN LATERAL pg_catalog.unnest(s.setconfig) WITH ORDINALITY AS c(item, n)
WHERE d.datname = $1::name ORDER BY s.setrole, c.n`

/** Whether a clone's privileges and settings are its template's, as text: 'true' or 'false'. */
const replayedQuery = `WITH s AS (
	SELECT d.datname, COALESCE(pg_catalog.array_agg(r.setrole::text || ':' || pg_catalog.array_to_string(r.setconfig, ',') ORDER BY r.setrole), '{}') AS settings
	FROM pg_catalog.pg_database AS d LEFT JOIN pg_catalog.pg_db_role_setting AS r ON r.setdatabase = d.oid
	WHERE d.datname IN ($1::name, $2::name) GROUP BY d.datname)
SELECT ((SELECT datacl::text FROM pg_catalog.pg_database WHERE datname = $1::name)
		IS NOT DISTINCT FROM (SELECT datacl::text FROM pg_catalog.pg_database WHERE datname = $2::name)
	AND (SELECT settings FROM s WHERE datname = $1::name) = (SELECT settings FROM s WHERE datname = $2::name))::text`

/** `ALTER target SET` of a stored setting, its value written as it is stored where the setting is a list of names. */
const settingOf = (target: string, setting: string | null, value: string | null): string => {
	const name = setting ?? ""
	const stored = value ?? ""
	return `ALTER ${target} SET ${name} = ${listQuoted.has(name) ? stored : quoteLiteral(stored)}`
}

/**
 * The replay of a template's privileges and settings, read on the owner's session: for its clones, and for a template
 * built from it.
 */
const replayOf = (owner: Owner, template: DatabaseName): Effect.Effect<Replay, NeedFailed> =>
	Effect.gen(function* () {
		const [acl, settings, unset] = yield* Effect.all([
			run(owner.session, aclQuery, [template]),
			run(owner.session, settingsQuery, [template]),
			single(
				owner.session,
				"SELECT (datacl IS NULL)::text FROM pg_catalog.pg_database WHERE datname = $1::name",
				[template]
			)
		])
		return (clone) => ({
			owner: [
				...(unset === "true"
					? []
					: [
							`REVOKE ALL ON DATABASE ${clone} FROM PUBLIC`,
							`REVOKE ALL ON DATABASE ${clone} FROM CURRENT_USER`,
							...Arr.map(
								acl,
								([privilege, grantee, grantable]) =>
									`GRANT ${privilege ?? ""} ON DATABASE ${clone} TO ${grantee ?? ""}${grantable === "true" ? " WITH GRANT OPTION" : ""}`
							)
						]),
				...Arr.flatMap(settings, ([role, setting, value]) =>
					role === "" || role === null
						? [settingOf(`DATABASE ${clone}`, setting ?? null, value ?? null)]
						: []
				)
			],
			superuser: Arr.flatMap(settings, ([role, setting, value]) =>
				role === "" || role === null
					? []
					: [settingOf(`ROLE ${role} IN DATABASE ${clone}`, setting ?? null, value ?? null)]
			)
		})
	})

/**
 * `replayed` made on `member`: the owner's statements on `session`, the owner's, and the superuser's on a session of
 * the member's bootstrap superuser in the owner's database, opened for them alone and only when there are any.
 */
const replayedOn = (
	cluster: PgClusterShape,
	member: PgMember,
	session: PgSession,
	replayed: Replayed
): Effect.Effect<void, NeedFailed> =>
	Effect.andThen(
		Effect.forEach(replayed.owner, (statement) => run(session, statement, []), { discard: true }),
		Arr.match(replayed.superuser, {
			onEmpty: () => Effect.void,
			onNonEmpty: (statements) =>
				Effect.scoped(
					Effect.flatMap(cluster.superuser(member, cluster.maintenance), (superuser) =>
						Effect.forEach(statements, (statement) => run(superuser, statement, []), {
							discard: true
						})
					)
				)
		})
	)

/**
 * The state of `name` on the member, as text: 'ready' (a template that refuses connections, and valid: not a database
 * a drop was interrupted in, whose connection limit dropdb set to -2), 'partial' or 'absent'.
 */
const stateQuery = `SELECT COALESCE((SELECT CASE WHEN datistemplate AND NOT datallowconn AND datconnlimit <> -2 THEN 'ready' ELSE 'partial' END
	FROM pg_catalog.pg_database WHERE datname = $1::name), 'absent')`

/**
 * The identity digest of a template, from its declaration, its module's closure hash and its origin's identity: the
 * SHA-256, as hex, of their canonical text, which the member computes on `session`. The closure is of the module as the
 * opening worker loads it (runner/module-closure.ts), a kill trial's mutant included, so a template a trial builds is
 * named by the mutant's code and no unmutated run ever opens it. That is version 2 of the text: version 1 hashed the
 * checkout's files as they are on disk, so a template first built in a trial was kept under the unmutated identity, and
 * every version-1 template is named by no declaration now, which the next run's collection drops (collect.ts).
 */
const identityOf = (
	session: Owner["session"],
	template: DatabaseTemplate,
	closure: string,
	origin: string
): Effect.Effect<string, NeedFailed> =>
	Effect.map(
		single(
			session,
			"SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to($1, 'UTF8')), 'hex')",
			[
				canonicalText([
					"@bjornpagen/testing/resources database template 2",
					template.name,
					template.content,
					closure,
					origin
				])
			]
		),
		(digest) => digest ?? ""
	)

/** A template's identity on a cluster: its name there, its digest, its module's closure hash and its origin's identity. */
export type Identified = Readonly<{
	template: DatabaseTemplate
	name: DatabaseName
	digest: string
	closure: string
	origin: Option.Option<Identified>
}>

/**
 * A template's identity on `cluster`, computed without building anything: its origin's first, then the digest of its
 * name, its content's canonical text, its declaring module's closure hash and its origin's name (or the cluster's base),
 * which names it (names.ts templateName). Collection names the declared templates this way.
 */
export const identify = (
	cluster: PgClusterShape,
	closures: ModuleClosure["Service"],
	session: Owner["session"],
	template: DatabaseTemplate
): Effect.Effect<Identified, NeedFailed> =>
	Effect.gen(function* () {
		const origin = yield* template.from.kind === "database-template"
			? Effect.asSome(identify(cluster, closures, session, template.from))
			: Effect.succeed(Option.none<Identified>())
		const closure = yield* closures.hashOf(template.declaredIn)
		const digest = yield* identityOf(
			session,
			template,
			closure,
			Option.match(origin, {
				onNone: () =>
					template.from.kind === "fresh"
						? `fresh ${template.from.locale}`
						: `cluster ${cluster.base}`,
				onSome: (built) => built.name
			})
		)
		return { template, name: templateName(cluster.prefix, digest), digest, closure, origin }
	})

/**
 * A libc locale name as glibc matches one: case aside, and its separators (`-`, `_`, `.`) dropped, so `en_US.UTF-8`
 * names the locale initdb imported as `en_US.utf8`.
 */
const localeKey = (placeholder: string): string =>
	`pg_catalog.lower(pg_catalog.regexp_replace(${placeholder}, '[-_.]', '', 'g'))`

/**
 * Makes `name` from template0 in the libc locale `locale`, refused with a NeedFailed that names the locale, before any
 * database is made, when the member has no such locale: none of the libc collations it imported from the system (initdb's
 * import of `locale -a`, pg_import_system_collations after) names it.
 */
const createdFresh = (
	gate: Parameters<typeof run>[0],
	template: DatabaseTemplate,
	name: DatabaseName,
	locale: string,
	strategy: Strategy
): Effect.Effect<void, NeedFailed> =>
	Effect.gen(function* () {
		const known = yield* single(
			gate,
			`SELECT EXISTS (SELECT FROM pg_catalog.pg_collation WHERE collprovider = 'c' AND ${localeKey("collcollate")} = ${localeKey("$1")})::text`,
			[locale]
		)
		if (known !== "true") {
			return yield* NeedFailed.make({
				need: template.key,
				message: `template ${template.name} is built in the locale ${locale}, which the member has not: no libc collation of its names it (install the locale, then SELECT pg_catalog.pg_import_system_collations('pg_catalog'))`
			})
		}
		yield* run(
			gate,
			`CREATE DATABASE ${quoteIdent(name)} TEMPLATE template0 LOCALE_PROVIDER libc LOCALE ${quoteLiteral(locale)} STRATEGY ${strategy}`,
			[]
		)
	})

/**
 * Makes sure the identified template is built on `member`. A built template (a template refusing connections) is
 * taken as it is. Otherwise the builder waits in the server for the session-level advisory lock of the template's
 * digest, in the owner's database, on a session of its own: the one gate, so concurrent builders of one template on one
 * member, in any worker of any run, build it once and the rest find it built once the lock is theirs (a declared wait,
 * as every statement is: cluster.ts run). Holding the lock, a database of the template's name that is not a built
 * template, and the template's build database (names.ts buildName), are a builder's that ended mid-build, and are
 * dropped.
 *
 * The build runs in the build database, a copy of the origin (built first, the same way) given the origin's settings and
 * privileges, which CREATE DATABASE does not copy (replayOf, as a clone is given its template's), so a template built
 * from another keeps what its origin's build set (GZ-PG-RUNTIME: grizzle's installTemplate over its base lost the base's
 * default_transaction_isolation and deadlock_timeout, and a build that writes failed); the build runs in a scope of its
 * own, whose close ends its sessions. The template is then a copy of the build database under the template's name,
 * given the build database's settings and privileges in turn, and the build database is dropped; the copy is marked a
 * template that refuses connections, which is what built means. So nothing ever connects to a template: PostgreSQL keeps
 * statistics of a database only once a session has connected to it, and autovacuum enters a database it keeps
 * statistics of, templates and databases refusing connections among them (its workers skip datallowconn), where it
 * holds up every CREATE DATABASE ... TEMPLATE of it, which waits five seconds for it to leave once signalled and is
 * refused when it has not (CountOtherDBBackends: metis's 5451, 2026-11-20, sixteen copies refused, a worker held 11.5 s
 * by another drop's ProcSignalBarrier). A copy no session has entered has no statistics, and autovacuum leaves it alone
 * but for wraparound, past autovacuum_freeze_max_age of its frozen transaction id (PostgreSQL 19: neither strategy of
 * CREATE DATABASE, of the template or from it, gives the copy statistics). A session the build left open fails the
 * copy, once PostgreSQL's own wait for it ends.
 */
const ensureBuilt = (
	cluster: PgClusterShape,
	identified: Identified,
	member: PgMember,
	strategy: Strategy
): Effect.Effect<void, NeedFailed, NeedContext> =>
	Effect.gen(function* () {
		const { template, name, digest, closure } = identified
		if (Option.isSome(identified.origin)) {
			yield* ensureBuilt(cluster, identified.origin.value, member, strategy)
		}
		const owner = yield* cluster.owner(member)
		if ((yield* single(owner.session, stateQuery, [name])) === "ready") {
			return
		}
		yield* Effect.scoped(
			Effect.gen(function* () {
				const gate = yield* cluster.connect(member, cluster.maintenance)
				yield* run(gate, `SELECT pg_catalog.pg_advisory_lock(${lockKey("$1")})::text`, [
					Str.slice(0, 16)(digest)
				])
				const state = yield* single(gate, stateQuery, [name])
				if (state === "ready") {
					return
				}
				if (state === "partial") {
					yield* run(gate, `DROP DATABASE ${quoteIdent(name)} WITH (FORCE)`, [])
				}
				const building = buildName(cluster.prefix, digest)
				yield* run(gate, `DROP DATABASE IF EXISTS ${quoteIdent(building)} WITH (FORCE)`, [])
				yield* Option.match(identified.origin, {
					onNone: () =>
						template.from.kind === "fresh"
							? createdFresh(gate, template, building, template.from.locale, strategy)
							: run(
									gate,
									`CREATE DATABASE ${quoteIdent(building)} TEMPLATE ${quoteIdent(cluster.base)} STRATEGY ${strategy}`,
									[]
								),
					onSome: (origin) =>
						run(
							gate,
							`CREATE DATABASE ${quoteIdent(building)} TEMPLATE ${quoteIdent(origin.name)} STRATEGY ${strategy}`,
							[]
						)
				})
				const replayed = (from: DatabaseName, onto: DatabaseName) =>
					Effect.flatMap(replayOf(owner, from), (inherited) =>
						replayedOn(cluster, member, gate, inherited(quoteIdent(onto)))
					)
				yield* Option.match(identified.origin, {
					onNone: () => Effect.void,
					onSome: (origin) => replayed(origin.name, building)
				})
				yield* Effect.scoped(template.build({ member, name: building }))
				yield* run(
					gate,
					`CREATE DATABASE ${quoteIdent(name)} TEMPLATE ${quoteIdent(building)} STRATEGY ${strategy}`,
					[]
				)
				yield* run(
					gate,
					`COMMENT ON DATABASE ${quoteIdent(name)} IS ${quoteLiteral(canonicalText({ template: template.name, declaredIn: template.declaredIn, closure }))}`,
					[]
				)
				yield* replayed(building, name)
				yield* run(gate, `DROP DATABASE IF EXISTS ${quoteIdent(building)} WITH (FORCE)`, [])
				yield* run(gate, `ALTER DATABASE ${quoteIdent(name)} ALLOW_CONNECTIONS false`, [])
				yield* run(gate, `ALTER DATABASE ${quoteIdent(name)} IS_TEMPLATE true`, [])
			})
		)
	})

/**
 * Holds the identified template and every origin it is built from in use for the worker's life: a session-level shared
 * advisory lock on each one's use key (cluster.ts useKey), taken on the worker's owner session, which ends with the
 * worker. Collection drops a template only once it holds that key exclusively (collect.ts), so it never drops one a
 * live worker opened, which the worker clones (and builds from) for as long as it runs, whichever run collects: a
 * concurrent run of other properties, or of other code, a kill trial's mutant included. Taken before the template is
 * built, so a collection that held a key first has dropped the template before the opener finds it absent and builds it
 * again, waiting on a collection that holds the key exclusively (a declared wait: cluster.ts run).
 */
const holdInUse = (owner: Owner, identified: Identified): Effect.Effect<void, NeedFailed> =>
	Effect.andThen(
		Option.match(identified.origin, {
			onNone: () => Effect.void,
			onSome: (origin) => holdInUse(owner, origin)
		}),
		run(owner.session, `SELECT pg_catalog.pg_advisory_lock_shared(${useKey("$1")})::text`, [
			Str.slice(0, 16)(identified.digest)
		])
	)

/** A database template opened on the worker's member: its name there, how a clone of it is made, and what a clone gets again. */
type BuiltTemplate = Readonly<{
	member: PgMember
	name: DatabaseName
	owner: Owner
	clone: Effect.Effect<Database, NeedFailed, Scope.Scope>
}>

/**
 * Opens `template` on the worker's member: the cluster and the closure hashes from the run, the member the worker
 * reaches, the template held in use for the worker's life (holdInUse) and built there once (ensureBuilt), the strategy
 * the member clones with, and what each clone gets again. A clone is created in the caller's scope, which drops it when
 * it closes, then given its template's privileges and settings, and refused unless they are the template's. The drop
 * ends no session: the case's own sessions in the clone were closed before it, so it waits only for their backends to
 * leave (dbcommands.c dropdb, CountOtherDBBackends, five seconds at most), and a session the case leaked is the case's
 * to end, not the drop's, whose ending it would fail mid-run in the client that holds it; only the run's collection
 * ends sessions (collect.ts). A drop the server refuses (a session still in the clone past the drop's wait, an
 * autovacuum worker held up under load) never fails the case, whose verdict its teardown is not: the clone is its
 * worker's, by its owner key, and the run's collection drops it once the worker has ended (runner/run.ts collected).
 */
const openDatabaseTemplate = (
	template: DatabaseTemplate
): Effect.Effect<BuiltTemplate, NeedFailed, NeedContext> =>
	Effect.gen(function* () {
		const cluster = yield* required(
			PgCluster,
			"a database template is built on the cluster the runner config's layer provides (PgCluster.layer)"
		)
		const closures = yield* ModuleClosure
		const worker = yield* WorkerIndex
		const member = yield* cluster.memberOf(worker)
		const owner = yield* cluster.owner(member)
		const fsync = yield* single(owner.session, "SELECT pg_catalog.current_setting('fsync')", [])
		const strategy = strategyOf(fsync)
		const identified = yield* identify(cluster, closures, owner.session, template)
		yield* holdInUse(owner, identified)
		yield* ensureBuilt(cluster, identified, member, strategy)
		const name = identified.name
		const replay = yield* replayOf(owner, name)
		const clone: Effect.Effect<Database, NeedFailed, Scope.Scope> = Effect.gen(function* () {
			const serial = yield* owner.serial
			const made = cloneName(cluster.prefix, owner.key, serial)
			yield* Effect.acquireRelease(
				run(
					owner.session,
					`CREATE DATABASE ${quoteIdent(made)} TEMPLATE ${quoteIdent(name)} STRATEGY ${strategy}`,
					[]
				),
				() => Effect.ignore(run(owner.session, `DROP DATABASE IF EXISTS ${quoteIdent(made)}`, []))
			)
			yield* replayedOn(cluster, member, owner.session, replay(quoteIdent(made)))
			if ((yield* single(owner.session, replayedQuery, [made, name])) !== "true") {
				return yield* NeedFailed.make({
					need: template.key,
					message: `clone ${made} of template ${template.name} does not hold the template's privileges and settings after their replay`
				})
			}
			return { member, name: made, template: name }
		})
		return { member, name, owner, clone }
	})

/** A database template (DatabaseTemplate): `Template.database({ declaredIn: import.meta, name, content, from, build })`. */
const database = (spec: DatabaseTemplateSpec): DatabaseTemplate => new DatabaseTemplate(spec)

/**
 * Templates: `Template.database(spec)`; `Template.cluster`, the origin of a template built from the cluster's base; and
 * `Template.fresh(locale)`, the origin of one built from template0 in a libc locale of the member's.
 */
export const Template = { database, cluster: clusterBase, fresh: freshIn } as const
