import { Schema } from "effect"

/**
 * The test system's gates (workspace/test-system.ts): another runner's configuration, a plant, a numbered shard of a
 * test module, a worker flag in a script.
 */
export const TEST_SYSTEM_RULES = [
	"no-vitest-config",
	"no-plants",
	"no-test-shards",
	"no-worker-flags"
] as const

export type TestSystemRule = (typeof TEST_SYSTEM_RULES)[number]

/**
 * The rules the workspace gate runs over the repository as a whole: the tsconfig gate's (the Effect diagnostics every
 * tsconfig sets, the shared base's roster, the one plugin block, the Effect-free packages' tsconfigs and manifests),
 * the TypeScript-only extensions, the test system's gates, the dead paths (an oxlint override's glob or an
 * exception's path that names no file), the root's tasks (a root script turbo would pass over), turbo's way for the
 * compile cache into its tasks (turbo-compile-cache), and the root's files
 * (each named by the root tsconfig's include, which the root's typecheck and lint both read). They are the only rules toolchain.config.ts's exceptions name: a lint rule's
 * exception is an override block in oxlint.config.ts, and a style rule's is the web pack app's.
 */
const WORKSPACE_RULES = [
	"rejected-diagnostics",
	"diagnostic-roster",
	"effect-plugin-block",
	"effect-free-packages",
	"ts-only-extensions",
	"dead-paths",
	"root-tasks",
	"root-files",
	"turbo-compile-cache",
	...TEST_SYSTEM_RULES
] as const

/** Repository-relative paths: one ending in "/" names a directory and every file beneath it, any other one file. */
const Paths = Schema.Array(Schema.String)

/** The repository's exceptions: files a workspace gate rule does not hold, by its id. Exceptions live in the
 * repository's toolchain.config.ts, never inline, and naming a rule the gate does not run is refused, by type and when
 * the toolchain is read. */
export const Exceptions = Schema.Array(
	Schema.Struct({ rule: Schema.Literals(WORKSPACE_RULES), files: Paths })
)

export type Exceptions = typeof Exceptions.Type

/** Packages a repository bans beside the standard's (the preset's BANNED_PACKAGES), each by its name on npm and why,
 * which every refusal quotes: a repository adds to the standard's and never lifts one. */
export const BannedPackages = Schema.Array(
	Schema.Struct({ name: Schema.NonEmptyString, message: Schema.NonEmptyString })
)

export type BannedPackages = typeof BannedPackages.Type

/** The workspace packages that use no Effect, by repository-relative directory without a trailing "/": each runs
 * the Effect-free lint rules, its tsconfig extends the dev tools' Effect-free base, and it depends on no `effect`. */
export const EffectFree = Schema.Array(Schema.String)
