import { Array as Arr, Schema } from "effect"
import { advice, authoredSqlOf, isAtAny, isDrizzleSqlTemplate } from "#oxlint/drizzle.ts"
import { configured } from "#oxlint/rule.ts"
import { hasJsonOperator } from "#oxlint/sql-text.ts"

/** The JSON leaves: repository-relative paths, a directory's ending in "/". */
const Options = Schema.Struct({ owners: Schema.Array(Schema.String) })

/** The JSON operators (`->`, `->>`, `#>`, `#>>`) and the jsonb expansion functions render in exactly one kind of file:
 * the JSON leaves the options name, which hold their typed functions. */
export const sqlJsonOwner = configured(Options, (context, options) => {
	if (isAtAny(context.filename, options.owners)) {
		return {}
	}
	const message = advice(
		"A JSON operator or expansion renders only in a JSON leaf.",
		`Call a typed JSON function of a JSON leaf (this rule's owners: ${Arr.join(options.owners, ", ")}).`
	)
	return {
		TaggedTemplateExpression: (node) => {
			if (hasJsonOperator(authoredSqlOf(node.quasi)) && isDrizzleSqlTemplate(context, node)) {
				context.report({ node, message })
			}
		}
	}
})
