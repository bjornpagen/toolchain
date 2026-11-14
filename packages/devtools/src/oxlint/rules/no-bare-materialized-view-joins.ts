import { Array as Arr, Option, Schema } from "effect"
import {
	advice,
	importedAt,
	initializersOf,
	isDrizzleExport,
	unwrapped,
	variableOf
} from "#oxlint/drizzle.ts"
import { type AnyNode, type Context, configured, type Expression } from "#oxlint/rule.ts"

/** The repository's modules that export materialized views: the specifiers a file imports one under, and the views'
 * export names. */
const Options = Schema.Struct({
	modules: Schema.Array(
		Schema.Struct({ specifiers: Schema.Array(Schema.String), views: Schema.Array(Schema.String) })
	)
})

type Options = typeof Options.Type

const JOIN_METHODS: ReadonlyArray<string> = [
	"innerJoin",
	"leftJoin",
	"rightJoin",
	"fullJoin",
	"crossJoin",
	"innerJoinLateral",
	"leftJoinLateral",
	"crossJoinLateral"
]

/** Whether an expression builds a materialized view: Drizzle's `pgMaterializedView(…)`, by import, and the steps
 * chained onto it (`.existing()`, `.as(…)`, `.with(…)`). */
const buildsView = (context: Context, expression: Expression): boolean => {
	const inner = unwrapped(expression)
	if (inner.type !== "CallExpression") {
		return false
	}
	if (isDrizzleExport(context, inner.callee, ["pgMaterializedView"])) {
		return true
	}
	return inner.callee.type === "MemberExpression" && buildsView(context, inner.callee.object)
}

/** Whether an expression is a materialized view: one this file builds and binds, followed through copies, or one
 * the options name, imported by name or read off a namespace import. A cyclic binding ends the walk. */
const isMaterializedView = (
	context: Context,
	options: Options,
	expression: Expression,
	seen: Set<AnyNode>
): boolean => {
	const inner = unwrapped(expression)
	if (seen.has(inner)) {
		return false
	}
	seen.add(inner)
	const listed = Option.exists(importedAt(context, inner), (imported) =>
		Arr.some(
			options.modules,
			(module) =>
				Arr.contains(module.specifiers, imported.specifier) &&
				Arr.contains(module.views, imported.name)
		)
	)
	if (listed) {
		return true
	}
	return (
		inner.type === "Identifier" &&
		Option.exists(variableOf(context, inner), (variable) =>
			Arr.some(
				initializersOf(variable),
				(init) => buildsView(context, init) || isMaterializedView(context, options, init, seen)
			)
		)
	)
}

const MESSAGE = advice(
	"A bare materialized-view join loses its native dependency provenance when nested.",
	"Join `db.select().from(view).as(getViewName(view))`, so the native FROM relation survives."
)

/**
 * A materialized view is joined through a subquery, never bare: Drizzle's native view JOIN rendering drops the
 * relation node when it is nested, which loses the view's dependency provenance before CTE and summary dependency
 * admission. A view is known by import: built in this file by Drizzle's `pgMaterializedView`, or imported from a module
 * the options name.
 */
export const noBareMaterializedViewJoins = configured(Options, (context, options) => ({
	CallExpression: (node) => {
		const callee = node.callee
		if (
			callee.type !== "MemberExpression" ||
			callee.computed ||
			callee.property.type !== "Identifier" ||
			!Arr.contains(JOIN_METHODS, callee.property.name)
		) {
			return
		}
		const [joined] = node.arguments
		if (
			joined !== undefined &&
			joined.type !== "SpreadElement" &&
			isMaterializedView(context, options, joined, new Set())
		) {
			context.report({ node: joined, message: MESSAGE })
		}
	}
}))
