import { Array as Arr } from "effect"
import { advice, isDrizzleExport } from "#oxlint/drizzle.ts"
import { type AnyNode, type Context, problem, type TypeNode } from "#oxlint/rule.ts"

/** The result types an executor answers with. */
const EXECUTOR_RESULTS: ReadonlyArray<string> = ["Effect", "Promise"]

/** Whether a written type is Drizzle's `SQL`, by import, or a union with it. */
const isRawSqlType = (context: Context, type: TypeNode): boolean => {
	if (type.type === "TSUnionType") {
		return Arr.some(type.types, (member) => isRawSqlType(context, member))
	}
	return type.type === "TSTypeReference" && isDrizzleExport(context, type.typeName, ["SQL"])
}

/** The type a parameter is annotated with, none for an unannotated one. */
const annotationOf = (parameter: AnyNode): ReadonlyArray<TypeNode> => {
	const annotation = "typeAnnotation" in parameter ? parameter.typeAnnotation : null
	return annotation?.type === "TSTypeAnnotation" ? [annotation.typeAnnotation] : []
}

/** Whether a written result type is an Effect or a Promise: `Promise<…>`, `Effect<…>` or `Effect.Effect<…>`. */
const isExecutorResult = (type: TypeNode): boolean => {
	if (type.type !== "TSTypeReference") {
		return false
	}
	const name = type.typeName
	const last =
		name.type === "Identifier" ? name.name : name.type === "TSQualifiedName" ? name.right.name : ""
	return Arr.contains(EXECUTOR_RESULTS, last)
}

const MESSAGE = advice(
	"An executor of Drizzle `SQL` erases the native builder's contract.",
	"Lend the query scope and return its typed QueryPromise."
)

/**
 * A function type or method signature that takes Drizzle `SQL` and answers an Effect or a Promise is an executor of
 * raw SQL, which erases the native builder's contract: lend the query scope and return its typed QueryPromise. The
 * types are read as written: a parameter annotated with `SQL` imported from drizzle-orm, and a result written as
 * `Promise<…>` or `Effect<…>`.
 */
export const sqlExecutorContract = problem((context) => {
	const check = (
		node: AnyNode,
		parameters: ReadonlyArray<AnyNode>,
		result: ReadonlyArray<TypeNode>
	): void => {
		if (
			Arr.some(parameters, (parameter) =>
				Arr.some(annotationOf(parameter), (type) => isRawSqlType(context, type))
			) &&
			Arr.some(result, isExecutorResult)
		) {
			context.report({ node, message: MESSAGE })
		}
	}
	return {
		TSFunctionType: (node) => {
			check(node, node.params, [node.returnType.typeAnnotation])
		},
		TSMethodSignature: (node) => {
			check(node, node.params, node.returnType === null ? [] : [node.returnType.typeAnnotation])
		}
	}
})
