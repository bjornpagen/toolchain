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
 * layer; or, for a theme with a route sheet, the app's stylesheet imports its tokens part alone and the route sheet the
 * entry. What the contract checks is the option's doc (`LibraryTheme` and `RouteSheet` in `#style/options.ts`); each
 * check reports in the theme's name.
 */

/** A theme's route sheet as the run finds it: the route sheet and the tokens part, each as the run holds it, and the
 * base sheets the route sheet imports before the entry. */
export type Route = Readonly<{ sheet: string; tokens: string; base: ReadonlyArray<string> }>

/** A library theme as the run finds it: its options, its entry, its parts, every other stylesheet under its directory,
 * and its route sheet, if it has one, each as the run holds it. */
export type LibraryTheme = Readonly<{
	option: LibraryThemeOption
	entry: string
	parts: ReadonlyArray<string>
	route: Option.Option<Route>
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

/** The files a sheet enters a library theme by: its entry, and its tokens part where it has a route sheet. */
const doorsOf = (theme: LibraryTheme): ReadonlyArray<string> => [
	theme.entry,
	...Option.match(theme.route, { onNone: () => [], onSome: (route) => [route.tokens] })
]

/** Whether an `@import` enters a library theme: its module, beside the importing file, is the theme's entry or its
 * tokens part. */
const importsTheme =
	(file: string, theme: LibraryTheme) =>
	(node: AtRule): boolean =>
		Option.exists(
			Option.flatMap(importedModuleOf(node.params), (module) => importedFile({ file, module })),
			(imported) => Arr.contains(doorsOf(theme), imported)
		)

/** The layered import of a file into a library theme's layer, beside the importing file. */
const layeredImportOf = (file: string, theme: LibraryTheme, target: string): string =>
	`"${moduleOf({ file, target })}" layer(${theme.option.layer})`

/** The import the app's stylesheet enters a library theme by: its entry, beside the app's stylesheet, into its layer;
 * its tokens part instead, where the theme has a route sheet. */
const enteringImportOf = (file: string, theme: LibraryTheme): string =>
	layeredImportOf(
		file,
		theme,
		Option.match(theme.route, { onNone: () => theme.entry, onSome: (route) => route.tokens })
	)

/** What the app's stylesheet is told for a theme: the one import it enters the theme by. */
const enteringMessageOf = (theme: LibraryTheme, entering: string): string =>
	Option.match(theme.route, {
		onNone: () =>
			`${nameOf(theme)} enters once, through the app's stylesheet alone: @import ${entering};`,
		onSome: (route) =>
			`${nameOf(theme)} enters the app's stylesheet once, by its tokens part alone: @import ${entering}; its route sheet ${route.sheet} imports the rest.`
	})

/**
 * What the contract says about the app's stylesheet for each library theme: it imports the entry exactly once, as the
 * layered import into the theme's layer (which its layered imports list, in their layer order), and in no other way;
 * for a theme with a route sheet, its tokens part so, and never the entry. A second import, one in another form or
 * layer, or one of the entry of a theme with a route sheet, is reported where it stands; no import in the one form is
 * reported at the top.
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
		const imports = Arr.filter(Arr.filter(input.nodes, isImport), importsTheme(input.file, theme))
		const first = Arr.findFirst(imports, (node) => node.params === entering)
		const message = enteringMessageOf(theme, entering)
		const strays = Arr.filterMap(imports, (node) =>
			Option.contains(first, node) ? Result.failVoid : Result.succeed({ at: node.at, message })
		)
		return Option.isSome(first) ? strays : [{ at: TOP, message }, ...strays]
	})

/** What the contract says about a sheet that is neither the app's stylesheet nor a library theme's: it imports no
 * library theme's entry, nor the tokens part of one with a route sheet. */
export const strayImportReports = (
	input: Readonly<{
		file: string
		nodes: ReadonlyArray<CssNode>
		themes: ReadonlyArray<LibraryTheme>
	}>
): ReadonlyArray<SheetReport> =>
	Arr.flatMap(input.themes, (theme) =>
		Arr.map(
			Arr.filter(Arr.filter(input.nodes, isImport), importsTheme(input.file, theme)),
			(node) => ({
				at: node.at,
				message: Option.match(theme.route, {
					onNone: () =>
						`${nameOf(theme)} enters only through the app's stylesheet, never through another sheet.`,
					onSome: (route) =>
						`${nameOf(theme)} enters only through the app's stylesheet and its route sheet ${route.sheet}, never through another sheet.`
				})
			})
		)
	)

/**
 * A route sheet's contract: comments, then exactly the app's stylesheet's `@layer` statement (`order`), the layered
 * imports of the library's base sheets in the options' order, and the layered import of the theme's entry, each into
 * the theme's layer; nothing else. A node out of that sequence is reported where it stands; a missing one, at the top,
 * with the whole sequence.
 */
export const routeSheetReports = (
	input: Readonly<{
		file: string
		nodes: ReadonlyArray<CssNode>
		theme: LibraryTheme
		route: Route
		order: string
	}>
): ReadonlyArray<SheetReport> => {
	const { file, theme, route } = input
	const expected: ReadonlyArray<Readonly<{ name: string; params: string }>> = [
		{ name: "layer", params: input.order },
		...Arr.map(route.base, (module) => ({
			name: "import",
			params: `"${module}" layer(${theme.option.layer})`
		})),
		{ name: "import", params: layeredImportOf(file, theme, theme.entry) }
	]
	const sequence = Arr.join(
		Arr.map(expected, ({ name, params }) => `@${name} ${params};`),
		" "
	)
	const message = `${nameOf(theme)}'s route sheet holds only comments and, in this order: ${sequence}`
	const walked = Arr.reduce(
		input.nodes,
		{ matched: 0, reports: Arr.empty<SheetReport>() },
		(state, node) => {
			const next = Arr.get(expected, state.matched)
			const matches = Option.exists(
				next,
				(step) =>
					node.kind === "at-rule" &&
					node.name === step.name &&
					node.params === step.params &&
					!Arr.isReadonlyArrayNonEmpty(node.nodes)
			)
			return matches
				? { matched: state.matched + 1, reports: state.reports }
				: { matched: state.matched, reports: [...state.reports, { at: node.at, message }] }
		}
	)
	return walked.matched === expected.length
		? walked.reports
		: [{ at: TOP, message }, ...walked.reports]
}

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

/** What a part's checks read: the theme, the theme namespaces the app's stylesheet owns, and whether the part is the
 * tokens part of a theme with a route sheet, which every page loads and so holds only `:root` rules. */
type PartContext = Readonly<{
	theme: LibraryTheme
	namespaces: ReadonlyArray<string>
	tokensOnly: boolean
}>

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
				...(context.tokensOnly && !nested && !root
					? [
							{
								at: node.at,
								message: `${nameOf(theme)}'s tokens part holds only :root rules of its tokens: the app's stylesheet loads it on every page.`
							}
						]
					: []),
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
 * the layer and outside it: fonts, animations, the theme and utilities are the app's stylesheet's. The tokens part of a
 * theme with a route sheet (`file` is the part as the run holds it) holds only `:root` rules. A refused node is
 * reported where it stands, and not looked into.
 */
export const partReports = (
	input: Readonly<{
		file: string
		theme: LibraryTheme
		namespaces: ReadonlyArray<string>
		nodes: ReadonlyArray<CssNode>
	}>
): ReadonlyArray<SheetReport> => {
	const context: PartContext = {
		theme: input.theme,
		namespaces: input.namespaces,
		tokensOnly: Option.exists(input.theme.route, (route) => route.tokens === input.file)
	}
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
