import { Array as Arr, Schema, String as Str } from "effect"
import { OwnStyleRules } from "#style/own.ts"

/** A file or directory the options name, repository-relative, as `#style/paths.ts` matches it. */
const RepositoryPath = Schema.NonEmptyString

/** A directory the options name, repository-relative and ending in "/", as `#style/paths.ts` matches it. */
const DirectoryPath = RepositoryPath.check(
	Schema.makeFilter((path: string) => Str.endsWith("/")(path), {
		expected: 'a repository-relative directory ending in "/"'
	})
)

/** One CSS declaration, exactly as a stylesheet must write it. */
const Declaration = Schema.Struct({ property: Schema.NonEmptyString, value: Schema.String })

/** An `@utility` a scoped sheet may declare, with exactly its declarations. */
const Utility = Schema.Struct({
	name: Schema.NonEmptyString,
	declarations: Schema.Array(Declaration)
})

/** An `@page` a scoped sheet may declare, with exactly its declarations and the margin boxes it claims empty. */
const Page = Schema.Struct({
	name: Schema.NonEmptyString,
	declarations: Schema.Array(Declaration),
	emptyBoxes: Schema.Array(Schema.NonEmptyString)
})

/** A stylesheet besides the app's own: the one home of its scope's tokens (`--<scope>-*`, `--color-<scope>-*` and
 * `<theme namespace>-<scope>-*`), with the utilities and pages it alone may declare. It imports nothing. */
const ScopedSheet = Schema.Struct({
	path: RepositoryPath,
	scope: Schema.NonEmptyString,
	utilities: Schema.Array(Utility),
	pages: Schema.Array(Page)
})

/**
 * A library theme: the stylesheets in one directory of the app that draw one library's markup, which the app renders
 * and does not write (a library's server-rendered parts, whose elements carry the library's hooks and never the app's
 * classes), so no utility reaches it. Every stylesheet under the directory is the theme's: the entry, which holds only
 * comments and its parts' imports, each part in the directory once, as `@import "./<part>.css";`, and the parts, whose
 * top level holds only comments and `@layer <layer> { … }` blocks of style rules, conditioned by `@media`, `@supports`
 * and `@container` and nested as needed. The app's stylesheet alone imports the entry, exactly once, as its layered
 * import into the layer, so the theme styles over Tailwind's reset and the app's classes override it.
 *
 * The theme draws the library's markup alone, never the app's: every selector styles an element that carries the
 * anchor, an attribute selector on the library's hook whose value begins with its prefix (`[data-slot="plate-…"]`,
 * `[data-slot^="plate-"]`), or one inside such an element. A `:root` rule, the one exception, holds only the theme's
 * tokens. Every custom property it declares lies under one of its token prefixes, which only it declares; the app's
 * shared tokens, `--color-*` and Tailwind's theme namespaces stay the app's stylesheet's, as do fonts, animations,
 * `@theme` and utilities. Its values are free, `!important` among them: a library such as UI SDK writes inline styles
 * that a theme must sometimes override.
 */
const LibraryTheme = Schema.Struct({
	/** The theme's directory: every stylesheet under it is the theme's. */
	directory: DirectoryPath,
	/** The entry's file name in the directory, such as "theme.css". */
	entry: Schema.NonEmptyString,
	/** The layer the app's stylesheet imports the entry into, and every part writes its rules in, such as "plate". */
	layer: Schema.NonEmptyString,
	/** The library's hook: the attribute its markup carries, and the prefix every value of the library's own begins with,
	 * such as `data-slot` and "plate-". */
	anchor: Schema.Struct({ attribute: Schema.NonEmptyString, prefix: Schema.NonEmptyString }),
	/** The prefixes of the custom properties the theme declares, such as "--plate-". */
	tokens: Schema.Array(Schema.NonEmptyString)
})

/** The stylesheet contract: what the app's stylesheet (components.json's tailwind.css) and the scoped sheets may
 * hold, the passthrough sheets that hold one fixed text, and the library themes that draw one library's markup. Any
 * other stylesheet is a second theme or component CSS owner. */
const StylesheetOptions = Schema.Struct({
	/** The modules the app's stylesheet may `@import`, as written between the quotes. */
	imports: Schema.Array(Schema.NonEmptyString),
	/** The modules the app's stylesheet imports into a cascade layer of their own, each as written between the quotes
	 * with its layer, in the order their layers stand. One `@layer` statement ahead of every import puts those layers
	 * after Tailwind's base and before its components and utilities, so a module styles over the reset and the app's
	 * classes override it; without that statement its layer would follow the utilities. */
	layeredImports: Schema.Array(
		Schema.Struct({ module: Schema.NonEmptyString, layer: Schema.NonEmptyString })
	),
	/** The layers a library writes into at run time, as UI SDK writes its reset into `ui-sdk` once a component mounts,
	 * which the `@layer` statement names ahead of Tailwind's, in this order: a layer the page has not named when its
	 * first rule arrives follows every other, so unnamed it would override the app's utilities and the layered
	 * imports' rules. */
	runtimeLayers: Schema.Array(Schema.NonEmptyString),
	/** The `@custom-variant` rules any sheet may declare, as written after the at-rule's name. */
	customVariants: Schema.Array(Schema.NonEmptyString),
	/** The selectors whose top-level rules hold the palette, each with the color-scheme it may declare. */
	themeSelectors: Schema.Array(
		Schema.Struct({ selector: Schema.NonEmptyString, scheme: Schema.Literals(["light", "dark"]) })
	),
	/** The declarations `:root` may hold besides the palette, exactly. */
	rootValues: Schema.Array(Declaration),
	/** The rules of `@layer base`: each selector list, comma-separated, with exactly the `@apply` it holds. */
	baseRules: Schema.Array(
		Schema.Struct({ selector: Schema.NonEmptyString, apply: Schema.NonEmptyString })
	),
	/** The `@theme` declarations besides the palette's `--color-<name>: var(--<name>)` aliases, exactly. */
	themeAliases: Schema.Array(Declaration),
	scopedSheets: Schema.Array(ScopedSheet),
	/** Stylesheets that hold exactly this text, trimmed: an isolated preview that only imports the theme. */
	passthrough: Schema.Array(Schema.Struct({ path: RepositoryPath, text: Schema.NonEmptyString })),
	/** The library themes, each of whose entries the layered imports list, relative to the app's stylesheet, with its
	 * layer. */
	libraryThemes: Schema.Array(LibraryTheme)
})

/** An inline style operand one file may use: an expression, as written up to whitespace, or any member of a module's
 * named export, a property chain rooted at its import. */
const Operand = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("expression"), text: Schema.NonEmptyString }),
	Schema.Struct({
		kind: Schema.Literal("export"),
		module: Schema.NonEmptyString,
		name: Schema.NonEmptyString
	})
])

/** The doors the markup rule (devtools/markup, which oxlint runs on the app's files) leaves open, each at the files
 * that own it. */
export const MarkupOptions = Schema.Struct({
	/** The inline `style` objects a file may write: each CSS property with the operands it may hold, measured
	 * layout or authored motion values, never static styling. */
	measuredStyles: Schema.Array(
		Schema.Struct({
			path: RepositoryPath,
			properties: Schema.Record(Schema.String, Schema.Array(Operand))
		})
	),
	/** The function a file declares that may merge a component's base style with its overlay's,
	 * `style: { ...base.style, ...overlay.style }`, and whose result a JSX spread may forward. */
	styleBridges: Schema.Array(
		Schema.Struct({
			path: RepositoryPath,
			function: Schema.NonEmptyString,
			base: Schema.NonEmptyString,
			overlay: Schema.NonEmptyString
		})
	),
	/** The files that may interpolate HTML into a template literal: bytes no React tree renders. */
	htmlTemplates: Schema.Array(RepositoryPath),
	/** The files that may construct a CSSStyleSheet and fill it with replaceSync. */
	stylesheetConstructors: Schema.Array(RepositoryPath)
})

/**
 * One Tailwind app's own names for the style rules that need them, and the repository's own style rules it runs.
 * Every field is required: an app where a rule has nothing to guard states that with an empty list, so the rule is
 * inert there.
 */
const AppStyleOptions = Schema.Struct({
	/** The stylesheet components.json names in tailwind.css, repository-relative: the entry of the design system the
	 * class rules read. The style linter holds it to components.json. */
	entryPoint: RepositoryPath,
	/** The directory components.json's aliases.ui resolves to, repository-relative and ending in "/": shadcn's
	 * vendored components, reinstalled from upstream and never edited, which the app's rules leave alone. The style
	 * linter holds it to components.json. */
	vendored: RepositoryPath,
	/** The app's exceptions: files where a rule's reports are not the repository's to fix, by the rule's id, a shared
	 * rule's or one of the app's own rules'. Exceptions live here, never inline: the preset turns an oxlint rule off on
	 * them, and the style linter drops its own findings there. */
	exceptions: Schema.Array(
		Schema.Struct({ rule: Schema.NonEmptyString, files: Schema.Array(RepositoryPath) })
	),
	stylesheet: StylesheetOptions,
	markup: MarkupOptions,
	/** The repository's own style rules the app runs, as `ownStyleRules` makes them. */
	own: Schema.Array(Schema.instanceOf(OwnStyleRules))
})

export type AppStyleOptions = typeof AppStyleOptions.Type

/** The web pack's options: the repository's root, absolute (`import.meta.dirname` of a module at the root, such as
 * web.ts), which the class rules resolve each app from wherever oxlint runs and the style linter holds to the
 * repository it runs in, and each Tailwind app's style options, by the app's package root relative to the repository's
 * root. A repository without a Tailwind app has no web pack. */
export const WebOptions = Schema.Struct({
	root: Schema.NonEmptyString,
	apps: Schema.Record(Schema.String, AppStyleOptions)
})

export type WebOptions = typeof WebOptions.Type

/** What the style linter's shared rules read of an app's options: the stylesheet contract. */
export type RuleOptions = Pick<AppStyleOptions, "stylesheet">

export type StylesheetOption = (typeof StylesheetOptions)["Type"]

export type DeclarationOption = (typeof Declaration)["Type"]

export type ScopedSheetOption = (typeof ScopedSheet)["Type"]

export type LibraryThemeOption = (typeof LibraryTheme)["Type"]

export type MarkupOption = (typeof MarkupOptions)["Type"]

export type OperandOption = (typeof Operand)["Type"]

/** A library theme's entry, by its repository-relative path. */
export const libraryEntryOf = (theme: LibraryThemeOption): string =>
	`${theme.directory}${theme.entry}`

/** Every path the stylesheet contract names, for the check that each names a file the run knows: a library theme's
 * directory, and its entry, among them. */
export const stylesheetPathsOf = (options: RuleOptions): ReadonlyArray<string> => [
	...Arr.map(options.stylesheet.scopedSheets, (sheet) => sheet.path),
	...Arr.map(options.stylesheet.passthrough, (sheet) => sheet.path),
	...Arr.flatMap(options.stylesheet.libraryThemes, (theme) => [
		theme.directory,
		libraryEntryOf(theme)
	])
]

/** Every path an app's options name, the markup rule's doors and the exceptions' files among them: oxlint does not
 * notice a path that names no file, so the style linter checks them all. The vendored directory, whose files it does
 * not read, it holds to components.json instead. */
export const appPathsOf = (options: AppStyleOptions): ReadonlyArray<string> => [
	options.entryPoint,
	...stylesheetPathsOf(options),
	...Arr.map(options.markup.measuredStyles, (entry) => entry.path),
	...Arr.map(options.markup.styleBridges, (bridge) => bridge.path),
	...options.markup.htmlTemplates,
	...options.markup.stylesheetConstructors,
	...Arr.flatMap(options.exceptions, (exception) => exception.files)
]

const FIXTURES = "src/style/fixtures"

const fixtureSheet = (path: string): ScopedSheetOption => ({
	path,
	scope: "report",
	utilities: [
		{
			name: "touch-callout-none",
			declarations: [{ property: "-webkit-touch-callout", value: "none" }]
		}
	],
	pages: [
		{
			name: "print",
			declarations: [{ property: "size", value: "letter" }],
			emptyBoxes: ["top-left"]
		}
	]
})

const PASSTHROUGH_TEXT = '@import "../../support/theme.css";'

/** The options the stylesheet fixtures run under: names that point into the rule's own fixture directory. The one layered
 * import is proven by the app sheets under stylesheet/app/layered/ and stylesheet/app/unordered/, and refused in a
 * scoped sheet under stylesheet/scoped/layered/. They name no runtime layer, RUNTIME_FIXTURE_OPTIONS name one, and no
 * library theme, which LIBRARY_FIXTURE_OPTIONS name. */
export const FIXTURE_OPTIONS: RuleOptions = {
	stylesheet: {
		imports: ["tailwindcss"],
		layeredImports: [{ module: "./module.css", layer: "module" }],
		runtimeLayers: [],
		customVariants: ["dark (&:is(.dark *))"],
		themeSelectors: [
			{ selector: ":root", scheme: "light" },
			{ selector: ".dark", scheme: "dark" }
		],
		rootValues: [{ property: "--radius", value: "0.625rem" }],
		baseRules: [
			{ selector: "*", apply: "border-border" },
			{ selector: 'button:not(:disabled), [role="button"]:not(:disabled)', apply: "cursor-pointer" }
		],
		themeAliases: [
			{ property: "--radius-lg", value: "var(--radius)" },
			{ property: "--spacing-report-gap", value: "1.5rem" }
		],
		scopedSheets: [
			fixtureSheet(`${FIXTURES}/stylesheet/scoped/violating.css`),
			fixtureSheet(`${FIXTURES}/stylesheet/scoped/clean.css`),
			fixtureSheet(`${FIXTURES}/stylesheet/scoped/layered/violating.css`),
			fixtureSheet(`${FIXTURES}/stylesheet/scoped/layered/clean.css`)
		],
		passthrough: [
			{ path: `${FIXTURES}/stylesheet/passthrough/violating.css`, text: PASSTHROUGH_TEXT },
			{ path: `${FIXTURES}/stylesheet/passthrough/clean.css`, text: PASSTHROUGH_TEXT },
			{ path: `${FIXTURES}/stylesheet/unnamed/clean.css`, text: PASSTHROUGH_TEXT }
		],
		libraryThemes: []
	}
}

/** The fixtures' options with one runtime layer, which the app sheets under stylesheet/app/runtime/ order first. */
export const RUNTIME_FIXTURE_OPTIONS: RuleOptions = {
	...FIXTURE_OPTIONS,
	stylesheet: { ...FIXTURE_OPTIONS.stylesheet, runtimeLayers: ["runtime"] }
}

const LIBRARY = `${FIXTURES}/stylesheet/library`

/**
 * The fixtures' options with two library themes, each in the directory of one case, whose two fixtures are the
 * theme's entry and a part: stylesheet/library/entry/ is the widget theme, whose entry is its violating fixture and
 * its clean fixture a part, beside dead.css, a part the entry never imports; stylesheet/library/part/ is the gadget
 * theme, whose entry is its clean fixture and its violating fixture its one part. The app sheets under
 * stylesheet/app/library/ import both entries, and the passthroughs under stylesheet/passthrough/library/, each its
 * text exactly, import one entry or none. The gadget theme's token prefixes reach under `--color-` and `--spacing-` on purpose, so its part proves that
 * the app's namespaces stay the app's even under a prefix of the theme's.
 */
export const LIBRARY_FIXTURE_OPTIONS: RuleOptions = {
	stylesheet: {
		...FIXTURE_OPTIONS.stylesheet,
		layeredImports: [
			...FIXTURE_OPTIONS.stylesheet.layeredImports,
			{ module: "../../library/entry/violating.css", layer: "widget" },
			{ module: "../../library/part/clean.css", layer: "gadget" }
		],
		passthrough: [
			...FIXTURE_OPTIONS.stylesheet.passthrough,
			{
				path: `${FIXTURES}/stylesheet/passthrough/library/violating.css`,
				text: '@import "../../library/part/clean.css"; /* // violation */'
			},
			{
				path: `${FIXTURES}/stylesheet/passthrough/library/clean.css`,
				text: '@import "../../app/library/clean.css";'
			}
		],
		libraryThemes: [
			{
				directory: `${LIBRARY}/entry/`,
				entry: "violating.css",
				layer: "widget",
				anchor: { attribute: "data-slot", prefix: "widget-" },
				tokens: ["--widget-", "--kit-"]
			},
			{
				directory: `${LIBRARY}/part/`,
				entry: "clean.css",
				layer: "gadget",
				anchor: { attribute: "data-part", prefix: "gadget-" },
				tokens: ["--gadget-", "--color-gadget-", "--spacing-gadget-"]
			}
		]
	}
}
