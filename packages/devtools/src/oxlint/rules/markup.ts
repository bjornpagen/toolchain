import { Array as Arr, Option, Record, String as Str } from "effect"
import { type AnyNode, type Context, configured, type NodeOf } from "#oxlint/rule.ts"
import { ancestorsOf } from "#oxlint/syntax.ts"
import { isWhitespace } from "#style/css.ts"
import { MarkupOptions, type MarkupOption, type OperandOption } from "#style/options.ts"
import { isNamedBy, isNamedByAny } from "#style/paths.ts"

/** The native elements that are widgets: the app composes its ui primitives instead. */
const RAW_WIDGETS: ReadonlyArray<string> = [
	"button",
	"input",
	"select",
	"textarea",
	"label",
	"fieldset",
	"legend",
	"table",
	"thead",
	"tbody",
	"tfoot",
	"tr",
	"th",
	"td",
	"caption",
	"details",
	"summary",
	"dialog"
]

/** The members that construct HTML or CSS from strings. */
const HTML_MEMBERS: ReadonlyArray<string> = [
	"innerHTML",
	"outerHTML",
	"insertAdjacentHTML",
	"writeHTML",
	"srcdoc",
	"srcDoc",
	"insertRule",
	"addRule",
	"replaceSync",
	"parseFromString",
	"renderToString",
	"renderToStaticMarkup"
]

const ELEMENT_FACTORIES: ReadonlyArray<string> = ["createElement", "createElementNS"]

const HANDLERS: ReadonlyArray<string> = ["onClick", "onPointerDown", "onKeyDown"]

const LAYOUT_ELEMENTS: ReadonlyArray<string> = ["div", "span"]

/** The attributes `setAttribute` may not write, in lower case. */
const UNSAFE_ATTRIBUTES: ReadonlyArray<string> = ["style", "srcdoc", "innerhtml", "outerhtml"]

/** Text without any whitespace: how an operand is compared, so formatting never matters. */
const squeezed = (text: string): string =>
	Arr.join(
		Arr.filter(Arr.fromIterable(text), (character) => !isWhitespace(character)),
		""
	)

const isTagNameCharacter = (character: string): boolean =>
	(character >= "a" && character <= "z") ||
	(character >= "A" && character <= "Z") ||
	(character >= "0" && character <= "9") ||
	character === "-"

const isLetter = (character: string): boolean =>
	(character >= "a" && character <= "z") || (character >= "A" && character <= "Z")

/** Whether text holds an HTML tag: `<`, an optional `!` or `/`, a letter, name characters, then whitespace or `>`. */
const holdsHtmlTag = (text: string): boolean => {
	const characters = Arr.fromIterable(text)
	return Arr.some(characters, (character, index) => {
		if (character !== "<") {
			return false
		}
		const rest = Arr.drop(characters, index + 1)
		const name = Option.exists(Arr.head(rest), (first) => first === "!" || first === "/")
			? Arr.drop(rest, 1)
			: rest
		const tag = Arr.takeWhile(name, isTagNameCharacter)
		return (
			Option.exists(Arr.head(name), isLetter) &&
			Option.exists(Arr.get(name, tag.length), (after) => after === ">" || isWhitespace(after))
		)
	})
}

type StyleBridge = MarkupOption["styleBridges"][number]

/** What one file's checks read: its context, the variables it declares and the names it imports, and the doors the
 * options open at it: the operands each measured style property may hold, its style bridges, and whether it may
 * write HTML templates and construct stylesheets. */
type MarkupFile = Readonly<{
	context: Context
	definitions: ReadonlyMap<string, AnyNode>
	imported: ReadonlyMap<string, string>
	measured: Readonly<Record<string, ReadonlyArray<OperandOption>>>
	bridges: ReadonlyArray<StyleBridge>
	htmlTemplates: boolean
	stylesheetConstructors: boolean
}>

const report = (file: MarkupFile, node: AnyNode, message: string): void => {
	file.context.report({ node, message })
}

const textOf = (file: MarkupFile, node: AnyNode): string => file.context.sourceCode.getText(node)

/** An object literal's own property, `name: value` or `name`, never a method, an accessor or a binding. */
const isPlainProperty = (node: AnyNode): node is NodeOf<"Property"> =>
	node.type === "Property" &&
	node.kind === "init" &&
	!node.method &&
	node.parent.type === "ObjectExpression"

/** A string literal's text, or a template's without substitutions. */
const stringOf = (node: AnyNode): Option.Option<string> => {
	if (node.type === "Literal" && typeof node.value === "string") {
		return Option.some(node.value)
	}
	if (node.type === "TemplateLiteral" && !Arr.isArrayNonEmpty(node.expressions)) {
		return Option.map(Arr.head(node.quasis), (quasi) => quasi.value.cooked ?? quasi.value.raw)
	}
	return Option.none()
}

/** A variable a file declares with its initializer, under its name. */
const recordDefinition = (
	definitions: Map<string, AnyNode>,
	node: NodeOf<"VariableDeclarator">
): void => {
	if (node.id.type === "Identifier" && node.init !== null) {
		definitions.set(node.id.name, node.init)
	}
}

/** The names an import binds: `module` for a default or namespace import, `module:export` for a named one. */
const recordImports = (imported: Map<string, string>, node: NodeOf<"ImportDeclaration">): void => {
	const specifier = node.source.value
	for (const binding of node.specifiers) {
		if (binding.type === "ImportSpecifier") {
			const exported =
				binding.imported.type === "Identifier" ? binding.imported.name : binding.imported.value
			imported.set(binding.local.name, `${specifier}:${exported}`)
		} else {
			imported.set(binding.local.name, specifier)
		}
	}
}

/** The string an expression always holds, followed through the file's variables and `+`. */
const literalOf = (
	file: MarkupFile,
	node: AnyNode,
	seen: ReadonlySet<string>
): Option.Option<string> => {
	const text = stringOf(node)
	if (Option.isSome(text)) {
		return text
	}
	if (
		node.type === "ParenthesizedExpression" ||
		node.type === "TSAsExpression" ||
		node.type === "TSSatisfiesExpression"
	) {
		return literalOf(file, node.expression, seen)
	}
	if (node.type === "Identifier" && !seen.has(node.name)) {
		return Option.flatMap(Option.fromUndefinedOr(file.definitions.get(node.name)), (definition) =>
			literalOf(file, definition, new Set([...seen, node.name]))
		)
	}
	if (node.type === "BinaryExpression" && node.operator === "+") {
		return Option.flatMap(literalOf(file, node.left, seen), (left) =>
			Option.map(literalOf(file, node.right, seen), (right) => `${left}${right}`)
		)
	}
	return Option.none()
}

const literal = (file: MarkupFile, node: AnyNode): Option.Option<string> =>
	literalOf(file, node, new Set<string>())

const argumentLiteral = (
	file: MarkupFile,
	call: NodeOf<"CallExpression">,
	index: number
): Option.Option<string> =>
	Option.flatMap(Arr.get(call.arguments, index), (argument) => literal(file, argument))

/** The member an access reads: a property's name, or a computed access's literal key. */
const memberOf = (file: MarkupFile, node: AnyNode): Option.Option<string> => {
	if (node.type !== "MemberExpression") {
		return Option.none()
	}
	if (!node.computed) {
		return node.property.type === "Identifier" ? Option.some(node.property.name) : Option.none()
	}
	return literal(file, node.property)
}

const isStyleAccess = (file: MarkupFile, node: AnyNode): boolean =>
	Option.contains(memberOf(file, node), "style")

/** `owner.style`, read off a binding of that name. */
const isStyleOf = (node: AnyNode, owner: string): boolean =>
	node.type === "MemberExpression" &&
	!node.computed &&
	node.property.type === "Identifier" &&
	node.property.name === "style" &&
	node.object.type === "Identifier" &&
	node.object.name === owner

/** The name of the function declaration a node sits in, the nearest one. */
const enclosingFunctionNameOf = (node: AnyNode): Option.Option<string> =>
	Option.flatMap(
		Arr.findFirst(ancestorsOf(node), (ancestor) => ancestor.type === "FunctionDeclaration"),
		(found) =>
			found.type === "FunctionDeclaration" && found.id !== null
				? Option.some(found.id.name)
				: Option.none()
	)

/** A property's written name, an identifier's or a string's; a computed name is none. */
const propertyNameOf = (property: NodeOf<"Property">): Option.Option<string> => {
	if (property.computed) {
		return Option.none()
	}
	return property.key.type === "Identifier"
		? Option.some(property.key.name)
		: stringOf(property.key)
}

/** A style bridge's one merge: `style: { ...base.style, ...overlay.style }` inside the bridge function. */
const isBridgeStyle = (file: MarkupFile, node: AnyNode): boolean => {
	if (
		!isPlainProperty(node) ||
		node.shorthand ||
		node.computed ||
		node.key.type !== "Identifier" ||
		node.key.name !== "style" ||
		node.value.type !== "ObjectExpression"
	) {
		return false
	}
	const [base, overlay, ...rest] = node.value.properties
	return Arr.some(
		file.bridges,
		(bridge) =>
			base !== undefined &&
			overlay !== undefined &&
			!Arr.isArrayNonEmpty(rest) &&
			base.type === "SpreadElement" &&
			overlay.type === "SpreadElement" &&
			isStyleOf(base.argument, bridge.base) &&
			isStyleOf(overlay.argument, bridge.overlay) &&
			Option.contains(enclosingFunctionNameOf(node), bridge.function)
	)
}

const isBridgeStyleRead = (file: MarkupFile, node: AnyNode): boolean => {
	const spread = node.parent
	const merge = spread?.parent
	const property = merge?.parent
	return (
		spread?.type === "SpreadElement" &&
		merge?.type === "ObjectExpression" &&
		property !== null &&
		property !== undefined &&
		isBridgeStyle(file, property)
	)
}

/** An operand that is a member of a module's named export: a property chain rooted at its import. */
const isExportOperand = (file: MarkupFile, value: AnyNode, operand: OperandOption): boolean => {
	if (operand.kind !== "export") {
		return false
	}
	const rootOf = (node: AnyNode): AnyNode =>
		node.type === "MemberExpression" && !node.computed ? rootOf(node.object) : node
	const root = rootOf(value)
	return (
		root.type === "Identifier" &&
		file.imported.get(root.name) === `${operand.module}:${operand.name}`
	)
}

const isExpressionOperand = (file: MarkupFile, value: AnyNode, operand: OperandOption): boolean =>
	operand.kind === "expression" && squeezed(operand.text) === squeezed(textOf(file, value))

/** A percentage of an expression operand, `${share}%`. */
const isPercentOperand = (
	file: MarkupFile,
	value: AnyNode,
	operands: ReadonlyArray<OperandOption>
): boolean => {
	if (value.type !== "TemplateLiteral") {
		return false
	}
	const [expression, ...others] = value.expressions
	const [head, tail] = value.quasis
	return (
		expression !== undefined &&
		!Arr.isArrayNonEmpty(others) &&
		head?.value.cooked === "" &&
		tail?.value.cooked === "%" &&
		Arr.some(operands, (operand) => isExpressionOperand(file, expression, operand))
	)
}

/** A measured style property: one of the operands its file admits for it, or a percentage of one. */
const isMeasuredProperty = (file: MarkupFile, property: AnyNode): boolean => {
	if (property.type !== "Property" || property.kind !== "init" || property.method) {
		return false
	}
	const value = property.value
	return Option.exists(
		Option.flatMap(propertyNameOf(property), (name) => Record.get(file.measured, name)),
		(operands) =>
			Arr.some(
				operands,
				(operand) =>
					isExpressionOperand(file, value, operand) || isExportOperand(file, value, operand)
			) || isPercentOperand(file, value, operands)
	)
}

/** A style attribute the options admit: an object literal of measured operands at a file that owns them. */
const isMeasuredStyle = (file: MarkupFile, attribute: NodeOf<"JSXAttribute">): boolean => {
	const value = attribute.value
	if (value?.type !== "JSXExpressionContainer" || value.expression.type !== "ObjectExpression") {
		return false
	}
	const properties = value.expression.properties
	return (
		Arr.isArrayNonEmpty(properties) &&
		Arr.every(properties, (property) => isMeasuredProperty(file, property))
	)
}

const checkAttribute = (file: MarkupFile, attribute: NodeOf<"JSXAttribute">, tag: string): void => {
	const name = textOf(file, attribute.name)
	if (
		(name === "style" && !isMeasuredStyle(file, attribute)) ||
		name === "dangerouslySetInnerHTML" ||
		name === "srcDoc"
	) {
		report(file, attribute, `JSX ${name} bypasses the shadcn styling and content boundary.`)
	}
	if (Arr.contains(HANDLERS, name) && Arr.contains(LAYOUT_ELEMENTS, tag)) {
		report(file, attribute, "Clickable layout elements must become shadcn controls.")
	}
}

const checkJsx = (file: MarkupFile, node: NodeOf<"JSXOpeningElement">): void => {
	const tag = textOf(file, node.name)
	if (Arr.contains(RAW_WIDGETS, tag)) {
		report(file, node, `Raw <${tag}> is a widget; compose the app's ui primitive.`)
	}
	if (tag === "style") {
		report(file, node, "A <style> element is a second stylesheet owner.")
	}
	if (tag === "svg") {
		report(file, node, "Application icons come from the icon library, not handwritten SVG.")
	}
	const selected = Option.flatMap(Option.fromUndefinedOr(file.definitions.get(tag)), (definition) =>
		literal(file, definition)
	)
	if (node.name.type === "JSXIdentifier" && Option.isSome(selected)) {
		report(file, node, "String-selected JSX tags are forbidden; use fixed declarative renderers.")
	}
	for (const attribute of node.attributes) {
		if (attribute.type === "JSXAttribute") {
			checkAttribute(file, attribute, tag)
		}
	}
}

const checkAccess = (file: MarkupFile, node: NodeOf<"MemberExpression">): void => {
	const name = memberOf(file, node)
	const isCalled = node.parent.type === "CallExpression" && node.parent.callee === node
	if (Option.exists(name, (found) => Arr.contains(ELEMENT_FACTORIES, found)) && !isCalled) {
		report(
			file,
			node,
			"Element factory methods may not escape into aliases; only direct calls are a rendering door."
		)
	}
	if (
		Option.isNone(name) &&
		node.computed &&
		Arr.contains(["document", "window.document"], textOf(file, node.object))
	) {
		report(
			file,
			node,
			"Dynamic document method acquisition cannot establish content-renderer authority."
		)
	}
	const door = Option.filter(
		name,
		(found) =>
			Arr.contains(HTML_MEMBERS, found) && !(found === "replaceSync" && file.stylesheetConstructors)
	)
	if (Option.isSome(door)) {
		report(file, node, `${door.value} is an unauthorized HTML or CSS construction door.`)
	}
	if (Option.contains(name, "write") && Str.includes("document")(textOf(file, node.object))) {
		report(file, node, "Document writes cannot construct application HTML.")
	}
	if (isStyleAccess(file, node.object)) {
		report(file, node, "Runtime styles may not be written.")
	}
	if (
		Option.contains(name, "style") &&
		!isBridgeStyleRead(file, node) &&
		node.parent.type !== "MemberExpression"
	) {
		report(file, node, "Style objects may not escape into aliases, merges or setters.")
	}
}

const checkCall = (file: MarkupFile, node: NodeOf<"CallExpression">): void => {
	const callee = node.callee
	const name = Option.orElse(memberOf(file, callee), () =>
		callee.type === "Identifier" ? Option.some(callee.name) : Option.none()
	)
	const importName =
		callee.type === "Identifier"
			? Option.fromUndefinedOr(file.imported.get(callee.name))
			: Option.none()
	if (
		Option.exists(name, (found) => Arr.contains(ELEMENT_FACTORIES, found)) ||
		Option.exists(importName, Str.endsWith(":createElement"))
	) {
		report(file, node, "Application rendering uses fixed JSX, never element creation.")
	}
	if (Option.exists(name, (found) => found === "setAttribute" || found === "setAttributeNS")) {
		const attribute = argumentLiteral(file, node, Option.contains(name, "setAttributeNS") ? 1 : 0)
		if (
			!Option.exists(attribute, (found) => !Arr.contains(UNSAFE_ATTRIBUTES, Str.toLowerCase(found)))
		) {
			report(
				file,
				node,
				"Dynamic, styling or HTML DOM attributes are not an admitted rendering door."
			)
		}
	}
	if (Option.exists(name, (found) => found === "defineProperty" || found === "set")) {
		const property = argumentLiteral(file, node, 1)
		if (
			Option.exists(property, (found) => found === "style" || Arr.contains(HTML_MEMBERS, found))
		) {
			report(file, node, "Reflective HTML and style writes are forbidden.")
		}
	}
}

/** A font loader's own option (next/font's `style` names the faces it loads), not a prop: in the loader's options,
 * or on one face of next/font/local's `src`. */
const isFontLoaderOption = (file: MarkupFile, node: NodeOf<"Property">): boolean => {
	const faces = node.parent.parent
	const face = faces?.type === "ArrayExpression" ? faces.parent : null
	const options =
		face?.type === "Property" && face.key.type === "Identifier" && face.key.name === "src"
			? face.parent
			: node.parent
	const call = options.parent
	return (
		call?.type === "CallExpression" &&
		Arr.some(call.arguments, (argument) => argument === options) &&
		call.callee.type === "Identifier" &&
		Option.exists(
			Option.fromUndefinedOr(file.imported.get(call.callee.name)),
			Str.startsWith("next/font/")
		)
	)
}

const checkProperty = (file: MarkupFile, node: NodeOf<"Property">): void => {
	const name = node.computed ? literal(file, node.key) : propertyNameOf(node)
	if (
		Option.exists(name, (found) => found === "dangerouslySetInnerHTML" || found === "srcDoc") ||
		(Option.contains(name, "style") &&
			!isBridgeStyle(file, node) &&
			!isFontLoaderOption(file, node))
	) {
		report(file, node, "Spreadable props may not carry inline styles or HTML injection.")
	}
}

const checkConstruction = (file: MarkupFile, node: NodeOf<"NewExpression">): void => {
	const constructed = textOf(file, node.callee)
	if (
		(constructed === "CSSStyleSheet" && !file.stylesheetConstructors) ||
		constructed === "DOMParser"
	) {
		report(
			file,
			node,
			"Application HTML and CSS may not acquire another parser or stylesheet owner."
		)
	}
}

const checkTemplate = (file: MarkupFile, node: NodeOf<"TemplateLiteral">): void => {
	const segments = Arr.map(node.quasis, (quasi) => quasi.value.cooked ?? quasi.value.raw)
	if (
		Arr.isArrayNonEmpty(node.expressions) &&
		!file.htmlTemplates &&
		Arr.some(segments, holdsHtmlTag)
	) {
		report(file, node, "Interpolated HTML construction must become fixed JSX.")
	}
}

/** The name a destructuring element takes: its property's, or its own when it takes none. */
const bindingNameOf = (element: AnyNode): Option.Option<string> => {
	if (element.type === "Property") {
		return element.computed
			? Option.none()
			: element.key.type === "Identifier"
				? Option.some(element.key.name)
				: stringOf(element.key)
	}
	const target = element.type === "AssignmentPattern" ? element.left : element
	if (target.type === "RestElement") {
		return target.argument.type === "Identifier" ? Option.some(target.argument.name) : Option.none()
	}
	return target.type === "Identifier" ? Option.some(target.name) : Option.none()
}

const checkBinding = (file: MarkupFile, element: AnyNode): void => {
	if (
		Option.exists(
			bindingNameOf(element),
			(found) => Arr.contains(HTML_MEMBERS, found) || Arr.contains(ELEMENT_FACTORIES, found)
		)
	) {
		report(
			file,
			element,
			"Destructuring cannot acquire HTML renderer or element-factory authority."
		)
	}
}

/** The operands a file's measured style properties may hold, by property, from every entry that names the file. */
const measuredOf = (
	options: MarkupOption,
	fileName: string
): Readonly<Record<string, ReadonlyArray<OperandOption>>> => {
	const entries = Arr.filter(options.measuredStyles, (entry) => isNamedBy(entry.path)(fileName))
	const properties = Arr.flatMap(entries, (entry) => Record.toEntries(entry.properties))
	const byProperty = Arr.groupBy(properties, ([property]) => property)
	return Record.map(byProperty, (group) => Arr.flatMap(group, ([, operands]) => operands))
}

/**
 * Presentation is fixed JSX styled by classes: no inline styles but the measured operands the options give a file,
 * no HTML from strings (innerHTML and its kin, document.write, DOMParser, HTML templates, setAttribute of style or
 * HTML), no element factories, no raw widgets or handwritten SVG where the app's primitives and icon library serve,
 * no clickable layout elements, and no `<style>` or constructed stylesheets beside the one theme. A file the options
 * name may merge styles in its style bridge, write HTML templates, or construct stylesheets. The options are the web
 * pack's markup options of the Tailwind app whose files the rule runs on.
 */
export const markup = configured(MarkupOptions, (context, options) => {
	const fileName = context.filename
	const definitions = new Map<string, AnyNode>()
	const imported = new Map<string, string>()
	const file: MarkupFile = {
		context,
		definitions,
		imported,
		measured: measuredOf(options, fileName),
		bridges: Arr.filter(options.styleBridges, (bridge) => isNamedBy(bridge.path)(fileName)),
		htmlTemplates: isNamedByAny(options.htmlTemplates)(fileName),
		stylesheetConstructors: isNamedByAny(options.stylesheetConstructors)(fileName)
	}
	/** The checks wait for the whole file, so every variable and import is known before any of them reads one. */
	const checks: Array<() => void> = []
	const later = (check: () => void): void => {
		checks.push(check)
	}
	return {
		VariableDeclarator: (node) => {
			recordDefinition(definitions, node)
		},
		ImportDeclaration: (node) => {
			recordImports(imported, node)
		},
		JSXOpeningElement: (node) => {
			later(() => checkJsx(file, node))
		},
		MemberExpression: (node) => {
			later(() => checkAccess(file, node))
		},
		CallExpression: (node) => {
			later(() => checkCall(file, node))
		},
		NewExpression: (node) => {
			later(() => checkConstruction(file, node))
		},
		Property: (node) => {
			if (isPlainProperty(node) && !node.shorthand) {
				later(() => checkProperty(file, node))
			}
		},
		TemplateLiteral: (node) => {
			later(() => checkTemplate(file, node))
		},
		ObjectPattern: (node) => {
			for (const element of node.properties) {
				later(() => checkBinding(file, element))
			}
		},
		ArrayPattern: (node) => {
			for (const element of node.elements) {
				if (element !== null) {
					later(() => checkBinding(file, element))
				}
			}
		},
		"Program:exit": () => {
			for (const check of checks) {
				check()
			}
		}
	}
})
