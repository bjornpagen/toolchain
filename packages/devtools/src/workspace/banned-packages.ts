import { Array as Arr, Effect, Option, Record, Schema, String as Str } from "effect"
import { Yaml } from "effect/encoding"
import { DevtoolFailure } from "#shared/devtool.ts"
import type { Finding } from "#shared/finding.ts"
import type { BannedPackages } from "#workspace/rules.ts"

/**
 * The banned-packages law: no edge the repository states itself reaches a banned package (the preset's
 * BANNED_PACKAGES, zod among them, and the repository's own bannedPackages), so no file can import one however its lint
 * blocks read. The edges it states are a workspace package's direct ones: each dependency, devDependency,
 * peerDependency and optionalDependency of the root's and every workspace package's package.json, each entry of
 * pnpm-workspace.yaml's catalog and named catalogs, and each importer's direct dependency in pnpm-lock.yaml (its
 * dependencies, devDependencies and optionalDependencies). An edge names a package by its key or, under an alias, by
 * its `npm:` specifier (`"schema": "npm:zod@^3"` installs zod). A third party's own dependencies and peers, which the
 * lockfile's packages and snapshots hold, are out of scope: zod as a transitive peer of the AI SDK or of Drizzle is the
 * third party's, which no file of the repository may import all the same (the preset's import ban). This law takes no
 * exception: toolchain.config.ts's exceptions name no rule of it.
 */

/** The rule's id, which no exception names. */
export const BANNED_PACKAGES_RULE = "banned-packages"

/** The workspace's package list and catalogs. */
export const WORKSPACE_MANIFEST = "pnpm-workspace.yaml"

/** The lockfile, whose importers are the workspace's packages. */
export const LOCKFILE = "pnpm-lock.yaml"

/** The fields of a manifest that state a package's direct edges. */
const MANIFEST_FIELDS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies"
] as const

/** The fields of a lockfile importer that state its direct edges. */
const IMPORTER_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"] as const

/** Edges by package name, each with its specifier. */
const Edges = Schema.Record(Schema.String, Schema.String)

/** What the law reads of a manifest: its name and its edges. */
const Manifest = Schema.fromJsonString(
	Schema.Struct({
		name: Schema.optionalKey(Schema.String),
		dependencies: Schema.optionalKey(Edges),
		devDependencies: Schema.optionalKey(Edges),
		peerDependencies: Schema.optionalKey(Edges),
		optionalDependencies: Schema.optionalKey(Edges)
	})
)

/** A catalog's entries, each a version or a specifier. */
const Catalog = Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Finite]))

/** What the law reads of pnpm-workspace.yaml: its catalog and named catalogs. */
const Workspace = Schema.Struct({
	catalog: Schema.optionalKey(Schema.NullOr(Catalog)),
	catalogs: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.NullOr(Catalog))))
})

/** The lockfile's sections the law judges, each a map of entries whose edge fields it reads: the importers alone, the
 * workspace's packages. The packages and snapshots sections hold the third parties' own edges, which it never reads. */
const LOCKFILE_SECTIONS = ["importers"] as const

/** A lockfile edge: an importer's states its specifier, a snapshot's its version alone. */
const LockfileEdge = Schema.Union([
	Schema.Struct({ specifier: Schema.Union([Schema.String, Schema.Finite]) }),
	Schema.String,
	Schema.Finite
])

/** A lockfile section's entries, each with its edge fields. */
const Section = Schema.NullOr(
	Schema.Record(
		Schema.String,
		Schema.Struct({
			dependencies: Schema.optionalKey(Schema.Record(Schema.String, LockfileEdge)),
			devDependencies: Schema.optionalKey(Schema.Record(Schema.String, LockfileEdge)),
			optionalDependencies: Schema.optionalKey(Schema.Record(Schema.String, LockfileEdge))
		})
	)
)

/** The specifier of a lockfile edge. */
const specifierOf = (edge: typeof LockfileEdge.Type): string =>
	typeof edge === "object" ? String(edge.specifier) : String(edge)

/** The package a specifier installs under an alias (`npm:zod@^3`, `npm:@scope/name@1`), if it is one. */
const aliasedOf = (specifier: string): Option.Option<string> =>
	Option.map(
		Str.startsWith("npm:")(specifier) ? Option.some(Str.slice(4)(specifier)) : Option.none(),
		(target) =>
			Option.match(Str.lastIndexOf("@")(target), {
				onNone: () => target,
				onSome: (at) => (at === 0 ? target : Str.slice(0, at)(target))
			})
	)

/** The banned package an edge names, by its key or its alias. */
const bannedOf =
	(banned: BannedPackages) =>
	(name: string, specifier: string): Option.Option<BannedPackages[number]> => {
		const aliased = aliasedOf(specifier)
		return Arr.findFirst(
			banned,
			(entry) => entry.name === name || Option.contains(aliased, entry.name)
		)
	}

/** Whether a line writes `name` as a key: JSON's `"name":`, YAML's `name:` or either quoted form. */
export const yamlKey =
	(name: string) =>
	(line: string): boolean => {
		const key = Str.trimStart(line)
		return Arr.some([`${name}:`, `'${name}':`, `"${name}":`], (form) => Str.startsWith(form)(key))
	}

/** Whether a line is `header` as a YAML text writes a section's key alone on its line (`catalog:`, `  legacy:`). */
export const isLine =
	(header: string) =>
	(line: string): boolean =>
		Str.trimEnd(line) === header

/** The 1-based line of the first line that writes `key` after the first lines each anchor holds in turn, else the
 * first. */
export const lineOf = (
	text: string,
	anchors: ReadonlyArray<(line: string) => boolean>,
	key: (line: string) => boolean
): number => {
	const lines = Str.split("\n")(text)
	const from = Arr.reduce(anchors, 0, (at, anchor) =>
		Option.match(Arr.findFirstIndex(Arr.drop(lines, at), anchor), {
			onNone: () => at,
			onSome: (found) => at + found
		})
	)
	return Option.match(Arr.findFirstIndex(Arr.drop(lines, from), key), {
		onNone: () => 1,
		onSome: (at) => from + at + 1
	})
}

/** A text that is not the file the law reads fails the gate. */
const unreadable = (path: string, what: string) => (cause: unknown) =>
	DevtoolFailure.make({ detail: `${path} is not ${what} the banned-packages law reads`, cause })

/** One stated edge to a banned package, reported where it is written. */
const findingOf = (
	input: Readonly<{ file: string; line: number; edge: string; banned: BannedPackages[number] }>
): Finding => ({
	file: input.file,
	line: input.line,
	column: 1,
	rule: BANNED_PACKAGES_RULE,
	message: `${input.edge} names the banned package ${input.banned.name}. ${input.banned.message}`,
	suggestion: `Delete the edge, and admit what it was for without ${input.banned.name}.`
})

/** A top-level section of a YAML text, from its key's line to the next top-level key, as a text of its own; a section the
 * text lacks is empty. */
const sectionOf = (text: string, section: string): string => {
	const lines = Str.split("\n")(text)
	return Option.match(
		Arr.findFirstIndex(lines, (line) => line === `${section}:`),
		{
			onNone: () => `${section}: {}`,
			onSome: (start) => {
				const rest = Arr.drop(lines, start + 1)
				const length = Option.getOrElse(
					Arr.findFirstIndex(rest, (line) => Str.isNonEmpty(line) && !Str.startsWith(" ")(line)),
					() => rest.length
				)
				return Arr.join([`${section}:`, ...Arr.take(rest, length)], "\n")
			}
		}
	)
}

/** What the law reads: the repository's root, its banned packages, each workspace package's manifest by its
 * repository-relative path (the root's `package.json` among them), and pnpm-workspace.yaml's and the lockfile's texts,
 * which a repository may lack. */
export type StatedEdges = Readonly<{
	root: string
	banned: BannedPackages
	manifests: ReadonlyArray<Readonly<{ path: string; text: string }>>
	workspace: Option.Option<string>
	lockfile: Option.Option<string>
}>

/** Every edge the repository states to a banned package. */
export const bannedPackageFindings = (
	stated: StatedEdges
): Effect.Effect<ReadonlyArray<Finding>, DevtoolFailure> =>
	Effect.gen(function* () {
		const named = bannedOf(stated.banned)
		const manifests = yield* Effect.forEach(stated.manifests, ({ path, text }) =>
			Schema.decodeEffect(Manifest)(text).pipe(
				Effect.mapBoth({
					onFailure: unreadable(path, "a manifest"),
					onSuccess: (manifest): ReadonlyArray<Finding> =>
						Arr.flatMap(MANIFEST_FIELDS, (field) =>
							Arr.flatMap(Record.toEntries(manifest[field] ?? {}), ([name, specifier]) =>
								Option.match(named(name, specifier), {
									onNone: () => [],
									onSome: (banned) => [
										findingOf({
											file: `${stated.root}/${path}`,
											line: lineOf(text, [Str.includes(`"${field}"`)], yamlKey(name)),
											edge: `${manifest.name ?? path}'s ${field} entry ${name}`,
											banned
										})
									]
								})
							)
						)
				})
			)
		)
		const catalogs = yield* Option.match(stated.workspace, {
			onNone: () => Effect.succeed<ReadonlyArray<Finding>>([]),
			onSome: (text) =>
				Effect.map(
					Effect.try({
						try: () => Yaml.parse(text),
						catch: unreadable(WORKSPACE_MANIFEST, "the YAML")
					}).pipe(
						Effect.flatMap((parsed) =>
							Schema.decodeUnknownEffect(Workspace)(parsed).pipe(
								Effect.mapError(unreadable(WORKSPACE_MANIFEST, "a workspace manifest"))
							)
						)
					),
					(workspace): ReadonlyArray<Finding> =>
						Arr.flatMap(
							[
								{
									anchors: [isLine("catalog:")],
									catalog: "catalog",
									entries: workspace.catalog ?? {}
								},
								...Arr.map(Record.toEntries(workspace.catalogs ?? {}), ([name, entries]) => ({
									anchors: [isLine("catalogs:"), isLine(`  ${name}:`)],
									catalog: `catalogs.${name}`,
									entries: entries ?? {}
								}))
							],
							({ anchors, catalog, entries }): ReadonlyArray<Finding> =>
								Arr.flatMap(Record.toEntries(entries), ([name, version]) =>
									Option.match(named(name, String(version)), {
										onNone: () => [],
										onSome: (banned) => [
											findingOf({
												file: `${stated.root}/${WORKSPACE_MANIFEST}`,
												line: lineOf(text, anchors, yamlKey(name)),
												edge: `${WORKSPACE_MANIFEST}'s ${catalog} entry ${name}`,
												banned
											})
										]
									})
								)
						)
				)
		})
		const importers = yield* Option.match(stated.lockfile, {
			onNone: () => Effect.succeed<ReadonlyArray<Finding>>([]),
			onSome: (text) =>
				Effect.forEach(LOCKFILE_SECTIONS, (section) =>
					Effect.try({
						try: () => Yaml.parse(sectionOf(text, section)),
						catch: unreadable(LOCKFILE, "the YAML")
					}).pipe(
						Effect.flatMap((parsed) =>
							Schema.decodeUnknownEffect(Schema.Struct({ [section]: Section }))(parsed).pipe(
								Effect.mapError(unreadable(LOCKFILE, "a lockfile"))
							)
						),
						Effect.map((read): ReadonlyArray<Finding> =>
							Arr.flatMap(Record.toEntries(read[section] ?? {}), ([entry, edges]) =>
								Arr.flatMap(IMPORTER_FIELDS, (field) =>
									Arr.flatMap(Record.toEntries(edges[field] ?? {}), ([name, edge]) =>
										Option.match(named(name, specifierOf(edge)), {
											onNone: () => [],
											onSome: (banned) => [
												findingOf({
													file: `${stated.root}/${LOCKFILE}`,
													line: lineOf(
														text,
														[isLine(`  ${entry}:`), isLine(`    ${field}:`)],
														yamlKey(name)
													),
													edge: `${LOCKFILE}'s ${section} entry ${entry}'s ${field} entry ${name}`,
													banned
												})
											]
										})
									)
								)
							)
						)
					)
				).pipe(Effect.map(Arr.flatten))
		})
		return [...Arr.flatten(manifests), ...catalogs, ...importers]
	})
