import { Array as Arr, Option } from "effect"
import { type AnyNode, type Context, type NodeOf, refusal } from "#oxlint/rule.ts"
import { enclosingFunctionOf, testPathOf, valueOf } from "#oxlint/syntax.ts"

/** The modifiers that run one test or suite per row of a table. */
export const TABLES: ReadonlyArray<string> = ["each", "for"]

const isTablePath = (path: ReadonlyArray<string>): boolean =>
	Option.exists(Arr.last(path), (last) => Arr.contains(TABLES, last))

/** Rows written out: an array literal, or a `const` that holds one. */
const isRows = (context: Context, node: AnyNode): boolean =>
	valueOf(context, node).type === "ArrayExpression"

/** A suite's or a test's call that runs its body once: its callee spells a test's path, and no table's. */
const isTestCall = (context: Context, call: NodeOf<"CallExpression">): boolean =>
	Option.exists(testPathOf(context, call.callee), (path) => !isTablePath(path))

const FUNCTIONS: ReadonlyArray<AnyNode["type"]> = [
	"FunctionExpression",
	"ArrowFunctionExpression",
	"FunctionDeclaration"
]

/** The expressions a value passes through unchanged: TypeScript's annotations, parentheses and optional chaining. */
const TRANSPARENT: ReadonlyArray<AnyNode["type"]> = [
	"TSAsExpression",
	"TSSatisfiesExpression",
	"TSTypeAssertion",
	"TSNonNullExpression",
	"ChainExpression",
	"ParenthesizedExpression"
]

/** The positions where a function's body runs an expression as one of its steps: returned, a statement, yielded,
 * awaited. */
const STEPS: ReadonlyArray<AnyNode["type"]> = [
	"ReturnStatement",
	"ExpressionStatement",
	"YieldExpression",
	"AwaitExpression"
]

/**
 * Whether `node` runs as a suite's or a test's body, by one walk up from it: the test's call itself takes it as an
 * argument; any other call takes it, a wrapper that hands it on (`Effect.gen(function* () {})`,
 * `Effect.fn("name")(function* (ctx) {})`, `Effect.scoped(...)`, `Effect.runPromise(...)`), or a method of it builds a
 * result from it (`Effect.gen(...).pipe(Effect.scoped)`), whose result the walk goes on from; a function returns it as its expression body, or its body runs it as a step (a return, a statement, a yield, an
 * await, or a declaration's initializer that is no function), and the walk goes on from that function; a `const` holds
 * it, and the walk goes on from each read of the `const`. A function a body only calls by name, a helper, is neither
 * handed on nor run as a step, so its own body is no test's.
 */
const runsAsBody = (context: Context, node: AnyNode, seen: ReadonlySet<AnyNode>): boolean => {
	const parent = node.parent
	if (parent === null) {
		return false
	}
	if (parent.type === "CallExpression") {
		return (
			Arr.contains(parent.arguments, node) &&
			(isTestCall(context, parent) || runsAsBody(context, parent, seen))
		)
	}
	if (Arr.contains(TRANSPARENT, parent.type)) {
		return runsAsBody(context, parent, seen)
	}
	if (parent.type === "MemberExpression") {
		const call = parent.parent
		return (
			parent.object === node &&
			call.type === "CallExpression" &&
			call.callee === parent &&
			runsAsBody(context, call, seen)
		)
	}
	if (parent.type === "ArrowFunctionExpression") {
		return parent.body === node && runsAsBody(context, parent, seen)
	}
	if (Arr.contains(STEPS, parent.type)) {
		return Option.exists(enclosingFunctionOf(parent), (fn) => runsAsBody(context, fn, seen))
	}
	if (parent.type !== "VariableDeclarator" || parent.init !== node || seen.has(parent)) {
		return false
	}
	const held = new Set([...seen, parent])
	const read = Arr.some(context.sourceCode.getDeclaredVariables(parent), (variable) =>
		Arr.some(
			variable.references,
			(reference) => reference.isRead() && runsAsBody(context, reference.identifier, held)
		)
	)
	return (
		read ||
		(!Arr.contains(FUNCTIONS, node.type) &&
			Option.exists(enclosingFunctionOf(parent), (fn) => runsAsBody(context, fn, held)))
	)
}

/**
 * Example tables: a suite or test run per row of written-out rows (`it.each([...])`, `it.effect.each`, `describe.each`,
 * `test.for`, and their tagged-template tables), and a `for…of` over written-out rows in a suite's or a test's body:
 * any function the test runs as its body, its callback, the generator an `Effect.gen` or an `Effect.fn("name")` it
 * hands the test makes, and whatever further wrapper hands a function on (runsAsBody).
 * Fixed inputs paired with expected outputs check only the rows someone thought of.
 */
export const noExampleTable = refusal(
	"exampleTable",
	"This is an example table: fixed inputs paired with expected outputs check only the rows someone thought of. State the property over the whole finite space with exhaust over element([...]), or over generated inputs with explore.",
	(context, refuse) => ({
		CallExpression: (node) => {
			if (
				Option.exists(testPathOf(context, node.callee), isTablePath) &&
				Option.exists(Arr.head(node.arguments), (rows) => isRows(context, rows))
			) {
				refuse(node)
			}
		},
		TaggedTemplateExpression: (node) => {
			if (Option.exists(testPathOf(context, node.tag), isTablePath)) {
				refuse(node)
			}
		},
		ForOfStatement: (node) => {
			if (
				isRows(context, node.right) &&
				Option.exists(enclosingFunctionOf(node), (fn) => runsAsBody(context, fn, new Set()))
			) {
				refuse(node)
			}
		}
	})
)
