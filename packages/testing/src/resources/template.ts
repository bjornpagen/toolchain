import { layerDigest } from "@effect/platform-node/NodeCrypto"
import {
	Array as Arr,
	Context,
	Effect,
	FileSystem,
	Layer,
	Option,
	Predicate,
	Record as Rec,
	Result,
	Schema,
	type Scope,
	String as Str
} from "effect"
import { Digest } from "effect/crypto"
import { waitingOn } from "#live.ts"
import { templateClaimsTable } from "#pg/settle.ts"
import type { NeedContext } from "#property.ts"
import {
	type Owner,
	PgCluster,
	type PgClusterShape,
	type PgMember,
	type Statements,
	type DatabaseName,
	databaseDroppedOn,
	lockKey,
	quoteIdent,
	quoteLiteral,
	required,
	run,
	single,
	templatesListed,
	useKey
} from "#resources/cluster.ts"
import type { Database, TemplateDatabase } from "#resources/database.ts"
import {
	buildName,
	buildPrefixOf,
	cloneName,
	namedOf,
	templateName,
	identityPrefixOf
} from "#resources/names.ts"
import { collectedOf } from "#runner/collected.ts"
import { asInfrastructure } from "#runner/infrastructure.ts"
import { guardRecorded, type Observation } from "#runner/observe.ts"
import { ObservationWire } from "#runner/protocol.ts"
import { ModuleClosure, NeedFailed, WorkerIndex } from "#runner/services.ts"
import type { KeyedRead } from "#runner/strace.ts"
import { absoluteOf, placeOf, standingOf, TracedRead } from "#traces.ts"

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
const canonicalText = (content: Content): string => {
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
 * `budget` is the CPU, in milliseconds, its open may spend on a worker, its build or the wait on another's included:
 * its owner's measured choice, stated with its evidence where the template is declared, which every need over it
 * (Database.fresh, oneOf) is judged by (property.ts Need).
 */
export type Template<T> = Readonly<{
	key: string
	budget: number
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
 * and its build's reads' (names.ts templateName), then marked a template that refuses connections, so it is immutable;
 * a case gets a clone of it. Its identity is the module that declares it (`declaredIn`, whose import-closure hash the
 * runner gives), its `name`, its `content`'s canonical text and its origin's name; what its build reads at run time (a
 * schema's SQL, a fixture: files no module loads) is kept with it and stands for it: a change to any of them is a new
 * template, and the old one is stale, collectable and never reused. `build` gets the database being built and makes in
 * it what `content` describes; it may connect to it as it likes, and must leave no session connected when it ends.
 */
export class DatabaseTemplate implements Template<Database> {
	readonly kind = "database-template"
	readonly key: string
	readonly declaredIn: string
	readonly name: string
	readonly content: string
	readonly from: Origin
	readonly budget: number
	readonly build: (target: TemplateDatabase) => Effect.Effect<void, NeedFailed, NeedContext>
	readonly open: Effect.Effect<Opened<Database>, NeedFailed, NeedContext>

	constructor(spec: DatabaseTemplateSpec) {
		this.declaredIn = spec.declaredIn.url
		this.name = spec.name
		this.content = canonicalText(spec.content)
		this.from = spec.from
		this.budget = spec.budget
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

/**
 * What a database template states: the declaring module's `import.meta`, a name, the content, the origin, the build,
 * and the budget its open may spend (Template), which is no part of its identity: a budget restated is the same
 * template.
 */
export type DatabaseTemplateSpec = Readonly<{
	declaredIn: ImportMeta
	name: string
	content: Content
	from: Origin
	budget: number
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
 * The strategy every template and clone is copied with, CREATE DATABASE ... STRATEGY FILE_COPY, one strategy for every
 * size, since a size between two would be a number no measurement fixes. FILE_COPY copies the source's files and forces
 * two checkpoints, before and after its copy (PostgreSQL 19.0 dbcommands.c CreateDatabaseUsingFileCopy, RequestCheckpoint
 * at L577 and L680); WAL_LOG forces none but writes every block of the source into WAL, a page image each (a DROP
 * DATABASE forces one checkpoint either way, dropdb L1885). Chosen by the member's CPU, the measure the machine's load
 * moves least, in the regime tests clone in, several clones at once (METIS-DBOPT, 2026-11-26: k clones at once and then
 * k drops of one template, three rounds each, on one member, fsync off, on ext4, at load 530 to 650;
 * ~/.cache/metis/METIS-DBOPT/runs/clone-profile.tsv and clone-profile2.tsv, scripts scratch/clone-profile.sh and
 * clone-profile2.sh). The member's CPU a round, in ms, FILE_COPY against WAL_LOG, at k = 1, 2 and 4:
 * - 8 MB: 43-56 against 141-225; 83-93 against 161-397; 193-197 against 374-533.
 * - 75 MB: 584-1,771 against 381-749; 343-1,237 against 859-1,353; 973-1,183 against 2,103-4,712.
 * - 248 MB (metis's installed template, 62,359 shared dependencies): 808-1,842 against 1,612-2,910; 1,784-3,252
 *   against 3,254-7,285; 3,153-3,539 against 11,945-13,029.
 * FILE_COPY spends less of the member's CPU wherever clones run at once, and at 248 MB at every k; the one cell against
 * it is a single clone of the 75 MB template, which no suite makes alone. Its wall time is 2 to 8 times lower at 248 MB
 * from k = 2 (k = 4: 4.3-5.2 s against 26-42 s) and mixed at the small sizes within the load's noise; WAL_LOG's edge
 * on a real tier of grizzle's small templates (lane PGFAMILY's arms, 2026-11-23: 37.4 min of the runner's properties
 * against FILE_COPY's 40.0, 860 and 771 forced checkpoints a member against 2,596 and 2,930) is 7% of wall, inside that
 * noise. Unmeasured: a member on memory-backed storage, where a checkpoint costs no disk.
 */
const strategy = "FILE_COPY"

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
	session: Statements,
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
 * Every database of the member named after a template's identity (names.ts identityPrefixOf, the parameter): its name,
 * whether it is built (a template that refuses connections, and valid: not a database a drop was interrupted in, whose
 * connection limit dropdb set to -2), and what its comment keeps (Kept), in name order.
 */
const templatesQuery = `SELECT d.datname::text, (d.datistemplate AND NOT d.datallowconn AND d.datconnlimit <> -2)::text, pg_catalog.shobj_description(d.oid, 'pg_database')
	FROM pg_catalog.pg_database AS d WHERE pg_catalog.starts_with(d.datname, $1) ORDER BY d.datname`

/**
 * A build's key, minted on its gate session (template.ts ensureBuilt): the transaction id the server assigns that
 * session's statement (pg_current_xact_id, 64 bits the cluster never assigns twice), as 16 hex digits, so every build of
 * every template on the member has a key of its own however its builders' processes are seeded, with no state of this
 * library's.
 */
const buildKeyQuery =
	"SELECT pg_catalog.lpad(pg_catalog.to_hex(pg_catalog.pg_current_xact_id()::text::int8), 16, '0')"

/** The SHA-256 of `text`, as hex, which the member computes on `session`. */
const digestOn = (session: Statements, text: string): Effect.Effect<string, NeedFailed> =>
	Effect.map(
		single(
			session,
			"SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to($1, 'UTF8')), 'hex')",
			[text]
		),
		(digest) => digest ?? ""
	)

/**
 * The identity digest of a template, from its declaration, its module's closure hash and its origin's name: the
 * SHA-256, as hex, of their canonical text, which the member computes on `session`. The closure is of the module as the
 * opening worker loads it (runner/module-closure.ts), a kill trial's mutant included, so a template a trial builds is
 * named by the mutant's code and no unmutated run ever opens it. The origin's name holds its build's reads' digest
 * (names.ts templateName), so a template built from another is a new one whenever its origin's build read anything
 * otherwise. That is version 3 of the text: version 2 named a template by this digest alone, so a template whose build
 * read a file no module loads (a schema's SQL) stood after the file changed, and every version-2 template is named by
 * no declaration now, which the next run's collection drops (collect.ts).
 */
const identityOf = (
	session: Owner["session"],
	template: DatabaseTemplate,
	closure: string,
	origin: string
): Effect.Effect<string, NeedFailed> =>
	digestOn(
		session,
		canonicalText([
			"@bjornpagen/testing/resources database template 3",
			template.name,
			template.content,
			closure,
			origin
		])
	)

/**
 * What a built template's comment keeps (COMMENT ON DATABASE, ensureBuilt): its declaration and its module's closure
 * hash; every read its build made (runner/collected.ts collectedOf), each by its place (traces.ts placeOf: under the
 * checkout from its root) with the digest of what it read once the build ended (traces.ts standingOf), in order of
 * kind, place and path; and the first observation past every key its build made (runner/observe.ts), none where it made
 * none.
 */
const Kept = Schema.fromJsonString(
	Schema.Struct({
		template: Schema.String,
		declaredIn: Schema.String,
		closure: Schema.String,
		reads: Schema.Array(TracedRead),
		observed: Schema.NullOr(ObservationWire)
	})
)

const decodeKept = Schema.decodeUnknownEffect(Kept)

/** What a build read and observed, as its template keeps them (Kept). */
type BuildReads = Readonly<{
	reads: ReadonlyArray<typeof TracedRead.Type>
	observed: Observation | undefined
}>

/** A template's identity on a cluster: its digest, its module's closure hash, and its origin, resolved (Built). */
type Identified = Readonly<{
	template: DatabaseTemplate
	digest: string
	closure: string
	origin: Option.Option<Built>
}>

/** A template resolved on a member: its identity and its name there, the template built from what its build read now. */
type Built = Readonly<{ identified: Identified; name: DatabaseName }>

/**
 * `template` resolved on `member`: its origin first, resolved the same way, so its name is part of this one's identity;
 * then the digest of its name, its content's canonical text, its declaring module's closure hash and its origin's name
 * (or the cluster's base, or the locale it is made fresh in), which keys its builds and its use; held in use for the
 * worker's life (holdInUse), then built there unless one of its builds stands (ensureBuilt), the name a run claims for
 * its checkout once it opens it (claimed).
 */
const resolved = (
	cluster: PgClusterShape,
	closures: ModuleClosure["Service"],
	owner: Owner,
	member: PgMember,
	template: DatabaseTemplate
): Effect.Effect<Built, NeedFailed, NeedContext | Digest.Digest> =>
	Effect.gen(function* () {
		const origin = yield* template.from.kind === "database-template"
			? Effect.asSome(resolved(cluster, closures, owner, member, template.from))
			: Effect.succeed(Option.none<Built>())
		const closure = yield* closures.hashOf(template.declaredIn)
		const digest = yield* identityOf(
			owner.session,
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
		const identified: Identified = { template, digest, closure, origin }
		yield* holdInUse(owner, identified)
		return { identified, name: yield* ensureBuilt(cluster, owner, identified, member) }
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
	locale: string
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
 * When a build began, as the file system's clock reads it: the modification time of a file made for it, the clock
 * every read's own modification time is on (traces.ts standingOf), which the kernel ticks coarser than the wall clock,
 * so a file changed after the mark is never stamped before it (runner/affected.ts runBegan). The runner's own act
 * (runner/infrastructure.ts), no property's.
 */
const buildBegan = (template: DatabaseTemplate): Effect.Effect<number, NeedFailed, NeedContext> =>
	asInfrastructure(
		Effect.scoped(
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const mark = yield* fs.makeTempFileScoped({ prefix: "toolchain-build-" })
				const info = yield* fs.stat(mark)
				return Option.getOrElse(
					Option.map(info.mtime, (at) => at.getTime()),
					() => 0
				)
			})
		).pipe(
			Effect.mapError((failure) =>
				NeedFailed.make({
					need: template.key,
					message: `the start of template ${template.name}'s build could not be marked: ${failure.message}`
				})
			)
		)
	)

/**
 * The reads `reads` of a build as its template keeps them (Kept): each once, in order of kind, place and path, by its
 * place in the checkout at `checkout` (traces.ts placeOf) with the digest of what it reads now (traces.ts standingOf);
 * and whether any changed at or after `began`, when the build began (buildBegan), so that what the build read may not be
 * what its digest holds. A read of the PostgreSQL serving the member is none of them: the template lives on that
 * server, and each opener's own connection to it reads it (runner/observe.ts guardServers). Weighed as the runner's
 * own work (runner/infrastructure.ts): reading a path's status to weigh it is no act of the property's.
 */
const weighedOf = (
	checkout: string,
	reads: ReadonlyArray<KeyedRead>,
	began: number
): Effect.Effect<
	Readonly<{ reads: BuildReads["reads"]; changed: boolean }>,
	never,
	NeedContext | Digest.Digest
> =>
	asInfrastructure(
		Effect.gen(function* () {
			const distinct = new Map<string, typeof TracedRead.Type>()
			let changed = false
			for (const read of reads) {
				if (read.kind === "postgres") {
					continue
				}
				const place = placeOf(checkout, read.path)
				const key = `${read.kind}\u0000${place.kind}\u0000${place.path}`
				if (distinct.has(key)) {
					continue
				}
				const standing = yield* standingOf(checkout, read.kind, read.path)
				changed = changed || standing.changed >= began
				distinct.set(key, {
					kind: read.kind,
					place: place.kind,
					path: place.path,
					digest: standing.digest
				})
			}
			return {
				reads: Arr.map(
					Arr.sortWith(Arr.fromIterable(distinct), ([key]) => key, Str.Order),
					([, read]) => read
				),
				changed
			}
		})
	)

/** Whether every read of `reads`, kept by a template's build (Kept), reads alike now in the checkout at `checkout`. */
const readsStand = (
	checkout: string,
	reads: BuildReads["reads"]
): Effect.Effect<boolean, never, NeedContext | Digest.Digest> =>
	asInfrastructure(
		Effect.gen(function* () {
			for (const read of reads) {
				const now = yield* standingOf(
					checkout,
					read.kind,
					absoluteOf(checkout, { kind: read.place, path: read.path })
				)
				if (now.digest !== read.digest) {
					return false
				}
			}
			return true
		})
	)

/**
 * The first built template of `identified`'s identity on the member (templatesQuery, over `session`) whose build's reads
 * all read alike now (Kept, readsStand), its build's reads and observation given to the property opening it as if it
 * had made them (runner/observe.ts guardRecorded): its verdict rests on what the template holds, so on what its build
 * read, whichever worker built it. None where none stands.
 */
const standingOn = (
	cluster: PgClusterShape,
	session: Statements,
	identified: Identified
): Effect.Effect<Option.Option<DatabaseName>, NeedFailed, NeedContext | Digest.Digest> =>
	Effect.gen(function* () {
		const checkout = yield* cluster.checkout
		const rows = yield* run(session, templatesQuery, [
			identityPrefixOf(cluster.prefix, identified.digest)
		])
		for (const [name, built, comment] of rows) {
			const named = Option.flatMap(Option.fromNullishOr(name), (text) =>
				namedOf(cluster.prefix, text)
			)
			if (built !== "true" || comment === null || comment === undefined || Option.isNone(named)) {
				continue
			}
			const kept = yield* Effect.option(decodeKept(comment))
			if (Option.isNone(kept) || !(yield* readsStand(checkout, kept.value.reads))) {
				continue
			}
			guardRecorded(
				Arr.map(kept.value.reads, (read) => ({
					kind: read.kind,
					path: absoluteOf(checkout, { kind: read.place, path: read.path })
				})),
				kept.value.observed ?? undefined
			)
			return Option.some(named.value.name)
		}
		return Option.none<DatabaseName>()
	})

/**
 * `database` on `member` with no backend left in it but none: every backend in it terminated, on a session of the
 * member's bootstrap superuser in the owner's database (cluster.ts superuser), who may end any of them (a session a
 * build left open, a backend of one it closed that is still exiting, an autovacuum worker, which PostgreSQL 19 lets in
 * whatever ALLOW_CONNECTIONS says, a superuser's), and each waited for until it has exited, on PostgreSQL's own wait
 * (pg_terminate_backend's timeout, signalfuncs.c pg_wait_until_termination, its latch), at most terminateWaitOf
 * `template` apiece; one still there past it fails the need, naming its process. Run just before the build database is
 * copied into its template, whose CREATE DATABASE refuses a source any other backend is in once its own five seconds of
 * waiting end (dbcommands.c, CountOtherDBBackends: grizzle's network tier, 2026-11-22, fin/scale.test, 55006 "source
 * database gz_tpb_... is being accessed by other users"); an autovacuum worker that enters after it is one CREATE
 * DATABASE signals itself. Run as well before the build database is dropped to be made again (builtIn: a builder's
 * that ended mid-build, or a build one of whose reads changed while it ran), whose DROP DATABASE WITH (FORCE) on the
 * owner's session may end no session of a superuser's ("permission denied to terminate process").
 */
const emptied = (
	cluster: PgClusterShape,
	member: PgMember,
	database: DatabaseName,
	template: DatabaseTemplate
): Effect.Effect<void, NeedFailed> =>
	Effect.scoped(
		Effect.gen(function* () {
			const superuser = yield* cluster.superuser(member, cluster.maintenance)
			const left = yield* run(
				superuser,
				"WITH there AS MATERIALIZED (SELECT pid FROM pg_catalog.pg_stat_activity WHERE datname = $1 AND pid <> pg_catalog.pg_backend_pid()) SELECT pid::text FROM there WHERE NOT pg_catalog.pg_terminate_backend(pid, $2::int8)",
				[database, `${terminateWaitOf(template)}`]
			)
			if (Arr.isReadonlyArrayNonEmpty(left)) {
				return yield* NeedFailed.make({
					need: template.key,
					message: `template ${template.name}'s build database ${database} still holds the backends ${Arr.join(
						Arr.map(left, ([pid]) => pid ?? "?"),
						", "
					)} past ${terminateWaitOf(template)} ms of their termination: its copy would be refused`
				})
			}
		})
	)

/**
 * How long, in milliseconds of wall time, the build of `template` waits for one backend left in its build database to
 * exit once terminated (emptied): as long as the build may spend of CPU, its budget, the bound the template states for
 * its whole open.
 *
 * @limitKind derived
 * @owner the testing library's database templates (resources/template.ts, ensureBuilt)
 * @unit milliseconds
 * @scope the wait for one terminated backend of one template's build database to exit, before its copy
 * @derivation a backend that SIGTERM ends exits within moments of being scheduled; one still there after the build's
 *   whole budget has passed is a backend PostgreSQL itself cannot end, which the build reports rather than waits on
 * @from the template's `budget` (Template.database), the milliseconds of CPU its open may spend
 */
const terminateWaitOf = (template: DatabaseTemplate): number => template.budget

/**
 * Builds `identified` on `member` in its build database `building` until a build's reads stand: the build database
 * made afresh from its origin (built first: resolved), the cluster's base or template0 in its locale, given its origin's
 * settings and privileges, which CREATE DATABASE does not copy (replayOf, as a clone is given its template's), so a
 * template built from another keeps what its origin's build set (GZ-PG-RUNTIME: grizzle's installTemplate over its base
 * lost the base's default_transaction_isolation and deadlock_timeout, and a build that writes failed); the build run in
 * a scope of its own, whose close ends its sessions, with what it read and observed collected (runner/collected.ts);
 * then its reads weighed (weighedOf). A build one of whose reads changed while it ran may hold what no digest of it
 * states, so it is dropped and made again, for as long as what it reads keeps changing under it.
 */
const builtIn = (
	cluster: PgClusterShape,
	owner: Owner,
	gate: Statements,
	identified: Identified,
	member: PgMember,
	building: DatabaseName,
	checkout: string
): Effect.Effect<BuildReads, NeedFailed, NeedContext | Digest.Digest> =>
	Effect.gen(function* () {
		const { template } = identified
		const began = yield* buildBegan(template)
		yield* emptied(cluster, member, building, template)
		yield* databaseDroppedOn(gate, building, "ended")
		yield* Option.match(identified.origin, {
			onNone: () =>
				template.from.kind === "fresh"
					? createdFresh(gate, template, building, template.from.locale)
					: run(
							gate,
							`CREATE DATABASE ${quoteIdent(building)} TEMPLATE ${quoteIdent(cluster.base)} STRATEGY ${strategy}`,
							[]
						),
			onSome: (origin) =>
				Effect.andThen(
					run(
						gate,
						`CREATE DATABASE ${quoteIdent(building)} TEMPLATE ${quoteIdent(origin.name)} STRATEGY ${strategy}`,
						[]
					),
					Effect.flatMap(replayOf(owner, origin.name), (inherited) =>
						replayedOn(cluster, member, gate, inherited(quoteIdent(building)))
					)
				)
		})
		const [, collected] = yield* collectedOf(
			Effect.scoped(template.build({ member, name: building }))
		)
		const weighed = yield* weighedOf(checkout, collected.reads, began)
		return weighed.changed
			? yield* builtIn(cluster, owner, gate, identified, member, building, checkout)
			: { reads: weighed.reads, observed: collected.observed }
	})

/**
 * The name of a built template of `identified` on `member` whose build's reads stand (standingOn), built there when none
 * does. Its name is its identity's digest and its build's key (names.ts templateName), the gate session's transaction
 * id (buildKeyQuery), which the database it is built in shares (buildName), and its comment keeps its build's reads
 * (Kept), so a template stands exactly while everything its build read reads alike: a build that reads a file no
 * module loads (a schema's SQL, a fixture) is made again once the file changed, and each opener that did not build it
 * is given its build's reads (standingOn), so a verdict cached over it is answered only while they stand. A built
 * template is taken as it is. Otherwise the builder waits in the server for the session-level advisory lock of the
 * identity's digest, in the owner's database, on a session of its own: the one gate, so concurrent builders of one
 * identity on one member, in any worker of any run, build it once and the rest find it standing once the lock is
 * theirs (a declared wait, live.ts waitingOn: the lock's holder sits between statements while its other connections
 * build, so no backend carrying the wait moves). Holding the lock, a database named after the identity that is not a
 * built template is a builder's that ended mid-copy, and is dropped, as is every build database of the identity
 * (names.ts buildPrefixOf), a builder's that ended mid-build under a key of its own.
 *
 * The build runs in the build database (builtIn); the template is then a copy of it under the template's name, given the
 * build database's settings and privileges in turn, and the build database is dropped; the copy is marked a template
 * that refuses connections, which is what built means. So nothing ever connects to a template: PostgreSQL keeps
 * statistics of a database only once a session has connected to it, and autovacuum enters a database it keeps
 * statistics of, templates and databases refusing connections among them (its workers skip datallowconn), where it
 * holds up every CREATE DATABASE ... TEMPLATE of it, which waits five seconds for it to leave once signalled and is
 * refused when it has not (CountOtherDBBackends: metis's 5451, 2026-11-20, sixteen copies refused, a worker held 11.5 s
 * by another drop's ProcSignalBarrier). A copy no session has entered has no statistics, and autovacuum leaves it alone
 * but for wraparound, past autovacuum_freeze_max_age of its frozen transaction id (PostgreSQL 19: neither strategy of
 * CREATE DATABASE, of the template or from it, gives the copy statistics). Before the copy the build database is emptied
 * of every backend still in it (emptied): a session the build left open, a backend of one it closed that is still
 * exiting, an autovacuum worker, which enters the build database whatever its ALLOW_CONNECTIONS, since the build gave it
 * statistics.
 */
const ensureBuilt = (
	cluster: PgClusterShape,
	owner: Owner,
	identified: Identified,
	member: PgMember
): Effect.Effect<DatabaseName, NeedFailed, NeedContext | Digest.Digest> =>
	Effect.gen(function* () {
		const standing = yield* standingOn(cluster, owner.session, identified)
		if (Option.isSome(standing)) {
			return standing.value
		}
		return yield* Effect.scoped(
			Effect.gen(function* () {
				const { template, digest, closure } = identified
				const gate = yield* cluster.connect(member, cluster.maintenance)
				yield* waitingOn(`the build of template ${template.name} on member ${member.name}`)(
					run(gate, `SELECT pg_catalog.pg_advisory_lock(${lockKey("$1")})::text`, [
						Str.slice(0, 16)(digest)
					])
				)
				const found = yield* standingOn(cluster, gate, identified)
				if (Option.isSome(found)) {
					return found.value
				}
				const named = yield* run(gate, templatesQuery, [identityPrefixOf(cluster.prefix, digest)])
				yield* Effect.forEach(
					Arr.filterMap(named, ([name, built]) =>
						built === "true" || name === null || name === undefined
							? Result.failVoid
							: Result.succeed(name)
					),
					(name) =>
						Option.match(namedOf(cluster.prefix, name), {
							onNone: () => Effect.void,
							onSome: (partial) => databaseDroppedOn(gate, partial.name, "ended")
						}),
					{ discard: true }
				)
				const stale = yield* run(gate, templatesQuery, [buildPrefixOf(cluster.prefix, digest)])
				yield* Effect.forEach(
					Arr.filterMap(stale, ([name]) =>
						Option.match(
							Option.flatMap(Option.fromNullishOr(name), (text) => namedOf(cluster.prefix, text)),
							{ onNone: () => Result.failVoid, onSome: (build) => Result.succeed(build.name) }
						)
					),
					(name) =>
						Effect.andThen(
							emptied(cluster, member, name, template),
							databaseDroppedOn(gate, name, "ended")
						),
					{ discard: true }
				)
				const key = yield* Effect.flatMap(single(gate, buildKeyQuery, []), (minted) =>
					Effect.mapError(Effect.fromOption(Option.fromNullishOr(minted)), () =>
						NeedFailed.make({
							need: template.name,
							message: `the build of template ${template.name} on member ${member.name} was given no key`
						})
					)
				)
				const building = buildName(cluster.prefix, digest, key)
				const checkout = yield* cluster.checkout
				const reads = yield* builtIn(cluster, owner, gate, identified, member, building, checkout)
				const name = templateName(cluster.prefix, digest, key)
				yield* emptied(cluster, member, building, template)
				yield* run(
					gate,
					`CREATE DATABASE ${quoteIdent(name)} TEMPLATE ${quoteIdent(building)} STRATEGY ${strategy}`,
					[]
				)
				yield* run(
					gate,
					`COMMENT ON DATABASE ${quoteIdent(name)} IS ${quoteLiteral(
						canonicalText({
							template: template.name,
							declaredIn: template.declaredIn,
							closure,
							reads: Arr.map(reads.reads, (read) => ({ ...read })),
							observed: reads.observed === undefined ? null : { ...reads.observed }
						})
					)}`,
					[]
				)
				yield* Effect.flatMap(replayOf(owner, building), (inherited) =>
					replayedOn(cluster, member, gate, inherited(quoteIdent(name)))
				)
				yield* databaseDroppedOn(gate, building, "ended")
				yield* run(gate, `ALTER DATABASE ${quoteIdent(name)} ALLOW_CONNECTIONS false`, [])
				yield* run(gate, `ALTER DATABASE ${quoteIdent(name)} IS_TEMPLATE true`, [])
				yield* templatesListed(cluster, member)
				return name
			})
		)
	})

/**
 * Holds the identified template in use for the worker's life: a session-level shared advisory lock on its identity's
 * use key (cluster.ts useKey), which every build of the identity shares (names.ts templateName), taken on the worker's
 * owner session, which ends with the worker; its origin is held as it is resolved (resolved). Collection drops a
 * template only once it holds that key exclusively (collect.ts), so it never drops one a live worker opened, which the
 * worker clones (and builds from) for as long as it runs, whichever run collects: a concurrent run of other
 * properties, or of other code, a kill trial's mutant included. Taken before the template is built, so a collection that
 * held a key first has dropped the template before the opener finds it absent and builds it again, waiting on a
 * collection that holds the key exclusively (a declared wait, live.ts waitingOn: the collection's session holds the key
 * between its statements).
 */
const holdInUse = (owner: Owner, identified: Identified): Effect.Effect<void, NeedFailed> =>
	Effect.asVoid(
		waitingOn(`the collection of template ${identified.template.name}`)(
			run(owner.session, `SELECT pg_catalog.pg_advisory_lock_shared(${useKey("$1")})::text`, [
				Str.slice(0, 16)(identified.digest)
			])
		)
	)

/**
 * The template `built` and every origin it is built from claimed by `runner`, the package directory of the runner
 * whose worker opened it, of `checkout` (pg/settle.ts templateClaimsTable), on the worker's owner session: a row of the
 * template, the checkout and the runner, with the template's logical identity (its name and its declaring module),
 * upserted in one statement that also drops that runner's claims of every other digest of the same logical template.
 * So a runner that moves to a new closure, or whose template's build read anything otherwise, gives up its old template
 * the moment it uses the new one, and only its own claim of it, while another runner of the checkout that uses another
 * digest of it (its conditions resolve a module otherwise) keeps its own: the two runners no longer drop each other's
 * template at every switch (metis, 2026-11-25: 338 s readying and 63.5 s of migrate CPU a switch). Collection keeps a
 * template while any existing checkout claims it (collect.ts), whichever run collects. Made after the template is held
 * in use (holdInUse) and built (ensureBuilt), so no collection finds it unclaimed and unheld between the two. It runs at
 * the owner session's READ COMMITTED (cluster.ts ownerLevel), so claims of two checkouts at once both commit.
 */
const claimed = (
	owner: Owner,
	built: Built,
	checkout: string,
	runner: string
): Effect.Effect<void, NeedFailed> =>
	Effect.andThen(
		Option.match(built.identified.origin, {
			onNone: () => Effect.void,
			onSome: (origin) => claimed(owner, origin, checkout, runner)
		}),
		run(
			owner.session,
			`WITH superseded AS (DELETE FROM public.${templateClaimsTable} WHERE checkout = $1 AND runner = $4 AND logical = $2 AND template <> $3) INSERT INTO public.${templateClaimsTable} (template, checkout, runner, logical) VALUES ($3, $1, $4, $2) ON CONFLICT (template, checkout, runner) DO UPDATE SET claimed = pg_catalog.clock_timestamp()`,
			[
				checkout,
				canonicalText({
					template: built.identified.template.name,
					declaredIn: built.identified.template.declaredIn
				}),
				built.name,
				runner
			]
		)
	)

/** Each session still in database $1, as a refused drop's log names it: its pid, role, application and backend type. */
const sessionsInQuery = `SELECT pg_catalog.string_agg(pg_catalog.format('%s %s %s %s', a.pid, a.usename, a.application_name, a.backend_type), '; ' ORDER BY a.pid) FROM pg_catalog.pg_stat_activity AS a WHERE a.datname = $1::name`

/**
 * A clone's drop the server refused, logged as a warning with the clone's name, the refusal and the sessions still in
 * the clone (sessionsInQuery), or why they could not be read: never the case's failure, since the run's collection drops
 * the clone once its worker has ended (openDatabaseTemplate).
 */
const refusedDropLogged = (
	session: Statements,
	clone: DatabaseName,
	refused: NeedFailed
): Effect.Effect<void> =>
	Effect.flatMap(Effect.result(single(session, sessionsInQuery, [clone])), (sessions) =>
		Effect.logWarning(
			`the drop of clone ${clone} was refused, and the run's collection drops it: ${refused.message}; the sessions in it: ${Result.match(
				sessions,
				{
					onFailure: (unread) => `unread (${unread.message})`,
					onSuccess: (listed) => listed ?? "none"
				}
			)}`
		)
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
 * reaches, the template resolved there (resolved: held in use for the worker's
 * life, and built unless a build of it stands, whose reads are then the opener's), and what each clone gets again. A clone is created in the caller's scope, which drops it when
 * it closes, then given its template's privileges and settings, and refused unless they are the template's. The drop is
 * the one drop of a database (cluster.ts databaseDropped): every replication slot made in the clone goes first, and
 * then the clone, its sessions awaited, never ended: the case's own sessions in the clone were closed before it, so it
 * waits only for their backends to leave (dbcommands.c dropdb, CountOtherDBBackends, five seconds at most), and a
 * session the case leaked is the case's to end, not the drop's, whose ending it would fail mid-run in the client that
 * holds it; only the run's collection ends sessions (collect.ts). A drop the server refuses (a session still in the
 * clone past the drop's wait, an autovacuum worker held up under load) never fails the case, whose verdict its teardown
 * is not: it is logged with the clone's name and the sessions still in it (refusedDropLogged), the clone is its
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
		const digest = yield* Effect.map(Layer.build(layerDigest), (services) =>
			Context.get(services, Digest.Digest)
		)
		const built = yield* Effect.provideService(
			resolved(cluster, closures, owner, member, template),
			Digest.Digest,
			digest
		)
		const checkout = yield* cluster.checkout
		yield* claimed(
			owner,
			built,
			checkout,
			process.getBuiltinModule("node:path").relative(checkout, closures.root) || "."
		)
		const name = built.name
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
				() =>
					Effect.catch(databaseDroppedOn(owner.session, made, "awaited"), (refused) =>
						refusedDropLogged(owner.session, made, refused)
					)
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
