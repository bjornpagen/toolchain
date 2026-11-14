import { Array as Arr, Option } from "effect"
import {
	advice,
	initializersOf,
	interpolationsOf,
	isDrizzleExport,
	isDrizzleSqlTemplate,
	unwrapped,
	variableOf
} from "#oxlint/drizzle.ts"
import { type AnyNode, type Context, type Expression, type NodeOf, problem } from "#oxlint/rule.ts"
import { closesWithWord } from "#oxlint/sql-text.ts"

/** The object literal an expression is declared with in this file: one written in place, a binding's, or a property's
 * of another, followed through copies. */
const objectLiteralOf = (
	context: Context,
	expression: Expression,
	seen: Set<AnyNode>
): ReadonlyArray<NodeOf<"ObjectExpression">> => {
	const inner = unwrapped(expression)
	if (seen.has(inner)) {
		return []
	}
	seen.add(inner)
	if (inner.type === "ObjectExpression") {
		return [inner]
	}
	if (inner.type === "Identifier") {
		return Option.match(variableOf(context, inner), {
			onNone: () => [],
			onSome: (variable) =>
				Arr.flatMap(initializersOf(variable), (init) => objectLiteralOf(context, init, seen))
		})
	}
	if (
		inner.type === "MemberExpression" &&
		!inner.computed &&
		inner.property.type === "Identifier"
	) {
		const name = inner.property.name
		return Arr.flatMap(objectLiteralOf(context, inner.object, seen), (object) =>
			Arr.flatMap(object.properties, (property) =>
				property.type === "Property" &&
				!property.computed &&
				property.key.type === "Identifier" &&
				property.key.name === name
					? objectLiteralOf(context, property.value, seen)
					: []
			)
		)
	}
	return []
}

/**
 * Whether an expression holds a Drizzle table alias. An alias proxy erases its origin from the table's type, and a
 * rule here reads no types at all, so the authored declarations of this file are followed instead: a direct `alias(…)`
 * call (Drizzle's, by import), either branch of a conditional, and copied bindings and object properties keep the
 * constructor's provenance. A cyclic binding ends the walk. An alias imported from another module is past what one
 * file's syntax shows.
 */
const comesFromTableAlias = (
	context: Context,
	expression: Expression,
	seen: Set<AnyNode>
): boolean => {
	const inner = unwrapped(expression)
	if (seen.has(inner)) {
		return false
	}
	seen.add(inner)
	if (inner.type === "CallExpression") {
		return isDrizzleExport(context, inner.callee, ["alias"])
	}
	if (inner.type === "ConditionalExpression") {
		return (
			comesFromTableAlias(context, inner.consequent, seen) ||
			comesFromTableAlias(context, inner.alternate, seen)
		)
	}
	if (inner.type === "Identifier") {
		return Option.exists(variableOf(context, inner), (variable) =>
			Arr.some(initializersOf(variable), (init) => comesFromTableAlias(context, init, seen))
		)
	}
	if (inner.type !== "MemberExpression" || inner.computed || inner.property.type !== "Identifier") {
		return false
	}
	const name = inner.property.name
	return Arr.some(objectLiteralOf(context, inner.object, new Set()), (object) =>
		Arr.some(
			object.properties,
			(property) =>
				property.type === "Property" &&
				!property.computed &&
				property.key.type === "Identifier" &&
				property.key.name === name &&
				comesFromTableAlias(context, property.value, seen)
		)
	)
}

const AS: ReadonlyArray<string> = ["as"]

const MESSAGE = advice(
	"A Drizzle alias interpolates only its alias name, not the relation it aliases.",
	"Use QueryBuilder.from/join(alias), a template that interpolates the base relation, the word as, then the alias, or the alias's typed columns."
)

/**
 * A Drizzle table alias interpolated into a `sql` template renders only its alias name, not the relation it aliases,
 * unless it follows `as` (`${base} as ${alias}`, which declares it).
 */
export const sqlAliasedTableReference = problem((context) => ({
	TaggedTemplateExpression: (node) => {
		if (
			!Arr.isReadonlyArrayNonEmpty(node.quasi.expressions) ||
			!isDrizzleSqlTemplate(context, node)
		) {
			return
		}
		for (const { expression, before } of interpolationsOf(node.quasi)) {
			if (!closesWithWord(before, AS) && comesFromTableAlias(context, expression, new Set())) {
				context.report({ node: expression, message: MESSAGE })
			}
		}
	}
}))
