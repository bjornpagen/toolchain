import { Array as Arr, Option } from "effect"

/**
 * The class rules of a Tailwind app, which oxlint runs through eslint-plugin-better-tailwindcss on the app's files: the
 * plugin reads every class string in a className, a `*ClassName` slot, a class helper's arguments (cn, clsx, twMerge,
 * cva's base, variants and compound variants), a classList call and a variable named for classes, against the app's
 * full Tailwind v4 design system, loaded from the stylesheet components.json names. It reads syntax and the design
 * system alone, so no class rule opens the app's TypeScript program. Each style rule id that a web pack's exception may
 * name maps to the plugin rules that hold it: a class compiles (no-unresolved-class), one class list sets no property
 * twice (no-conflicting-classes), a class is never glued to an interpolation (no-dynamic-class), and an arbitrary value
 * or a Tailwind palette color is refused (no-arbitrary-value, no-invalid-color), by patterns over each class.
 */

/** The plugin's name, which prefixes its rules in a configuration and in their diagnostics. */
export const TAILWIND_PLUGIN = "better-tailwindcss"

/** The plugin's module, resolved as Node resolves the dev tools' own imports, so a repository's configuration loads it
 * by its absolute path wherever its dependencies are installed. */
export const TAILWIND_PLUGIN_PATH = decodeURIComponent(
	new URL(import.meta.resolve("eslint-plugin-better-tailwindcss")).pathname
)

/** Tailwind's own palette, whose colors are no design tokens: the colors of tailwindcss/theme.css with a shade, and
 * black and white. */
const PALETTE: ReadonlyArray<string> = [
	"red",
	"orange",
	"amber",
	"yellow",
	"lime",
	"green",
	"emerald",
	"teal",
	"cyan",
	"sky",
	"blue",
	"indigo",
	"violet",
	"purple",
	"fuchsia",
	"pink",
	"rose",
	"slate",
	"gray",
	"zinc",
	"neutral",
	"stone",
	"mauve",
	"olive",
	"mist",
	"taupe"
]

/** The utility roots whose values are colors, so `font-black` is a weight and `text-sm` a size, never a color. */
const COLOR_UTILITIES: ReadonlyArray<string> = [
	"bg",
	"text",
	"border",
	"border-t",
	"border-r",
	"border-b",
	"border-l",
	"border-x",
	"border-y",
	"outline",
	"ring",
	"ring-offset",
	"shadow",
	"inset-shadow",
	"drop-shadow",
	"accent",
	"caret",
	"fill",
	"stroke",
	"decoration",
	"divide",
	"from",
	"via",
	"to"
]

/** The variants whose arbitrary values select structure (an attribute, a relation, a position) rather than set a
 * breakpoint or a support query, and the compound variants that may wrap them. */
const STRUCTURAL_VARIANTS: ReadonlyArray<string> = [
	"aria",
	"data",
	"has",
	"not",
	"in",
	"nth",
	"nth-last",
	"nth-of-type",
	"nth-last-of-type"
]

const COMPOUND_VARIANTS: ReadonlyArray<string> = ["group", "peer", "has", "not", "in"]

const alternation = (words: ReadonlyArray<string>): string => Arr.join(words, "|")

/** A bracketed or parenthesized group of a class, read whole, so a colon inside it ends no variant. */
const GROUP = String.raw`\[[^\]]*\]|\([^)]*\)`

/** One variant with its colon: `hover:`, `data-[size=sm]:`, `[&_svg]:`. */
const VARIANT = String.raw`(?:[^:\[\]()\s]|${GROUP})+:`

/** Every variant of a class and the important mark before its utility. */
const PREFIX = String.raw`^(?:${VARIANT})*!?`

/** A utility's root and the dash before its value, `bg-` or `-mt-`. */
const ROOT = String.raw`-?[a-z][\w-]*?-`

/** What may follow a value: a modifier and the important mark, up to the class's end. */
const SUFFIX = String.raw`(?:\/[^\s:]*)?!?$`

/** A palette color by name: a shade of one of Tailwind's palette colors, or black or white. */
const PALETTE_COLOR = String.raw`(?:(?:${alternation(PALETTE)})-\d+|black|white)`

const ARBITRARY_MESSAGE =
	"This class takes an arbitrary value, not a theme token. Use the theme's named utility (p-4, rounded-md, bg-primary), a named variant, or var(--token) naming a theme variable."

const PALETTE_MESSAGE =
	"This class names Tailwind's palette, not a design token. Use a theme color token, such as primary or muted-foreground."

/** A pattern no-restricted-classes refuses a class by, with what it says. */
type Restriction = Readonly<{ pattern: string; message: string }>

/**
 * A class takes its values from the theme: an arbitrary property (`[padding:37px]`), an arbitrary value that is not
 * exactly one variable (`bg-[red]`, `text-[13px]`, `rounded-[min(var(--radius-md),10px)]`, while `rounded-[var(--radius-md)]`,
 * `text-[length:var(--text-sm)]` and `bg-(--color-primary)` pass), a variable of Tailwind's palette
 * (`bg-[var(--color-blue-500)]`), an arbitrary modifier (`bg-primary/[0.5]`), an arbitrary breakpoint or query
 * (`min-[800px]:`, `supports-[display:grid]:`) and a structural variant that reaches for a variable or a query
 * (`data-[size=var(--x)]:`) are refused. A structural variant (`data-[size=sm]:`, `has-data-[slot=x]:`, `[&_svg]:`)
 * sets no value, so it passes. Whether a variable names a theme token is no longer read: that needs the design system's
 * variables, which a pattern does not see.
 */
const ARBITRARY: ReadonlyArray<Restriction> = Arr.map(
	[
		String.raw`${PREFIX}\[[^\]]*\]!?$`,
		String.raw`${PREFIX}${ROOT}\[(?!(?:[a-z-]+:)?var\(--[\w-]+\)\])[^\]]*\]${SUFFIX}`,
		String.raw`${PREFIX}${ROOT}\((?!(?:[a-z-]+:)?--[\w-]+\))[^)]*\)${SUFFIX}`,
		String.raw`${PREFIX}${ROOT}(?:\[(?:[a-z-]+:)?var\(--color-${PALETTE_COLOR}\)\]|\((?:[a-z-]+:)?--color-${PALETTE_COLOR}\))${SUFFIX}`,
		String.raw`^\S*\/[\[(]`,
		String.raw`^(?:${VARIANT})*?(?!(?:(?:${alternation(COMPOUND_VARIANTS)})(?:\/[\w-]+)?-)*(?:${alternation(STRUCTURAL_VARIANTS)})-\[)[a-z][\w-]*-\[[^\]]*\](?:\/[\w-]+)?:`,
		String.raw`^(?:${VARIANT})*?[^:\[\]()\s]*\[[^\]]*(?:var\(|@)[^\]]*\](?:\/[\w-]+)?:`
	],
	(pattern) => ({ pattern, message: ARBITRARY_MESSAGE })
)

/** Color utilities name the theme's tokens: `bg-blue-500` and `text-gray-700/50` (Tailwind's palette) are refused;
 * `bg-primary` and `text-muted-foreground` are tokens. */
const PALETTE_COLORS: ReadonlyArray<Restriction> = [
	{
		pattern: String.raw`${PREFIX}(?:${alternation(COLOR_UTILITIES)})-${PALETTE_COLOR}${SUFFIX}`,
		message: PALETTE_MESSAGE
	}
]

/** Where the plugin reads class strings besides its defaults: a component's `*ClassName` slot, a classList call, and
 * a variable named for classes. */
const SELECTORS = {
	extends: [
		{ kind: "attribute", name: "^[a-z][A-Za-z]*ClassName$", match: [{ type: "strings" }] },
		{
			kind: "callee",
			path: String.raw`^.+\.classList\.(?:add|remove|replace|toggle)$`,
			match: [{ type: "strings" }]
		},
		{
			kind: "variable",
			name: "^[a-z][A-Za-z]*(?:Class|ClassName|Classes)$",
			match: [{ type: "strings" }]
		}
	]
} as const

/** Where one app's classes are read from: the app's package root, from which Tailwind resolves, and its entry
 * stylesheet, both absolute. */
export type ClassSource = Readonly<{ cwd: string; entryPoint: string }>

/** The plugin rules the class rules run. */
const PLUGIN_RULES: ReadonlyArray<string> = [
	"no-unknown-classes",
	"no-conflicting-classes",
	"no-duplicate-classes",
	"no-concatenated-classes",
	"no-restricted-classes"
]

/** The style rule ids the class rules hold, each with the plugin rules or the restrictions that hold it. */
const HELD_BY = {
	"no-unresolved-class": { rules: ["no-unknown-classes"], restrictions: [] },
	"no-conflicting-classes": {
		rules: ["no-conflicting-classes", "no-duplicate-classes"],
		restrictions: []
	},
	"no-dynamic-class": { rules: ["no-concatenated-classes"], restrictions: [] },
	"no-arbitrary-value": { rules: [], restrictions: ARBITRARY },
	"no-invalid-color": { rules: [], restrictions: PALETTE_COLORS }
} as const satisfies Readonly<
	Record<
		string,
		Readonly<{ rules: ReadonlyArray<string>; restrictions: ReadonlyArray<Restriction> }>
	>
>

/** A style rule id the class rules hold. */
export type ClassRuleId = keyof typeof HELD_BY

export const CLASS_RULE_IDS: ReadonlyArray<ClassRuleId> = [
	"no-unresolved-class",
	"no-conflicting-classes",
	"no-dynamic-class",
	"no-arbitrary-value",
	"no-invalid-color"
]

/** One plugin rule as an app runs it: with its options, or off. */
export type ClassSetting = Readonly<{
	rule: string
	options: Option.Option<Readonly<Record<string, unknown>>>
}>

/** Whether a style rule id is held, in part or whole, by a plugin rule. */
const holds = (id: ClassRuleId, rule: string): boolean =>
	Arr.contains<string>(HELD_BY[id].rules, rule) ||
	(rule === "no-restricted-classes" && Arr.isReadonlyArrayNonEmpty(HELD_BY[id].restrictions))

/**
 * Every plugin rule as an app runs it once the style rule ids in `lifted` are lifted: a rule runs, with the app's
 * source, while an id it holds is not lifted, and no-restricted-classes refuses the restrictions of the ids not lifted.
 * `lifted` empty is the app's own block.
 */
export const classSettingsOf = (
	source: ClassSource,
	lifted: ReadonlyArray<ClassRuleId>
): ReadonlyArray<ClassSetting> => {
	const kept = Arr.filter(CLASS_RULE_IDS, (id) => !Arr.contains(lifted, id))
	const common = { cwd: source.cwd, entryPoint: source.entryPoint, selectors: SELECTORS }
	const restrictions = Arr.flatMap(
		kept,
		(id): ReadonlyArray<Restriction> => HELD_BY[id].restrictions
	)
	return Arr.map(PLUGIN_RULES, (rule): ClassSetting => {
		if (!Arr.some(kept, (id) => holds(id, rule))) {
			return { rule, options: Option.none() }
		}
		return rule === "no-restricted-classes"
			? { rule, options: Option.some({ ...common, restrict: restrictions }) }
			: { rule, options: Option.some(common) }
	})
}

/** What a style exception for `id` sets on its files: each plugin rule that holds the id, as it runs with the id
 * lifted. */
export const liftedSettingsOf = (
	source: ClassSource,
	id: ClassRuleId
): ReadonlyArray<ClassSetting> =>
	Arr.filter(classSettingsOf(source, [id]), (setting) => holds(id, setting.rule))
