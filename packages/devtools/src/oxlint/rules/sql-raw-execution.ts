import { Array as Arr, Option, Schema } from "effect"
import {
	advice,
	importedAt,
	initializersOf,
	isAtAny,
	isDrizzleExport,
	isDrizzleModule,
	isDrizzleSqlTemplate,
	isValueOf,
	topLevelNameOf,
	unwrapped,
	variableOf
} from "#oxlint/drizzle.ts"
import {
	type AnyNode,
	type Context,
	configured,
	type Expression,
	isFileAt,
	type NodeOf
} from "#oxlint/rule.ts"

/**
 * Who may execute statements: the statement-custody files that run native builders and prepared queries, the files
 * that may run a pg-copy-streams COPY, the files that hold a native client and may call pg's `query` (each by
 * repository-relative path, a directory's ending in "/"), and the executors whose one reviewed statement may run
 * through Drizzle's `execute`: in the executor declared at the top level of the owner, `execute(statement(…))` with the
 * statement declared at the top level of the same owner.
 */
const Options = Schema.Struct({
	statementOwners: Schema.Array(Schema.String),
	copyStreamOwners: Schema.Array(Schema.String),
	nativeClientOwners: Schema.Array(Schema.String),
	declaredExecutions: Schema.Array(
		Schema.Struct({ owner: Schema.String, executor: Schema.String, statement: Schema.String })
	)
})

const isPgModule = (specifier: string): boolean => specifier === "pg"

const isCopyStreamModule = (specifier: string): boolean => specifier === "pg-copy-streams"

/** An arrow, or a function declaration or expression, whose node type is one with the bodiless declarations
 * TypeScript adds, which isFunction leaves out. */
type FunctionNode =
	| NodeOf<"ArrowFunctionExpression">
	| Extract<
			AnyNode,
			{
				type:
					| "FunctionDeclaration"
					| "FunctionExpression"
					| "TSDeclareFunction"
					| "TSEmptyBodyFunctionExpression"
			}
	  >

const isFunction = (node: AnyNode): node is FunctionNode =>
	node.type === "ArrowFunctionExpression" ||
	node.type === "FunctionExpression" ||
	node.type === "FunctionDeclaration"

/** The functions a binding of this file declares: a function declaration, or a variable declared with one. */
const functionsOf = (context: Context, callee: Expression): ReadonlyArray<FunctionNode> =>
	callee.type === "Identifier"
		? Option.match(variableOf(context, callee), {
				onNone: () => [],
				onSome: (variable) => [
					...Arr.filter(initializersOf(variable), isFunction),
					...Arr.flatMap(variable.defs, (def) =>
						def.type === "FunctionName" && def.node.type === "FunctionDeclaration" ? [def.node] : []
					)
				]
			})
		: []

/**
 * Whether an expression is SQL as the file shows it: a Drizzle `sql` template, a call of one of `sql`'s helpers
 * (`sql.join`, `sql.raw`), a binding declared with one, or a call of a function of this file that returns one. A
 * cyclic binding ends the walk.
 */
const isSqlValue = (context: Context, expression: Expression, seen: Set<AnyNode>): boolean => {
	const inner = unwrapped(expression)
	if (seen.has(inner)) {
		return false
	}
	seen.add(inner)
	if (isDrizzleSqlTemplate(context, inner)) {
		return true
	}
	if (inner.type === "Identifier") {
		return Option.exists(variableOf(context, inner), (variable) =>
			Arr.some(initializersOf(variable), (init) => isSqlValue(context, init, seen))
		)
	}
	if (inner.type !== "CallExpression") {
		return false
	}
	const callee = inner.callee
	if (callee.type === "MemberExpression" && isDrizzleExport(context, callee.object, ["sql"])) {
		return true
	}
	return Arr.some(functionsOf(context, callee), (fn) => {
		const body = fn.body
		if (body === null) {
			return false
		}
		if (body.type !== "BlockStatement") {
			return isSqlValue(context, body, seen)
		}
		return Arr.some(
			body.body,
			(statement) =>
				statement.type === "ReturnStatement" &&
				statement.argument !== null &&
				isSqlValue(context, statement.argument, seen)
		)
	})
}

/** Whether a receiver is a Drizzle database, as the file shows it: the value of Drizzle's `drizzle(…)`, by import,
 * bound and copied in this file. */
const isDatabase = (context: Context, expression: Expression, seen: Set<AnyNode>): boolean => {
	const inner = unwrapped(expression)
	if (seen.has(inner)) {
		return false
	}
	seen.add(inner)
	if (inner.type === "CallExpression") {
		return isDrizzleExport(context, inner.callee, ["drizzle"])
	}
	return (
		inner.type === "Identifier" &&
		Option.exists(variableOf(context, inner), (variable) =>
			Arr.some(initializersOf(variable), (init) => isDatabase(context, init, seen))
		)
	)
}

/** Whether a receiver is a pg client: Drizzle's `$client`, or a pg value as the file shows it (src/oxlint/drizzle.ts). */
const isPgClient = (context: Context, receiver: Expression): boolean =>
	(receiver.type === "MemberExpression" &&
		!receiver.computed &&
		receiver.property.type === "Identifier" &&
		receiver.property.name === "$client") ||
	isValueOf(context, receiver, isPgModule, new Set())

const MESSAGE = advice(
	"Statements execute only through statement custody: native builders and prepared queries run in a statement owner, and only declared executions issue their reviewed statement.",
	"Run the statement through the statement owner's scope (this rule's options)."
)

/**
 * Statements execute only through statement custody. A Drizzle `execute` (a builder's, a prepared query's, or a
 * database's `execute(sql)`) runs only in a statement owner, which runs native builders and prepared queries, or as a
 * declared execution: in its executor, `execute(statement(…))` with the statement declared in the same owner. pg's
 * `query` runs only in a native client owner, or as a pg-copy-streams COPY in a copy-stream owner.
 *
 * Without types, a call is known by what the file shows: an `execute` is Drizzle's when it is handed SQL (a Drizzle
 * `sql` template, or a function of this file that returns one) or its receiver is a Drizzle value of this file, and a
 * statement owner's `execute` is a native one when it is handed no SQL and its receiver is no `drizzle(…)` database; a
 * `query` is pg's when its receiver is Drizzle's `$client` or a pg value of this file. An `execute` or `query` on a
 * receiver the file does not trace, handed no SQL, is no evidence, so an HTTP client's `execute` stays out.
 */
export const sqlRawExecution = configured(Options, (context, options) => {
	const { filename } = context
	const statementOwner = isAtAny(filename, options.statementOwners)
	const copyStreamOwner = isAtAny(filename, options.copyStreamOwners)
	const nativeClientOwner = isAtAny(filename, options.nativeClientOwners)
	const declared = Arr.filter(options.declaredExecutions, (execution) =>
		isFileAt(filename, execution.owner)
	)

	const isDeclaredExecution = (call: NodeOf<"CallExpression">): boolean => {
		const [statement, extra] = call.arguments
		if (
			statement === undefined ||
			extra !== undefined ||
			statement.type !== "CallExpression" ||
			statement.callee.type !== "Identifier"
		) {
			return false
		}
		const name = statement.callee.name
		const declaredHere = Option.exists(
			variableOf(context, statement.callee),
			(variable) =>
				variable.scope.type === "module" &&
				Arr.every(variable.defs, (def) => def.type !== "ImportBinding")
		)
		return (
			declaredHere &&
			Arr.some(
				declared,
				(execution) =>
					execution.statement === name && Option.contains(topLevelNameOf(call), execution.executor)
			)
		)
	}

	const isCopyStream = (call: NodeOf<"CallExpression">): boolean => {
		const [copy, extra] = call.arguments
		return (
			copyStreamOwner &&
			copy !== undefined &&
			extra === undefined &&
			copy.type === "CallExpression" &&
			Option.exists(importedAt(context, copy.callee), (imported) =>
				isCopyStreamModule(imported.specifier)
			)
		)
	}

	return {
		CallExpression: (node) => {
			const callee = node.callee
			if (
				callee.type !== "MemberExpression" ||
				callee.computed ||
				callee.property.type !== "Identifier"
			) {
				return
			}
			const receiver = callee.object
			if (callee.property.name === "execute") {
				const [first, extra] = node.arguments
				const handedSql =
					first !== undefined &&
					extra === undefined &&
					first.type !== "SpreadElement" &&
					isSqlValue(context, first, new Set())
				if (!handedSql && !isValueOf(context, receiver, isDrizzleModule, new Set())) {
					return
				}
				const native =
					statementOwner &&
					!handedSql &&
					node.arguments.length <= 1 &&
					!isDatabase(context, receiver, new Set())
				if (!native && !isDeclaredExecution(node)) {
					context.report({ node, message: MESSAGE })
				}
			}
			if (
				callee.property.name === "query" &&
				isPgClient(context, receiver) &&
				!nativeClientOwner &&
				!isCopyStream(node)
			) {
				context.report({ node, message: MESSAGE })
			}
		}
	}
})
