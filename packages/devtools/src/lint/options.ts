import { Schema } from "effect"

/** Repository-relative paths: one ending in "/" names a directory and every file beneath it, any other one file. */
const Paths = Schema.Array(Schema.String)

const Names = Schema.Array(Schema.String)

const PackageDirectories = Schema.Array(Schema.String)

/** Files a rule does not read, and the reason it leaves them, which the repository states beside them. */
const Exemption = Schema.Struct({ files: Paths, reason: Schema.NonEmptyString })

/** A search of a repository module, by its module and name, and the property of its spec that holds its space
 * (`exhaust`'s `generator`, `explore`'s `draw`). */
const SearchSpace = Schema.Struct({
	module: Schema.String,
	name: Schema.String,
	space: Schema.String
})

/**
 * What a generator draws, for no-case-list: the members of the list it is handed (`element`), the one value it is
 * handed (`constant`), one value for each value of the generator it is handed (`map`, `span`, `drawn`, `sketched`), or a value of one of the generators it is handed (`oneOf`, `weighted`, `proportional`).
 */
const Draws = Schema.Literals(["list", "value", "each", "union"])

export type Draws = typeof Draws.Type

/** What of a module's values a no-environment source reads: every one, or the named ones. */
const EnvironmentReads = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("module") }),
	Schema.Struct({ kind: Schema.Literal("exports"), names: Names })
])

/** The repository's exceptions: files where a rule does not run, by its id. Exceptions live in the repository's
 * toolchain.config.ts, never inline. */
export const Exceptions = Schema.Array(Schema.Struct({ rule: Schema.String, files: Paths }))

export type Exceptions = typeof Exceptions.Type

/** The workspace packages that use no Effect, by repository-relative directory without a trailing "/": each runs
 * the Effect-free lint rules, its tsconfig extends the dev tools' Effect-free base, and it depends on no `effect`. */
export const EffectFree = PackageDirectories

/** The core pack's options: its rules take no names. */
export const CoreOptions = Schema.Struct({})

export type CoreOptions = typeof CoreOptions.Type

/**
 * The grizzle pack's options: exempt paths, helper names and vocabularies. Every field is required: a repository
 * where a rule has nothing to guard states that with an empty list, so the rule is inert there.
 */
export const GrizzleOptions = Schema.Struct({
	/** Where the library reads no environment: the files read, the sanctioned readers among them, the packages' modules
	 * whose values are the environment, and the values of those a program's entry module (one that tests
	 * `import.meta.main`) reads as its own arguments and working directory. */
	noEnvironment: Schema.Struct({
		files: Paths,
		readers: Paths,
		sources: Schema.Array(
			Schema.Struct({
				package: Schema.String,
				module: Schema.String,
				reads: EnvironmentReads
			})
		),
		entryReads: Names
	}),
	/** Where a search's space is never a list of cases: the files whose searches are read; the files among them where
	 * every list written is a list of cases, beside the test files, whose lists always are (elsewhere a list is a roster
	 * the source declares); the dictionaries, whose lists are the values the code branches on, never verdicts, each set
	 * with its reason; the searches, with the property of their spec that holds the space; and the generators, each with
	 * what it draws. */
	noCaseList: Schema.Struct({
		files: Paths,
		cases: Paths,
		dictionaries: Schema.Array(Exemption),
		searches: Schema.Array(SearchSpace),
		generators: Schema.Array(Schema.Struct({ module: Schema.String, names: Names, draws: Draws }))
	})
})

export type GrizzleOptions = typeof GrizzleOptions.Type

/** The exceptions the fixtures run under, relative to the fixtures root. */
export const FIXTURE_EXCEPTIONS: Exceptions = []

/** The core pack's options for its fixtures. */
export const CORE_FIXTURE_OPTIONS: CoreOptions = {}

/** The grizzle pack's options for its fixtures: names that point into each rule's own fixture directory. */
export const GRIZZLE_FIXTURE_OPTIONS: GrizzleOptions = {
	noEnvironment: {
		files: ["no-environment/"],
		readers: ["no-environment/reader/clean.ts"],
		sources: [
			{
				package: "@types/node",
				module: "process",
				reads: {
					kind: "exports",
					names: [
						"env",
						"cwd",
						"chdir",
						"argv",
						"argv0",
						"execArgv",
						"execPath",
						"loadEnvFile",
						"platform",
						"arch",
						"version",
						"versions",
						"release",
						"config",
						"features",
						"title",
						"ppid",
						"getuid",
						"geteuid",
						"getgid",
						"getegid",
						"getgroups",
						"umask",
						"memoryUsage",
						"resourceUsage",
						"availableMemory",
						"constrainedMemory",
						"allowedNodeEnvironmentFlags",
						"permission"
					]
				}
			},
			{ package: "@types/node", module: "os", reads: { kind: "module" } },
			{ package: "@types/node", module: "navigator", reads: { kind: "module" } },
			{
				package: "@types/node",
				module: "v8",
				reads: {
					kind: "exports",
					names: ["getHeapStatistics", "getHeapSpaceStatistics", "getHeapCodeStatistics"]
				}
			},
			{ package: "effect", module: "Config", reads: { kind: "module" } },
			{ package: "effect", module: "ConfigProvider", reads: { kind: "module" } }
		],
		entryReads: ["argv", "cwd"]
	},
	noCaseList: {
		files: [
			"no-case-list/violating.ts",
			"no-case-list/clean.ts",
			"no-case-list/cases.ts",
			"no-case-list/dictionary.ts",
			"no-case-list/roster.ts"
		],
		cases: [
			"no-case-list/violating.ts",
			"no-case-list/clean.ts",
			"no-case-list/cases.ts",
			"no-case-list/dictionary.ts"
		],
		dictionaries: [
			{
				files: ["no-case-list/dictionary.ts"],
				reason:
					"A dictionary's fixture: the values a generator draws, which no case's verdict rides on."
			}
		],
		searches: [
			{ module: "no-case-list/testing.ts", name: "exhaust", space: "generator" },
			{ module: "no-case-list/testing.ts", name: "explore", space: "draw" }
		],
		generators: [
			{ module: "no-case-list/testing.ts", names: ["element"], draws: "list" },
			{ module: "no-case-list/testing.ts", names: ["constant"], draws: "value" },
			{
				module: "no-case-list/testing.ts",
				names: ["map", "span", "drawn", "sketched"],
				draws: "each"
			},
			{ module: "no-case-list/testing.ts", names: ["oneOf", "weighted"], draws: "union" }
		]
	}
}
