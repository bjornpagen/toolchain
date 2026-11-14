import { Array as Arr, Option, Schema } from "effect"
import {
	advice,
	annotationsOf,
	initializersOf,
	isDrizzleExport,
	isDrizzleModule,
	isValueOf,
	unwrapped,
	variableOf
} from "#oxlint/drizzle.ts"
import {
	type AnyNode,
	type Context,
	configured,
	type Expression,
	type NodeOf,
	type TypeNode
} from "#oxlint/rule.ts"

/** The names the repository gives its Drizzle databases and transactions where they are handed in untyped (a scope's
 * callback parameter): a write on a receiver of one of these names, or whose last property is one (`this.db`), is a
 * Drizzle write. */
const Options = Schema.Struct({ receivers: Schema.Array(Schema.String) })

const WRITES: ReadonlyArray<string> = ["delete", "update"]

/** A call `receiver.method(…)`, with the method's name. */
type Step = Readonly<{
	call: NodeOf<"CallExpression">
	receiver: Expression
	method: string
	name: AnyNode
}>

const stepOf = (node: AnyNode): Option.Option<Step> => {
	if (node.type !== "CallExpression") {
		return Option.none()
	}
	const callee = node.callee
	return callee.type === "MemberExpression" &&
		!callee.computed &&
		callee.property.type === "Identifier"
		? Option.some({
				call: node,
				receiver: callee.object,
				method: callee.property.name,
				name: callee.property
			})
		: Option.none()
}

/** The step a call's result is the receiver of, none when its result goes anywhere else. */
const nextStepOf = (call: NodeOf<"CallExpression">): Option.Option<Step> => {
	const access = call.parent
	if (access.type !== "MemberExpression" || access.object !== call) {
		return Option.none()
	}
	return Option.filter(stepOf(access.parent), (step) => step.call.callee === access)
}

/** The calls chained onto a call, in order: `database.update(t).set(v).where(c)` chains `set`, then `where`. */
const chainOf = (call: NodeOf<"CallExpression">): ReadonlyArray<Step> =>
	Option.match(nextStepOf(call), {
		onNone: () => [],
		onSome: (next) => [next, ...chainOf(next.call)]
	})

/** The binding a query is declared under when its chain initializes it, `const query = database.delete(t)`. */
const boundTo = (end: NodeOf<"CallExpression">): Option.Option<NodeOf<"Identifier">> => {
	const declarator = end.parent
	return declarator.type === "VariableDeclarator" &&
		declarator.init === end &&
		declarator.id.type === "Identifier"
		? Option.some(declarator.id)
		: Option.none()
}

/** The last name a receiver is read under: `db` of `db`, `this.db` and `scope.db`. */
const lastNameOf = (receiver: Expression): Option.Option<string> => {
	if (receiver.type === "Identifier") {
		return Option.some(receiver.name)
	}
	return receiver.type === "MemberExpression" &&
		!receiver.computed &&
		receiver.property.type === "Identifier"
		? Option.some(receiver.property.name)
		: Option.none()
}

/** Whether a written type admits undefined: `undefined`, `void`, or a union with one. */
const typeAdmitsUndefined = (type: TypeNode): boolean => {
	if (type.type === "TSUnionType") {
		return Arr.some(type.types, typeAdmitsUndefined)
	}
	return type.type === "TSUndefinedKeyword" || type.type === "TSVoidKeyword"
}

/**
 * Whether a condition can be undefined, as the file shows it: `undefined` itself, `void …`, Drizzle's `and(…)` or
 * `or(…)` (typed `SQL | undefined`, undefined for an empty list), either branch of a conditional, or a binding of this
 * file declared with one or annotated with a type that admits undefined. A cyclic binding ends the walk.
 */
const admitsUndefined = (context: Context, expression: Expression, seen: Set<AnyNode>): boolean => {
	const inner = unwrapped(expression)
	if (seen.has(inner)) {
		return false
	}
	seen.add(inner)
	if (inner.type === "UnaryExpression") {
		return inner.operator === "void"
	}
	if (inner.type === "CallExpression") {
		return isDrizzleExport(context, inner.callee, ["and", "or"])
	}
	if (inner.type === "ConditionalExpression") {
		return (
			admitsUndefined(context, inner.consequent, seen) ||
			admitsUndefined(context, inner.alternate, seen)
		)
	}
	return (
		inner.type === "Identifier" &&
		Option.match(variableOf(context, inner), {
			onNone: () => inner.name === "undefined",
			onSome: (variable) =>
				Arr.some(annotationsOf(variable), typeAdmitsUndefined) ||
				Arr.some(initializersOf(variable), (init) => admitsUndefined(context, init, seen))
		})
	)
}

const verbOf = (method: string): string => (method === "delete" ? "deletes" : "updates")

/**
 * A Drizzle `delete` or `update` is narrowed by a `.where(…)` whose condition is always there: without one, or with a
 * condition that can be undefined (`and()` of an empty list is undefined), it changes every row of the table. The
 * `.where` is chained in the same expression, or onto the binding the query is declared under in the same file.
 *
 * Without types, a write is Drizzle's when its receiver is a Drizzle value of this file (src/oxlint/drizzle.ts) or
 * is read under one of the options' receiver names, or when its chain shows the builder: an update's `.set(…)`, a
 * delete's `.where(…)` or `.returning(…)`. A Map's or a Set's `delete` shows none of these.
 */
export const noDrizzleWriteWithoutWhere = configured(Options, (context, options) => {
	const isDrizzleWrite = (step: Step, chain: ReadonlyArray<Step>): boolean => {
		const shown = Option.exists(Arr.head(chain), (next) =>
			step.method === "update"
				? next.method === "set"
				: next.method === "where" || next.method === "returning"
		)
		return (
			shown ||
			Option.exists(lastNameOf(step.receiver), (name) => Arr.contains(options.receivers, name)) ||
			isValueOf(context, step.receiver, isDrizzleModule, new Set())
		)
	}
	const wheresOf = (step: Step, chain: ReadonlyArray<Step>): ReadonlyArray<Step> => {
		const chained = Arr.filter(chain, (next) => next.method === "where")
		const end = Option.getOrElse(Arr.last(chain), () => step).call
		const bound = Option.match(
			Option.flatMap(boundTo(end), (id) => variableOf(context, id)),
			{
				onNone: (): ReadonlyArray<Step> => [],
				onSome: (variable) =>
					Arr.flatMap(variable.references, (reference): ReadonlyArray<Step> => {
						const access = reference.identifier.parent
						if (access.type !== "MemberExpression" || access.object !== reference.identifier) {
							return []
						}
						return Option.match(stepOf(access.parent), {
							onNone: () => [],
							onSome: (next) =>
								next.call.callee === access && next.method === "where" ? [next] : []
						})
					})
			}
		)
		return [...chained, ...bound]
	}
	return {
		CallExpression: (node) => {
			const step = stepOf(node)
			if (Option.isNone(step) || !Arr.contains(WRITES, step.value.method)) {
				return
			}
			const chain = chainOf(node)
			if (!isDrizzleWrite(step.value, chain)) {
				return
			}
			const { method } = step.value
			const wheres = wheresOf(step.value, chain)
			if (!Arr.isReadonlyArrayNonEmpty(wheres)) {
				context.report({
					node: step.value.name,
					message: advice(
						`Drizzle \`.${method}()\` without \`.where()\` ${verbOf(method)} every row of the table.`,
						`Chain \`.where(…)\` onto the \`.${method}()\`, or onto the name its query is bound to.`
					)
				})
				return
			}
			for (const where of wheres) {
				const [condition] = where.call.arguments
				if (
					condition === undefined ||
					(condition.type !== "SpreadElement" && admitsUndefined(context, condition, new Set()))
				) {
					context.report({
						node: condition ?? where.name,
						message: advice(
							`This \`.where()\` of a Drizzle \`.${method}()\` takes a condition that can be undefined, and an undefined condition ${verbOf(method)} every row of the table.`,
							"Make the condition total: build it from a non-empty list of conditions, so `and(…)` cannot be undefined."
						)
					})
				}
			}
		}
	}
})
