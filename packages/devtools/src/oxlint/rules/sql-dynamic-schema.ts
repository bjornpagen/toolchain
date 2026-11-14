import { Array as Arr, Option, Schema } from "effect"
import {
	advice,
	initializersOf,
	isDrizzleExport,
	isEnclosedByFunction,
	unwrapped,
	variableOf
} from "#oxlint/drizzle.ts"
import { type Context, configured, type Expression, isFileAt, type NodeOf } from "#oxlint/rule.ts"

/** The top-level arrow functions that may build a table from a computed column map: session-local relations derived
 * from static declarations, each by its owner's repository-relative path and the name it is declared under. */
const Options = Schema.Struct({
	tableFactories: Schema.Array(Schema.Struct({ owner: Schema.String, declaration: Schema.String }))
})

/** Whether a table constructor's column map is not one static object: a computed map, a spread or a computed name. */
const hasDynamicColumns = (call: NodeOf<"CallExpression">): boolean => {
	const columns = call.arguments[1]
	return (
		columns?.type !== "ObjectExpression" ||
		Arr.some(
			columns.properties,
			(property) => property.type === "SpreadElement" || property.computed
		)
	)
}

/** Whether an expression is a call of one of Drizzle's exports, by import. */
const callsDrizzle = (
	context: Context,
	expression: Expression,
	names: ReadonlyArray<string>
): boolean => {
	const inner = unwrapped(expression)
	return inner.type === "CallExpression" && isDrizzleExport(context, inner.callee, names)
}

/** Whether a binding of this file is declared with a call of one of Drizzle's exports. */
const boundToCall = (context: Context, node: Expression, names: ReadonlyArray<string>): boolean =>
	node.type === "Identifier" &&
	Option.exists(variableOf(context, node), (variable) =>
		Arr.some(initializersOf(variable), (init) => callsDrizzle(context, init, names))
	)

const TABLE = advice(
	"A table and its columns are declared directly, in one static object at the top level; table and column-shape factories and spreads are forbidden.",
	"Declare the table with a literal column object at the top level of its schema module."
)

const SCHEMA = advice(
	"A schema's identity is a static literal declared at the top level.",
	'Call `pgSchema("name")` with a string literal at the top level of its module.'
)

/**
 * A Drizzle schema is static: each table is declared at the top level with a literal column object (no factory, no
 * spread, no computed name), and each `pgSchema` names a literal at the top level. A table constructor is known by
 * import: Drizzle's `pgTable` and `pgTableCreator`, a table function this file makes with `pgTableCreator`, and the
 * `table` of a schema this file makes with `pgSchema`. The table factories the options name are exempt: top-level
 * arrow functions in their owner that build a session-local relation from static declarations.
 */
export const sqlDynamicSchema = configured(Options, (context, options) => {
	const factories = Arr.filter(options.tableFactories, (factory) =>
		isFileAt(context.filename, factory.owner)
	)
	const isDeclaredFactory = (call: NodeOf<"CallExpression">): boolean => {
		const enclosing = call.parent
		if (
			enclosing.type !== "ArrowFunctionExpression" ||
			enclosing.body !== call ||
			enclosing.parent.type !== "VariableDeclarator" ||
			enclosing.parent.id.type !== "Identifier"
		) {
			return false
		}
		const declared = enclosing.parent.id.name
		return Arr.some(factories, (factory) => factory.declaration === declared)
	}
	const isTableConstructor = (callee: Expression): boolean =>
		isDrizzleExport(context, callee, ["pgTable", "pgTableCreator"]) ||
		boundToCall(context, callee, ["pgTableCreator"]) ||
		(callee.type === "MemberExpression" &&
			!callee.computed &&
			callee.property.type === "Identifier" &&
			callee.property.name === "table" &&
			boundToCall(context, callee.object, ["pgSchema"]))
	return {
		CallExpression: (node) => {
			if (
				isTableConstructor(node.callee) &&
				!isDeclaredFactory(node) &&
				(isEnclosedByFunction(node) || hasDynamicColumns(node))
			) {
				context.report({ node, message: TABLE })
			}
			const [identity] = node.arguments
			if (
				isDrizzleExport(context, node.callee, ["pgSchema"]) &&
				(isEnclosedByFunction(node) ||
					identity === undefined ||
					!(
						(identity.type === "Literal" && typeof identity.value === "string") ||
						(identity.type === "TemplateLiteral" &&
							!Arr.isReadonlyArrayNonEmpty(identity.expressions))
					))
			) {
				context.report({ node, message: SCHEMA })
			}
		}
	}
})
