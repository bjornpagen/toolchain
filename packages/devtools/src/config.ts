import { Array as Arr, Record, Schema } from "effect"
import { WebOptions } from "#style/options.ts"
import type { BannedPackages, Exceptions } from "#workspace/rules.ts"

/**
 * A repository's toolchain: the one value its root `toolchain.config.ts` exports by default, typed here and decoded by
 * every tool that reads it. It holds the repository's own decisions: what it rejects, where a workspace gate rule does
 * not run, which packages use no Effect, and which packs it runs beside the core. Everything else is the shared
 * standard: the lint rules' names and exceptions are the repository's oxlint.config.ts's, and a Tailwind app's style
 * names the web pack's.
 */

/** Lint rules and Effect diagnostics the repository rejects on purpose, each with why it is off. A rejected rule is off
 * in every block of every configuration the preset builds, naming one in a block is a type error, and turning one back
 * on needs the owner. The shared tsconfig base sets every diagnostic to error, or off where the toolchain drops it for
 * every repository (the workspace gate's DROPPED_DIAGNOSTICS); the repository's root tsconfig sets exactly these and the
 * dropped ones to off, and the workspace gate holds every tsconfig of the repository to that. */
export type Rejected = Readonly<{
	rules: Readonly<Record<string, string>>
	diagnostics: Readonly<Record<string, string>>
}>

/**
 * The packs a repository runs beside the core, each under its name, so no pack can be listed twice; a pack it does not
 * run is absent. `drizzle`: the SQL and Drizzle rules of a repository that owns an application database. `grizzle`:
 * grizzle's rules. `properties`: the properties pack, which a repository's conversion to the toolchain's runner turns on:
 * its test modules hold properties alone (the testing library's module rules), and the workspace gate refuses a Vitest
 * configuration and a numbered shard of a test module. `web`: the web rules of a repository with React apps (the React,
 * jsx-a11y and Next plugins with the React Compiler's rules, the browser rules, each Tailwind app's class, markup and
 * paint rules, and the style linter's stylesheet contract), with each app's style options by the app's
 * repository-relative root. The drizzle and grizzle packs' names are the repository's oxlint.config.ts's, given to the
 * preset's `lintConfig`, so those packs take none here.
 */
export const Packs = Schema.Struct({
	drizzle: Schema.optionalKey(Schema.Literal(true)),
	grizzle: Schema.optionalKey(Schema.Literal(true)),
	properties: Schema.optionalKey(Schema.Literal(true)),
	web: Schema.optionalKey(WebOptions)
})

export type Packs = typeof Packs.Type

/** The packs a repository may run beside the core, by name. */
export type PackName = keyof typeof Packs.fields

/** The packs a toolchain runs, by name. */
export const packNamesOf = (packs: Packs): ReadonlyArray<PackName> =>
	Arr.filter(Record.keys(Packs.fields), (name) => packs[name] !== undefined)

/**
 * How the repository's clones land on its trunk, which `toolchain-land` (bin/land.sh, `pnpm land`) reads: `lock`, the
 * file every clone of the repository on the machine takes the push lock on, written from the home directory (`~/`);
 * and `branch`, the branch a landing pushes to, which only a push holding the lock may update (the push gate's check,
 * `toolchain-land pre-push`, and a local hub's pre-receive hook). A landing waits for the lock, rebases the clone's
 * branch onto the remote's inside it and pushes, so the push gate (the clone's pre-push hook) runs once, on the commit
 * that lands, which nothing else can move while it runs.
 */
export const Land = Schema.Struct({
	lock: Schema.TemplateLiteral(["~/", Schema.NonEmptyString]),
	branch: Schema.NonEmptyString
})

export type Land = typeof Land.Type

/** The web pack's options, which a repository may build in a module of its own. */
export type { WebOptions } from "#style/options.ts"

/** What a repository's toolchain.config.ts holds. */
export type Toolchain = Readonly<{
	rejected: Rejected
	/** Files where a workspace gate rule does not run, by the rule's id. */
	exceptions: Exceptions
	/** The workspace packages that use no Effect, by repository-relative directory without a trailing "/". */
	effectFree: ReadonlyArray<string>
	/** The packs the repository runs beside the core. */
	packs: Packs
	/** The packages the repository bans beside the standard's, which no manifest, catalog or lockfile importer of it
	 * may name (the workspace gate's banned-packages) and no file may import, the package or a subpath of it. */
	bannedPackages: BannedPackages
	/** How the repository's clones land on its trunk (`pnpm land`). */
	land: Land
}>

/** A key a toolchain.config.ts may not write: every key no Toolchain holds, such as the `core` and `own` that the
 * retired superlint read, which a toolchain would otherwise carry unread, and every pack no Packs names. */
type UnreadKeys<T extends Toolchain> = Readonly<{
	[K in Exclude<keyof T, keyof Toolchain>]: never
}> &
	Readonly<{ packs: Readonly<{ [K in Exclude<keyof T["packs"], PackName>]: never }> }>

/** A repository's toolchain, as its toolchain.config.ts writes it; the literal types survive, so the preset can refuse
 * a rejected rule by name, and a key no Toolchain or Packs holds is a type error. */
export const toolchain = <const T extends Toolchain>(config: T & UnreadKeys<T>): T => config
