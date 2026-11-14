import { Schema } from "effect"

/** Repository-relative paths: one ending in "/" names a directory and every file beneath it, any other one file. */
const Paths = Schema.Array(Schema.String)

const Names = Schema.Array(Schema.String)

const PackageDirectories = Schema.Array(Schema.String)

/** A top-level declaration of a repository module: the module by its repository-relative path, the declaration by
 * its name. */
const Declaration = Schema.Struct({ owner: Schema.String, declaration: Schema.String })

/** Values a repository module exports, by the module's repository-relative path and the values' names. */
const DeclaredValues = Schema.Struct({ module: Schema.String, names: Names })

/** Declarations of an installed package, by the package's name and the declarations' names. */
const PackageDeclarations = Schema.Struct({ package: Schema.String, declarations: Names })

/** Files a rule does not read, and the reason it leaves them, which the repository states beside them. */
const Exemption = Schema.Struct({ files: Paths, reason: Schema.NonEmptyString })

/** Values of a repository module a rule does not count, and the reason, which the repository states beside them. */
const Scaffolds = Schema.Struct({
	module: Schema.String,
	names: Names,
	reason: Schema.NonEmptyString
})

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
 * The drizzle pack's options, for a repository that owns an application database: owner paths and declared
 * statements. Every field is required: a rule with nothing to admit states it with an empty list.
 */
export const DrizzleOptions = Schema.Struct({
	/** The leaf files that may write Drizzle `sql` templates. */
	sqlLeafOwnersOnly: Schema.Struct({ owners: Paths }),
	/** The leaf files that may render a `::` cast. */
	sqlCastOwner: Schema.Struct({ owners: Paths }),
	/** The leaf files that may render JSON operators and expansions. */
	sqlJsonOwner: Schema.Struct({ owners: Paths }),
	/** The top-level arrow functions that may build a table from a computed column map: session-local relations
	 * derived from static declarations. */
	sqlDynamicSchema: Schema.Struct({ tableFactories: Schema.Array(Declaration) }),
	/** Where database deadlines are refused: the files read, the property names that set a deadline, the string
	 * literals that refuse work by elapsed time, and the deadlines admitted. An admitted deadline is the property set
	 * in its owner, inside `new construction(…)`, to `subject === principals.principal ? constant : false`, where the
	 * constant is declared in its module. */
	sqlQueryDeadline: Schema.Struct({
		files: Paths,
		properties: Names,
		refusals: Names,
		admitted: Schema.Array(
			Schema.Struct({
				owner: Schema.String,
				property: Schema.String,
				construction: Schema.String,
				guard: Schema.Struct({
					subject: Schema.String,
					principals: Schema.String,
					principal: Schema.String
				}),
				value: Schema.Struct({ module: Schema.String, constant: Schema.String })
			})
		)
	}),
	/** Who may execute statements: the statement-custody files that run native builders and prepared queries, the
	 * files that may run a pg-copy-streams COPY, the files that hold a native client and may call pg's `query`, and the
	 * executors whose one reviewed statement may run through Drizzle's `execute`: in the executor declared at the top
	 * level of the owner, `execute(statement(…))` with the statement declared in the same owner. */
	sqlRawExecution: Schema.Struct({
		statementOwners: Paths,
		copyStreamOwners: Paths,
		nativeClientOwners: Paths,
		declaredExecutions: Schema.Array(
			Schema.Struct({ owner: Schema.String, executor: Schema.String, statement: Schema.String })
		)
	}),
	/** The statement grammar admitted in a `sql` template: the files that hold the recursive envelope
	 * (`with recursive ${join} ${builder}`) and the projection envelope (`${builder.getSQL()} offset 0`), and the
	 * declared statements, each a top-level declaration of its owner whose templates' authored grammar, whitespace
	 * collapsed, is exactly its grammar. */
	sqlRawStatement: Schema.Struct({
		recursiveEnvelopeOwners: Paths,
		projectionEnvelopeOwners: Paths,
		declaredStatements: Schema.Array(
			Schema.Struct({ owner: Schema.String, declaration: Schema.String, grammar: Schema.String })
		)
	})
})

export type DrizzleOptions = typeof DrizzleOptions.Type

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
	/** Where every test case runs a search: the files whose cases are read, the declarations of the installed packages
	 * whose signatures register a test case (`it`, `it.effect`, `test`), the searches a case's body must reach, the
	 * scaffolds that run a search around a scenario a person wrote and so are no way to one, and the files exempt, each
	 * scaffold and each set of files with its reason. */
	testCaseIsSearch: Schema.Struct({
		files: Paths,
		registrars: Schema.Array(PackageDeclarations),
		searches: Schema.Array(DeclaredValues),
		scaffolds: Schema.Array(Scaffolds),
		exempt: Schema.Array(Exemption)
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

/** The drizzle pack's options for its fixtures: names that point into each rule's own fixture directory. */
export const DRIZZLE_FIXTURE_OPTIONS: DrizzleOptions = {
	sqlLeafOwnersOnly: { owners: ["sql-leaf-owners-only/clean.ts"] },
	sqlCastOwner: { owners: ["sql-cast-owner/clean.ts"] },
	sqlJsonOwner: { owners: ["sql-json-owner/clean.ts"] },
	sqlDynamicSchema: {
		tableFactories: [{ owner: "sql-dynamic-schema/clean.ts", declaration: "stageOf" }]
	},
	sqlQueryDeadline: {
		files: ["sql-query-deadline/"],
		properties: ["statement_timeout", "queryTimeoutMs"],
		refusals: ["budget-exhausted"],
		admitted: [
			{
				owner: "sql-query-deadline/clean.ts",
				property: "statement_timeout",
				construction: "Pool",
				guard: { subject: "username", principals: "PRINCIPALS", principal: "reader" },
				value: { module: "sql-query-deadline/clean.ts", constant: "READER_TIMEOUT_MILLISECONDS" }
			}
		]
	},
	sqlRawExecution: {
		statementOwners: ["sql-raw-execution/clean.ts"],
		copyStreamOwners: ["sql-raw-execution/clean.ts"],
		nativeClientOwners: ["sql-raw-execution/clean.ts"],
		declaredExecutions: [
			{
				owner: "sql-raw-execution/clean.ts",
				executor: "createStaging",
				statement: "stagingDefinition"
			}
		]
	},
	sqlRawStatement: {
		recursiveEnvelopeOwners: ["sql-raw-statement/clean.ts"],
		projectionEnvelopeOwners: ["sql-raw-statement/clean.ts"],
		declaredStatements: [
			{
				owner: "sql-raw-statement/clean.ts",
				declaration: "truncation",
				grammar: "truncate ? cascade"
			}
		]
	}
}

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
	testCaseIsSearch: {
		files: ["test-case-is-search/"],
		registrars: [
			{ package: "@effect/vitest", declarations: ["Test", "each", "prop"] },
			{
				package: "vitest",
				declarations: ["TestCollectorCallable", "EachFunctionReturn", "TestForFunctionReturn"]
			}
		],
		searches: [
			{ module: "test-case-is-search/testing.ts", names: ["explore", "exhaust", "interleave"] }
		],
		scaffolds: [
			{
				module: "test-case-is-search/support.ts",
				names: ["scripted"],
				reason: "A scaffold's fixture: it searches a box around a scenario its caller writes."
			}
		],
		exempt: [
			{
				files: ["test-case-is-search/exempt/clean.ts"],
				reason:
					"An exempt file's fixture: its cases stay as they are, for the reason its exemption states."
			}
		]
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
