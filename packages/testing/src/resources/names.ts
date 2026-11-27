import { regex } from "arkregex"
import { Brand, Option, String as Str } from "effect"
import type { DatabaseName, DatabasePrefix, OwnerKey } from "#resources/cluster.ts"

/**
 * The names this library gives databases on a cluster, all after the repository's prefix, and the only place a
 * DatabaseName is minted: a template is `<prefix>tpl_<16 hex digits of its identity's digest><its build's key>`, and
 * its build runs in `<prefix>tpb_<the same 16><the same key>` (buildName), which a builder drops once it has copied it
 * to the template's name, so a template and the database it was built in share their build's key (templateKeyOf),
 * and every build of one identity is a template of its own; what the build read is in the template's comment
 * (template.ts Kept), which is what its standing compares. A clone is `<prefix>c_<its owner's key>_<the owner's
 * serial>`, so its owner lock tells whether the worker that made it still runs.
 */
const databaseName = Brand.nominal<DatabaseName>()

/**
 * A template's name: the cluster's prefix, `tpl_`, the first 16 hex digits of its identity's SHA-256 and its build's
 * key, 16 hex digits (template.ts ensureBuilt), so every build of one identity shares the digits that key its gate and
 * its use (cluster.ts lockKey, useKey; collect.ts) and is a template of its own, named alike at its build (buildName).
 */
export const templateName = (prefix: DatabasePrefix, identity: string, key: string): DatabaseName =>
	databaseName(`${prefix}tpl_${Str.slice(0, 16)(identity)}${key}`)

/** What every database named after the identity `identity` begins with (templateName): its templates and their copies. */
export const identityPrefixOf = (prefix: DatabasePrefix, identity: string): string =>
	`${prefix}tpl_${Str.slice(0, 16)(identity)}`

/**
 * The name of a template's build database: the cluster's prefix, `tpb_`, the first 16 hex digits of the template's
 * identity and its build's key (template.ts ensureBuilt), so the two are one width and share both: the digits that key
 * the template's gate, and the key its consumers' names derive from (templateKeyOf).
 */
export const buildName = (prefix: DatabasePrefix, identity: string, key: string): DatabaseName =>
	databaseName(`${prefix}tpb_${Str.slice(0, 16)(identity)}${key}`)

/** What every build database of the identity `identity` begins with (buildName): every build of it, under any key. */
export const buildPrefixOf = (prefix: DatabasePrefix, identity: string): string =>
	`${prefix}tpb_${Str.slice(0, 16)(identity)}`

/**
 * The key of the build a template's name or its build database's names, its last 16 hex digits: one at the build (its
 * TemplateDatabase's name) and at every clone of the template it made (a clone's `template`), and another for every
 * other build of the identity, so a name a consumer derives per template (a role prefix its build creates roles under)
 * is the same wherever the template is reached and never meets another build's. The key is the cluster's transaction
 * id (template.ts buildKeyQuery), a counter, so the digits that differ between builds are its last: a shorter name
 * derived from it takes them from its end.
 */
export const templateKeyOf = (name: string): string => Str.slice(-16)(name)

/** A clone's name: the cluster's prefix, `c_`, its owner's key and the owner's serial for it. */
export const cloneName = (prefix: DatabasePrefix, owner: OwnerKey, serial: number): DatabaseName =>
	databaseName(`${prefix}c_${owner}_${serial}`)

/**
 * A database of the cluster this library made, by what its name says: a template, a template's build database, or a
 * clone and its owner's key.
 */
export type Named =
	| Readonly<{ kind: "template"; name: DatabaseName }>
	| Readonly<{ kind: "build"; name: DatabaseName }>
	| Readonly<{ kind: "clone"; name: DatabaseName; owner: string }>

const templateSuffix = regex("^tpl_[0-9a-f]{32}$")

const buildSuffix = regex("^tpb_[0-9a-f]{32}$")

const cloneSuffix = regex("^c_([0-9a-f]{16})_[1-9][0-9]*$")

/** What `name` is among the databases this library makes under `prefix`, or none for any other database. */
export const namedOf = (prefix: DatabasePrefix, name: string): Option.Option<Named> => {
	if (!Str.startsWith(prefix)(name)) {
		return Option.none()
	}
	const suffix = Str.slice(prefix.length)(name)
	if (templateSuffix.test(suffix)) {
		return Option.some({ kind: "template", name: databaseName(name) })
	}
	if (buildSuffix.test(suffix)) {
		return Option.some({ kind: "build", name: databaseName(name) })
	}
	return Option.map(Option.fromNullishOr(cloneSuffix.exec(suffix)?.[1]), (owner) => ({
		kind: "clone",
		name: databaseName(name),
		owner
	}))
}
