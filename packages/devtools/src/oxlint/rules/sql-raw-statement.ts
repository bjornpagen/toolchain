import { Array as Arr, Option, Schema } from "effect"
import {
	advice,
	authoredSqlOf,
	isAtAny,
	isDrizzleExport,
	isDrizzleSqlTemplate,
	topLevelNameOf
} from "#oxlint/drizzle.ts"
import { type Context, configured, type Expression, isFileAt, type NodeOf } from "#oxlint/rule.ts"
import { collapseWhitespace, hasStatementGrammar } from "#oxlint/sql-text.ts"

/**
 * The statement grammar admitted in a `sql` template: the files that hold the recursive envelope
 * (`with recursive ${join} ${builder}`) and the projection envelope (`${builder.getSQL()} offset 0`), by
 * repository-relative path, a directory's ending in "/", and the declared statements, each a top-level declaration of
 * its owner whose templates' authored grammar, whitespace collapsed, is exactly its grammar.
 */
const Options = Schema.Struct({
	recursiveEnvelopeOwners: Schema.Array(Schema.String),
	projectionEnvelopeOwners: Schema.Array(Schema.String),
	declaredStatements: Schema.Array(
		Schema.Struct({ owner: Schema.String, declaration: Schema.String, grammar: Schema.String })
	)
})

/** The text of a template's part at `index`, none past its last. */
const partAt = (template: NodeOf<"TemplateLiteral">, index: number): Option.Option<string> =>
	Option.map(Arr.get(template.quasis, index), (quasi) => quasi.value.cooked ?? quasi.value.raw)

/** Whether an expression is a call of Drizzle's `sql.join`, by import. */
const isSqlJoin = (context: Context, expression: Expression): boolean =>
	expression.type === "CallExpression" &&
	expression.callee.type === "MemberExpression" &&
	!expression.callee.computed &&
	expression.callee.property.type === "Identifier" &&
	expression.callee.property.name === "join" &&
	isDrizzleExport(context, expression.callee.object, ["sql"])

/** Whether an expression is a native builder's value, as far as syntax shows: a binding, a member or a call chain,
 * never a template or a literal, whose grammar the rule would have to read. */
const isBuilderValue = (expression: Expression): boolean =>
	expression.type === "Identifier" ||
	expression.type === "MemberExpression" ||
	expression.type === "CallExpression"

/**
 * Drizzle has no recursive declaration syntax. The envelope it needs is admitted exactly: `with recursive `, a Drizzle
 * `sql.join` of the declarations, then a native builder, and nothing else. Every declaration template it joins is
 * still inspected on its own, so the envelope admits no authored SELECT, UNION, predicate or execution.
 */
const isRecursiveEnvelope = (context: Context, template: NodeOf<"TemplateLiteral">): boolean => {
	const [entries, result, extra] = template.expressions
	return (
		Option.contains(partAt(template, 0), "with recursive ") &&
		Option.contains(partAt(template, 1), " ") &&
		Option.contains(partAt(template, 2), "") &&
		entries !== undefined &&
		result !== undefined &&
		extra === undefined &&
		isSqlJoin(context, entries) &&
		isBuilderValue(result)
	)
}

/** Drizzle leaves out a numeric `offset 0`. The projection boundary around a native builder is admitted exactly:
 * `${builder.getSQL()} offset 0`. */
const isProjectionEnvelope = (template: NodeOf<"TemplateLiteral">): boolean => {
	const [query, extra] = template.expressions
	return (
		Option.contains(partAt(template, 0), "") &&
		Option.contains(partAt(template, 1), " offset 0") &&
		query !== undefined &&
		extra === undefined &&
		query.type === "CallExpression" &&
		!Arr.isReadonlyArrayNonEmpty(query.arguments) &&
		query.callee.type === "MemberExpression" &&
		!query.callee.computed &&
		query.callee.property.type === "Identifier" &&
		query.callee.property.name === "getSQL"
	)
}

const RAW = advice(
	"`sql.raw` is forbidden.",
	"Use a native query builder or a fixed typed scalar expression."
)

const STATEMENT = advice(
	"A handwritten data statement, subquery or statement fragment in a `sql` template; `sql` templates express only narrow scalar or boolean gaps.",
	"Compose Drizzle's native fluent builders, or declare the reviewed statement in this rule's declaredStatements."
)

/**
 * A Drizzle `sql` template writes no statement grammar: no data command (SELECT, INSERT, UPDATE, DELETE, MERGE, DDL,
 * GRANT, a set operation), and no opening clause, sided join or grouping. `sql.raw` is refused wherever it is read.
 * The options admit the native gaps exactly: the recursive and projection envelopes in their owners, and each
 * declared statement, a top-level declaration of its owner whose authored grammar is exactly its grammar.
 */
export const sqlRawStatement = configured(Options, (context, options) => {
	const { filename } = context
	const recursive = isAtAny(filename, options.recursiveEnvelopeOwners)
	const projection = isAtAny(filename, options.projectionEnvelopeOwners)
	const declared = Arr.filter(options.declaredStatements, (statement) =>
		isFileAt(filename, statement.owner)
	)
	const isAdmitted = (node: NodeOf<"TaggedTemplateExpression">, authored: string): boolean =>
		(recursive && isRecursiveEnvelope(context, node.quasi)) ||
		(projection && isProjectionEnvelope(node.quasi)) ||
		Arr.some(
			declared,
			(statement) =>
				Option.contains(topLevelNameOf(node), statement.declaration) &&
				collapseWhitespace(authored) === statement.grammar
		)
	return {
		MemberExpression: (node) => {
			if (
				!node.computed &&
				node.property.type === "Identifier" &&
				node.property.name === "raw" &&
				isDrizzleExport(context, node.object, ["sql"])
			) {
				context.report({ node: node.property, message: RAW })
			}
		},
		TaggedTemplateExpression: (node) => {
			const authored = authoredSqlOf(node.quasi)
			if (
				hasStatementGrammar(authored) &&
				isDrizzleSqlTemplate(context, node) &&
				!isAdmitted(node, authored)
			) {
				context.report({ node, message: STATEMENT })
			}
		}
	}
})
