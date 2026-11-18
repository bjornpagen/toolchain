import { Array as Arr, Option, Result, String as Str } from "effect"
import {
	type AttributeSelector,
	type CssNode,
	type CssPosition,
	type SelectorStep,
	selectorsOf,
	simpleSelectorsOf,
	stepsOf
} from "#style/css.ts"
import type { LibraryThemeOption } from "#style/options.ts"
import type { SheetReport } from "#style/own.ts"
import { importedFile, moduleOf } from "#style/paths.ts"

/**
 * The contract of a library theme's sheets: an entry that imports its parts and nothing else, and parts that draw the
 * library's markup through its hooks alone, in its layer. The app's stylesheet alone imports the entry, once, into that
 * layer. What the contract checks is the option's doc (`LibraryTheme` in `#style/options.ts`); each check reports in
 * the theme's name.
 */

/** A library theme as the run finds it: its options, its entry, and its parts, every other stylesheet under its
 * directory, each as the run holds it. */
export type LibraryTheme = Readonly<{
	option: LibraryThemeOption
	entry: string
	parts: ReadonlyArray<string>
}>

const TOP: CssPosition = { line: 1, column: 1 }

type AtRule = Extract<CssNode, { kind: "at-rule" }>

type Rule = Extract<CssNode, { kind: "rule" }>

const nameOf = (theme: LibraryTheme): string => `Library theme ${theme.option.directory}`

const isImport = (node: CssNode): node is AtRule =>
	node.kind === "at-rule" && node.name === "import"

/** The module an `@import` names: between its quotes, or inside its `url()`, quoted or not. */
const importedModuleOf = (params: string): Option.Option<string> => {
	const inUrl = Str.startsWith("url(")(params)
	const operand = Str.trimStart(inUrl ? Str.slice("url(".length)(params) : params)
	const quoted = Option.flatMap(
		Option.filter(Str.charAt(0)(operand), (character) => character === '"' || character === "'"),
		(quote) =>
			Option.map(Str.indexOf(quote)(Str.slice(1)(operand)), (close) =>
				Str.slice(1, close + 1)(operand)
			)
	)
	return inUrl
		? Option.orElse(quoted, () =>
				Option.map(Str.indexOf(")")(operand), (close) => Str.trim(Str.slice(0, close)(operand)))
			)
		: quoted
}

/** Whether an `@import` names a library theme's entry: its module, beside the importing file, is the entry. */
const importsEntry =
	(file: string, theme: LibraryTheme) =>
	(node: AtRule): boolean =>
		Option.exists(
			Option.flatMap(importedModuleOf(node.params), (module) => importedFile({ file, module })),
			(imported) => imported === theme.entry
		)

/** The import the app's stylesheet enters a library theme by: its entry, beside the app's stylesheet, into its layer. */
const enteringImportOf = (file: string, theme: LibraryTheme): string =>
	`"${moduleOf({ file, target: theme.entry })}" layer(${theme.option.layer})`

/**
 * What the contract says about the app's stylesheet for each library theme: it imports the entry exactly once, as the
 * layered import into the theme's layer (which its layered imports list, in their layer order), and in no other way.
 * A second import, or one in another form or layer, is reported where it stands; no import in the one form is reported
 * at the top.
 */
export const appImportReports = (
	input: Readonly<{
		file: string
		nodes: ReadonlyArray<CssNode>
		themes: ReadonlyArray<LibraryTheme>
	}>
): ReadonlyArray<SheetReport> =>
	Arr.flatMap(input.themes, (theme) => {
		const entering = enteringImportOf(input.file, theme)
		const imports = Arr.filter(Arr.filter(input.nodes, isImport), importsEntry(input.file, theme))
		const first = Arr.findFirst(imports, (node) => node.params === entering)
		const message = `${nameOf(theme)} enters once, through the app's stylesheet alone: @import ${entering};`
		const strays = Arr.filterMap(imports, (node) =>
			Option.contains(first, node) ? Result.failVoid : Result.succeed({ at: node.at, message })
		)
		return Option.isSome(first) ? strays : [{ at: TOP, message }, ...strays]
	})

/** What the contract says about a sheet that is neither the app's stylesheet nor a library theme's: it imports no
 * library theme's entry. */
export const strayImportReports = (
	input: Readonly<{
		file: string
		nodes: ReadonlyArray<CssNode>
		themes: ReadonlyArray<LibraryTheme>
	}>
): ReadonlyArray<SheetReport> =>
	Arr.flatMap(input.themes, (theme) =>
		Arr.map(
			Arr.filter(Arr.filter(input.nodes, isImport), importsEntry(input.file, theme)),
			(node) => ({
				at: node.at,
				message: `${nameOf(theme)} enters only through the app's stylesheet, never through another sheet.`
			})
		)
	)

/** The module the entry imports a part by, when the part lies in the entry's directory itself: `./<part>.css`. */
const partModuleOf = (theme: LibraryTheme, part: string): Option.Option<string> => {
	const module = moduleOf({ file: theme.entry, target: part })
	return Str.includes("/")(Str.slice("./".length)(module)) ? Option.none() : Option.some(module)
}

/**
 * The entry's contract: it holds only comments and plain imports of the parts in its directory, `@import
 * "./<part>.css";`, each part exactly once, so no part is dead and none enters twice or outside the theme's layer. A
 * node of any other kind is reported where it stands, and not looked into; a part it never imports, at the top.
 */
export const entryReports = (
	input: Readonly<{ theme: LibraryTheme; nodes: ReadonlyArray<CssNode> }>
): ReadonlyArray<SheetReport> => {
	const { theme, nodes } = input
	const plain: ReadonlyMap<string, string> = new Map(
		Arr.filterMap(theme.parts, (part) =>
			Option.match(partModuleOf(theme, part), {
				onNone: () => Result.failVoid,
				onSome: (module): Result.Result<readonly [string, string], void> =>
					Result.succeed([`"${module}"`, part])
			})
		)
	)
	const imported = Arr.filterMap(nodes, (node, index) =>
		isImport(node) &&
		plain.has(node.params) &&
		!Arr.some(Arr.take(nodes, index), (before) => isImport(before) && before.params === node.params)
			? Result.succeed(node)
			: Result.failVoid
	)
	const strays = Arr.filterMap(nodes, (node) => {
		if (Arr.contains(imported, node)) {
			return Result.failVoid
		}
		return Result.succeed({
			at: node.at,
			message: isImport(node)
				? `${nameOf(theme)}'s entry imports each part in its directory once, as @import "./<part>.css";`
				: `${nameOf(theme)}'s entry holds only comments and its parts' imports, @import "./<part>.css";`
		})
	})
	const dead = Arr.filterMap(theme.parts, (part) =>
		Arr.some(imported, (node) => plain.get(node.params) === part)
			? Result.failVoid
			: Result.succeed({
					at: TOP,
					message: `${nameOf(theme)}'s entry imports every part in its directory, and not ${moduleOf({ file: theme.entry, target: part })}.`
				})
	)
	return [...dead, ...strays]
}

/** Whether an attribute selector is the library's hook: its attribute, equal to or beginning with a value of the
 * library's own (`=` or `^=`, no case flag), which begins with the anchor's prefix. */
const isAnchor = (theme: LibraryTheme, attribute: AttributeSelector): boolean =>
	attribute.name === theme.option.anchor.attribute &&
	Option.exists(
		attribute.match,
		(match) =>
			(match.operator === "=" || match.operator === "^=") &&
			Str.startsWith(theme.option.anchor.prefix)(match.value) &&
			Option.isNone(match.flag)
	)

/** Where a selector stands: whether it is nested in a style rule, whose selector `&` names, and whether it is the
 * nested rule's own selector, which reads as `& <selector>` when it names no `&`. */
type Nesting = Readonly<{ nested: boolean; implicit: boolean }>

/** Whether a compound selects only the library's markup: it holds the anchor, the nesting selector of a rule nested in
 * another, or an `:is()` or `:where()` whose every selector is anchored. `:not()` and `:has()` never anchor: one selects
 * what lacks the hook, the other what holds it below. */
const isAnchoredCompound = (theme: LibraryTheme, compound: string, nesting: Nesting): boolean =>
	Arr.some(simpleSelectorsOf(compound), (simple) => {
		switch (simple.kind) {
			case "attribute":
				return isAnchor(theme, simple.attribute)
			case "nesting":
				return nesting.nested
			case "pseudo":
				return (
					(simple.name === ":is" || simple.name === ":where") &&
					Option.exists(simple.argument, (argument) =>
						Arr.every(selectorsOf(argument), (selector) =>
							isAnchoredSelector(theme, selector, { nested: nesting.nested, implicit: false })
						)
					)
				)
			case "other":
				return false
		}
	})

const isInto = (step: SelectorStep): boolean =>
	Option.exists(
		step.combinator,
		(combinator) => combinator === "descendant" || combinator === "child"
	)

const namesNesting = (selector: string): boolean => Str.includes("&")(selector)

/**
 * Whether a complex selector selects only the library's markup: the compound it styles is anchored, or an anchored
 * compound before it steps into its own subtree (a descendant or child combinator), after which every step, a
 * sibling's too, stays inside that subtree. A step across to an anchored compound's sibling leaves it: the sibling of a
 * library's root may be the app's.
 */
const isAnchoredSelector = (theme: LibraryTheme, selector: string, nesting: Nesting): boolean => {
	const written = stepsOf(selector)
	const steps: ReadonlyArray<SelectorStep> =
		nesting.implicit && !namesNesting(selector)
			? [
					{ combinator: Option.none(), compound: "&" },
					...Arr.map(written, (step, index) =>
						index === 0 && Option.isNone(step.combinator)
							? { ...step, combinator: Option.some("descendant" as const) }
							: step
					)
				]
			: written
	return Arr.some(steps, (step, index) => {
		const isSubject = index === steps.length - 1
		return (
			isAnchoredCompound(theme, step.compound, nesting) &&
			(isSubject || Option.exists(Arr.get(steps, index + 1), isInto))
		)
	})
}

const ROOT_SELECTORS: ReadonlyArray<string> = [":root", ":where(:root)"]

/** The at-rules a part's layer holds besides style rules: conditions on the rules inside them. */
const CONDITIONS: ReadonlyArray<string> = ["media", "supports", "container"]

const isCustomProperty = (property: string): boolean => Str.startsWith("--")(property)

/** What a part's checks read: the theme, and the theme namespaces the app's stylesheet owns. */
type PartContext = Readonly<{ theme: LibraryTheme; namespaces: ReadonlyArray<string> }>

/** Where a node stands in the layer: in the style rule nearest it, if any. */
type Place = Readonly<{ rule: Option.Option<Rule> }>

const isRoot = (rule: Rule): boolean =>
	Arr.contains(ROOT_SELECTORS, Arr.join(selectorsOf(rule.selector), ", "))

/** A custom property the theme declares: under one of its token prefixes, and never `--color-*` or a theme namespace,
 * which the app's stylesheet owns. */
const tokenReports = (
	context: PartContext,
	node: Extract<CssNode, { kind: "declaration" }>
): ReadonlyArray<SheetReport> => {
	if (!isCustomProperty(node.property)) {
		return []
	}
	const shared = Arr.some(
		["--color", ...context.namespaces],
		(namespace) => node.property === namespace || Str.startsWith(`${namespace}-`)(node.property)
	)
	if (shared) {
		return [
			{
				at: node.at,
				message: `${nameOf(context.theme)} declares no --color-* or theme namespace token: the app's stylesheet owns them.`
			}
		]
	}
	return Arr.some(context.theme.option.tokens, (prefix) => Str.startsWith(prefix)(node.property))
		? []
		: [
				{
					at: node.at,
					message: `${nameOf(context.theme)} declares only its own tokens, under ${Arr.join(context.theme.option.tokens, " or ")}.`
				}
			]
}

/** What the contract says about one node inside a part's layer, and about the nodes inside it unless it is refused. */
const layerReports = (
	context: PartContext,
	node: CssNode,
	place: Place
): ReadonlyArray<SheetReport> => {
	const { theme } = context
	switch (node.kind) {
		case "declaration": {
			const outside = Option.isNone(place.rule)
				? [
						{
							at: node.at,
							message: `${nameOf(theme)} declares only inside its style rules.`
						}
					]
				: []
			const root = Option.exists(place.rule, isRoot) && !isCustomProperty(node.property)
			return [
				...outside,
				...(root
					? [
							{
								at: node.at,
								message: `${nameOf(theme)}'s :root rules hold only its custom properties.`
							}
						]
					: []),
				...tokenReports(context, node)
			]
		}
		case "at-rule":
			return Arr.contains(CONDITIONS, node.name)
				? Arr.flatMap(node.nodes, (child) => layerReports(context, child, place))
				: [
						{
							at: node.at,
							message: `${nameOf(theme)} holds only style rules, @media, @supports and @container in its layer; @${node.name} is not part of a library theme.`
						}
					]
		case "rule": {
			const nested = Option.isSome(place.rule)
			const inRoot = Option.exists(place.rule, isRoot)
			const root = !nested && isRoot(node)
			const unanchored = root
				? []
				: Arr.filter(
						selectorsOf(node.selector),
						(selector) => !isAnchoredSelector(theme, selector, { nested, implicit: nested })
					)
			const reports: ReadonlyArray<SheetReport> = [
				...(inRoot
					? [
							{
								at: node.at,
								message: `${nameOf(theme)}'s :root rules hold only its custom properties.`
							}
						]
					: []),
				...(Arr.isReadonlyArrayNonEmpty(unanchored)
					? [
							{
								at: node.at,
								message: `${nameOf(theme)} draws only its library's markup: every selector styles an element that carries [${theme.option.anchor.attribute}="${theme.option.anchor.prefix}…"] or [${theme.option.anchor.attribute}^="${theme.option.anchor.prefix}"], or one inside it (${Arr.join(unanchored, ", ")}).`
							}
						]
					: [])
			]
			return [
				...reports,
				...Arr.flatMap(node.nodes, (child) =>
					layerReports(context, child, { rule: Option.some(node) })
				)
			]
		}
	}
}

/**
 * A part's contract: its top level holds only comments and `@layer <layer> { … }` blocks in the theme's layer, and the
 * layer holds style rules, conditioned by `@media`, `@supports` and `@container` and nested as needed, whose selectors
 * draw the library's markup alone; the theme's tokens alone stand in a `:root` rule. Every other at-rule is refused, in
 * the layer and outside it: fonts, animations, the theme and utilities are the app's stylesheet's. A refused node is
 * reported where it stands, and not looked into.
 */
export const partReports = (
	input: Readonly<{
		theme: LibraryTheme
		namespaces: ReadonlyArray<string>
		nodes: ReadonlyArray<CssNode>
	}>
): ReadonlyArray<SheetReport> => {
	const context: PartContext = { theme: input.theme, namespaces: input.namespaces }
	const { layer } = input.theme.option
	return Arr.flatMap(input.nodes, (node) =>
		node.kind === "at-rule" &&
		node.name === "layer" &&
		node.params === layer &&
		Arr.isReadonlyArrayNonEmpty(node.nodes)
			? Arr.flatMap(node.nodes, (child) => layerReports(context, child, { rule: Option.none() }))
			: [
					{
						at: node.at,
						message: `${nameOf(input.theme)}'s parts hold only comments and @layer ${layer} { … } blocks at their top level.`
					}
				]
	)
}

/** Whether a file is one of a library theme's: its entry, or a stylesheet under its directory. */
export const isThemeSheet =
	(theme: LibraryTheme) =>
	(file: string): boolean =>
		file === theme.entry || Arr.contains(theme.parts, file)

/** Whether a custom property is a library theme's token, which only that theme declares. */
export const libraryOwnerOf = (
	themes: ReadonlyArray<LibraryThemeOption>,
	property: string
): Option.Option<Readonly<{ theme: LibraryThemeOption; prefix: string }>> =>
	Arr.findFirst(
		Arr.flatMap(themes, (theme) => Arr.map(theme.tokens, (prefix) => ({ theme, prefix }))),
		({ prefix }) => Str.startsWith(prefix)(property)
	)
