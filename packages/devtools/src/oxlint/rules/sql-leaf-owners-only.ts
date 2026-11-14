import { Array as Arr, Schema } from "effect"
import { advice, isAtAny, isDrizzleSqlTemplate } from "#oxlint/drizzle.ts"
import { configured } from "#oxlint/rule.ts"

/** The leaf files that may write Drizzle `sql` templates: repository-relative paths, a directory's ending in "/". */
const Options = Schema.Struct({ owners: Schema.Array(Schema.String) })

/**
 * A Drizzle `sql` template is written only in a typed SQL leaf, one of the owners the options name: readers and
 * schemas compose native builders, and a missing operator becomes a typed function of a leaf. The template is Drizzle's
 * when its tag is `sql` imported from drizzle-orm.
 */
export const sqlLeafOwnersOnly = configured(Options, (context, options) => {
	if (isAtAny(context.filename, options.owners)) {
		return {}
	}
	const message = advice(
		"A Drizzle `sql` template is written only in a typed SQL leaf; readers and schemas compose native builders.",
		`Move the missing operator into a typed function of a SQL leaf (this rule's owners: ${Arr.join(options.owners, ", ")}).`
	)
	return {
		TaggedTemplateExpression: (node) => {
			if (isDrizzleSqlTemplate(context, node)) {
				context.report({ node, message })
			}
		}
	}
})
