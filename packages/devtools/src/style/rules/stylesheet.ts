import { Array as Arr, Option, Order, Result, String as Str } from "effect"
import {
	type CssNode,
	type CssPosition,
	compact,
	isColorValue,
	parseStylesheet,
	selectorsOf
} from "#style/css.ts"
import type { DeclarationOption, ScopedSheetOption, StylesheetOption } from "#style/options.ts"
import type { SheetExtension, SheetReport } from "#style/own.ts"
import { isNamedBy } from "#style/paths.ts"
import {
	appImportReports,
	entryReports,
	isThemeSheet,
	type LibraryTheme,
	libraryOwnerOf,
	partReports,
	strayImportReports
} from "#style/rules/library-theme.ts"

/** The theme namespaces Tailwind reads besides colors: a scope's tokens under them belong to its sheet. */
const THEME_NAMESPACES: ReadonlyArray<string> = [
	"--spacing",
	"--container",
	"--radius",
	"--shadow",
	"--inset-shadow",
	"--drop-shadow",
	"--font",
	"--font-weight",
	"--text",
	"--tracking",
	"--leading",
	"--ease",
	"--animate",
	"--breakpoint",
	"--perspective",
	"--aspect",
	"--blur",
	"--background-image",
	"--background-size",
	"--mask-position",
	"--mask-size"
]

/** The role the options give one stylesheet: the app's own, the home of the shared tokens and the one sheet that
 * imports; a scoped sheet, the home of its scope's tokens; a passthrough, which holds exactly its text; or a library
 * theme's entry or one of its parts, which draw one library's markup through its hooks alone. */
export type SheetRole =
	| Readonly<{ kind: "app" }>
	| Readonly<{ kind: "scoped"; sheet: ScopedSheetOption }>
	| Readonly<{ kind: "passthrough"; text: string }>
	| Readonly<{ kind: "library-entry"; theme: LibraryTheme }>
	| Readonly<{ kind: "library-part"; theme: LibraryTheme }>

/** One maintained stylesheet as the contract reads it: the scope whose tokens it owns, none for the app's own
 * stylesheet, and the utilities and pages it alone may declare. */
type Sheet = Readonly<{
	scope: Option.Option<string>
	utilities: ScopedSheetOption["utilities"]
	pages: ScopedSheetOption["pages"]
}>

/** What one stylesheet's checks read: the contract, the sheet, every scope the options name (the longest first, so
 * a scope never claims a longer one's tokens), the theme namespaces a scope's tokens live under (Tailwind's and the
 * repository's own rules'), the palette the sheet's `--color-*` declarations name, the sheet's top-level nodes, and
 * what the repository's own rules add to this sheet's contract. */
type Context = Readonly<{
	options: StylesheetOption
	sheet: Sheet
	scopes: ReadonlyArray<string>
	namespaces: ReadonlyArray<string>
	palette: ReadonlySet<string>
	nodes: ReadonlyArray<CssNode>
	extensions: ReadonlyArray<SheetExtension>
}>

const TOP: CssPosition = { line: 1, column: 1 }

type Declaration = Extract<CssNode, { kind: "declaration" }>

type AtRule = Extract<CssNode, { kind: "at-rule" }>

type Rule = Extract<CssNode, { kind: "rule" }>

/** Every node of a stylesheet with its ancestors, outermost first. */
const walked = (
	nodes: ReadonlyArray<CssNode>,
	ancestors: ReadonlyArray<CssNode>
): ReadonlyArray<Readonly<{ node: CssNode; ancestors: ReadonlyArray<CssNode> }>> =>
	Arr.flatMap(nodes, (node) => [
		{ node, ancestors },
		...(node.kind === "declaration" ? [] : walked(node.nodes, [...ancestors, node]))
	])

const parentOf = (ancestors: ReadonlyArray<CssNode>): Option.Option<CssNode> => Arr.last(ancestors)

const isAtRuleNamed = (node: Option.Option<CssNode>, name: string): boolean =>
	Option.exists(node, (found) => found.kind === "at-rule" && found.name === name)

const isAtRule = (node: Option.Option<CssNode>, name: string, params: string): boolean =>
	Option.exists(
		node,
		(found) => found.kind === "at-rule" && found.name === name && found.params === params
	)

const isListed = (declarations: ReadonlyArray<DeclarationOption>, node: Declaration): boolean =>
	Arr.some(
		declarations,
		(declaration) => declaration.property === node.property && declaration.value === node.value
	)

const normalized = (selector: string): string => Arr.join(selectorsOf(selector), ", ")

/** The scope a custom property belongs to: `--<scope>-*`, `--color-<scope>-*` or `<namespace>-<scope>-*`; none
 * for the shared tokens. */
const ownerOf = (context: Context, property: string): Option.Option<string> =>
	Arr.findFirst(context.scopes, (scope) =>
		Arr.some(
			[
				`--${scope}-`,
				...Arr.map(["--color", ...context.namespaces], (namespace) => `${namespace}-${scope}-`)
			],
			(prefix) => Str.startsWith(prefix)(property)
		)
	)

const homeOf = (context: Context, scope: Option.Option<string>): string =>
	Option.match(scope, {
		onNone: () =>
			"The shared theme belongs only in the app's stylesheet, the one components.json names",
		onSome: (owner) =>
			`${owner} tokens belong only in ${Arr.join(
				Arr.filterMap(context.options.scopedSheets, (sheet) =>
					sheet.scope === owner ? Result.succeed(sheet.path) : Result.failVoid
				),
				" or "
			)}`
	})

const schemeOf = (context: Context, selector: string): Option.Option<string> =>
	Option.map(
		Arr.findFirst(
			context.options.themeSelectors,
			(theme) => theme.selector === normalized(selector)
		),
		(theme) => theme.scheme
	)

const baseApplyOf = (context: Context, selector: string): Option.Option<string> =>
	Option.map(
		Arr.findFirst(context.options.baseRules, (rule) => rule.selector === normalized(selector)),
		(rule) => rule.apply
	)

const checkRule = (
	context: Context,
	rule: Rule,
	ancestors: ReadonlyArray<CssNode>
): Option.Option<string> => {
	const topLevelTheme =
		!Arr.isReadonlyArrayNonEmpty(ancestors) && Option.isSome(schemeOf(context, rule.selector))
	const baseElement =
		isAtRule(parentOf(ancestors), "layer", "base") &&
		Option.isSome(baseApplyOf(context, rule.selector))
	return topLevelTheme || baseElement
		? Option.none()
		: Option.some("Custom CSS selectors are forbidden; compose standard utilities.")
}

const pageAtRoot = (
	context: Context,
	node: Option.Option<CssNode>,
	ancestors: ReadonlyArray<CssNode>
) =>
	Arr.findFirst(
		context.sheet.pages,
		(page) => isAtRule(node, "page", page.name) && ancestors.length === 0
	)

/** Whether an at-rule is one of a page's empty margin boxes, inside that page at the root. */
const isMarginBox = (context: Context, rule: AtRule, ancestors: ReadonlyArray<CssNode>): boolean =>
	Arr.some(
		context.sheet.pages,
		(page) =>
			Arr.contains(page.emptyBoxes, rule.name) &&
			isAtRule(parentOf(ancestors), "page", page.name) &&
			ancestors.length === 1
	)

/** Whether the contract admits one at-rule where it stands. */
type AtRuleCheck = (
	place: Readonly<{ context: Context; rule: AtRule; ancestors: ReadonlyArray<CssNode> }>
) => boolean

/** The one `@layer` statement the app's stylesheet may hold: the runtime layers first, then Tailwind's layers, with
 * each layered import's layer between base and components in the options' order; none when the options name neither a
 * runtime layer nor a layered import. */
const layerOrderOf = (context: Context): Option.Option<string> =>
	Arr.isReadonlyArrayNonEmpty(context.options.layeredImports) ||
	Arr.isReadonlyArrayNonEmpty(context.options.runtimeLayers)
		? Option.some(
				Arr.join(
					[
						...context.options.runtimeLayers,
						"theme",
						"base",
						...Arr.map(context.options.layeredImports, ({ layer }) => layer),
						"components",
						"utilities"
					],
					", "
				)
			)
		: Option.none()

const isImport = (node: CssNode): boolean => node.kind === "at-rule" && node.name === "import"

/** Whether a top-level at-rule is the layer order, in the app's stylesheet and ahead of every import, where the order
 * still decides. */
const isLayerOrder = (context: Context, rule: AtRule): boolean =>
	Option.isNone(context.sheet.scope) &&
	rule.nodes.length === 0 &&
	Option.contains(layerOrderOf(context), rule.params) &&
	!Arr.some(
		Arr.takeWhile(context.nodes, (node) => node !== rule),
		isImport
	)

/** Whether the sheet orders its layers: a layered import's layer stands where the order puts it only then. */
const ordersLayers = (context: Context): boolean =>
	Arr.some(
		context.nodes,
		(node) => node.kind === "at-rule" && node.name === "layer" && isLayerOrder(context, node)
	)

/** The at-rules the contract knows, each with where it may stand and what it may say. */
const AT_RULES: ReadonlyMap<string, AtRuleCheck> = new Map<string, AtRuleCheck>([
	[
		"import",
		({ context, rule, ancestors }) =>
			Option.isNone(context.sheet.scope) &&
			ancestors.length === 0 &&
			(Arr.some(context.options.imports, (imported) => rule.params === `"${imported}"`) ||
				(ordersLayers(context) &&
					Arr.some(
						context.options.layeredImports,
						({ module, layer }) => rule.params === `"${module}" layer(${layer})`
					)))
	],
	[
		"custom-variant",
		({ context, rule, ancestors }) =>
			ancestors.length === 0 &&
			Arr.contains(Arr.map(context.options.customVariants, compact), compact(rule.params))
	],
	["theme", ({ rule, ancestors }) => ancestors.length === 0 && rule.params === "inline"],
	[
		"layer",
		({ context, rule, ancestors }) =>
			ancestors.length === 0 && (rule.params === "base" || isLayerOrder(context, rule))
	],
	[
		"utility",
		({ context, rule, ancestors }) =>
			ancestors.length === 0 &&
			Arr.some(context.sheet.utilities, (utility) => utility.name === rule.params)
	],
	[
		"page",
		({ context, rule, ancestors }) =>
			ancestors.length === 0 && Arr.some(context.sheet.pages, (page) => page.name === rule.params)
	],
	[
		"apply",
		({ context, rule, ancestors }) =>
			Option.exists(
				parentOf(ancestors),
				(parent) =>
					parent.kind === "rule" &&
					Option.contains(baseApplyOf(context, parent.selector), rule.params)
			)
	]
])

/** Whether an at-rule is one the repository's own rules add to this sheet's contract, by name and by params up to
 * whitespace. */
const isExtensionAtRule = (context: Context, node: Option.Option<CssNode>): boolean =>
	Option.exists(
		node,
		(found) =>
			found.kind === "at-rule" &&
			Arr.some(context.extensions, (extension) =>
				Arr.some(
					extension.atRules,
					(atRule) => atRule.name === found.name && compact(atRule.params) === compact(found.params)
				)
			)
	)

/** Whether an at-rule is one the contract admits where it stands: one it knows, a page's margin box, or a top-level
 * at-rule the repository's own rules add. */
const isAdmittedAtRule = (
	context: Context,
	rule: AtRule,
	ancestors: ReadonlyArray<CssNode>
): boolean =>
	(ancestors.length === 0 && isExtensionAtRule(context, Option.some(rule))) ||
	Option.match(Option.fromUndefinedOr(AT_RULES.get(rule.name)), {
		onNone: () => isMarginBox(context, rule, ancestors),
		onSome: (admits) => admits({ context, rule, ancestors })
	})

/** A declaration one of the sheet's own utilities or pages declares exactly where it stands, the empty `content` of
 * one of its pages' empty margin boxes, or one directly inside an at-rule the repository's own rules add, which they
 * check. */
const isOwnDeclaration = (
	context: Context,
	node: Declaration,
	ancestors: ReadonlyArray<CssNode>
): boolean => {
	const parent = parentOf(ancestors)
	const inUtility = Arr.some(
		context.sheet.utilities,
		(utility) =>
			isAtRule(parent, "utility", utility.name) &&
			ancestors.length === 1 &&
			isListed(utility.declarations, node)
	)
	const inPage = Option.exists(pageAtRoot(context, parent, Arr.dropRight(ancestors, 1)), (page) =>
		isListed(page.declarations, node)
	)
	const grandparent = Arr.get(ancestors, ancestors.length - 2)
	const marginBox = Option.filter(parent, (found): found is AtRule => found.kind === "at-rule")
	const inMarginBox =
		Option.exists(marginBox, (box) =>
			Option.exists(pageAtRoot(context, grandparent, Arr.dropRight(ancestors, 2)), (page) =>
				Arr.contains(page.emptyBoxes, box.name)
			)
		) &&
		node.property === "content" &&
		node.value === '""'
	return inUtility || inPage || inMarginBox || isExtensionAtRule(context, parent)
}

/** Whether a theme declaration is one the repository's own rules check in place of the aliases: a token of the
 * scoped sheet's own scope under a theme namespace, when the rules extend the sheet. */
const isExtensionToken = (context: Context, node: Declaration): boolean =>
	Arr.isReadonlyArrayNonEmpty(context.extensions) &&
	Option.exists(context.sheet.scope, (scope) =>
		Arr.some(context.namespaces, (namespace) =>
			Str.startsWith(`${namespace}-${scope}-`)(node.property)
		)
	)

const themeValueViolation = (
	context: Context,
	node: Declaration,
	selector: string
): Option.Option<string> => {
	const scheme = schemeOf(context, selector)
	const rootValue = Arr.findFirst(
		context.options.rootValues,
		(value) => value.property === node.property
	)
	const allowed =
		node.property === "color-scheme"
			? Option.contains(scheme, node.value)
			: Option.match(rootValue, {
					onNone: () =>
						context.palette.has(Str.slice(2)(node.property)) && isColorValue(node.value),
					onSome: (value) => normalized(selector) === ":root" && value.value === node.value
				})
	return allowed
		? Option.none()
		: Option.some(
				"Theme declarations are the palette's direct color values and the root values the options list."
			)
}

const aliasViolation = (context: Context, node: Declaration): Option.Option<string> => {
	const isColorAlias =
		Str.startsWith("--color-")(node.property) &&
		node.value === `var(--${Str.slice("--color-".length)(node.property)})`
	return isColorAlias || isListed(context.options.themeAliases, node)
		? Option.none()
		: Option.some(
				"Theme aliases are the palette's --color-<name>: var(--<name>) and the aliases the options list."
			)
}

const checkDeclaration = (
	context: Context,
	node: Declaration,
	ancestors: ReadonlyArray<CssNode>
): Option.Option<string> =>
	Option.match(parentOf(ancestors), {
		onNone: () => Option.some("CSS declarations are forbidden outside the theme."),
		onSome: (found) => {
			if (found.kind === "rule" && Option.isSome(schemeOf(context, found.selector))) {
				return themeValueViolation(context, node, found.selector)
			}
			if (found.kind === "at-rule" && found.name === "theme") {
				return isExtensionToken(context, node) ? Option.none() : aliasViolation(context, node)
			}
			return Option.some("CSS declarations are forbidden outside the theme.")
		}
	})

/** A theme declaration outside its home: a library theme's tokens in any sheet of the contract's, a scope's tokens in
 * another sheet, the shared theme in a scoped one. */
const placementViolation = (context: Context, node: Declaration): Option.Option<string> => {
	const library = libraryOwnerOf(context.options.libraryThemes, node.property)
	if (Option.isSome(library)) {
		return Option.some(
			`${library.value.prefix} tokens belong only in library theme ${library.value.theme.directory}.`
		)
	}
	const owner = ownerOf(context, node.property)
	const inPlace = Option.match(owner, {
		onNone: () => Option.isNone(context.sheet.scope),
		onSome: (scope) => Option.contains(context.sheet.scope, scope)
	})
	return inPlace ? Option.none() : Option.some(`${homeOf(context, owner)}.`)
}

/** A sheet's own utility and page declarations stand as they are; any other declaration is a theme declaration
 * where it stands, in its home sheet. */
const declarationViolation = (
	context: Context,
	node: Declaration,
	ancestors: ReadonlyArray<CssNode>
): Option.Option<string> =>
	isOwnDeclaration(context, node, ancestors)
		? Option.none()
		: Option.orElse(checkDeclaration(context, node, ancestors), () =>
				placementViolation(context, node)
			)

/** What the contract says about one node where it stands. */
const checkNode = (
	context: Context,
	node: CssNode,
	ancestors: ReadonlyArray<CssNode>
): Option.Option<string> => {
	switch (node.kind) {
		case "rule":
			return checkRule(context, node, ancestors)
		case "at-rule":
			return isAdmittedAtRule(context, node, ancestors)
				? Option.none()
				: Option.some(`@${node.name} is not part of the stylesheet contract.`)
		case "declaration":
			return declarationViolation(context, node, ancestors)
	}
}

const paletteOf = (nodes: ReadonlyArray<CssNode>): ReadonlySet<string> =>
	new Set(
		Arr.filterMap(walked(nodes, []), ({ node }) =>
			node.kind === "declaration" && Str.startsWith("--color-")(node.property)
				? Result.succeed(Str.slice("--color-".length)(node.property))
				: Result.failVoid
		)
	)

/** What the rule says about a stylesheet the options give no role: the app's stylesheet, the scoped sheets, the
 * passthroughs and the library themes' sheets are the only ones. */
export const SECOND_STYLESHEET =
	"A maintained stylesheet must not create a second theme or component CSS owner."

/** Every role the options give a stylesheet: none for a sheet they do not name, and more than one for a sheet they
 * name twice. */
export const sheetRolesOf = (
	input: Readonly<{
		file: string
		isApp: boolean
		options: StylesheetOption
		libraries: ReadonlyArray<LibraryTheme>
	}>
): ReadonlyArray<SheetRole> => {
	const isNamed = (path: string): boolean => isNamedBy(path)(input.file)
	const app: ReadonlyArray<SheetRole> = input.isApp ? [{ kind: "app" }] : []
	return [
		...app,
		...Arr.filterMap(input.options.scopedSheets, (sheet): Result.Result<SheetRole, void> =>
			isNamed(sheet.path) ? Result.succeed({ kind: "scoped", sheet }) : Result.failVoid
		),
		...Arr.filterMap(input.options.passthrough, (entry): Result.Result<SheetRole, void> =>
			isNamed(entry.path)
				? Result.succeed({ kind: "passthrough", text: entry.text })
				: Result.failVoid
		),
		...Arr.filterMap(input.libraries, (theme): Result.Result<SheetRole, void> => {
			if (!isThemeSheet(theme)(input.file)) {
				return Result.failVoid
			}
			return Result.succeed(
				input.file === theme.entry
					? { kind: "library-entry", theme }
					: { kind: "library-part", theme }
			)
		})
	]
}

const LONGEST_FIRST = Order.mapInput(Order.flip(Order.Number), (scope: string) => scope.length)

/** The theme namespaces, Tailwind's and the repository's own rules': a scope's tokens under them belong to its sheet,
 * and a library theme declares none. */
const namespacesOf = (extensions: Extensions): ReadonlyArray<string> => [
	...THEME_NAMESPACES,
	...extensions.namespaces
]

/** What the repository's own rules add to the stylesheet contract: their theme namespaces, which hold in every sheet,
 * and their additions to this sheet's contract. */
type Extensions = Readonly<{
	namespaces: ReadonlyArray<string>
	sheets: ReadonlyArray<SheetExtension>
}>

/** The contract over one maintained sheet, node by node where it stands, and what the repository's own rules say
 * over it. */
const contractReports = (
	input: Readonly<{
		nodes: ReadonlyArray<CssNode>
		sheet: Sheet
		options: StylesheetOption
		extensions: Extensions
	}>
): ReadonlyArray<SheetReport> => {
	const { nodes } = input
	const context: Context = {
		options: input.options,
		sheet: input.sheet,
		scopes: Arr.sort(
			Arr.dedupe(Arr.map(input.options.scopedSheets, (sheet) => sheet.scope)),
			LONGEST_FIRST
		),
		namespaces: namespacesOf(input.extensions),
		palette: paletteOf(nodes),
		nodes,
		extensions: input.extensions.sheets
	}
	const contract = Arr.filterMap(walked(nodes, []), ({ node, ancestors }) =>
		Option.match(checkNode(context, node, ancestors), {
			onNone: () => Result.failVoid,
			onSome: (message) => Result.succeed({ at: node.at, message })
		})
	)
	const tokens = Arr.filterMap(walked(nodes, []), ({ node, ancestors }) =>
		node.kind === "declaration" &&
		isAtRuleNamed(parentOf(ancestors), "theme") &&
		isExtensionToken(context, node)
			? Result.succeed(node)
			: Result.failVoid
	)
	return [
		...contract,
		...Arr.flatMap(input.extensions.sheets, (extension) => extension.reports({ nodes, tokens }))
	]
}

/** What the repository's own rules say over a library theme's sheet: their reports, never their at-rules, since the
 * theme's contract is its library's hooks alone. */
const extensionReports = (
	nodes: ReadonlyArray<CssNode>,
	extensions: Extensions
): ReadonlyArray<SheetReport> =>
	Arr.flatMap(extensions.sheets, (extension) => extension.reports({ nodes, tokens: [] }))

/**
 * The app's stylesheet (the one components.json names) and the scoped sheets the options name are the theme's only
 * maintained stylesheets, each the one home of its tokens; components compose utilities. A sheet holds the theme's
 * palette under the theme selectors, `@theme inline` aliases, the base layer's rules, and exactly the variants the
 * options admit; the app's stylesheet alone imports (its layered imports after the one layer order, each library
 * theme's entry among them, once), and a scoped sheet alone declares its utilities and pages. A passthrough holds
 * exactly its text, which imports no library theme. A library theme's sheets draw markup the app renders and does not
 * write, through the library's hooks alone, in the library's layer (`#style/rules/library-theme.ts`). The repository's
 * own rules extend the contract of the sheets they name: `extensions.sheets` are this sheet's. `file` is the sheet's
 * path as the run holds it, which its imports are read beside.
 */
export const stylesheet = (
	input: Readonly<{
		file: string
		text: string
		role: SheetRole
		options: StylesheetOption
		libraries: ReadonlyArray<LibraryTheme>
		extensions: Extensions
	}>
): ReadonlyArray<SheetReport> => {
	const { file, text, role, options, libraries, extensions } = input
	const nodes = parseStylesheet(text)
	switch (role.kind) {
		case "passthrough":
			return [
				...(Str.trim(text) === Str.trim(role.text)
					? []
					: [
							{
								at: TOP,
								message:
									"A passthrough stylesheet holds exactly the text the style options give it."
							}
						]),
				...strayImportReports({ file, nodes, themes: libraries })
			]
		case "app":
			return [
				...contractReports({
					nodes,
					options,
					extensions,
					sheet: { scope: Option.none(), utilities: [], pages: [] }
				}),
				...appImportReports({ file, nodes, themes: libraries })
			]
		case "scoped":
			return contractReports({
				nodes,
				options,
				extensions,
				sheet: {
					scope: Option.some(role.sheet.scope),
					utilities: role.sheet.utilities,
					pages: role.sheet.pages
				}
			})
		case "library-entry":
			return [...entryReports({ theme: role.theme, nodes }), ...extensionReports(nodes, extensions)]
		case "library-part":
			return [
				...partReports({ theme: role.theme, namespaces: namespacesOf(extensions), nodes }),
				...extensionReports(nodes, extensions)
			]
	}
}
