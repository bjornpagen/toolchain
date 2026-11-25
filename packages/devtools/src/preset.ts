import { TEST_SCOPE, TEST_SUFFIXES } from "@bjornpagen/testing/scope"
import { Array as Arr, Option, Record, Result, String as Str } from "effect"
import type { DummyRule, DummyRuleMap, OxlintConfig, OxlintOverride } from "oxlint"
import { type PackName, packNamesOf, type Toolchain } from "#config.ts"
import plugin from "#oxlint-plugin.ts"
import {
	ENVIRONMENT_GLOBALS,
	ENVIRONMENT_IMPORTS,
	ENVIRONMENT_PROPERTIES
} from "#oxlint/environment.ts"
import type { OptionsOf, Plugin } from "#oxlint/rule.ts"
import {
	CLASS_RULE_IDS,
	type ClassRuleId,
	type ClassSetting,
	type ClassSource,
	classSettingsOf,
	liftedSettingsOf,
	TAILWIND_PLUGIN,
	TAILWIND_PLUGIN_PATH
} from "#style/classes.ts"
import type { AppStyleOptions } from "#style/options.ts"
import type { BannedPackages } from "#workspace/rules.ts"

/**
 * The shared lint preset. A repository's root oxlint.config.ts calls `standard` with its toolchain.config.ts, which
 * says what the repository rejects, where Effect does not run and which packs it runs beside the core, and then the
 * `lintConfig` it gets back with its own lists: ignored paths, restricted modules, the library that reads no
 * environment, the files where no-shadow is ceremony, the plugin's names, its own plugins and its exception blocks.
 * Everything else is the standard.
 */

/** The core, which every repository runs, or a pack a repository runs beside it. */
export type Part = "core" | PackName

/** The parts a toolchain runs: the core, and each pack it names. */
type PartsOf<T extends Toolchain> = "core" | Extract<keyof T["packs"], PackName>

/** The rules a toolchain rejects, by name. */
type RejectedOf<T extends Toolchain> = Extract<keyof T["rejected"]["rules"], string>

/** The rules the preset builds from a repository's lists, by the name oxlint gives each after its plugin's prefix. */
type ListedName =
	| "no-restricted-globals"
	| "no-restricted-imports"
	| "no-restricted-properties"
	| "no-unassigned-import"

/**
 * A block's rules: naming one of the repository's rejected rules is a type error, and so is naming a rule the preset
 * builds from lists, spelled any way oxlint reads it (`eslint/no-restricted-imports`, `no-restricted-imports`,
 * `typescript/no-restricted-imports`, `@typescript-eslint/no-restricted-imports` are one rule to oxlint): a block that
 * set one would replace the lists on its files, the shared bans and the repository's own with them, so a block adds to
 * the lists only through a restriction (Project's `restrictions`), which keeps them.
 */
export type ActiveRules<Rejected extends string> = DummyRuleMap &
	Partial<Record<Rejected, never>> &
	Readonly<Record<`${string}${ListedName}`, never>>

/** oxlint's built-in plugins, in the order a configuration lists them, each with the part that runs it. */
const PLUGINS = [
	{ name: "eslint", part: "core" },
	{ name: "typescript", part: "core" },
	{ name: "unicorn", part: "core" },
	{ name: "oxc", part: "core" },
	{ name: "react", part: "web" },
	{ name: "jsx-a11y", part: "web" },
	{ name: "nextjs", part: "web" },
	{ name: "node", part: "core" },
	{ name: "import", part: "core" }
] as const satisfies ReadonlyArray<
	Readonly<{ name: NonNullable<OxlintConfig["plugins"]>[number]; part: Part }>
>

/** The built-in rules the preset turns on everywhere, with their generic options, by the part that runs them: the
 * correctness category's reviewed additions. Lists that name a repository's own modules or files come from the
 * repository. The web part holds React code to the React Compiler as `next build` does at panicThreshold all_errors:
 * the correctness category holds the compiler's correctness rules, and react/todo, react/unsupported-syntax,
 * react/syntax and react/invariant refuse a component or hook the compiler cannot compile, which it would otherwise
 * leave unmemoized. */
export const GENERIC_RULES = {
	core: {
		"eslint/array-callback-return": ["error", { checkForEach: true }],
		"eslint/block-scoped-var": "error",
		"eslint/curly": ["error", "all"],
		"eslint/default-case-last": "error",
		"eslint/default-param-last": "error",
		"eslint/eqeqeq": ["error", "always", { null: "ignore" }],
		"eslint/no-array-constructor": "error",
		"eslint/no-case-declarations": "error",
		"eslint/no-constructor-return": "error",
		"eslint/no-else-return": ["error", { allowElseIf: false }],
		"eslint/no-extend-native": "error",
		"eslint/no-extra-bind": "error",
		"eslint/no-extra-label": "error",
		"eslint/no-label-var": "error",
		"eslint/no-labels": ["error", { allowLoop: true }],
		"eslint/no-lone-blocks": "error",
		"eslint/no-multi-assign": "error",
		"eslint/no-new": "error",
		"eslint/no-param-reassign": "error",
		"eslint/no-proto": "error",
		"eslint/no-prototype-builtins": "error",
		"eslint/no-regex-spaces": "error",
		"eslint/no-return-assign": ["error", "except-parens"],
		"eslint/no-script-url": "error",
		"eslint/no-self-compare": "error",
		"eslint/no-sequences": "error",
		"eslint/no-shadow": "error",
		"eslint/no-template-curly-in-string": "error",
		"eslint/no-unexpected-multiline": "error",
		"eslint/no-unmodified-loop-condition": "error",
		"eslint/no-unneeded-ternary": "error",
		"eslint/no-useless-computed-key": "error",
		"eslint/no-useless-concat": "error",
		"eslint/no-useless-constructor": "error",
		"eslint/no-var": "error",
		"eslint/one-var": ["error", "never"],
		"eslint/prefer-arrow-callback": "error",
		"eslint/prefer-const": ["error", { ignoreReadBeforeAssign: true }],
		"eslint/prefer-exponentiation-operator": "error",
		"eslint/prefer-numeric-literals": "error",
		"eslint/prefer-object-has-own": "error",
		"eslint/prefer-rest-params": "error",
		"eslint/prefer-template": "error",
		"eslint/radix": "error",
		"import/extensions": ["error", "always", { ignorePackages: true, checkTypeImports: true }],
		"node/no-exports-assign": "error",
		"oxc/approx-constant": "error",
		"oxc/misrefactored-assign-op": "error",
		"oxc/no-accumulating-spread": "error",
		"oxc/no-barrel-file": ["error", { threshold: 0 }],
		"oxc/no-this-in-exported-function": "error",
		"typescript/adjacent-overload-signatures": "error",
		"typescript/ban-ts-comment": [
			"error",
			{ "ts-check": true, "ts-expect-error": true, "ts-ignore": true, "ts-nocheck": true }
		],
		"typescript/consistent-type-assertions": ["error", { assertionStyle: "never" }],
		"typescript/dot-notation": "error",
		"typescript/no-confusing-non-null-assertion": "error",
		"typescript/no-deprecated": "error",
		"typescript/no-empty-object-type": "error",
		"typescript/no-explicit-any": "error",
		"typescript/no-extraneous-class": "error",
		"typescript/no-generated-empty-object-type": "error",
		"typescript/no-inferrable-types": "error",
		"typescript/no-misused-promises": "error",
		"typescript/no-non-null-assertion": "error",
		"typescript/no-unnecessary-boolean-literal-compare": "error",
		"typescript/no-unnecessary-condition": "error",
		"typescript/no-unnecessary-template-expression": "error",
		"typescript/no-unnecessary-type-arguments": "error",
		"typescript/no-unnecessary-type-constraint": "error",
		"typescript/no-unnecessary-type-conversion": "error",
		"typescript/no-unnecessary-type-parameters": "error",
		"typescript/no-unsafe-argument": "error",
		"typescript/no-unsafe-assignment": "error",
		"typescript/no-unsafe-call": "error",
		"typescript/no-unsafe-function-type": "error",
		"typescript/no-unsafe-member-access": "error",
		"typescript/no-unsafe-return": "error",
		"typescript/only-throw-error": "error",
		"typescript/prefer-find": "error",
		"typescript/prefer-function-type": "error",
		"typescript/prefer-includes": "error",
		"typescript/prefer-nullish-coalescing": "error",
		"typescript/prefer-optional-chain": "error",
		"typescript/prefer-promise-reject-errors": "error",
		"typescript/prefer-readonly": "error",
		"typescript/prefer-reduce-type-parameter": "error",
		"typescript/prefer-regexp-exec": "error",
		"typescript/prefer-return-this-type": "error",
		"typescript/prefer-string-starts-ends-with": "error",
		"typescript/related-getter-setter-pairs": "error",
		"typescript/restrict-plus-operands": "error",
		"typescript/switch-exhaustiveness-check": [
			"error",
			{ allowDefaultCaseForExhaustiveSwitch: false }
		],
		"typescript/use-unknown-in-catch-callback-variable": "error",
		"unicorn/new-for-builtins": "error",
		"unicorn/no-accessor-recursion": "error",
		"unicorn/no-array-fill-with-reference-type": "error",
		"unicorn/no-array-reverse": "error",
		"unicorn/no-array-sort": "error",
		"unicorn/no-confusing-array-with": "error",
		"unicorn/no-document-cookie": "error",
		"unicorn/no-instanceof-builtins": ["error", { useErrorIsError: true }],
		"unicorn/no-useless-switch-case": "error",
		"unicorn/prefer-add-event-listener": "error",
		"unicorn/prefer-array-flat": "error",
		"unicorn/prefer-array-flat-map": "error",
		"unicorn/prefer-dom-node-text-content": "error",
		"unicorn/prefer-math-min-max": "error",
		"unicorn/prefer-node-protocol": "error",
		"unicorn/prefer-number-properties": ["error", { checkInfinity: true }],
		"unicorn/require-module-specifiers": "error",
		"unicorn/require-post-message-target-origin": "error"
	},
	drizzle: {},
	grizzle: {},
	properties: {},
	web: {
		"jsx-a11y/anchor-ambiguous-text": "error",
		"react/button-has-type": "error",
		"react/capitalized-calls": "error",
		"react/exhaustive-effect-dependencies": "error",
		"react/hooks": "error",
		"react/iframe-missing-sandbox": "error",
		"react/invariant": "error",
		"react/jsx-no-comment-textnodes": "error",
		"react/jsx-no-script-url": "error",
		"react/jsx-no-target-blank": "error",
		"react/jsx-no-useless-fragment": "error",
		"react/memo-dependencies": "error",
		"react/no-danger": "error",
		"react/no-namespace": "error",
		"react/self-closing-comp": "error",
		"react/style-prop-object": "error",
		"react/syntax": "error",
		"react/todo": "error",
		"react/unsupported-syntax": "error"
	}
} as const satisfies Readonly<Record<Part, DummyRuleMap>>

/** Relative imports are banned everywhere: a file reaches its package's files through `#` subpath imports. */
const RELATIVE_IMPORTS: RestrictedPattern = {
	group: [".", "..", "./**", "../**"],
	message:
		"Relative imports are banned. Use a `#` subpath import with the real file extension (`#lib/cn.ts`)."
}

/** One module, some of its exports, or all but some of them (`allowImportNames`), a project bans, and why. */
type RestrictedPath = Readonly<{
	name: string
	importNames?: ReadonlyArray<string>
	allowImportNames?: ReadonlyArray<string>
	allowTypeImports?: boolean
	message: string
}>

/** One glob of modules a project bans, and why. */
type RestrictedPattern = Readonly<{
	group: ReadonlyArray<string>
	importNames?: ReadonlyArray<string>
	allowTypeImports?: boolean
	message: string
}>

/** A project's no-restricted-imports lists. */
export type RestrictedImports = Readonly<{
	paths: ReadonlyArray<RestrictedPath>
	patterns: ReadonlyArray<RestrictedPattern>
}>

/** Effect's metrics reach no exporter: a fact belongs on its span, and a count or a rate is a query over spans. */
const EFFECT_METRICS_MESSAGE =
	"Effect metrics are exported nowhere: put the fact on its span (Effect.annotateCurrentSpan); counts and rates are queries over spans."

/**
 * `@effect/platform-node`'s index loads every platform module, NodeRedis's client among them, before the importer runs a
 * line. Measured on Node 26.13.1 (lane SYNC-EOCG, 2026-11-16): a generated CLI's start loaded 1,425 modules through the
 * index and 625 through its platform modules' own paths, 647 of the difference @redis/client's; a process importing
 * effect, NodeServices and NodeCrypto took 0.74 s of CPU through the index and 0.35 s through their own paths, with a
 * warm compile cache (median of 8 runs). Every process that imports it pays that: each test worker, each CLI.
 */
const PLATFORM_INDEX_MESSAGE =
	'Import each platform module from its own path (`import * as NodeServices from "@effect/platform-node/NodeServices"`): the index loads every platform module, its Redis client\'s 647 among them, about 0.39 s of CPU in every process that imports it.'

/**
 * The packages every repository bans (Bjorn, 2026-11-20: "zod is banned from this codebase, effect schema only"): no
 * file imports one or a subpath of it, and no manifest, catalog or lockfile importer names one (the workspace gate's
 * banned-packages). A repository adds its own in toolchain.config.ts's bannedPackages and lifts none of these.
 */
export const BANNED_PACKAGES: BannedPackages = [
	{
		name: "zod",
		message:
			'Zod is banned in every repository: Effect Schema is the one schema library. Admit a foreign value once, at its boundary, with Effect Schema (`import { Schema } from "effect"`).'
	}
]

/** A banned package's import ban: the package and every subpath of it (`zod`, `zod/v3`, `zod/v4/core`), where a ban
 * of the path `zod` alone let `zod/v3` through (alphatest-novus, 2026-11-20). */
const bannedImportOf = (banned: BannedPackages[number]): RestrictedPattern => ({
	group: [banned.name, `${banned.name}/**`],
	message: banned.message
})

/** eslint/no-restricted-imports with a block's lists and the shared bans: the banned packages, the relative-import
 * ban, Effect's metrics and the platform's index. Every block the preset makes builds the rule here, and no block of a
 * repository's may name it (ActiveRules), so no file is held to a list without the shared bans. */
const restrictedImports = (banned: BannedPackages, lists: RestrictedImports): DummyRule => [
	"error",
	{
		paths: [
			...lists.paths,
			{ name: "effect/Metric", message: EFFECT_METRICS_MESSAGE },
			{ name: "@effect/platform-node", message: PLATFORM_INDEX_MESSAGE }
		],
		patterns: [...lists.patterns, ...Arr.map(banned, bannedImportOf), RELATIVE_IMPORTS]
	}
]

/** One property a project bans, and why. */
export type RestrictedProperty = Readonly<{ object?: string; property: string; message: string }>

/** Effect's metric constructors, banned wherever they are reached from. */
const EFFECT_METRICS: ReadonlyArray<RestrictedProperty> = Arr.map(
	["counter", "gauge", "frequency", "histogram", "summary", "summaryWithTimestamp", "timer"],
	(property) => ({ object: "Metric", property, message: EFFECT_METRICS_MESSAGE })
)

/** eslint/no-restricted-properties with a block's list and the shared metrics ban. */
const restrictedProperties = (list: ReadonlyArray<RestrictedProperty>): DummyRule => [
	"error",
	...list,
	...EFFECT_METRICS
]

/** Math.random is Effect's globalRandom's where Effect runs; in Effect-free code this ban owns it. */
const MATH_RANDOM: RestrictedProperty = {
	object: "Math",
	property: "random",
	message:
		"Math.random is banned: draw randomness from an injected source, so a run can be replayed."
}

/** One global a project bans, and why. */
export type RestrictedGlobal = Readonly<{ name: string; message: string }>

/** Node 26's Temporal global, banned everywhere: where Effect runs, time is its Clock and DateTime's. */
const TEMPORAL: RestrictedGlobal = {
	name: "Temporal",
	message:
		"Temporal is banned: time goes through Effect's Clock and DateTime, and in Effect-free code through what the code is handed."
}

/** The built-in rules the Effect-free code is held to beside the plugin's Effect-free rules: where Effect runs, its
 * diagnostics own these bans. */
const EFFECT_FREE_BANS = {
	"oxc/no-async-await": "error",
	"typescript/strict-boolean-expressions": "error",
	"eslint/no-console": "error",
	"node/no-process-env": "error"
} as const satisfies DummyRuleMap

/** Where a repository's library reads no environment, which is its caller's to hand it: the library's directories, by
 * repository-relative path without a trailing "/" (as toolchain.config.ts's effectFree names them), and the sanctioned
 * readers among them, by file. A program's entry module that reads its arguments or working directory is a reader. */
export type Environment = Readonly<{
	library: ReadonlyArray<string>
	readers: ReadonlyArray<string>
}>

/** Whether a repository-relative path is a directory or lies beneath it. */
const isWithin = (path: string, directory: string): boolean =>
	path === directory || Str.startsWith(`${directory}/`)(path)

/** A block's lists: the imports, globals and properties it bans. */
export type Lists = Readonly<{
	restrictedImports: RestrictedImports
	restrictedGlobals: ReadonlyArray<RestrictedGlobal>
	restrictedProperties: ReadonlyArray<RestrictedProperty>
}>

/**
 * Lists a repository adds on some of its files, beside its root lists. A restriction only adds: every file it names
 * keeps the shared bans, the repository's root lists and the environment and Effect-free bans its place holds it to,
 * and takes the restriction's lists beside them. A file several restrictions name takes the last one's lists whole, as
 * a scope narrower than another restates what of the wider one's it keeps: a restriction of empty lists holds its files
 * to the root's alone.
 */
export type Restriction = Lists &
	Readonly<{
		/** Repository-relative paths: one ending in "/" names a directory and every file beneath it, any other one file. */
		paths: ReadonlyArray<string>
	}>

/** The files a block holds, as the preset reads the paths a repository states: every file, a directory and every file
 * beneath it, or one file. Paths meet exactly, where globs do not, so the preset knows every place a restriction's
 * files share with the library and the Effect-free code, and holds each to both. */
type Area = Readonly<
	{ kind: "everything" } | { kind: "directory"; path: string } | { kind: "file"; path: string }
>

/** A directory as toolchain.config.ts's effectFree and the environment's library name it: "." is every file. */
const directoryArea = (path: string): Area =>
	path === "." ? { kind: "everything" } : { kind: "directory", path }

/** A restriction's path: one ending in "/" names a directory, any other one file. */
const restrictedArea = (path: string): Area =>
	Str.endsWith("/")(path) ? directoryArea(Str.slice(0, -1)(path)) : { kind: "file", path }

/** Whether every file of `inner` lies in `outer`. */
const liesIn = (inner: Area, outer: Area): boolean => {
	switch (outer.kind) {
		case "everything":
			return true
		case "directory":
			return inner.kind !== "everything" && isWithin(inner.path, outer.path)
		case "file":
			return inner.kind === "file" && inner.path === outer.path
	}
}

/** The files two lists of areas both hold: of each pair, the area that lies in the other. */
const meet = (left: ReadonlyArray<Area>, right: ReadonlyArray<Area>): ReadonlyArray<Area> =>
	Arr.flatMap(left, (outer) =>
		Arr.flatMap(right, (inner) => {
			if (liesIn(outer, inner)) {
				return [outer]
			}
			return liesIn(inner, outer) ? [inner] : []
		})
	)

/** An area's files as one oxlint glob. */
const globOfArea = (area: Area): string => {
	switch (area.kind) {
		case "everything":
			return "**"
		case "directory":
			return `${area.path}/**`
		case "file":
			return area.path
	}
}

/** What a place holds a file's lists to beyond its block's: the environment bans (the library, outside its sanctioned
 * readers) and Math.random's (the Effect-free code). */
type Region = Readonly<{ environment: boolean; effectFree: boolean }>

const PLAIN: Region = { environment: false, effectFree: false }

/** One place the preset holds to a region, in the order it writes their blocks: a later place wins on the files it
 * shares with an earlier one, so the library's Effect-free code follows the library and the readers follow both. */
type Place = Readonly<{ areas: ReadonlyArray<Area>; region: Region }>

/** The places of a repository's library and Effect-free code, beyond every file's. */
const placesOf = (
	effectFree: ReadonlyArray<string>,
	environment: Environment
): ReadonlyArray<Place> => {
	const free = Arr.map(effectFree, directoryArea)
	const library = Arr.map(environment.library, directoryArea)
	const readers = Arr.map(environment.readers, (path): Area => ({ kind: "file", path }))
	const freeReaders = meet(readers, free)
	return [
		{ areas: free, region: { environment: false, effectFree: true } },
		{ areas: library, region: { environment: true, effectFree: false } },
		{ areas: meet(library, free), region: { environment: true, effectFree: true } },
		{
			areas: Arr.filter(readers, (reader) => !Arr.some(free, (area) => liesIn(reader, area))),
			region: PLAIN
		},
		{ areas: freeReaders, region: { environment: false, effectFree: true } }
	]
}

/** The lists a block may state, each by the rule it sets. */
const LISTED = {
	restrictedGlobals: "eslint/no-restricted-globals",
	restrictedImports: "eslint/no-restricted-imports",
	restrictedProperties: "eslint/no-restricted-properties"
} as const satisfies Readonly<Record<keyof Lists, string>>

type Listed = keyof typeof LISTED

const NO_LISTS: Lists = {
	restrictedImports: { paths: [], patterns: [] },
	restrictedGlobals: [],
	restrictedProperties: []
}

/** The built-in rules the preset builds from a repository's lists. */
type ListedRule =
	| "eslint/no-restricted-globals"
	| "eslint/no-restricted-imports"
	| "eslint/no-restricted-properties"
	| "import/no-unassigned-import"

type PluginRule = keyof typeof plugin.rules

/** Where a plugin rule runs: on every file, only on the Effect-free code (where Effect's diagnostics, which own the
 * ban elsewhere, do not run), only on test modules, on test scope (test modules, fixtures modules, and every module
 * under a test, integration or support directory), or only on the files of the web pack's Tailwind apps, with the
 * app's own options. */
type Scope = "every file" | "effect-free code" | "test files" | "test scope" | "tailwind apps"

/** Each plugin rule's part, which a repository runs or not, and the files it runs on there. */
const PLACES = {
	"bearer-owners": { part: "core", scope: "every file" },
	"brands-sole-mint": { part: "core", scope: "every file" },
	"effect-free-imports": { part: "core", scope: "effect-free code" },
	"import-doors": { part: "core", scope: "every file" },
	markup: { part: "web", scope: "tailwind apps" },
	"no-bare-materialized-view-joins": { part: "drizzle", scope: "every file" },
	"no-case-list": { part: "core", scope: "every file" },
	"no-collation": { part: "drizzle", scope: "every file" },
	"no-comment": { part: "core", scope: "every file" },
	"no-default-parameter": { part: "core", scope: "every file" },
	"no-drizzle-write-without-where": { part: "drizzle", scope: "every file" },
	"no-dynamic-imports": { part: "core", scope: "every file" },
	"no-implicit-select-all": { part: "drizzle", scope: "every file" },
	"no-inline-suppression": { part: "core", scope: "every file" },
	"no-module-state": { part: "core", scope: "every file" },
	"no-new-error": { part: "core", scope: "effect-free code" },
	"no-null-undefined-union": { part: "core", scope: "every file" },
	"no-option-bridge": { part: "core", scope: "every file" },
	"no-optional-parameter": { part: "core", scope: "every file" },
	"no-overload": { part: "core", scope: "every file" },
	"no-plant": { part: "core", scope: "every file" },
	"no-pointless-type-alias": { part: "core", scope: "every file" },
	"no-raw-regexp": { part: "core", scope: "every file" },
	"no-raw-sql": { part: "core", scope: "every file" },
	"no-send-beacon": { part: "web", scope: "every file" },
	"no-spread-argument": { part: "core", scope: "every file" },
	"no-svg-paint": { part: "web", scope: "tailwind apps" },
	"no-svg-without-title": { part: "web", scope: "every file" },
	"no-switch-default-bailout": { part: "core", scope: "every file" },
	"no-try": { part: "core", scope: "effect-free code" },
	"no-unoptimized-next-image": { part: "web", scope: "every file" },
	"no-useless-continue": { part: "core", scope: "every file" },
	"no-variadic-callback": { part: "core", scope: "every file" },
	"prefer-early-return": { part: "core", scope: "every file" },
	"sha256-digests": { part: "core", scope: "every file" },
	"side-effect-free": { part: "grizzle", scope: "every file" },
	"single-permit-owners": { part: "core", scope: "test scope" },
	"sql-aliased-table-reference": { part: "drizzle", scope: "every file" },
	"sql-distinct-window": { part: "drizzle", scope: "every file" },
	"sql-dynamic-schema": { part: "drizzle", scope: "every file" },
	"sql-executor-contract": { part: "drizzle", scope: "every file" },
	"sql-json-owner": { part: "drizzle", scope: "every file" },
	"sql-leaf-owners-only": { part: "drizzle", scope: "every file" },
	"sql-number-decoder": { part: "drizzle", scope: "every file" },
	"sql-query-deadline": { part: "drizzle", scope: "every file" },
	"sql-raw-execution": { part: "drizzle", scope: "every file" },
	"sql-raw-statement": { part: "drizzle", scope: "every file" },
	"test-no-prose-search": { part: "grizzle", scope: "test files" },
	"test-no-spelled-names": { part: "grizzle", scope: "test files" }
} as const satisfies { readonly [R in PluginRule]: Readonly<{ part: Part; scope: Scope }> }

/** The plugin rules of the parts `P` that take a repository's names in its oxlint.config.ts. A rule of a Tailwind app
 * takes the app's names from the web pack instead. */
type NamedRule<P extends Part> = {
	[R in PluginRule]: (typeof PLACES)[R]["part"] extends P
		? (typeof PLACES)[R]["scope"] extends "tailwind apps"
			? never
			: OptionsOf<(typeof plugin.rules)[R]> extends null
				? never
				: R
		: never
}[PluginRule]

/** The plugin rules that run on the files of a Tailwind app. */
type AppRule = {
	[R in PluginRule]: (typeof PLACES)[R]["scope"] extends "tailwind apps" ? R : never
}[PluginRule]

/** How each rule of a Tailwind app takes the app's options from the web pack. */
const APP_RULES: { readonly [R in AppRule]: (app: AppStyleOptions) => DummyRule } = {
	markup: (app) => ["error", app.markup],
	"no-svg-paint": () => "error"
}

/** A path of the style options (repository-relative; one ending in "/" names a directory) as an oxlint glob. */
const globOf = (path: string): string => (Str.endsWith("/")(path) ? `${path}**` : path)

/** One of the web pack's Tailwind apps: the repository's root, absolute, the app's package root relative to it, and
 * the app's style options. */
type TailwindApp = Readonly<{ root: string; app: string; options: AppStyleOptions }>

/** The web pack's Tailwind apps; none for a repository without a web pack. */
const tailwindAppsOf = (toolchain: Toolchain): ReadonlyArray<TailwindApp> =>
	Option.match(Option.fromUndefinedOr(toolchain.packs.web), {
		onNone: () => [],
		onSome: (web) =>
			Arr.map(Record.toEntries(web.apps), ([app, options]) => ({ root: web.root, app, options }))
	})

const isClassRuleId = (rule: string): rule is ClassRuleId =>
	Arr.contains<string>(CLASS_RULE_IDS, rule)

/** The class rules as a configuration names them: each plugin rule at error with its options, or off. */
const classRulesOf = (settings: ReadonlyArray<ClassSetting>): DummyRuleMap =>
	Record.fromEntries(
		Arr.map(settings, (setting): readonly [string, DummyRule] => [
			`${TAILWIND_PLUGIN}/${setting.rule}`,
			Option.match(setting.options, {
				onNone: (): DummyRule => "off",
				onSome: (options): DummyRule => ["error", options]
			})
		])
	)

/** What a style exception sets on its files: an oxlint rule of the plugin off, or the class rules that hold a class
 * rule id with that id lifted; none for a rule only the style linter runs. */
const exceptionRulesOf = (source: ClassSource, rule: string): Option.Option<DummyRuleMap> => {
	if (isClassRuleId(rule)) {
		return Option.some(classRulesOf(liftedSettingsOf(source, rule)))
	}
	const off: DummyRule = "off"
	return Arr.contains<string>(Record.keys(APP_RULES), rule)
		? Option.some({ [`${plugin.meta.name}/${rule}`]: off })
		: Option.none()
}

/** The plugin's names for the parts `P`: one options object for each of their rules that takes them, and none for a
 * rule of a part the repository does not run. */
export type PluginOptions<P extends Part> = {
	readonly [R in NamedRule<P>]: OptionsOf<(typeof plugin.rules)[R]>
}

/** Every rule the preset turns on itself, by name: a repository may reject none of them. */
type StandardRule =
	| { [P in Part]: keyof (typeof GENERIC_RULES)[P] }[Part]
	| keyof typeof EFFECT_FREE_BANS
	| ListedRule
	| `${typeof plugin.meta.name}/${PluginRule}`

/** The rules a toolchain rejects that the preset turns on. */
type RejectedStandard<T extends Toolchain> = Extract<keyof T["rejected"]["rules"], StandardRule>

/** A toolchain that rejects a rule the preset turns on is refused by type: the reason of each such rule must be
 * never, so the error names the rule. */
type RejectsNoStandardRule<T extends Toolchain> = [RejectedStandard<T>] extends [never]
	? unknown
	: Readonly<{ rejected: Readonly<{ rules: Readonly<Record<RejectedStandard<T>, never>> }> }>

/** A plugin's names: one options object for each of its rules that takes them. */
export type NamesOf<P extends Plugin> = {
	readonly [R in keyof P["rules"] as OptionsOf<P["rules"][R]> extends null ? never : R]: OptionsOf<
		P["rules"][R]
	>
}

/** A rule at error under its plugin's name, with the repository's names when it takes them. */
const entryOf = (
	pluginName: string,
	names: Readonly<Record<string, unknown>>,
	rule: string
): readonly [string, DummyRule] => [
	`${pluginName}/${rule}`,
	Option.match(Record.get(names, rule), {
		onNone: (): DummyRule => "error",
		onSome: (options): DummyRule => ["error", options]
	})
]

/** A repository's own oxlint plugin, loaded beside the shared one: the specifier oxlint loads it with, and its rules,
 * every one on in every file. */
export type OwnPlugin = Readonly<{ specifier: string; rules: DummyRuleMap }>

/**
 * A repository's own plugin: every rule of it on in every file, each that takes names with the repository's. Its
 * rules are named `<its meta.name>/<rule>`, so an exception block turns one off by that name; the name must differ
 * from every other plugin's, since oxlint refuses two plugins of one name. The specifier is a path oxlint resolves
 * from the configuration file, or an absolute one.
 */
export const ownPlugin = <const P extends Plugin>(
	input: Readonly<{ specifier: string; plugin: P; names: NamesOf<P> }>
): OwnPlugin => {
	const names: Readonly<Record<string, unknown>> = input.names
	return {
		specifier: input.specifier,
		rules: Record.fromEntries(
			Arr.map(Record.keys(input.plugin.rules), (rule) =>
				entryOf(input.plugin.meta.name, names, rule)
			)
		)
	}
}

/** Test modules, by their suffix. */
const TEST_FILES: ReadonlyArray<string> = Arr.map(TEST_SUFFIXES, (suffix) => `**/*${suffix}`)

/** The globs the preset scopes its own blocks by, test modules and test scope: definitions of the standard's, which a
 * repository's files need not all match. Every other glob of a configuration is a repository's own. */
export const STANDARD_GLOBS: ReadonlyArray<string> = Arr.dedupe([...TEST_FILES, ...TEST_SCOPE])

/** The testing library's oxlint plugin, by the specifier oxlint loads it with, the rules it holds test scope to, the
 * rules it holds a test module to once the repository runs the properties pack, and the rules it holds every file to;
 * or none, for a repository with no testing library. */
export type Tests =
	| Readonly<{ library: "none" }>
	| Readonly<{
			library: "installed"
			jsPlugin: string
			rules: DummyRuleMap
			/** A test module's own shape, which holds only a repository whose tests are properties (the properties pack). */
			modules: DummyRuleMap
			everyFile: DummyRuleMap
			/** Clock-free code beyond the test files, and the plugin's clock rules it is held to: the testing library and the
			 * tests' support, so no verdict rests on a hidden clock. A module whose job is the clock is an override's
			 * exception. */
			clock: Readonly<{ files: ReadonlyArray<string>; rules: DummyRuleMap }>
	  }>

/** What the testing library adds to a configuration: its plugin, the rules it holds test scope, test modules and every
 * file to, and its clock rules over the clock-free files. A repository with none adds nothing. */
type TestingAdds = Readonly<{
	jsPlugins: ReadonlyArray<string>
	rules: DummyRuleMap
	modules: DummyRuleMap
	everyFile: DummyRuleMap
	clock: Readonly<{ files: ReadonlyArray<string>; rules: DummyRuleMap }>
}>

const testingAdds = (tests: Tests): TestingAdds => {
	switch (tests.library) {
		case "none":
			return {
				jsPlugins: [],
				rules: {},
				modules: {},
				everyFile: {},
				clock: { files: [], rules: {} }
			}
		case "installed":
			return {
				jsPlugins: [tests.jsPlugin],
				rules: tests.rules,
				modules: tests.modules,
				everyFile: tests.everyFile,
				clock: tests.clock
			}
	}
}

/** What a repository states about itself in its oxlint.config.ts, beside its toolchain. Every field is required: a
 * repository with nothing to say states it empty. Globs are relative to the repository root. */
export type Project<Rejected extends string, P extends Part> = Lists &
	Readonly<{
		/** Paths oxlint never reads: vendored code, generated code, fixtures. */
		ignorePatterns: ReadonlyArray<string>
		/** The lists the repository adds on some of its files, in order, beside its root lists, which hold every file. */
		restrictions: ReadonlyArray<Restriction>
		/** The side-effect imports a project allows (`server-only`, stylesheets). */
		unassignedImports: ReadonlyArray<string>
		/** The library that reads no environment, and its sanctioned readers; both empty where there is no library to
		 * guard. */
		environment: Environment
		/** Tests, scripts and bench: no-shadow guards long passes and is ceremony there. */
		ceremony: ReadonlyArray<string>
		/** The shared plugin's names for the parts the repository runs, one options object per rule that takes them. */
		plugin: PluginOptions<P>
		/** The repository's own oxlint plugins, each made by `ownPlugin`. */
		ownPlugins: ReadonlyArray<OwnPlugin>
		tests: Tests
		/** The project's exceptions, in order; later blocks win. A block names no rule the preset builds from lists. */
		overrides: ReadonlyArray<
			Readonly<{ files: ReadonlyArray<string>; rules: ActiveRules<Rejected> }>
		>
	}>

/** The standard bound to one repository's toolchain: `active` types an exception block's rules against what the
 * repository rejects, and `lintConfig` builds its oxlint configuration. */
export type Standard<Rejected extends string, P extends Part> = Readonly<{
	/** A block's rules, refused by type when they name a rejected rule. lintConfig turns every rejected rule off after
	 * each block, so no block can bring one back. */
	active: <const R extends ActiveRules<Rejected>>(rules: R) => R
	/** The repository's oxlint configuration: the shared standard with the repository's lists. */
	lintConfig: (project: Project<Rejected, P>) => OxlintConfig
}>

/**
 * The standard for one repository, from its toolchain.config.ts: its rejected rules are off in every block of every
 * configuration it builds, and naming one in a block is a type error; the plugins, generic rules and plugin rules of
 * the core and of each pack it lists are on; its Effect-free directories are held to the Effect-free bans. A toolchain
 * that rejects a rule the standard itself turns on is refused by type.
 */
export const standard = <const T extends Toolchain>(
	toolchain: T & RejectsNoStandardRule<T>
): Standard<RejectedOf<T>, PartsOf<T>> => {
	const parts: ReadonlyArray<Part> = ["core", ...packNamesOf(toolchain.packs)]
	const runs = (part: Part): boolean => Arr.contains(parts, part)
	const off: DummyRuleMap = Record.map(toolchain.rejected.rules, (): DummyRule => "off")
	const banned: BannedPackages = [...BANNED_PACKAGES, ...toolchain.bannedPackages]
	const plugins = Arr.map(
		Arr.filter(PLUGINS, (builtIn) => runs(builtIn.part)),
		(builtIn) => builtIn.name
	)
	const apps = tailwindAppsOf(toolchain)
	const generic = Arr.reduce(parts, {}, (rules: DummyRuleMap, part): DummyRuleMap => ({
		...rules,
		...GENERIC_RULES[part]
	}))
	/** The plugin rules of the parts the repository runs that run on `scope`, with the repository's names. */
	const pluginRules = (names: Readonly<Record<string, unknown>>, scope: Scope): DummyRuleMap =>
		Record.fromEntries(
			Arr.map(
				Arr.filter(
					Record.keys(PLACES),
					(rule) => PLACES[rule].scope === scope && runs(PLACES[rule].part)
				),
				(rule) => entryOf(plugin.meta.name, names, rule)
			)
		)
	/** Each Tailwind app's block, which runs the app's rules and its class rules on its files with its options, its
	 * vendored components aside, and the blocks of its style exceptions that name an oxlint rule, which lift that rule
	 * on the files they name. */
	const appBlocks = ({ root, app, options }: TailwindApp): ReadonlyArray<OxlintOverride> => {
		const source: ClassSource = {
			cwd: `${root}/${app}`,
			entryPoint: `${root}/${options.entryPoint}`
		}
		return [
			{
				files: [`${app}/**`],
				excludeFiles: [globOf(options.vendored)],
				rules: {
					...Record.fromEntries(
						Arr.map(Record.keys(APP_RULES), (rule) => [
							`${plugin.meta.name}/${rule}`,
							APP_RULES[rule](options)
						])
					),
					...classRulesOf(classSettingsOf(source, [])),
					...off
				}
			},
			...Arr.filterMap(options.exceptions, (exception): Result.Result<OxlintOverride, void> =>
				Option.match(exceptionRulesOf(source, exception.rule), {
					onNone: () => Result.failVoid,
					onSome: (rules) =>
						Arr.isReadonlyArrayNonEmpty(exception.files)
							? Result.succeed({
									files: Arr.map(exception.files, globOf),
									rules: { ...rules, ...off }
								})
							: Result.failVoid
				})
			)
		]
	}
	/** A file group's block, its rejected rules off after its own, and none when the repository has no such files. */
	const block = (
		files: ReadonlyArray<string>,
		rules: DummyRuleMap
	): ReadonlyArray<OxlintOverride> =>
		Arr.isReadonlyArrayNonEmpty(files) ? [{ files: [...files], rules: { ...rules, ...off } }] : []
	return {
		active: (rules) => rules,
		lintConfig: (project) => {
			const names: Readonly<Record<string, unknown>> = project.plugin
			const testing = testingAdds(project.tests)
			const places = placesOf(toolchain.effectFree, project.environment)
			/** The lists' rules in a region: each the root's list, the region's bans and `lists`' own. */
			const listedRules = (lists: Lists, region: Region): DummyRuleMap => {
				const { environment, effectFree } = region
				const rules: { readonly [L in Listed]: DummyRule } = {
					restrictedGlobals: [
						"error",
						...project.restrictedGlobals,
						TEMPORAL,
						...(environment ? ENVIRONMENT_GLOBALS : []),
						...lists.restrictedGlobals
					],
					restrictedImports: restrictedImports(banned, {
						paths: [
							...project.restrictedImports.paths,
							...(environment ? ENVIRONMENT_IMPORTS.paths : []),
							...lists.restrictedImports.paths
						],
						patterns: [
							...project.restrictedImports.patterns,
							...(environment ? ENVIRONMENT_IMPORTS.patterns : []),
							...lists.restrictedImports.patterns
						]
					}),
					restrictedProperties: restrictedProperties([
						...project.restrictedProperties,
						...(environment ? ENVIRONMENT_PROPERTIES : []),
						...(effectFree ? [MATH_RANDOM] : []),
						...lists.restrictedProperties
					])
				}
				return Record.fromEntries(
					Arr.map(Record.keys(LISTED), (listed) => [LISTED[listed], rules[listed]] as const)
				)
			}
			/** A block's lists on its areas: their rules on every file of them, then again on each place they share with
			 * the library or the Effect-free code, held to that place's bans too. */
			const listBlocks = (
				areas: ReadonlyArray<Area>,
				lists: Lists
			): ReadonlyArray<OxlintOverride> =>
				Arr.flatMap([{ areas, region: PLAIN }, ...places], (place) =>
					block(
						Arr.dedupe(Arr.map(meet(areas, place.areas), globOfArea)),
						listedRules(lists, place.region)
					)
				)
			/** The root's lists on every place beyond every file's, and each restriction's on its paths, in order. */
			const lists: ReadonlyArray<OxlintOverride> = [
				...Arr.flatMap(places, (place) =>
					block(Arr.dedupe(Arr.map(place.areas, globOfArea)), listedRules(NO_LISTS, place.region))
				),
				...Arr.flatMap(project.restrictions, (restriction) =>
					listBlocks(Arr.map(restriction.paths, restrictedArea), restriction)
				)
			]
			return {
				plugins: [...plugins],
				jsPlugins: [
					`${import.meta.dirname}/oxlint-plugin.ts`,
					...(Arr.isReadonlyArrayNonEmpty(apps) ? [TAILWIND_PLUGIN_PATH] : []),
					...testing.jsPlugins,
					...Arr.map(project.ownPlugins, (own) => own.specifier)
				],
				categories: { correctness: "error" },
				env: { browser: true, node: true, es2024: true },
				options: {
					typeAware: true,
					denyWarnings: true,
					reportUnusedDisableDirectives: "error",
					respectEslintDisableDirectives: false
				},
				ignorePatterns: [...project.ignorePatterns],
				rules: {
					...generic,
					...pluginRules(names, "every file"),
					...testing.everyFile,
					...Arr.reduce(project.ownPlugins, {}, (rules: DummyRuleMap, own): DummyRuleMap => ({
						...rules,
						...own.rules
					})),
					...listedRules(NO_LISTS, PLAIN),
					"import/no-unassigned-import": ["error", { allow: [...project.unassignedImports] }],
					...off
				},
				overrides: [
					...block(
						Arr.map(toolchain.effectFree, (directory) =>
							directory === "." ? "**" : `${directory}/**`
						),
						{ ...pluginRules(names, "effect-free code"), ...EFFECT_FREE_BANS }
					),
					...lists,
					...Arr.flatMap(apps, appBlocks),
					{
						files: [...TEST_SCOPE],
						plugins: [...plugins, "vitest"],
						rules: { ...pluginRules(names, "test scope"), ...testing.rules, ...off }
					},
					{
						files: [...TEST_FILES],
						rules: {
							...pluginRules(names, "test files"),
							...(runs("properties") ? testing.modules : {}),
							...off
						}
					},
					...block(testing.clock.files, testing.clock.rules),
					...block(project.ceremony, { "eslint/no-shadow": "off" }),
					...Arr.map(project.overrides, (exception) => ({
						files: [...exception.files],
						rules: { ...exception.rules, ...off }
					}))
				]
			}
		}
	}
}

/**
 * A configuration's AST-only twin, for the commit gate (oxlint.ast.config.ts): the same plugins, rules and blocks, but
 * typeAware off, so oxlint skips every type-aware rule and starts no `tsrs-lint`, and lints without building a program.
 * Every rule of the JavaScript plugins stays, since a JavaScript plugin reads syntax and scope only.
 */
export const astOnly = (config: OxlintConfig): OxlintConfig => ({
	...config,
	options: { ...config.options, typeAware: false }
})
