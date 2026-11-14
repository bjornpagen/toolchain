import { Array as Arr } from "effect"
import { advice, isDrizzleModule, isValueOf } from "#oxlint/drizzle.ts"
import { type Expression, type NodeOf, problem } from "#oxlint/rule.ts"

/** Each column-taking builder method, with how many arguments come before its column object. */
const COLUMN_POSITIONS: ReadonlyMap<string, number> = new Map([
	["select", 0],
	["selectDistinct", 0],
	["selectDistinctOn", 1],
	["returning", 0]
])

/** The relational query methods, which read every column unless their config names `columns`. */
const FINDERS: ReadonlyArray<string> = ["findMany", "findFirst"]

/** A config literal that names `columns`, or spreads another object that may. */
const mayNameColumns = (config: NodeOf<"ObjectExpression">): boolean =>
	Arr.some(
		config.properties,
		(property) =>
			property.type === "SpreadElement" ||
			(!property.computed && property.key.type === "Identifier" && property.key.name === "columns")
	)

/** `receiver.method(…)`: the call shape of a builder step, with the step's name. */
type Step = Readonly<{ call: NodeOf<"CallExpression">; receiver: Expression; method: string }>

const stepOf = (call: NodeOf<"CallExpression">): ReadonlyArray<Step> => {
	const callee = call.callee
	return callee.type === "MemberExpression" &&
		!callee.computed &&
		callee.property.type === "Identifier"
		? [{ call, receiver: callee.object, method: callee.property.name }]
		: []
}

/** Whether a call's result is the receiver of a `.from(…)` call: a select builder's next step. */
const isChainedIntoFrom = (call: NodeOf<"CallExpression">): boolean => {
	const access = call.parent
	return (
		access.type === "MemberExpression" &&
		access.object === call &&
		!access.computed &&
		access.property.type === "Identifier" &&
		access.property.name === "from" &&
		access.parent.type === "CallExpression" &&
		access.parent.callee === access
	)
}

/** Whether a finder's receiver is a relational query table, `<database>.query.<table>`. */
const isRelationalTable = (receiver: Expression): boolean =>
	receiver.type === "MemberExpression" &&
	receiver.object.type === "MemberExpression" &&
	!receiver.object.computed &&
	receiver.object.property.type === "Identifier" &&
	receiver.object.property.name === "query"

const messageOf = (method: string): string => {
	if (method === "returning") {
		return advice(
			"Implicit `.returning()` with no column object returns every column.",
			"Return only what the code uses, almost always `{ id: table.id }`."
		)
	}
	if (Arr.contains(FINDERS, method)) {
		return advice(
			`\`${method}\` without \`columns\` reads every column.`,
			"Name the columns the code uses: `columns: { id: true }`."
		)
	}
	return advice(
		`Implicit \`${method}()\` with no column object reads every column.`,
		`Name the columns the code uses: \`.${method}({ id: table.id })\`.`
	)
}

/**
 * Every Drizzle select, returning and relational find names its columns. Without types, a step is Drizzle's by its
 * method and its place in the chain: `selectDistinct`, `selectDistinctOn` and `returning` by their names, a bare
 * `select()` when `.from(…)` follows it or its receiver is a Drizzle value of this file (src/oxlint/drizzle.ts), and a
 * finder on `<database>.query.<table>`.
 */
export const noImplicitSelectAll = problem((context) => {
	const omitsColumns = (step: Step): boolean => {
		const { call, receiver, method } = step
		if (Arr.contains(FINDERS, method)) {
			const [config] = call.arguments
			return (
				isRelationalTable(receiver) &&
				(config === undefined || (config.type === "ObjectExpression" && !mayNameColumns(config)))
			)
		}
		const position = COLUMN_POSITIONS.get(method)
		if (position === undefined || call.arguments.length > position) {
			return false
		}
		return (
			method !== "select" ||
			isChainedIntoFrom(call) ||
			isValueOf(context, receiver, isDrizzleModule, new Set())
		)
	}
	return {
		CallExpression: (node) => {
			for (const step of stepOf(node)) {
				if (omitsColumns(step)) {
					const callee = node.callee
					context.report({
						node: callee.type === "MemberExpression" ? callee.property : node,
						message: messageOf(step.method)
					})
				}
			}
		}
	}
})
