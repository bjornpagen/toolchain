import { boolean, element, type Gen, subset } from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Order, Record, Schema, String as Str } from "effect"
import type { DummyRule, DummyRuleMap, OxlintConfig } from "oxlint"
import { toolchain } from "#config.ts"
import {
	ENVIRONMENT_GLOBALS,
	ENVIRONMENT_IMPORTS,
	ENVIRONMENT_PROPERTIES
} from "#oxlint/environment.ts"
import { type Restriction, standard } from "#preset.ts"
import { globMatches } from "#workspace/dead-paths.ts"

/**
 * The projects the list property draws (preset.test.ts), from a grammar of the preset's contract for its lists: a
 * root's imports, globals and properties, none of them zod; restrictions over directories and files of a small tree,
 * each list of each stated or not; the library, its readers and the Effect-free code over the same tree; and one file
 * of it. And the lists oxlint holds the file to, read from the built configuration as oxlint reads one (its top-level
 * rules, then each block whose globs match the file, a later one winning by rule), beside what the contract says they
 * are: the shared bans (the banned packages, the relative-import ban, Effect's metrics and the platform's index, Temporal),
 * the root's lists, the environment bans in the library outside its readers, Math.random's ban in Effect-free code, and
 * the lists of the last restriction naming the file, whole.
 */

/** What a case reaches, as the property names its situations. */
export type Feature =
	| "a file no restriction names"
	| "a restriction's imports on its file"
	| "a later restriction's list over an earlier one's"
	| "a later restriction of an empty list"
	| "a restriction over a directory above the library"
	| "a restricted file in the library"
	| "a restricted reader"
	| "a restricted file in Effect-free code"

/** The tree's files; every directory of the property is one of their parents. */
const FILES = [
	"packages/engine/src/core/sha256.ts",
	"packages/engine/src/plan/plan.ts",
	"packages/engine/scripts/build.ts",
	"packages/app/src/main.ts",
	"packages/app/src/env.ts",
	"test/unit/a.test.ts"
] as const

/** Directories a restriction, the library or the Effect-free code may name. */
const DIRECTORIES = [
	"packages",
	"packages/engine",
	"packages/engine/src",
	"packages/app/src",
	"test"
] as const

const NO_LISTS = {
	restrictedImports: { paths: [], patterns: [] },
	restrictedGlobals: [],
	restrictedProperties: []
} as const

/** The lists a block may add, each drawn from its own entries: a list is the entries of a subset. */
const IMPORT_PATHS = [
	{ name: "pg", message: "no pg" },
	{ name: "node:fs", message: "no fs" }
] as const
const IMPORT_PATTERNS = [{ group: ["@aws-sdk/*"], message: "no aws" }] as const
const GLOBALS = [
	{ name: "Date", message: "no clock" },
	{ name: "fetch", message: "no io" }
] as const
const PROPERTIES = [{ object: "JSON", property: "parse", message: "no parse" }] as const

type Lists = Pick<Restriction, "restrictedImports" | "restrictedGlobals" | "restrictedProperties">

const listsGen: Gen<Lists> = (source) => ({
	restrictedImports: {
		paths: source.draw(subset(IMPORT_PATHS, { min: 0, max: IMPORT_PATHS.length })),
		patterns: source.draw(subset(IMPORT_PATTERNS, { min: 0, max: IMPORT_PATTERNS.length }))
	},
	restrictedGlobals: source.draw(subset(GLOBALS, { min: 0, max: GLOBALS.length })),
	restrictedProperties: source.draw(subset(PROPERTIES, { min: 0, max: PROPERTIES.length }))
})

/** A restriction's paths: directories, written with their "/", and files. */
const restrictionGen: Gen<Restriction> = (source) => ({
	...source.draw(listsGen),
	paths: [
		...Arr.map(
			source.draw(subset(DIRECTORIES, { min: 0, max: 2 })),
			(directory) => `${directory}/`
		),
		...source.draw(subset(FILES, { min: 0, max: 2 }))
	]
})

export type Case = Readonly<{
	root: Lists
	restrictions: ReadonlyArray<Restriction>
	library: ReadonlyArray<string>
	readers: ReadonlyArray<string>
	effectFree: ReadonlyArray<string>
	file: string
}>

export const cases: Gen<Case> = (source) => ({
	root: source.draw(listsGen),
	restrictions: Arr.map(source.draw(subset([0, 1, 2], { min: 0, max: 3 })), () =>
		source.draw(restrictionGen)
	),
	library: source.draw(subset(DIRECTORIES, { min: 0, max: 2 })),
	readers: source.draw(subset(FILES, { min: 0, max: 2 })),
	effectFree: source.draw(boolean) ? source.draw(subset(DIRECTORIES, { min: 1, max: 2 })) : [],
	file: source.draw(element(FILES))
})

/** Whether a restriction's path names a file: a directory every file beneath it, any other path that file. */
const names = (path: string, file: string): boolean =>
	Str.endsWith("/")(path) ? Str.startsWith(path)(file) : file === path

const isUnder = (file: string, directory: string): boolean =>
	directory === "." || Str.startsWith(`${directory}/`)(file)

/** The configuration the preset builds for a case's project, whatever its file. */
export const configOf = (c: Omit<Case, "file">): OxlintConfig =>
	standard(
		toolchain({
			rejected: { rules: {}, diagnostics: {} },
			exceptions: [],
			effectFree: c.effectFree,
			packs: {},
			bannedPackages: [],
			land: { lock: "~/.cache/toolchain-land/preset.lock", branch: "main" }
		})
	).lintConfig({
		...c.root,
		ignorePatterns: [],
		restrictions: c.restrictions,
		unassignedImports: [],
		environment: { library: c.library, readers: c.readers },
		ceremony: [],
		plugin: {
			"bearer-owners": { owners: [] },
			"brands-sole-mint": { mints: [] },
			"import-doors": { doors: [] },
			"no-case-list": { searches: [], generators: [], mints: [], cases: [], dictionaries: [] },
			"no-dynamic-imports": { allowed: [] },
			"no-raw-sql": { sources: [], writers: [] },
			"no-spread-argument": { tuples: [] },
			"single-permit-owners": { owners: [] }
		},
		ownPlugins: [],
		tests: { library: "none" },
		overrides: []
	})

/** The three lists' rules, by the names the preset gives them. */
const LISTED_RULES = [
	"eslint/no-restricted-imports",
	"eslint/no-restricted-globals",
	"eslint/no-restricted-properties"
] as const

/** A rule's entries, each as canonical JSON, sorted: the entries a list holds, whatever their order. */
export type Entries = Readonly<Record<(typeof LISTED_RULES)[number], ReadonlyArray<string>>>

/** An entry with its message dropped, as canonical JSON: the contract says what a list bans, never in which words. */
const Entry = Schema.Record(Schema.String, Schema.Unknown)

const json = Schema.encodeOption(Schema.fromJsonString(Schema.Unknown))

const withoutMessage = (value: unknown): unknown =>
	Option.match(Schema.decodeUnknownOption(Entry)(value), {
		onNone: () => value,
		onSome: (entry) => Record.remove(entry, "message")
	})

const canonical = (value: unknown): string =>
	Option.getOrElse(json(withoutMessage(value)), () => String(value))

const sortedEntries = (entries: ReadonlyArray<unknown>): ReadonlyArray<string> =>
	Arr.sort(Arr.dedupe(Arr.map(entries, canonical)), Order.String)

/** The imports rule's option: its paths and patterns. */
const ImportLists = Schema.Struct({
	paths: Schema.Array(Schema.Unknown),
	patterns: Schema.Array(Schema.Unknown)
})

/** A rule's entries as oxlint reads them: the imports rule's paths and patterns, each other list's entries. */
const entriesOfRule = (rule: string, value: DummyRule | undefined): ReadonlyArray<string> => {
	if (value === undefined || typeof value === "string" || typeof value === "number") {
		return []
	}
	const [, ...options] = value
	if (rule !== "eslint/no-restricted-imports") {
		return sortedEntries(options)
	}
	return sortedEntries(
		Arr.flatMap(options, (option) =>
			Option.match(Schema.decodeUnknownOption(ImportLists)(option), {
				onNone: () => [option],
				onSome: (lists) => [
					...Arr.map(lists.paths, (path) => ({ path: withoutMessage(path) })),
					...Arr.map(lists.patterns, (pattern) => ({ pattern: withoutMessage(pattern) }))
				]
			})
		)
	)
}

/** The rules oxlint holds a file to under a configuration: its top-level rules, then every block whose globs match the
 * file and whose excluded globs do not, a later one winning by rule. */
export const heldRulesOf = (config: OxlintConfig, file: string): DummyRuleMap => {
	const matching = Arr.filter(
		config.overrides ?? [],
		(block) =>
			Arr.some(block.files, (glob) => globMatches(glob, file)) &&
			!Arr.some(block.excludeFiles ?? [], (glob) => globMatches(glob, file))
	)
	return Arr.reduce(matching, { ...config.rules }, (held, block) => ({
		...held,
		...block.rules
	}))
}

/** The lists oxlint holds a file to under a configuration (heldRulesOf). */
export const resolvedOf = (config: OxlintConfig, file: string): Entries => {
	const rules = heldRulesOf(config, file)
	return {
		"eslint/no-restricted-imports": entriesOfRule(
			"eslint/no-restricted-imports",
			rules["eslint/no-restricted-imports"]
		),
		"eslint/no-restricted-globals": entriesOfRule(
			"eslint/no-restricted-globals",
			rules["eslint/no-restricted-globals"]
		),
		"eslint/no-restricted-properties": entriesOfRule(
			"eslint/no-restricted-properties",
			rules["eslint/no-restricted-properties"]
		)
	}
}

/** Whether a restriction states a list: it names an entry of it. */
type Kind = keyof Lists

const states = (restriction: Restriction, kind: Kind): boolean => {
	switch (kind) {
		case "restrictedImports":
			return (
				Arr.isReadonlyArrayNonEmpty(restriction.restrictedImports.paths) ||
				Arr.isReadonlyArrayNonEmpty(restriction.restrictedImports.patterns)
			)
		case "restrictedGlobals":
			return Arr.isReadonlyArrayNonEmpty(restriction.restrictedGlobals)
		case "restrictedProperties":
			return Arr.isReadonlyArrayNonEmpty(restriction.restrictedProperties)
	}
}

/** The restrictions naming a case's file. */
const namingOf = (c: Case): ReadonlyArray<Restriction> =>
	Arr.filter(c.restrictions, (restriction) =>
		Arr.some(restriction.paths, (path) => names(path, c.file))
	)

/** The last restriction naming the file, whose lists the file takes whole, or the root's nothing. */
const lastNaming = (c: Case): Lists => Option.getOrElse(Arr.last(namingOf(c)), () => NO_LISTS)

/** What the contract holds a case's file to. */
export const expectedOf = (c: Case): Entries => {
	const environment =
		Arr.some(c.library, (directory) => isUnder(c.file, directory)) &&
		!Arr.contains(c.readers, c.file)
	const effectFree = Arr.some(c.effectFree, (directory) => isUnder(c.file, directory))
	const imports = lastNaming(c).restrictedImports
	return {
		"eslint/no-restricted-imports": sortedEntries([
			...Arr.map(
				[
					...c.root.restrictedImports.paths,
					...(environment ? ENVIRONMENT_IMPORTS.paths : []),
					...imports.paths,
					{ name: "effect/Metric" },
					{ name: "@effect/platform-node" }
				],
				(path) => ({ path: withoutMessage(path) })
			),
			...Arr.map(
				[
					...c.root.restrictedImports.patterns,
					...(environment ? ENVIRONMENT_IMPORTS.patterns : []),
					...imports.patterns,
					{ group: ["zod", "zod/**"] },
					{ group: [".", "..", "./**", "../**"] }
				],
				(pattern) => ({ pattern: withoutMessage(pattern) })
			)
		]),
		"eslint/no-restricted-globals": sortedEntries([
			...c.root.restrictedGlobals,
			{ name: "Temporal" },
			...(environment ? ENVIRONMENT_GLOBALS : []),
			...lastNaming(c).restrictedGlobals
		]),
		"eslint/no-restricted-properties": sortedEntries([
			...c.root.restrictedProperties,
			...(environment ? ENVIRONMENT_PROPERTIES : []),
			...(effectFree ? [{ object: "Math", property: "random" }] : []),
			...lastNaming(c).restrictedProperties,
			...Arr.map(
				["counter", "gauge", "frequency", "histogram", "summary", "summaryWithTimestamp", "timer"],
				(property) => ({ object: "Metric", property })
			)
		])
	}
}

/** The situations a case reaches. */
export const featuresOf = (c: Case): ReadonlyArray<Feature> => {
	const naming = namingOf(c)
	const stating = (kind: Kind) => Arr.filter(naming, (restriction) => states(restriction, kind))
	return [
		...(Arr.isReadonlyArrayNonEmpty(naming) ? [] : ["a file no restriction names" as const]),
		...(Arr.isReadonlyArrayNonEmpty(stating("restrictedImports"))
			? ["a restriction's imports on its file" as const]
			: []),
		...(Arr.some(
			["restrictedImports", "restrictedGlobals", "restrictedProperties"] as const,
			(kind) => stating(kind).length > 1
		)
			? ["a later restriction's list over an earlier one's" as const]
			: []),
		...(naming.length > 1 &&
		Option.exists(Arr.last(naming), (last) => !states(last, "restrictedGlobals"))
			? ["a later restriction of an empty list" as const]
			: []),
		...(Arr.some(c.restrictions, (restriction) =>
			Arr.some(restriction.paths, (path) =>
				Arr.some(
					c.library,
					(directory) => Str.endsWith("/")(path) && isUnder(directory, Str.slice(0, -1)(path))
				)
			)
		)
			? ["a restriction over a directory above the library" as const]
			: []),
		...(Arr.isReadonlyArrayNonEmpty(naming) &&
		Arr.some(c.library, (directory) => isUnder(c.file, directory))
			? ["a restricted file in the library" as const]
			: []),
		...(Arr.isReadonlyArrayNonEmpty(naming) && Arr.contains(c.readers, c.file)
			? ["a restricted reader" as const]
			: []),
		...(Arr.isReadonlyArrayNonEmpty(naming) &&
		Arr.some(c.effectFree, (directory) => isUnder(c.file, directory))
			? ["a restricted file in Effect-free code" as const]
			: [])
	]
}
