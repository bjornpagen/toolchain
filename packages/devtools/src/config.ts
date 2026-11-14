import { Array as Arr, Data } from "effect"
import type { CoreOptions, DrizzleOptions, Exceptions, GrizzleOptions } from "#lint/options.ts"
import type { BoundRule, Rule } from "#lint/types.ts"
import type { WebOptions } from "#style/options.ts"

/**
 * A repository's toolchain: the one value its root `toolchain.config.ts` exports by default, typed here and decoded by
 * every tool that reads it. It holds the repository's own decisions: what it rejects, where a rule does not run, which
 * packs it runs beside the core and with what names, and its own rules. Everything else is the shared standard.
 */

/** Lint rules and Effect diagnostics the repository rejects on purpose, each with why it is off. A rejected rule is off
 * in every block of every configuration the preset builds, naming one in a block is a type error, and turning one back
 * on needs the owner. The shared tsconfig base sets every diagnostic to error; the repository's root tsconfig sets
 * exactly these to off, and superlint holds every tsconfig of the repository to that. */
export type Rejected = Readonly<{
	rules: Readonly<Record<string, string>>
	diagnostics: Readonly<Record<string, string>>
}>

/** A pack beside the core: the SQL and Drizzle rules of a repository that owns an application database, grizzle's rules,
 * or the web rules of a repository with React apps (the React, jsx-a11y and Next plugins, the browser rules, the style
 * linter and the React Compiler check), each with the repository's names for it. */
export type Pack =
	| Readonly<{ pack: "drizzle"; options: DrizzleOptions }>
	| Readonly<{ pack: "grizzle"; options: GrizzleOptions }>
	| Readonly<{ pack: "web"; options: WebOptions }>

/** The packs a repository may run beside the core, by name. */
export type PackName = Pack["pack"]

/** The one pack of a name, so a repository's config keeps which packs it runs in its type. */
type PackOf<N extends PackName> = Extract<Pack, Readonly<{ pack: N }>>

/** The drizzle pack, with the repository's owner paths and declared statements. */
export const drizzle = (options: DrizzleOptions): PackOf<"drizzle"> => ({
	pack: "drizzle",
	options
})

/** The grizzle pack, with the repository's exempt paths, helper names and vocabularies. */
export const grizzle = (options: GrizzleOptions): PackOf<"grizzle"> => ({
	pack: "grizzle",
	options
})

/** The web pack, with each app's style options by the app's repository-relative root. */
export const web = (options: WebOptions): PackOf<"web"> => ({ pack: "web", options })

/**
 * A repository's own superlint rules, proven as the shared ones are: the rules, the names they run under on the tree
 * and on their fixtures, and the directory of their fixtures (a tsconfig.json and one `<rule>/violating.ts` and
 * `<rule>/clean.ts` per rule, with the fixtures' option paths relative to that directory). The options are bound to
 * the rules here, so the engine never sees their type.
 */
export class OwnRules extends Data.Class<{
	readonly name: string
	readonly rules: ReadonlyArray<BoundRule>
	readonly fixtureRules: ReadonlyArray<BoundRule>
	readonly fixtures: string
}> {}

/** A rule whose visits read `options` wherever they read their context's options. */
const boundTo = <O>(rule: Rule<O>, options: O): BoundRule => {
	const { starting } = rule
	switch (starting.reads) {
		case "file":
			return {
				...rule,
				starting: { reads: "file", visit: (context) => starting.visit({ ...context, options }) }
			}
		case "program":
			return {
				...rule,
				starting: {
					reads: "program",
					start: (program) => {
						const visit = starting.start(program)
						return (context) => visit({ ...context, options })
					}
				}
			}
		case "surface":
			return {
				...rule,
				starting: {
					reads: "surface",
					start: (program) => {
						const visit = starting.start(program)
						return (context) => visit({ ...context, options })
					}
				}
			}
	}
}

/** Binds every rule to the options it runs under. */
export const bindRules = <O>(rules: ReadonlyArray<Rule<O>>, options: O): ReadonlyArray<BoundRule> =>
	Arr.map(rules, (rule) => boundTo(rule, options))

/** A repository's own superlint rules: their name (for the output), the rules, the repository's names for them, and
 * their fixtures' directory and names. */
export const ownRules = <O>(
	input: Readonly<{
		name: string
		rules: ReadonlyArray<Rule<O>>
		options: O
		fixtures: Readonly<{ directory: string; options: O }>
	}>
): OwnRules =>
	new OwnRules({
		name: input.name,
		rules: bindRules(input.rules, input.options),
		fixtureRules: bindRules(input.rules, input.fixtures.options),
		fixtures: input.fixtures.directory
	})

/** What a repository's toolchain.config.ts holds. */
export type Toolchain = Readonly<{
	rejected: Rejected
	/** Files where a rule does not run, by the rule's id: per-file rules and repository-wide ones alike. */
	exceptions: Exceptions
	/** The workspace packages that use no Effect, by repository-relative directory without a trailing "/". */
	effectFree: ReadonlyArray<string>
	/** The core pack's names: every repository runs the core. */
	core: CoreOptions
	/** The packs the repository runs beside the core, each at most once. */
	packs: ReadonlyArray<Pack>
	/** The repository's own superlint rules. */
	own: ReadonlyArray<OwnRules>
}>

/** A repository's toolchain, as its toolchain.config.ts writes it; the literal types survive, so the preset can refuse
 * a rejected rule by name. */
export const toolchain = <const T extends Toolchain>(config: T): T => config
