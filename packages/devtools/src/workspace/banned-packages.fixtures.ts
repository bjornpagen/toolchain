import { boolean, element, type Gen, subset } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Order, String as Str } from "effect"
import { BANNED_PACKAGES } from "#preset.ts"
import {
	BANNED_PACKAGES_RULE,
	bannedPackageFindings,
	LOCKFILE,
	WORKSPACE_MANIFEST
} from "#workspace/banned-packages.ts"

/**
 * The repositories the banned-packages property draws (banned-packages.test.ts), from a grammar of the law's contract:
 * the root's and two packages' manifests, each field of edges present or not; pnpm-workspace.yaml's catalog and a named
 * one; the lockfile's importers, and a third party in its packages and snapshots sections whose own peer and
 * dependency is zod, or none; and whether the repository bans a package of its own. Every edge is one of a roster: zod
 * by version, by catalog and installed under an alias, a project-banned package, and harmless ones, among them names
 * that only begin like zod and an alias of another package. Each writer records the line of every edge the contract
 * refuses, which is where the law must report it.
 */

/** What an edge is, as the property names its situations. */
export type Feature =
	| "a manifest's dependency on zod"
	| "a manifest's devDependency on zod"
	| "a manifest's peerDependency on zod"
	| "a manifest's optionalDependency on zod"
	| "an alias that installs zod"
	| "a catalog entry for zod"
	| "a named catalog's entry for zod"
	| "a lockfile importer's edge to zod"
	| "a third party's own zod peer in the lockfile"
	| "a project's own banned package"
	| "a name that only begins like zod"

/** A package a repository may ban of its own. */
const OWN_BANNED = { name: "yup", message: "Yup is banned here." } as const

/** One edge a field may hold: its key, its specifier, and the package it installs. */
type Edge = Readonly<{ name: string; specifier: string; installs: string }>

/** The edges a field draws from, each at most once: zod by version or by catalog, zod under an alias, the
 * project-banned package, and harmless ones. */
const EDGES: ReadonlyArray<ReadonlyArray<Edge>> = [
	[
		{ name: "zod", specifier: "3.25.76", installs: "zod" },
		{ name: "zod", specifier: "catalog:", installs: "zod" }
	],
	[
		{ name: "schema", specifier: "npm:zod@^3.25.0", installs: "zod" },
		{ name: "schema", specifier: "npm:zodiac@1.0.0", installs: "zodiac" }
	],
	[{ name: OWN_BANNED.name, specifier: "1.6.1", installs: OWN_BANNED.name }],
	[{ name: "effect", specifier: "4.1.4", installs: "effect" }],
	[{ name: "zod-validation-error", specifier: "3.4.0", installs: "zod-validation-error" }],
	[{ name: "@scope/zod", specifier: "0.1.0", installs: "@scope/zod" }]
]

/** A field's edges: a subset of the roster's names, each with one of its specifiers. */
const edgesGen: Gen<ReadonlyArray<Edge>> = (source) =>
	Arr.map(source.draw(subset(EDGES, { min: 0, max: EDGES.length })), (choices) =>
		Arr.getUnsafe(choices, source.draw(element([0, 1] as const)) % choices.length)
	)

const MANIFEST_FIELDS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies"
] as const

const IMPORTER_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"] as const

type Fields<F extends string> = ReadonlyArray<Readonly<{ field: F; edges: ReadonlyArray<Edge> }>>

/** Some of `fields`, each with its edges. */
const fieldsGen =
	<F extends string>(fields: ReadonlyArray<F>): Gen<Fields<F>> =>
	(source) =>
		Arr.flatMap(fields, (field) =>
			source.draw(boolean) ? [{ field, edges: source.draw(edgesGen) }] : []
		)

/** The workspace's packages, by directory: the root and two others. */
const PACKAGES = [".", "packages/a", "packages/b"] as const

/** A repository: each package's manifest fields and lockfile importer fields, its catalogs, whether its lockfile holds
 * a third party whose own peer is zod, and whether it bans a package of its own. */
export type Repository = Readonly<{
	manifests: ReadonlyArray<Fields<(typeof MANIFEST_FIELDS)[number]>>
	catalog: ReadonlyArray<Edge>
	named: Option.Option<ReadonlyArray<Edge>>
	importers: ReadonlyArray<Fields<(typeof IMPORTER_FIELDS)[number]>>
	thirdParty: boolean
	ownBan: boolean
}>

export const repositories: Gen<Repository> = (source) => ({
	manifests: Arr.map(PACKAGES, () => source.draw(fieldsGen(MANIFEST_FIELDS))),
	catalog: source.draw(edgesGen),
	named: source.draw(boolean) ? Option.some(source.draw(edgesGen)) : Option.none(),
	importers: Arr.map(PACKAGES, () => source.draw(fieldsGen(IMPORTER_FIELDS))),
	thirdParty: source.draw(boolean),
	ownBan: source.draw(boolean)
})

/** The packages the repository bans: the standard's, and its own when it bans one. */
const bannedOf = (repository: Repository) =>
	repository.ownBan ? [...BANNED_PACKAGES, OWN_BANNED] : BANNED_PACKAGES

/** Whether the contract refuses an edge: the package it installs is banned. */
const refuses = (repository: Repository, edge: Edge): boolean =>
	Arr.some(bannedOf(repository), (banned) => banned.name === edge.installs)

/** A written text and the 1-based lines of the edges in it the contract refuses. */
type Written = Readonly<{ text: string; refused: ReadonlyArray<number> }>

/** Lines, each marked refused or not, as one text. */
const writtenOf = (lines: ReadonlyArray<readonly [string, boolean]>): Written => ({
	text: Arr.join(
		Arr.map(lines, ([line]) => line),
		"\n"
	),
	refused: Arr.flatMap(lines, ([, refused], at) => (refused ? [at + 1] : []))
})

const manifestOf = (
	repository: Repository,
	directory: string,
	fields: Fields<(typeof MANIFEST_FIELDS)[number]>
): Written =>
	writtenOf([
		["{", false],
		[`\t"name": "${directory === "." ? "root" : directory}",`, false],
		...Arr.flatMap(fields, ({ field, edges }) => [
			[`\t"${field}": {`, false] as const,
			...Arr.map(
				edges,
				(edge, at) =>
					[
						`\t\t"${edge.name}": "${edge.specifier}"${at === edges.length - 1 ? "" : ","}`,
						refuses(repository, edge)
					] as const
			),
			["\t},", false] as const
		]),
		['\t"private": true', false],
		["}", false]
	])

/** A YAML value as pnpm writes one: quoted when it ends in a colon (`'catalog:'`). */
const valueOf = (value: string): string => (Str.endsWith(":")(value) ? `'${value}'` : value)

/** A YAML key as pnpm writes one: quoted when it starts with `@`. */
const keyOf = (name: string): string => (Str.startsWith("@")(name) ? `'${name}'` : name)

const workspaceOf = (repository: Repository): Written =>
	writtenOf([
		["packages:", false],
		["  - packages/*", false],
		...(Arr.isReadonlyArrayNonEmpty(repository.catalog)
			? [
					["catalog:", false] as const,
					...Arr.map(
						repository.catalog,
						(edge) =>
							[
								`  ${keyOf(edge.name)}: ${valueOf(edge.specifier)}`,
								refuses(repository, edge)
							] as const
					)
				]
			: [["catalog: {}", false] as const]),
		...Option.match(repository.named, {
			onNone: () => [],
			onSome: (edges) => [
				["catalogs:", false] as const,
				["  legacy:", false] as const,
				...Arr.map(
					edges,
					(edge) =>
						[
							`    ${keyOf(edge.name)}: ${valueOf(edge.specifier)}`,
							refuses(repository, edge)
						] as const
				)
			]
		})
	])

const lockfileOf = (repository: Repository): Written =>
	writtenOf([
		["lockfileVersion: '9.0'", false],
		["", false],
		["importers:", false],
		...Arr.flatMap(repository.importers, (fields, at) => [
			["", false] as const,
			[
				`  ${Arr.getUnsafe(PACKAGES, at)}:${Arr.some(fields, ({ edges }) => Arr.isReadonlyArrayNonEmpty(edges)) ? "" : " {}"}`,
				false
			] as const,
			...Arr.flatMap(fields, ({ field, edges }) =>
				Arr.isReadonlyArrayNonEmpty(edges)
					? [
							[`    ${field}:`, false] as const,
							...Arr.flatMap(edges, (edge) => [
								[`      ${keyOf(edge.name)}:`, refuses(repository, edge)] as const,
								[`        specifier: ${valueOf(edge.specifier)}`, false] as const,
								[`        version: 1.0.0`, false] as const
							])
						]
					: []
			)
		]),
		...(repository.thirdParty
			? [
					["", false] as const,
					["packages:", false] as const,
					["", false] as const,
					["  ai@5.0.0:", false] as const,
					["    resolution: {integrity: sha512-x}", false] as const,
					["    peerDependencies:", false] as const,
					["      zod: ^3.25.0", false] as const,
					["", false] as const,
					["snapshots:", false] as const,
					["", false] as const,
					["  ai@5.0.0(zod@3.25.76):", false] as const,
					["    dependencies:", false] as const,
					["      zod: 3.25.76", false] as const
				]
			: [])
	])

const ROOT = "/repository"

/** What the law gives a repository: each finding's file and line, and whether every one is its rule's. */
export type Outcome = Readonly<{ found: ReadonlyArray<string>; placed: boolean }>

const sorted = (found: ReadonlyArray<string>): ReadonlyArray<string> =>
	Arr.sort(found, Order.String)

const manifestPathOf = (directory: string): string =>
	directory === "." ? "package.json" : `${directory}/package.json`

/** The law's findings over a repository. */
export const outcomeOf = (repository: Repository) =>
	Effect.map(
		bannedPackageFindings({
			root: ROOT,
			banned: bannedOf(repository),
			manifests: Arr.map(repository.manifests, (fields, at) => {
				const directory = Arr.getUnsafe(PACKAGES, at)
				return {
					path: manifestPathOf(directory),
					text: manifestOf(repository, directory, fields).text
				}
			}),
			workspace: Option.some(workspaceOf(repository).text),
			lockfile: Option.some(lockfileOf(repository).text)
		}),
		(findings): Outcome => ({
			found: sorted(Arr.map(findings, (finding) => `${finding.file}:${finding.line}`)),
			placed: Arr.every(findings, (finding) => finding.rule === BANNED_PACKAGES_RULE)
		})
	)

/** What the contract gives a repository: a finding at every refused edge, each its rule's. */
export const expectedOf = (repository: Repository): Outcome => {
	const at = (path: string, written: Written) =>
		Arr.map(written.refused, (line) => `${ROOT}/${path}:${line}`)
	return {
		found: sorted([
			...Arr.flatMap(repository.manifests, (fields, index) => {
				const directory = Arr.getUnsafe(PACKAGES, index)
				return at(manifestPathOf(directory), manifestOf(repository, directory, fields))
			}),
			...at(WORKSPACE_MANIFEST, workspaceOf(repository)),
			...at(LOCKFILE, lockfileOf(repository))
		]),
		placed: true
	}
}

const isZod = (edge: Edge): boolean => edge.installs === "zod"

/** The situations a repository reaches. */
export const featuresOf = (repository: Repository): ReadonlyArray<Feature> => {
	const manifestEdges = Arr.flatten(repository.manifests)
	const fieldFeature: Readonly<Record<(typeof MANIFEST_FIELDS)[number], Feature>> = {
		dependencies: "a manifest's dependency on zod",
		devDependencies: "a manifest's devDependency on zod",
		peerDependencies: "a manifest's peerDependency on zod",
		optionalDependencies: "a manifest's optionalDependency on zod"
	}
	const everyEdge = [
		...Arr.flatMap(manifestEdges, ({ edges }) => edges),
		...repository.catalog,
		...Option.getOrElse(repository.named, () => []),
		...Arr.flatMap(Arr.flatten(repository.importers), ({ edges }) => edges)
	]
	return [
		...Arr.flatMap(manifestEdges, ({ field, edges }) =>
			Arr.some(edges, isZod) ? [fieldFeature[field]] : []
		),
		...(Arr.some(everyEdge, (edge) => isZod(edge) && edge.name !== "zod")
			? ["an alias that installs zod" as const]
			: []),
		...(Arr.some(repository.catalog, isZod) ? ["a catalog entry for zod" as const] : []),
		...(Option.exists(repository.named, (edges) => Arr.some(edges, isZod))
			? ["a named catalog's entry for zod" as const]
			: []),
		...(Arr.some(Arr.flatten(repository.importers), ({ edges }) => Arr.some(edges, isZod))
			? ["a lockfile importer's edge to zod" as const]
			: []),
		...(repository.thirdParty ? ["a third party's own zod peer in the lockfile" as const] : []),
		...(repository.ownBan && Arr.some(everyEdge, (edge) => edge.installs === OWN_BANNED.name)
			? ["a project's own banned package" as const]
			: []),
		...(Arr.some(
			everyEdge,
			(edge) => edge.name === "zod-validation-error" || edge.name === "@scope/zod"
		)
			? ["a name that only begins like zod" as const]
			: [])
	]
}
