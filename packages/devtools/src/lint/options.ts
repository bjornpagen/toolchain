import { Schema } from "effect"

/** Repository-relative paths: one ending in "/" names a directory and every file beneath it, any other one file. */
const Paths = Schema.Array(Schema.String)

const Names = Schema.Array(Schema.String)

const PackageDirectories = Schema.Array(Schema.String)

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
	})
})

export type GrizzleOptions = typeof GrizzleOptions.Type

/** The exceptions the fixtures run under, relative to the fixtures root. */
export const FIXTURE_EXCEPTIONS: Exceptions = []

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
	}
}
