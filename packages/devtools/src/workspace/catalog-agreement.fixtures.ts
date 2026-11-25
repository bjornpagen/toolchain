import { element, type Gen, oneOf, subset, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Order, String as Str } from "effect"
import { WORKSPACE_MANIFEST } from "#workspace/banned-packages.ts"
import {
	CATALOG_AGREEMENT_RULE,
	catalogAgreementFindings,
	type Disagreement,
	disagreementsOf,
	resolvedWorkspace,
	type WorkspaceText
} from "#workspace/catalog-agreement.ts"

/**
 * The repositories the catalog-agreement property draws (catalog-agreement.test.ts), from a grammar of the agreement's
 * contract: a root's pnpm workspace, or none, and one to three other workspaces in its tree, one vendored inside
 * another. Each workspace states each of a roster of packages at one of two versions, or not at all, in one of the ways
 * pnpm resolves: in its catalog, in a named catalog, in both at two versions, under an override in the catalog's place,
 * or under an override of `catalog:` that defers to it; and states some of a roster of release-age exclusions: by name,
 * by a glob of `*`, and by versions, one or two. A vendored workspace mostly copies the root's statements and
 * exclusions, so agreement is common and each disagreement is one drawn change. Each writer records the line of every
 * statement and exclusion it writes, where the agreement must report a disagreement over it.
 */

/** What a repository reaches, as the property names its situations. */
export type Feature =
	| "a workspace that agrees with the root's"
	| "a version mismatch"
	| "an entry one side alone states"
	| "an override in a catalog's place"
	| "an override deferring to the catalog"
	| "a named catalog's entry"
	| "an exclusion both state"
	| "an exclusion the root alone states"
	| "an exclusion the workspace alone states"
	| "a versioned exclusion naming the root's version"
	| "a versioned exclusion naming another version"
	| "a glob exclusion"
	| "a root with no workspace"
	| "a workspace vendored inside another"

/** The packages a workspace may state, each at one of two versions. */
const PACKAGES = [
	{ name: "oxfmt", versions: ["0.78.0", "0.79.0"] },
	{ name: "effect", versions: ["4.0.0-beta.70", "4.0.0-beta.71"] },
	{ name: "@effect/vitest", versions: ["4.0.0-beta.70", "4.0.0-beta.71"] },
	{ name: "@ui-sdk/core", versions: ["0.1.0-beta.10", "0.1.0-beta.17"] }
] as const

type Package = (typeof PACKAGES)[number]

/** Which of a package's two versions. */
type Version = 0 | 1

/** How a workspace states a package, if it does. */
type Statement = Readonly<
	| { kind: "absent" }
	| { kind: "catalog"; version: Version }
	| { kind: "named"; version: Version }
	| { kind: "both"; version: Version; named: Version }
	| { kind: "overridden"; version: Version; override: Version }
	| { kind: "deferred"; version: Version }
>

/** A release-age exclusion as written, the packages it names and the versions it names, none for every version. */
type Exclusion = Readonly<{
	text: string
	names: ReadonlyArray<string>
	versions: ReadonlyArray<string>
}>

const EXCLUSIONS: ReadonlyArray<Exclusion> = [
	{ text: "effect", names: ["effect"], versions: [] },
	{ text: "@effect/*", names: ["@effect/vitest"], versions: [] },
	{ text: "@ui-sdk/*", names: ["@ui-sdk/core"], versions: [] },
	{ text: "@ui-sdk/core@0.1.0-beta.10", names: ["@ui-sdk/core"], versions: ["0.1.0-beta.10"] },
	{ text: "@ui-sdk/core@0.1.0-beta.17", names: ["@ui-sdk/core"], versions: ["0.1.0-beta.17"] },
	{ text: "oxfmt@0.78.0 || 0.79.0", names: ["oxfmt"], versions: ["0.78.0", "0.79.0"] }
]

/** A workspace: its statement of each package (PACKAGES' order) and its exclusions. */
type Workspace = Readonly<{
	statements: ReadonlyArray<Statement>
	exclusions: ReadonlyArray<Exclusion>
}>

/** A repository: its root's workspace, if it holds one, and the other workspaces of its tree (VENDORED's order). */
export type Repository = Readonly<{
	root: Option.Option<Workspace>
	vendored: ReadonlyArray<Workspace>
}>

/** Where the other workspaces lie: the second inside the first's repository. */
const VENDORED = ["vendor/a", "vendor/a/vendor/b", "packages/c"] as const

const ROOT = "/repository"

const versionGen: Gen<Version> = element([0, 1] as const)

const statementGen: Gen<Statement> = oneOf<Statement>([
	() => ({ kind: "absent" }),
	(source) => ({ kind: "catalog", version: source.draw(versionGen) }),
	(source) => ({ kind: "named", version: source.draw(versionGen) }),
	(source) => ({ kind: "both", version: source.draw(versionGen), named: source.draw(versionGen) }),
	(source) => ({
		kind: "overridden",
		version: source.draw(versionGen),
		override: source.draw(versionGen)
	}),
	(source) => ({ kind: "deferred", version: source.draw(versionGen) })
])

const exclusionsGen: Gen<ReadonlyArray<Exclusion>> = subset(EXCLUSIONS, {
	min: 0,
	max: EXCLUSIONS.length
})

const freshGen: Gen<Workspace> = (source) => ({
	statements: Arr.map(PACKAGES, () => source.draw(statementGen)),
	exclusions: source.draw(exclusionsGen)
})

/** A workspace vendored beside `root`: each statement the root's or a fresh one, and the root's exclusions or fresh ones. */
const vendoredGen =
	(root: Workspace): Gen<Workspace> =>
	(source) => ({
		statements: Arr.map(root.statements, (statement) =>
			source.draw(
				weighted<Statement>([
					[3, () => statement],
					[1, statementGen]
				])
			)
		),
		exclusions: source.draw(
			weighted<ReadonlyArray<Exclusion>>([
				[3, () => root.exclusions],
				[1, exclusionsGen]
			])
		)
	})

export const repositories: Gen<Repository> = (source) => {
	const root = source.draw(
		weighted<Option.Option<Workspace>>([
			[5, (s) => Option.some(s.draw(freshGen))],
			[1, () => Option.none()]
		])
	)
	const count = source.draw(element([1, 2, 3] as const))
	return {
		root,
		vendored: Arr.map(Arr.take(VENDORED, count), () =>
			source.draw(Option.match(root, { onNone: () => freshGen, onSome: vendoredGen }))
		)
	}
}

/** The versions a statement resolves to, as pnpm resolves them; none for a package it leaves unstated. */
const versionsOf = (pkg: Package, statement: Statement): Option.Option<ReadonlyArray<string>> => {
	const at = (version: Version): string => pkg.versions[version]
	switch (statement.kind) {
		case "absent":
			return Option.none()
		case "catalog":
		case "named":
		case "deferred":
			return Option.some([at(statement.version)])
		case "both":
			return Option.some(
				Arr.sort(Arr.dedupe([at(statement.version), at(statement.named)]), Order.String)
			)
		case "overridden":
			return Option.some([at(statement.override)])
	}
}

/** The tag of the line the agreement must point at for a statement: the override where one states the package, else
 * the catalog's line, the default catalog first. */
const lineTagOf = (pkg: Package, statement: Statement): string => {
	switch (statement.kind) {
		case "overridden":
		case "deferred":
			return `override:${pkg.name}`
		case "named":
			return `named:${pkg.name}`
		case "absent":
		case "catalog":
		case "both":
			return `catalog:${pkg.name}`
	}
}

/** A written manifest and the 1-based line of each tagged line in it. */
type Written = WorkspaceText & Readonly<{ lines: ReadonlyMap<string, number> }>

type Line = readonly [string, Option.Option<string>]

const plain = (line: string): Line => [line, Option.none()]

const tagged = (line: string, tag: string): Line => [line, Option.some(tag)]

/** A section's header and its lines, or nothing for a section with none. */
const section = (header: ReadonlyArray<string>, lines: ReadonlyArray<Line>): ReadonlyArray<Line> =>
	Arr.isReadonlyArrayNonEmpty(lines) ? [...Arr.map(header, plain), ...lines] : []

/** The manifest a workspace writes at `file`, each package and exclusion on a tagged line. */
const writtenOf = (file: string, workspace: Workspace): Written => {
	const stated = Arr.zip(PACKAGES, workspace.statements)
	const entry = (indent: string, pkg: Package, value: string, tag: string): Line =>
		tagged(`${indent}"${pkg.name}": "${value}"`, `${tag}:${pkg.name}`)
	const catalog = Arr.flatMap(stated, ([pkg, statement]): ReadonlyArray<Line> =>
		statement.kind === "absent" || statement.kind === "named"
			? []
			: [entry("  ", pkg, pkg.versions[statement.version], "catalog")]
	)
	const named = Arr.flatMap(stated, ([pkg, statement]): ReadonlyArray<Line> => {
		switch (statement.kind) {
			case "named":
				return [entry("    ", pkg, pkg.versions[statement.version], "named")]
			case "both":
				return [entry("    ", pkg, pkg.versions[statement.named], "named")]
			case "absent":
			case "catalog":
			case "overridden":
			case "deferred":
				return []
		}
	})
	const overrides = Arr.flatMap(stated, ([pkg, statement]): ReadonlyArray<Line> => {
		switch (statement.kind) {
			case "overridden":
				return [entry("  ", pkg, pkg.versions[statement.override], "override")]
			case "deferred":
				return [entry("  ", pkg, "catalog:", "override")]
			case "absent":
			case "catalog":
			case "named":
			case "both":
				return []
		}
	})
	const lines: ReadonlyArray<Line> = [
		plain("packages:"),
		plain("  - packages/*"),
		...(Arr.isReadonlyArrayNonEmpty(workspace.exclusions)
			? [
					tagged("minimumReleaseAgeExclude:", "exclusions"),
					...Arr.map(workspace.exclusions, (exclusion) =>
						tagged(`  - "${exclusion.text}"`, `exclusion:${exclusion.text}`)
					)
				]
			: []),
		...section(["catalog:"], catalog),
		...section(["catalogs:", "  next:"], named),
		...section(["overrides:"], overrides)
	]
	return {
		file,
		text: Arr.join(
			Arr.map(lines, ([line]) => line),
			"\n"
		),
		lines: new Map(
			Arr.flatMap(lines, ([, tag], at) =>
				Option.match(tag, { onNone: () => [], onSome: (t) => [[t, at + 1] as const] })
			)
		)
	}
}

const rootFile = `${ROOT}/${WORKSPACE_MANIFEST}`

/** Each workspace of a repository as written, with its file: the root's first where it holds one. */
const manifestsOf = (
	repository: Repository
): Readonly<{ root: Option.Option<Written>; vendored: ReadonlyArray<Written> }> => ({
	root: Option.map(repository.root, (workspace) => writtenOf(rootFile, workspace)),
	vendored: Arr.map(repository.vendored, (workspace, at) =>
		writtenOf(`${ROOT}/${Arr.getUnsafe(VENDORED, at)}/${WORKSPACE_MANIFEST}`, workspace)
	)
})

/** A tagged line's number; every tag the contract reads is written. */
const lineAt = (written: Written, tag: string): number => written.lines.get(tag) ?? 0

/** The exclusions of a workspace that name a package, as written. */
const namingOf = (workspace: Workspace, pkg: Package): ReadonlyArray<string> =>
	Arr.map(
		Arr.filter(workspace.exclusions, (exclusion) => Arr.contains(exclusion.names, pkg.name)),
		(exclusion) => exclusion.text
	)

/** The packages both a workspace and the root state, each with both statements' versions. */
const sharedOf = (
	root: Workspace,
	workspace: Workspace
): ReadonlyArray<
	Readonly<{ pkg: Package; at: number; ours: ReadonlyArray<string>; theirs: ReadonlyArray<string> }>
> =>
	Arr.flatMap(PACKAGES, (pkg, at) =>
		Option.match(
			Option.all([
				versionsOf(pkg, Arr.getUnsafe(root.statements, at)),
				versionsOf(pkg, Arr.getUnsafe(workspace.statements, at))
			]),
			{ onNone: () => [], onSome: ([ours, theirs]) => [{ pkg, at, ours, theirs }] }
		)
	)

/** One order of disagreements, whatever order they were found in. */
const byPlace = Order.combineAll<Disagreement>([
	Order.mapInput(Order.String, (d: Disagreement) => d.file),
	Order.mapInput(Order.Number, (d: Disagreement) => d.line),
	Order.mapInput(Order.String, (d: Disagreement) => d.rule),
	Order.mapInput(Order.String, (d: Disagreement) => d.entry),
	Order.mapInput(Order.String, (d: Disagreement) => ("exclusion" in d ? d.exclusion : ""))
])

const sorted = (disagreements: ReadonlyArray<Disagreement>): ReadonlyArray<Disagreement> =>
	Arr.sort(disagreements, byPlace)

/** What the contract gives a repository: every disagreement of a vendored workspace with the root's, where written. */
const expectedOf = (repository: Repository): ReadonlyArray<Disagreement> => {
	const manifests = manifestsOf(repository)
	return Option.match(Option.all([repository.root, manifests.root]), {
		onNone: () => [],
		onSome: ([root, rootWritten]) => {
			const vendored = Arr.zip(repository.vendored, manifests.vendored)
			const perWorkspace = Arr.flatMap(vendored, ([workspace, written]) =>
				Arr.flatMap(
					sharedOf(root, workspace),
					({ pkg, at, ours, theirs }): ReadonlyArray<Disagreement> => {
						const ourExclusions = namingOf(root, pkg)
						const theirExclusions = namingOf(workspace, pkg)
						return [
							...(Arr.makeEquivalence(Str.Equivalence)(ours, theirs)
								? []
								: [
										{
											rule: "version",
											file: written.file,
											line: lineAt(
												written,
												lineTagOf(pkg, Arr.getUnsafe(workspace.statements, at))
											),
											entry: pkg.name,
											versions: theirs,
											root: ours
										} as const
									]),
							...Arr.flatMap(ourExclusions, (exclusion) =>
								Arr.contains(theirExclusions, exclusion)
									? []
									: [
											{
												rule: "exclusion",
												file: written.file,
												line: written.lines.get("exclusions") ?? 1,
												entry: pkg.name,
												exclusion,
												statedBy: "root"
											} as const
										]
							),
							...Arr.flatMap(theirExclusions, (exclusion) =>
								Arr.contains(ourExclusions, exclusion)
									? []
									: [
											{
												rule: "exclusion",
												file: written.file,
												line: lineAt(written, `exclusion:${exclusion}`),
												entry: pkg.name,
												exclusion,
												statedBy: "workspace"
											} as const
										]
							)
						]
					}
				)
			)
			const shared = Arr.dedupe(
				Arr.flatMap(repository.vendored, (workspace) =>
					Arr.map(sharedOf(root, workspace), ({ at }) => at)
				)
			)
			const excluded = Arr.flatMap(
				[[root, rootWritten] as const, ...vendored],
				([workspace, written]) =>
					Arr.flatMap(workspace.exclusions, (exclusion) => {
						const named = Arr.filter(shared, (at) =>
							Arr.contains(exclusion.names, Arr.getUnsafe(PACKAGES, at).name)
						)
						return Arr.flatMap(named, (at): ReadonlyArray<Disagreement> => {
							const pkg = Arr.getUnsafe(PACKAGES, at)
							const ours = Option.getOrElse(
								versionsOf(pkg, Arr.getUnsafe(root.statements, at)),
								() => []
							)
							return Arr.every(exclusion.versions, (version) => Arr.contains(ours, version))
								? []
								: [
										{
											rule: "excluded version",
											file: written.file,
											line: lineAt(written, `exclusion:${exclusion.text}`),
											entry: pkg.name,
											exclusion: exclusion.text,
											root: ours
										}
									]
						})
					})
			)
			return sorted([...perWorkspace, ...excluded])
		}
	})
}

/** What the agreement gives a repository: its disagreements, read from the written manifests, and its findings' places
 * (each with whether it is the agreement's), in the disagreements' order. */
export type Outcome = Readonly<{
	disagreements: ReadonlyArray<Disagreement>
	placed: ReadonlyArray<string>
}>

const placesOf = (
	places: ReadonlyArray<Readonly<{ file: string; line: number }>>
): ReadonlyArray<string> =>
	Arr.sort(
		Arr.map(places, ({ file, line }) => `${file}:${line}`),
		Order.String
	)

/** The agreement over a repository's written manifests. */
export const outcomeOf = (repository: Repository) =>
	Effect.gen(function* () {
		const manifests = manifestsOf(repository)
		const findings = yield* catalogAgreementFindings(manifests)
		const disagreements = yield* Option.match(manifests.root, {
			onNone: () => Effect.succeed<ReadonlyArray<Disagreement>>([]),
			onSome: (root) =>
				Effect.map(
					Effect.all([
						resolvedWorkspace(root),
						Effect.forEach(manifests.vendored, resolvedWorkspace)
					]),
					([resolved, vendored]) => disagreementsOf(resolved, vendored)
				)
		})
		return {
			disagreements: sorted(disagreements),
			placed: placesOf(Arr.filter(findings, (finding) => finding.rule === CATALOG_AGREEMENT_RULE))
		}
	})

/** The outcome the contract gives a repository: its disagreements, each a finding where it is written. */
export const expectedOutcomeOf = (repository: Repository): Outcome => {
	const disagreements = expectedOf(repository)
	return { disagreements, placed: placesOf(disagreements) }
}

/** The situations a repository reaches. */
export const featuresOf = (repository: Repository): ReadonlyArray<Feature> =>
	Option.match(repository.root, {
		onNone: () => ["a root with no workspace"],
		onSome: (root): ReadonlyArray<Feature> => {
			const expected = expectedOf(repository)
			const manifests = manifestsOf(repository)
			const shared = Arr.map(repository.vendored, (workspace) => sharedOf(root, workspace))
			const sharedStatements = Arr.flatMap(repository.vendored, (workspace, w) =>
				Arr.flatMap(Arr.getUnsafe(shared, w), ({ at }) => [
					Arr.getUnsafe(root.statements, at),
					Arr.getUnsafe(workspace.statements, at)
				])
			)
			const sharedNamed = Arr.flatMap(repository.vendored, (workspace, w) =>
				Arr.flatMap(Arr.getUnsafe(shared, w), ({ pkg }) => [
					...Arr.map(namingOf(root, pkg), (text) => ({
						text,
						by: "root" as const,
						pkg,
						workspace
					})),
					...Arr.map(namingOf(workspace, pkg), (text) => ({
						text,
						by: "workspace" as const,
						pkg,
						workspace
					}))
				])
			)
			const versionedNaming = Arr.filter(
				[
					...root.exclusions,
					...Arr.flatMap(repository.vendored, (workspace) => workspace.exclusions)
				],
				(exclusion) =>
					Arr.isReadonlyArrayNonEmpty(exclusion.versions) &&
					Arr.some(sharedNamed, ({ pkg }) => Arr.contains(exclusion.names, pkg.name))
			)
			const reached: ReadonlyArray<readonly [Feature, boolean]> = [
				[
					"a workspace that agrees with the root's",
					Arr.some(
						manifests.vendored,
						(written, w) =>
							Arr.isReadonlyArrayNonEmpty(Arr.getUnsafe(shared, w)) &&
							!Arr.some(expected, (d) => d.file === written.file)
					)
				],
				["a version mismatch", Arr.some(expected, (d) => d.rule === "version")],
				[
					"an entry one side alone states",
					Arr.some(repository.vendored, (workspace) =>
						Arr.some(
							PACKAGES,
							(pkg, at) =>
								Option.isSome(versionsOf(pkg, Arr.getUnsafe(root.statements, at))) !==
								Option.isSome(versionsOf(pkg, Arr.getUnsafe(workspace.statements, at)))
						)
					)
				],
				[
					"an override in a catalog's place",
					Arr.some(sharedStatements, (s) => s.kind === "overridden")
				],
				[
					"an override deferring to the catalog",
					Arr.some(sharedStatements, (s) => s.kind === "deferred")
				],
				[
					"a named catalog's entry",
					Arr.some(sharedStatements, (s) => s.kind === "named" || s.kind === "both")
				],
				[
					"an exclusion both state",
					Arr.some(
						sharedNamed,
						({ text, by, pkg, workspace }) =>
							by === "root" && Arr.contains(namingOf(workspace, pkg), text)
					)
				],
				[
					"an exclusion the root alone states",
					Arr.some(expected, (d) => d.rule === "exclusion" && d.statedBy === "root")
				],
				[
					"an exclusion the workspace alone states",
					Arr.some(expected, (d) => d.rule === "exclusion" && d.statedBy === "workspace")
				],
				[
					"a versioned exclusion naming the root's version",
					Arr.some(
						versionedNaming,
						(exclusion) =>
							!Arr.some(
								expected,
								(d) => d.rule === "excluded version" && d.exclusion === exclusion.text
							)
					)
				],
				[
					"a versioned exclusion naming another version",
					Arr.some(expected, (d) => d.rule === "excluded version")
				],
				["a glob exclusion", Arr.some(sharedNamed, ({ text }) => Str.includes("*")(text))],
				["a workspace vendored inside another", repository.vendored.length > 1]
			]
			return Arr.flatMap(reached, ([feature, holds]) => (holds ? [feature] : []))
		}
	})
