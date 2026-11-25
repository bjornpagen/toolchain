import { Array as Arr, Effect, Option, Order, Record, Schema, String as Str } from "effect"
import { Yaml } from "effect/encoding"
import { type DevtoolFailure, failureFrom } from "#shared/devtool.ts"
import type { Finding } from "#shared/finding.ts"
import { isLine, lineOf, yamlKey } from "#workspace/banned-packages.ts"

/**
 * The catalog agreement (catalog-agreement): one package, one version, through every pnpm workspace a repository holds.
 * A repository holds, beside its root's pnpm workspace, every other one in its tree at any depth, its own or a
 * submodule's (qti-pie's inside edullm and metis, a vendored grizzle's or toolchain's, and what each vendors in turn):
 * each is the workspace its repository's packages install by when that repository is installed alone, so a version one
 * of them states that the root states otherwise is a second version of one package, the one the vendored repository
 * proves its code against and not the one the root runs it with. Three rules hold every workspace to the root's, over
 * each entry the two share (both state it; an entry one side alone states is no agreement's to judge):
 * - version: the workspace states the entry at the root's versions;
 * - exclusion: the workspace states the root's release-age exclusions of the entry, as written, and no other, so the
 *   tree trusts a fresh release of it by one policy (`effect` and `@effect/*` as much as `@ui-sdk/core@0.1.0-beta.2`);
 * - excluded version: a release-age exclusion of a shared entry that names versions (`name@1.2.3`, `name@1.2.3 || 1.2.4`)
 *   names only the root's, wherever it is stated.
 * A workspace is read resolved, as pnpm resolves it: an entry's versions are those its catalog and named catalogs state
 * (`catalogs.<name>`, `catalogs.default` the catalog), or, where an override names the entry, that override's alone, an
 * override of `catalog:` or `catalog:<name>` the version that catalog states (an override scoped to a parent or a range,
 * `a>b` or `b@<2`, is an entry of its own selector, which only the same selector shares). An exclusion names an entry by
 * its package pattern, a name or a glob of `*` (`@effect/*`). A repository whose root holds no pnpm workspace has no
 * versions to agree with. No exception excuses a finding.
 */

/** The rule's id, as its findings name it. */
export const CATALOG_AGREEMENT_RULE = "catalog-agreement"

/** A catalog's entries, each a version or a specifier. */
const Catalog = Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Finite]))

/** What the agreement reads of a pnpm-workspace.yaml. */
const Workspace = Schema.Struct({
	catalog: Schema.optionalKey(Schema.NullOr(Catalog)),
	catalogs: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.NullOr(Catalog)))),
	overrides: Schema.optionalKey(Schema.NullOr(Catalog)),
	minimumReleaseAgeExclude: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String)))
})

/** A workspace manifest: its file (absolute) and its text. */
export type WorkspaceText = Readonly<{ file: string; text: string }>

/** An entry as a workspace states it: its versions, in order, and the section headers above the line that states it. */
type Stated = Readonly<{ versions: ReadonlyArray<string>; section: ReadonlyArray<string> }>

/** A workspace as pnpm resolves it: each entry as it states it, and its release-age exclusions as written. */
export type ResolvedWorkspace = WorkspaceText &
	Readonly<{ entries: ReadonlyMap<string, Stated>; exclusions: ReadonlyArray<string> }>

/** The default catalog's name, as `catalog:default` and `catalogs.default` write it. */
const DEFAULT_CATALOG = "default"

/** The prefix of a specifier that names a catalog's version. */
const CATALOG_PROTOCOL = "catalog:"

/** The workspace a manifest holds, resolved; a text that is no workspace manifest fails the gate. */
export const resolvedWorkspace = (
	manifest: WorkspaceText
): Effect.Effect<ResolvedWorkspace, DevtoolFailure> =>
	Effect.try({
		try: () => Yaml.parse(manifest.text),
		catch: failureFrom(`${manifest.file} is no YAML the catalog agreement reads`)
	}).pipe(
		Effect.flatMap((parsed) =>
			Schema.decodeUnknownEffect(Workspace)(parsed).pipe(
				Effect.mapError(
					failureFrom(`${manifest.file} is no workspace manifest the catalog agreement reads`)
				)
			)
		),
		Effect.map((workspace): ResolvedWorkspace => {
			const catalogs = [
				{ name: DEFAULT_CATALOG, section: ["catalog:"], entries: workspace.catalog ?? {} },
				...Arr.map(Record.toEntries(workspace.catalogs ?? {}), ([name, entries]) => ({
					name,
					section: ["catalogs:", `  ${name}:`],
					entries: entries ?? {}
				}))
			]
			const entries = new Map<string, Stated>()
			for (const catalog of catalogs) {
				for (const [entry, version] of Record.toEntries(catalog.entries)) {
					const stated = entries.get(entry)
					entries.set(entry, {
						versions: [...(stated?.versions ?? []), String(version)],
						section: stated?.section ?? catalog.section
					})
				}
			}
			for (const [entry, specifier] of Record.toEntries(workspace.overrides ?? {})) {
				const written = String(specifier)
				const named = Str.startsWith(CATALOG_PROTOCOL)(written)
					? Option.some(Str.slice(CATALOG_PROTOCOL.length)(written) || DEFAULT_CATALOG)
					: Option.none()
				const version = Option.match(named, {
					onNone: () => written,
					onSome: (name) =>
						Option.getOrElse(
							Option.flatMap(
								Arr.findFirst(catalogs, (catalog) => catalog.name === name),
								(catalog) => Record.get(catalog.entries, entry)
							),
							() => written
						)
				})
				entries.set(entry, { versions: [String(version)], section: ["overrides:"] })
			}
			return {
				...manifest,
				entries: new Map(
					Arr.map([...entries], ([entry, stated]) => [
						entry,
						{ ...stated, versions: Arr.sort(Arr.dedupe(stated.versions), Order.String) }
					])
				),
				exclusions: workspace.minimumReleaseAgeExclude ?? []
			}
		})
	)

/** An exclusion's package pattern and the versions it names, none where it names no version: `name@1.2.3 || 1.2.4`, a
 * scope's leading `@` aside. */
const exclusionOf = (
	exclusion: string
): Readonly<{ pattern: string; versions: ReadonlyArray<string> }> => {
	const at = Option.filter(Str.lastIndexOf("@")(exclusion), (index) => index > 0)
	return Option.match(at, {
		onNone: () => ({ pattern: exclusion, versions: [] }),
		onSome: (index) => ({
			pattern: Str.slice(0, index)(exclusion),
			versions: Arr.map(Str.split("||")(Str.slice(index + 1)(exclusion)), (version) =>
				Str.trim(version)
			)
		})
	})
}

/** Whether a package pattern, a name or a glob whose `*` stands for any run of characters, names an entry. */
const names = (pattern: string, entry: string): boolean => {
	const [first, ...rest] = Str.split("*")(pattern)
	if (!Arr.isReadonlyArrayNonEmpty(rest)) {
		return entry === first
	}
	const last = Arr.lastNonEmpty(rest)
	if (!Str.startsWith(first)(entry) || entry.length < first.length + last.length) {
		return false
	}
	const middle = Arr.reduce(Arr.initNonEmpty(rest), Option.some(first.length), (from, part) =>
		Option.flatMap(from, (at) =>
			Option.map(Str.indexOf(part)(Str.slice(at)(entry)), (found) => at + found + part.length)
		)
	)
	return (
		Option.exists(middle, (at) => at <= entry.length - last.length) && Str.endsWith(last)(entry)
	)
}

/** The exclusions of `exclusions` that name `entry`. */
const naming = (exclusions: ReadonlyArray<string>, entry: string): ReadonlyArray<string> =>
	Arr.filter(exclusions, (exclusion) => names(exclusionOf(exclusion).pattern, entry))

/** One way a workspace disagrees with the root's over an entry they share, at the line of the file that states it. */
export type Disagreement = Readonly<
	{ file: string; line: number; entry: string } & (
		| { rule: "version"; versions: ReadonlyArray<string>; root: ReadonlyArray<string> }
		| { rule: "exclusion"; exclusion: string; statedBy: "root" | "workspace" }
		| { rule: "excluded version"; exclusion: string; root: ReadonlyArray<string> }
	)
>

/** Whether a line opens the release-age exclusions. */
const exclusionsHeader = isLine("minimumReleaseAgeExclude:")

/** Whether a line writes `exclusion` as a list item, bare or quoted. */
const writesItem =
	(exclusion: string) =>
	(line: string): boolean =>
		Arr.contains([`- ${exclusion}`, `- "${exclusion}"`, `- '${exclusion}'`], Str.trim(line))

/** The line of a workspace's manifest that writes `exclusion`. */
const exclusionLine = (workspace: WorkspaceText, exclusion: string): number =>
	lineOf(workspace.text, [exclusionsHeader], writesItem(exclusion))

/** Every way the workspaces `vendored` disagree with `root`'s, by the agreement's three rules. */
export const disagreementsOf = (
	root: ResolvedWorkspace,
	vendored: ReadonlyArray<ResolvedWorkspace>
): ReadonlyArray<Disagreement> => {
	const rootVersions = (entry: string): ReadonlyArray<string> =>
		root.entries.get(entry)?.versions ?? []
	const sharedWith = (workspace: ResolvedWorkspace): ReadonlyArray<string> =>
		Arr.filter([...root.entries.keys()], (entry) => workspace.entries.has(entry))
	const perWorkspace = Arr.flatMap(vendored, (workspace) =>
		Arr.flatMap(sharedWith(workspace), (entry): ReadonlyArray<Disagreement> => {
			const stated = workspace.entries.get(entry) ?? { versions: [], section: [] }
			const theirs = naming(workspace.exclusions, entry)
			const ours = naming(root.exclusions, entry)
			return [
				...(Arr.makeEquivalence(Str.Equivalence)(stated.versions, rootVersions(entry))
					? []
					: [
							{
								rule: "version",
								file: workspace.file,
								line: lineOf(workspace.text, Arr.map(stated.section, isLine), yamlKey(entry)),
								entry,
								versions: stated.versions,
								root: rootVersions(entry)
							} as const
						]),
				...Arr.map(Arr.difference(ours, theirs), (exclusion) => ({
					rule: "exclusion" as const,
					file: workspace.file,
					line: lineOf(workspace.text, [], exclusionsHeader),
					entry,
					exclusion,
					statedBy: "root" as const
				})),
				...Arr.map(Arr.difference(theirs, ours), (exclusion) => ({
					rule: "exclusion" as const,
					file: workspace.file,
					line: exclusionLine(workspace, exclusion),
					entry,
					exclusion,
					statedBy: "workspace" as const
				}))
			]
		})
	)
	const shared = Arr.dedupe(Arr.flatMap(vendored, (workspace) => sharedWith(workspace)))
	const excludedVersions = Arr.flatMap([root, ...vendored], (workspace) =>
		Arr.flatMap(workspace.exclusions, (exclusion): ReadonlyArray<Disagreement> => {
			const { pattern, versions } = exclusionOf(exclusion)
			const named = Arr.filter(shared, (entry) => names(pattern, entry))
			return Arr.flatMap(named, (entry): ReadonlyArray<Disagreement> =>
				Arr.every(versions, (version) => Arr.contains(rootVersions(entry), version))
					? []
					: [
							{
								rule: "excluded version",
								file: workspace.file,
								line: exclusionLine(workspace, exclusion),
								entry,
								exclusion,
								root: rootVersions(entry)
							}
						]
			)
		})
	)
	return [...perWorkspace, ...excludedVersions]
}

/** Versions as a list a reader takes in at a glance. */
const listed = (versions: ReadonlyArray<string>): string => Arr.join(versions, " and ")

/** What a disagreement tells its reader: what is wrong, and how to make it agree. */
const wordsOf = (disagreement: Disagreement): Readonly<{ message: string; suggestion: string }> => {
	const { entry } = disagreement
	switch (disagreement.rule) {
		case "version":
			return {
				message: `${entry} is ${listed(disagreement.versions)} in this workspace and ${listed(disagreement.root)} in the root's: one package at two versions in one tree.`,
				suggestion: `State ${entry} at ${listed(disagreement.root)} here, or move the root's to ${listed(disagreement.versions)}: one version everywhere.`
			}
		case "exclusion":
			return disagreement.statedBy === "root"
				? {
						message: `the root's workspace exempts ${entry} from the release-age wait by ${disagreement.exclusion}, which this workspace, sharing ${entry}, does not state.`,
						suggestion: `State ${disagreement.exclusion} here too, or drop it from the root's: one release-age policy for ${entry}.`
					}
				: {
						message: `this workspace exempts ${entry} from the release-age wait by ${disagreement.exclusion}, which the root's, sharing ${entry}, does not state.`,
						suggestion: `State ${disagreement.exclusion} in the root's too, or drop it here: one release-age policy for ${entry}.`
					}
		case "excluded version":
			return {
				message: `the release-age exclusion ${disagreement.exclusion} names a version of ${entry} the tree does not install: it installs ${listed(disagreement.root)}.`,
				suggestion: `Name ${entry}@${Arr.join(disagreement.root, " || ")}, or drop the exclusion.`
			}
	}
}

/**
 * The agreement's findings over a repository: `root`, its root's workspace manifest where it holds one, and every
 * other one its tree holds, each disagreement at the line of the file that states it.
 */
export const catalogAgreementFindings = (
	input: Readonly<{ root: Option.Option<WorkspaceText>; vendored: ReadonlyArray<WorkspaceText> }>
): Effect.Effect<ReadonlyArray<Finding>, DevtoolFailure> =>
	Option.match(input.root, {
		onNone: () => Effect.succeed([]),
		onSome: (manifest) =>
			Effect.gen(function* () {
				const root = yield* resolvedWorkspace(manifest)
				const vendored = yield* Effect.forEach(input.vendored, resolvedWorkspace)
				return Arr.map(disagreementsOf(root, vendored), (disagreement): Finding => ({
					file: disagreement.file,
					line: disagreement.line,
					column: 1,
					rule: CATALOG_AGREEMENT_RULE,
					...wordsOf(disagreement)
				}))
			})
	})
