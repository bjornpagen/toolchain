import { Array as Arr } from "effect"
import { advice, isDrizzleSqlTemplate } from "#oxlint/drizzle.ts"
import { type NodeOf, problem, type TypeNode } from "#oxlint/rule.ts"

/** Whether a written type is a number: `number`, a number literal, or a union with one. */
const containsNumber = (type: TypeNode): boolean => {
	if (type.type === "TSUnionType") {
		return Arr.some(type.types, containsNumber)
	}
	if (type.type !== "TSLiteralType") {
		return type.type === "TSNumberKeyword"
	}
	const literal = type.literal
	return (
		(literal.type === "Literal" && typeof literal.value === "number") ||
		(literal.type === "UnaryExpression" && literal.operator === "-")
	)
}

/** The types a tagged template's tag is instantiated with, none when it spells none. */
const typeArgumentsOf = (node: NodeOf<"TaggedTemplateExpression">): ReadonlyArray<TypeNode> => {
	const instantiation = node.typeArguments
	return instantiation === null || instantiation === undefined ? [] : instantiation.params
}

/** Whether a template's value is decoded by a real `.mapWith(decoder)` call: a property read or a type claim is no
 * decoder. */
const hasDecoder = (node: NodeOf<"TaggedTemplateExpression">): boolean => {
	const access = node.parent
	return (
		access.type === "MemberExpression" &&
		access.object === node &&
		!access.computed &&
		access.property.type === "Identifier" &&
		access.property.name === "mapWith" &&
		access.parent.type === "CallExpression" &&
		access.parent.callee === access &&
		Arr.isReadonlyArrayNonEmpty(access.parent.arguments)
	)
}

const MESSAGE = advice(
	"`sql<number>` is not a pg decoder: pg returns int8 and numeric as strings.",
	"Keep raw rows unknown and admit them with the owning schema, or decode with `.mapWith(…)` in a typed query builder."
)

/**
 * `sql<number>` is a claim, not a pg decoder: pg returns int8 and numeric as strings, so a template typed with a
 * number keeps its raw rows unknown and admits them with the owning schema, or decodes through `.mapWith(…)`. The type
 * is read as written: `number`, a number literal, or a union holding one.
 */
export const sqlNumberDecoder = problem((context) => ({
	TaggedTemplateExpression: (node) => {
		if (
			Arr.some(typeArgumentsOf(node), containsNumber) &&
			!hasDecoder(node) &&
			isDrizzleSqlTemplate(context, node)
		) {
			context.report({ node, message: MESSAGE })
		}
	}
}))
