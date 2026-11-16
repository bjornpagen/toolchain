import type { WebOptions } from "#style/options.ts"
import type { Exceptions } from "#workspace/rules.ts"

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

/** A pack beside the core: the SQL and Drizzle rules of a repository that owns an application database, grizzle's rules,
 * the limit rules of a repository that keeps its limits in a limits package (no-bare-limit and limits-sole-mint), the
 * web rules of a repository with React apps (the React, jsx-a11y and Next plugins with the React Compiler's
 * rules, the browser rules, each Tailwind app's class, markup and paint rules, and the style linter's stylesheet
 * contract), or the properties pack of a repository whose tests are the toolchain runner's properties. The web pack
 * carries each app's style names; the drizzle, grizzle and limits packs' names are the repository's oxlint.config.ts's,
 * given to the preset's `lintConfig`. */
export type Pack =
	| Readonly<{ pack: "drizzle" }>
	| Readonly<{ pack: "grizzle" }>
	| Readonly<{ pack: "limits" }>
	| Readonly<{ pack: "properties" }>
	| Readonly<{ pack: "web"; options: WebOptions }>

/** The packs a repository may run beside the core, by name. */
export type PackName = Pack["pack"]

/** The one pack of a name, so a repository's config keeps which packs it runs in its type. */
type PackOf<N extends PackName> = Extract<Pack, Readonly<{ pack: N }>>

/** The drizzle pack. Its rules are the oxlint plugin's, so the repository's names for them are its oxlint.config.ts's,
 * given to the preset's `lintConfig`, and the pack takes none here. */
export const drizzle = (): PackOf<"drizzle"> => ({ pack: "drizzle" })

/** The grizzle pack. Its rules are the oxlint plugin's, so the repository's names for them are its oxlint.config.ts's,
 * and the pack takes none here. */
export const grizzle = (): PackOf<"grizzle"> => ({ pack: "grizzle" })

/** The limits pack, which a repository runs once its limits live in its limits package (packages/limits): no-bare-limit
 * and limits-sole-mint. Their names, the limits packages and the test files, are the repository's oxlint.config.ts's,
 * and the pack takes none here. */
export const limits = (): PackOf<"limits"> => ({ pack: "limits" })

/**
 * The properties pack, which a repository's conversion to the toolchain's runner turns on: its test modules hold
 * properties alone (the testing library's module rules), and the workspace gate refuses a Vitest configuration and a
 * numbered shard of a test module. A repository still on Vitest's callbacks runs without it until its tests are
 * converted.
 */
export const properties = (): PackOf<"properties"> => ({ pack: "properties" })

/** The web pack, with each app's style options by the app's repository-relative root. */
export const web = (options: WebOptions): PackOf<"web"> => ({ pack: "web", options })

/** What a repository's toolchain.config.ts holds. */
export type Toolchain = Readonly<{
	rejected: Rejected
	/** Files where a workspace gate rule does not run, by the rule's id. */
	exceptions: Exceptions
	/** The workspace packages that use no Effect, by repository-relative directory without a trailing "/". */
	effectFree: ReadonlyArray<string>
	/** The packs the repository runs beside the core, each at most once. */
	packs: ReadonlyArray<Pack>
}>

/** A key a toolchain.config.ts may not write: every key no Toolchain holds, such as the `core` and `own` that the
 * retired superlint read, which a toolchain would otherwise carry unread. */
type UnreadKeys<T> = Readonly<{ [K in Exclude<keyof T, keyof Toolchain>]: never }>

/** A repository's toolchain, as its toolchain.config.ts writes it; the literal types survive, so the preset can refuse
 * a rejected rule by name, and a key no Toolchain holds is a type error. */
export const toolchain = <const T extends Toolchain>(config: T & UnreadKeys<T>): T => config
