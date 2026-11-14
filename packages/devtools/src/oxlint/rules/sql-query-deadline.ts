import { Array as Arr, Option, Schema } from "effect"
import { advice, importedAt, isAtAny } from "#oxlint/drizzle.ts"
import { type AnyNode, type Context, configured, isFileAt, type NodeOf } from "#oxlint/rule.ts"

/**
 * Where database deadlines are refused: the files read (repository-relative paths, a directory's ending in "/"), the
 * property names that set a deadline, the string literals that refuse work by elapsed time, and the deadlines admitted.
 * An admitted deadline is the property set in its owner, inside `new construction(…)`, to
 * `subject === principals.principal ? constant : false`, where the owner imports the constant under its specifier.
 */
const Options = Schema.Struct({
	files: Schema.Array(Schema.String),
	properties: Schema.Array(Schema.String),
	refusals: Schema.Array(Schema.String),
	admitted: Schema.Array(
		Schema.Struct({
			owner: Schema.String,
			property: Schema.String,
			construction: Schema.String,
			guard: Schema.Struct({
				subject: Schema.String,
				principals: Schema.String,
				principal: Schema.String
			}),
			value: Schema.Struct({ specifier: Schema.String, constant: Schema.String })
		})
	)
})

type AdmittedDeadline = (typeof Options.Type)["admitted"][number]

/** The text of a name written as an identifier or a string literal. */
const literalTextOf = (node: AnyNode): Option.Option<string> => {
	if (node.type === "Identifier") {
		return Option.some(node.name)
	}
	return node.type === "Literal" && typeof node.value === "string"
		? Option.some(node.value)
		: Option.none()
}

/** The text of a string literal, or of a template with no interpolation. */
const stringTextOf = (node: AnyNode): Option.Option<string> => {
	if (node.type === "Literal" && typeof node.value === "string") {
		return Option.some(node.value)
	}
	if (node.type !== "TemplateLiteral" || Arr.isReadonlyArrayNonEmpty(node.expressions)) {
		return Option.none()
	}
	return Option.map(Arr.head(node.quasis), (quasi) => quasi.value.cooked ?? quasi.value.raw)
}

/** Whether a property is an admitted deadline: in its owner, inside `new construction(…)`, the property set to
 * `subject === principals.principal ? constant : false`, the constant imported under its specifier. */
const isAdmittedDeadline = (
	context: Context,
	admitted: AdmittedDeadline,
	node: NodeOf<"Property">
): boolean => {
	const value = node.value
	if (
		!Option.contains(literalTextOf(node.key), admitted.property) ||
		value.type !== "ConditionalExpression"
	) {
		return false
	}
	const { test, consequent, alternate } = value
	const allocation = node.parent.parent
	return (
		test.type === "BinaryExpression" &&
		test.operator === "===" &&
		test.right.type === "MemberExpression" &&
		!test.right.computed &&
		Option.contains(literalTextOf(test.left), admitted.guard.subject) &&
		Option.contains(literalTextOf(test.right.object), admitted.guard.principals) &&
		Option.contains(literalTextOf(test.right.property), admitted.guard.principal) &&
		alternate.type === "Literal" &&
		alternate.value === false &&
		Option.exists(
			importedAt(context, consequent),
			(imported) =>
				imported.specifier === admitted.value.specifier && imported.name === admitted.value.constant
		) &&
		allocation?.type === "NewExpression" &&
		Option.contains(literalTextOf(allocation.callee), admitted.construction)
	)
}

const SETTING = advice(
	"A database query or checkout deadline terminates admitted work.",
	"Remove the timeout option; performance targets do not terminate admitted work."
)

const REFUSAL = advice(
	"An elapsed-time database refusal terminates admitted work.",
	"Remove the refusal; keep real cancellation and native settlement."
)

/**
 * Database code sets no deadline on admitted work: no property that sets a query, statement, lock or checkout timeout,
 * and no refusal by elapsed time, in the files the options name. A deadline the options admit (a reader's startup
 * bound, which survives an orphaned host) is the one exception.
 */
export const sqlQueryDeadline = configured(Options, (context, options) => {
	const { files, properties, refusals, admitted } = options
	if (!isAtAny(context.filename, files)) {
		return {}
	}
	const deadlines = [...properties, ...refusals]
	const admittedHere = Arr.filter(admitted, (entry) => isFileAt(context.filename, entry.owner))
	const setsDeadline = (key: AnyNode): boolean =>
		Option.exists(literalTextOf(key), (name) => Arr.contains(deadlines, name))
	const refuses = (node: AnyNode): void => {
		if (Option.exists(stringTextOf(node), (text) => Arr.contains(refusals, text))) {
			context.report({ node, message: REFUSAL })
		}
	}
	return {
		Property: (node) => {
			if (
				node.parent.type === "ObjectExpression" &&
				!node.computed &&
				setsDeadline(node.key) &&
				!Arr.some(admittedHere, (entry) => isAdmittedDeadline(context, entry, node))
			) {
				context.report({ node, message: SETTING })
			}
		},
		TSPropertySignature: (node) => {
			if (!node.computed && setsDeadline(node.key)) {
				context.report({ node, message: SETTING })
			}
		},
		Literal: refuses,
		TemplateLiteral: refuses
	}
})
