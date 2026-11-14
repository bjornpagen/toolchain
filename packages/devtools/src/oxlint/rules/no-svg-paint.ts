import { Array as Arr, Option, String as Str } from "effect"
import type { AnyNode, Context, CreateRule, NodeOf } from "#oxlint/rule.ts"
import { hasLiteralColor } from "#style/css.ts"

/** SVG paint attributes, in JSX and native spelling. */
const PAINT_ATTRIBUTES: ReadonlyArray<string> = ["fill", "stroke", "stopColor", "stop-color"]

/** Paint keywords that name no palette color, so they carry no second home for one. */
const PAINT_KEYWORDS: ReadonlyArray<string> = ["none", "currentColor", "transparent", "inherit"]

type Paint = Readonly<{ node: AnyNode; text: string }>

type Scope = ReturnType<Context["sourceCode"]["getScope"]>

type Variable = Scope["variables"][number]

/** The variable an identifier names where it stands: the nearest scope's of its name. */
const variableOf = (
	context: Context,
	identifier: NodeOf<"Identifier">
): Option.Option<Variable> => {
	for (
		let scope: Scope | null = context.sourceCode.getScope(identifier);
		scope !== null;
		scope = scope.upper
	) {
		const found = scope.set.get(identifier.name)
		if (found !== undefined) {
			return Option.some(found)
		}
	}
	return Option.none()
}

/** The value a name refers to, when its one declaration in this file gives it one. */
const definitionOf = (context: Context, name: NodeOf<"Identifier">): Option.Option<AnyNode> =>
	Option.flatMap(variableOf(context, name), (variable) => {
		const [only, ...others] = variable.defs
		if (only === undefined || Arr.isArrayNonEmpty(others)) {
			return Option.none()
		}
		const declarator = only.node
		return declarator.type === "VariableDeclarator" && declarator.init !== null
			? Option.some(declarator.init)
			: Option.none()
	})

/** Every literal paint an attribute value can produce, through the variables of this file it names. */
const paintsOf = (
	context: Context,
	node: AnyNode,
	seen: ReadonlySet<AnyNode>
): ReadonlyArray<Paint> => {
	if (node.type === "Literal") {
		return typeof node.value === "string" ? [{ node, text: node.value }] : []
	}
	if (node.type === "TemplateLiteral") {
		return Arr.map(Arr.take(node.quasis, 1), (head) => ({
			node,
			text: head.value.cooked ?? head.value.raw
		}))
	}
	if (
		node.type === "ParenthesizedExpression" ||
		node.type === "TSAsExpression" ||
		node.type === "TSSatisfiesExpression"
	) {
		return paintsOf(context, node.expression, seen)
	}
	if (node.type === "ConditionalExpression") {
		return [...paintsOf(context, node.consequent, seen), ...paintsOf(context, node.alternate, seen)]
	}
	if (node.type === "BinaryExpression" || node.type === "LogicalExpression") {
		return [...paintsOf(context, node.left, seen), ...paintsOf(context, node.right, seen)]
	}
	if (node.type !== "Identifier") {
		return []
	}
	return Option.match(
		Option.filter(definitionOf(context, node), (definition) => !seen.has(definition)),
		{
			onNone: () => [],
			onSome: (definition) => paintsOf(context, definition, new Set([...seen, definition]))
		}
	)
}

/** A paint that names a color: a literal color, a variable, or anything but a keyword or a paint server
 * reference (a gradient, pattern or mask by id, which is structure). */
const isColorPaint = (text: string): boolean =>
	hasLiteralColor(text) ||
	Str.includes("var(")(text) ||
	!(Arr.contains(PAINT_KEYWORDS, text) || Str.startsWith("url(")(text))

/** The expression an attribute's value is: a string, or what its braces hold. */
const attributeValueOf = (attribute: NodeOf<"JSXAttribute">): Option.Option<AnyNode> => {
	const value = attribute.value
	if (value === null) {
		return Option.none()
	}
	if (value.type === "JSXExpressionContainer") {
		return value.expression.type === "JSXEmptyExpression"
			? Option.none()
			: Option.some(value.expression)
	}
	return Option.some(value)
}

const SUGGESTION = "Use a fill-*, stroke-* or text-* class, with currentColor on the attribute."

/**
 * Palette colors belong to `fill-*`, `stroke-*` and `text-*` classes; paint attributes only name structure. A paint
 * attribute of a .tsx file is followed through conditionals and through the variables of its own file that it names;
 * every literal color, CSS variable or other color it can hold is reported where it is written.
 */
export const noSvgPaint: CreateRule = {
	meta: { type: "problem" },
	create: (context) => {
		if (!Str.endsWith(".tsx")(context.filename)) {
			return {}
		}
		return {
			JSXAttribute: (node) => {
				const name = node.name.type === "JSXIdentifier" ? node.name.name : ""
				if (!Arr.contains(PAINT_ATTRIBUTES, name)) {
					return
				}
				const paints = Option.match(attributeValueOf(node), {
					onNone: (): ReadonlyArray<Paint> => [],
					onSome: (value) => paintsOf(context, value, new Set<AnyNode>())
				})
				for (const paint of Arr.filter(paints, (found) => isColorPaint(found.text))) {
					context.report({
						node: paint.node,
						message: `SVG ${name}="${paint.text}" is a second home for a palette color. ${SUGGESTION}`
					})
				}
			}
		}
	}
}
