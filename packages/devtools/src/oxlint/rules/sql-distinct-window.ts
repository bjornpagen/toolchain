import { Array as Arr, Option } from "effect"
import { advice, authoredSqlOf, isDrizzleSqlTemplate } from "#oxlint/drizzle.ts"
import { problem } from "#oxlint/rule.ts"
import { hasWindowExpression } from "#oxlint/sql-text.ts"

/** The distinct selections, with the position of their field object among the arguments. */
const DISTINCT_FIELDS: ReadonlyMap<string, number> = new Map([
	["selectDistinct", 0],
	["selectDistinctOn", 1]
])

const MESSAGE = advice(
	"A window value in a DISTINCT selection becomes part of the distinct key, so the rows it numbers are never deduplicated.",
	"Deduplicate the relation first, then number its rows."
)

/**
 * A distinct Drizzle selection selects no window value: a row number or other window computed in the DISTINCT list
 * becomes part of the distinct key, so the rows it numbers are never deduplicated. Deduplicate first, then number. A
 * selection is distinct by its method's name, `selectDistinct` or `selectDistinctOn`, and its field is a Drizzle `sql`
 * template written in place.
 */
export const sqlDistinctWindow = problem((context) => ({
	CallExpression: (node) => {
		const callee = node.callee
		if (
			callee.type !== "MemberExpression" ||
			callee.computed ||
			callee.property.type !== "Identifier"
		) {
			return
		}
		const fields = Option.flatMap(
			Option.fromUndefinedOr(DISTINCT_FIELDS.get(callee.property.name)),
			(index) => Arr.get(node.arguments, index)
		)
		if (Option.isNone(fields) || fields.value.type !== "ObjectExpression") {
			return
		}
		for (const property of fields.value.properties) {
			if (
				property.type === "Property" &&
				isDrizzleSqlTemplate(context, property.value) &&
				hasWindowExpression(authoredSqlOf(property.value.quasi))
			) {
				context.report({ node: property.value, message: MESSAGE })
			}
		}
	}
}))
