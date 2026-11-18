import { Data, type Effect } from "effect"
import type { DevtoolFailure } from "#shared/devtool.ts"
import type { Finding } from "#shared/finding.ts"
import type { CssNode, CssPosition } from "#style/css.ts"
import type { RuleOptions, StylesheetOption } from "#style/options.ts"

/**
 * A repository's own style rules: rules that exist for one repository only, which the style linter runs beside its own
 * for the apps whose options list them. They reach the run at three points: additions to the stylesheet contract of
 * the sheets they extend, theme namespaces of their own, and findings on the files they read. They read files as text,
 * through the run's reader, never through a TypeScript program; a rule that must read classes or syntax is an oxlint
 * rule of the repository's own plugin instead.
 */

export type { Finding } from "#shared/finding.ts"
export { DevtoolFailure } from "#shared/devtool.ts"
export type { AttributeSelector, CssNode, CssPosition } from "#style/css.ts"
export { attributeSelectorsOf, compact, parseStylesheet, selectorsOf, wordsOf } from "#style/css.ts"
export type {
	DeclarationOption,
	LibraryThemeOption,
	RuleOptions,
	StylesheetOption
} from "#style/options.ts"
export { isNamedBy } from "#style/paths.ts"

/** One file the run knows: its path, as the run holds it, and its text. */
export type SourceText = Readonly<{ file: string; text: string }>

/** The one file the run knows that a repository-relative path names; a path that names none or several is a broken
 * option. */
export type SourceReader = (path: string) => Effect.Effect<SourceText, DevtoolFailure>

/** What a repository's own style rules read once per run, before any of them reports: the reader of the files the run
 * knows, and the stylesheet options of the app they run for. */
export type OwnStyleInput = Readonly<{
	read: SourceReader
	stylesheet: StylesheetOption
}>

/** What a stylesheet check says, where. */
export type SheetReport = Readonly<{ at: CssPosition; message: string }>

/** One declaration of a stylesheet, where it stands. */
export type SheetDeclaration = Extract<CssNode, { kind: "declaration" }>

/**
 * What a repository's own rules add to the stylesheet contract of one sheet, which the options give a role. The sheet
 * may hold these at-rules at its top level besides the contract's, matched by name and by params up to whitespace,
 * and the declarations directly inside them are the rules' to check. When the sheet is a scoped sheet, the theme
 * tokens of its scope (`<namespace>-<scope>-*` inside `@theme`, colors aside) are the rules' to check too: the
 * contract's theme aliases do not hold them, and the engine hands them over as `tokens`. A library theme's sheet takes
 * the rules' reports and never their at-rules, since its contract is its library's hooks alone. The reports are what
 * the rules say over the sheet's parsed nodes; they report under the stylesheet rule.
 */
export type SheetExtension = Readonly<{
	/** The sheet, by repository-relative path, or every sheet under a directory, by one ending in "/". */
	sheet: string
	atRules: ReadonlyArray<Readonly<{ name: string; params: string }>>
	reports: (
		sheet: Readonly<{ nodes: ReadonlyArray<CssNode>; tokens: ReadonlyArray<SheetDeclaration> }>
	) => ReadonlyArray<SheetReport>
}>

/** What a repository's own style rules run with, once they have read their files: the theme namespaces their tokens
 * live under besides Tailwind's (a scope's tokens under them belong to its sheet), what they add to the stylesheet
 * contract, and their findings on the files they read, each under one of their rule ids. */
export type OwnStyleRun = Readonly<{
	namespaces: ReadonlyArray<string>
	stylesheets: ReadonlyArray<SheetExtension>
	findings: ReadonlyArray<Finding>
}>

/** A repository's own style rules bound to the options they run under: every repository-relative path the options
 * name (each must name a file the run knows; files outside the app that they name are reported on too), and the step
 * that reads them and returns what the rules run with. */
export type OwnStyleSet = Readonly<{
	paths: ReadonlyArray<string>
	prepare: (input: OwnStyleInput) => Effect.Effect<OwnStyleRun, DevtoolFailure>
}>

/** A fixture case beyond an id's own directory: a directory, relative to the fixtures' directory, holding a clean
 * fixture and a violating one, and the rule they prove (one of the set's ids, or the stylesheet rule it extends). */
export type FixtureCase = Readonly<{ directory: string; rule: string }>

/**
 * A repository's own style rules, proven as the shared ones are: their name (for the output), the ids they report
 * under, the rules bound to the repository's names for them and to their fixtures' names, and their fixtures. The
 * fixtures' directory holds one `<id>/violating` and `<id>/clean` fixture (`.tsx`, `.css` for the stylesheet rule) for
 * every id, and the fixtures of the set's other cases, such as the stylesheet rule it extends; a sheet under
 * `stylesheet/app/` is read as the app's own. The options are bound here, so the engine never sees their type.
 */
export class OwnStyleRules extends Data.Class<{
	readonly name: string
	readonly ids: ReadonlyArray<string>
	readonly set: OwnStyleSet
	readonly fixtureSet: OwnStyleSet
	readonly fixtures: Readonly<{
		directory: string
		style: RuleOptions
		cases: ReadonlyArray<FixtureCase>
	}>
}> {}

/** A repository's own style rules: their name, ids and rules, the repository's names for them, and their fixtures'
 * directory, the stylesheet options their fixtures run under, their names, and their other cases. */
export const ownStyleRules = <O>(
	input: Readonly<{
		name: string
		ids: ReadonlyArray<string>
		rules: (options: O) => OwnStyleSet
		options: O
		fixtures: Readonly<{
			directory: string
			style: RuleOptions
			options: O
			cases: ReadonlyArray<FixtureCase>
		}>
	}>
): OwnStyleRules =>
	new OwnStyleRules({
		name: input.name,
		ids: input.ids,
		set: input.rules(input.options),
		fixtureSet: input.rules(input.fixtures.options),
		fixtures: {
			directory: input.fixtures.directory,
			style: input.fixtures.style,
			cases: input.fixtures.cases
		}
	})
