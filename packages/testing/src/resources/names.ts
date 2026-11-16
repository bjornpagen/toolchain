import { regex } from "arkregex"
import { Brand, Option, String as Str } from "effect"
import type { DatabaseName, DatabasePrefix, OwnerKey } from "#resources/cluster.ts"

/**
 * The names this library gives databases on a cluster, all after the repository's prefix, and the only place a
 * DatabaseName is minted: a template is `<prefix>tpl_<32 hex digits of its identity's digest>`, so its name is its
 * identity; a clone is `<prefix>c_<its owner's key>_<the owner's serial>`, so its owner lock tells whether the worker
 * that made it still runs.
 */
const databaseName = Brand.nominal<DatabaseName>()

/** A template's name: the cluster's prefix, `tpl_`, and the first 32 hex digits of its identity's SHA-256. */
export const templateName = (prefix: DatabasePrefix, digest: string): DatabaseName =>
	databaseName(`${prefix}tpl_${Str.slice(0, 32)(digest)}`)

/** A clone's name: the cluster's prefix, `c_`, its owner's key and the owner's serial for it. */
export const cloneName = (prefix: DatabasePrefix, owner: OwnerKey, serial: number): DatabaseName =>
	databaseName(`${prefix}c_${owner}_${serial}`)

/** A database of the cluster this library made, by what its name says: a template, or a clone and its owner's key. */
export type Named =
	| Readonly<{ kind: "template"; name: DatabaseName }>
	| Readonly<{ kind: "clone"; name: DatabaseName; owner: string }>

const templateSuffix = regex("^tpl_[0-9a-f]{32}$")

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
	return Option.map(Option.fromNullishOr(cloneSuffix.exec(suffix)?.[1]), (owner) => ({
		kind: "clone",
		name: databaseName(name),
		owner
	}))
}
