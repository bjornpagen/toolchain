import { Array as Arr, Option, Schema } from "effect"
import { type AnyNode, configured, type Context, type NodeOf, type TypeNode } from "#oxlint/rule.ts"
import { isMember } from "#oxlint/syntax.ts"

/** The functions whose result is a tuple of a length written in source, which the syntax of a call site cannot show:
 * each module, by the specifier the code imports it with, and the functions of it (grizzle's test support's
 * `argumentsOf`, which hands a drawn list to a variadic API as a tuple of at most eight). */
const Options = Schema.Struct({
	tuples: Schema.Array(Schema.Struct({ module: Schema.String, names: Schema.Array(Schema.String) }))
})

type Tuples = (typeof Options.Type)["tuples"]

const MESSAGE =
	"A spread argument puts every element of a variable-length list on the call stack; V8 refuses about 120,000 of them at Node's default stack. Pass the list as one value (an array parameter), append it with a for-of loop or Arr.appendAll, or fold it (Arr.reduce, Arr.max)."

type Scope = ReturnType<Context["sourceCode"]["getScope"]>

type Variable = Scope["variables"][number]

/** A module's own type aliases by name, which a written type is read through. */
type OwnAliases = ReadonlyMap<string, NodeOf<"TSTypeAliasDeclaration">>

/** The module's top-level type aliases, exported ones included. */
const ownAliasesOf = (program: NodeOf<"Program">): OwnAliases =>
	new Map(
		Arr.flatMap(program.body, (statement) => {
			const node =
				statement.type === "ExportNamedDeclaration" && statement.declaration !== null
					? statement.declaration
					: statement
			return node.type === "TSTypeAliasDeclaration" ? [[node.id.name, node] as const] : []
		})
	)

/** An element of a written tuple that stands for any number of elements: `...T[]`, named or not. */
const isVariableElement = (element: AnyNode): boolean =>
	element.type === "TSRestType" ||
	(element.type === "TSNamedTupleMember" && element.elementType.type === "TSRestType")

/**
 * A written type whose length is written in source: a tuple without a rest element, readonly or not, a union of such
 * tuples, or one of the module's own aliases of one.
 */
const isFixedLengthType = (
	aliases: OwnAliases,
	type: TypeNode,
	seen: ReadonlySet<string>
): boolean => {
	if (type.type === "TSTypeOperator") {
		return type.operator === "readonly" && isFixedLengthType(aliases, type.typeAnnotation, seen)
	}
	if (type.type === "TSTupleType") {
		return !Arr.some(type.elementTypes, isVariableElement)
	}
	if (type.type === "TSUnionType") {
		return Arr.every(type.types, (member) => isFixedLengthType(aliases, member, seen))
	}
	if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") {
		return false
	}
	const { name } = type.typeName
	const alias = aliases.get(name)
	return (
		alias !== undefined &&
		!seen.has(name) &&
		isFixedLengthType(aliases, alias.typeAnnotation, new Set([...seen, name]))
	)
}

/** An expression as written, through `satisfies` and non-null assertions. */
const bare = (node: AnyNode): AnyNode =>
	node.type === "TSSatisfiesExpression" || node.type === "TSNonNullExpression"
		? bare(node.expression)
		: node

/** An array literal without a spread element: its length is written in source. */
const isSpreadFreeLiteral = (node: AnyNode): boolean =>
	node.type === "ArrayExpression" &&
	Arr.every(node.elements, (element) => element?.type !== "SpreadElement")

/** `[…] as const`: a spread-free array literal made a readonly tuple. */
const isConstTuple = (node: AnyNode): boolean => {
	const value = bare(node)
	return (
		value.type === "TSAsExpression" &&
		value.typeAnnotation.type === "TSTypeReference" &&
		value.typeAnnotation.typeName.type === "Identifier" &&
		value.typeAnnotation.typeName.name === "const" &&
		isSpreadFreeLiteral(bare(value.expression))
	)
}

/** The variable an identifier names where it stands: the nearest scope's of its name; none for a global. */
const resolve = (context: Context, identifier: NodeOf<"Identifier">): Option.Option<Variable> => {
	for (
		let scope: Scope | null = context.sourceCode.getScope(identifier);
		scope !== null;
		scope = scope.upper
	) {
		const found = scope.set.get(identifier.name)
		if (found !== undefined) {
			return Arr.isArrayNonEmpty(found.defs) ? Option.some(found) : Option.none()
		}
	}
	return Option.none()
}

/** A binding's written type, where its declaration writes one. */
const writtenTypeOf = (binding: AnyNode): Option.Option<TypeNode> => {
	const annotation =
		binding.type === "Identifier" || binding.type === "RestElement" ? binding.typeAnnotation : null
	return annotation === null || annotation === undefined
		? Option.none()
		: Option.some(annotation.typeAnnotation)
}

/** A function's written return type, where it writes one. */
const returnTypeOf = (node: AnyNode): Option.Option<TypeNode> => {
	if (
		node.type !== "FunctionDeclaration" &&
		node.type !== "FunctionExpression" &&
		node.type !== "ArrowFunctionExpression"
	) {
		return Option.none()
	}
	const annotation = node.returnType
	return annotation === null || annotation === undefined
		? Option.none()
		: Option.some(annotation.typeAnnotation)
}

/** What an import binding names: the module's specifier, and the export it names, or every export for a namespace. */
const importedOf = (
	definition: Variable["defs"][number]
): Option.Option<Readonly<{ module: string; name: Option.Option<string> }>> => {
	const { node, parent } = definition
	if (definition.type !== "ImportBinding" || parent?.type !== "ImportDeclaration") {
		return Option.none()
	}
	const module = parent.source.value
	if (node.type === "ImportNamespaceSpecifier") {
		return Option.some({ module, name: Option.none() })
	}
	if (node.type !== "ImportSpecifier") {
		return Option.none()
	}
	const { imported } = node
	return Option.some({
		module,
		name: Option.some(imported.type === "Identifier" ? imported.name : imported.value)
	})
}

/** Whether a module's function is one the options name as returning a tuple. */
const isListedTuple = (tuples: Tuples, module: string, name: string): boolean =>
	Arr.some(tuples, (entry) => entry.module === module && Arr.contains(entry.names, name))

/** What a list's syntax and the bindings it names are read with: the rule's context, the module's own aliases, and
 * the functions the options name. */
type Reading = Readonly<{ context: Context; aliases: OwnAliases; tuples: Tuples }>

/**
 * Whether a call returns a tuple of a length written in source: a function of this module whose written return type is
 * one, or a function the options name, imported by name or reached through a namespace import of its module.
 */
const returnsFixedLength = (reading: Reading, call: NodeOf<"CallExpression">): boolean => {
	const { callee } = call
	const fixedReturn = (fn: AnyNode): boolean =>
		Option.exists(returnTypeOf(fn), (type) => isFixedLengthType(reading.aliases, type, new Set()))
	if (callee.type === "Identifier") {
		return Option.exists(resolve(reading.context, callee), (variable) =>
			Arr.every(variable.defs, (definition) => {
				if (definition.type === "FunctionName") {
					return fixedReturn(definition.node)
				}
				if (definition.type === "Variable" && definition.node.type === "VariableDeclarator") {
					return definition.node.init !== null && fixedReturn(definition.node.init)
				}
				return Option.exists(importedOf(definition), ({ module, name }) =>
					Option.exists(name, (exported) => isListedTuple(reading.tuples, module, exported))
				)
			})
		)
	}
	if (
		callee.type !== "MemberExpression" ||
		callee.computed ||
		callee.object.type !== "Identifier" ||
		callee.property.type !== "Identifier"
	) {
		return false
	}
	const method = callee.property.name
	return Option.exists(resolve(reading.context, callee.object), (variable) =>
		Arr.every(variable.defs, (definition) =>
			Option.exists(
				importedOf(definition),
				({ module, name }) => Option.isNone(name) && isListedTuple(reading.tuples, module, method)
			)
		)
	)
}

/**
 * Whether a variable holds a list of a length written in source: a binding with a written tuple type, a constant that
 * holds an `as const` tuple or the result of a call that returns one, or the function's own rest parameter, which holds the arguments its
 * call already passed, so forwarding them adds no list a call site does not already spread, and that call site is
 * checked where it stands.
 */
const holdsFixedLength = (reading: Reading, variable: Variable): boolean =>
	Arr.every(variable.defs, (definition) => {
		const binding = definition.name
		if (definition.type === "Parameter") {
			return (
				binding.parent.type === "RestElement" ||
				Option.exists(writtenTypeOf(binding), (type) =>
					isFixedLengthType(reading.aliases, type, new Set())
				)
			)
		}
		const { node, parent } = definition
		if (definition.type !== "Variable" || node.type !== "VariableDeclarator") {
			return false
		}
		return Option.match(writtenTypeOf(node.id), {
			onSome: (type) => isFixedLengthType(reading.aliases, type, new Set()),
			onNone: () =>
				parent?.type === "VariableDeclaration" &&
				parent.kind === "const" &&
				node.init !== null &&
				(isConstTuple(node.init) ||
					(node.init.type === "CallExpression" && returnsFixedLength(reading, node.init)))
		})
	})

/** Whether a list a call spreads has a length written in source, read off the syntax and the bindings it names. */
const isFixedLength = (reading: Reading, list: AnyNode): boolean => {
	const node = bare(list)
	if (isSpreadFreeLiteral(node) || isConstTuple(node)) {
		return true
	}
	if (node.type === "TSAsExpression") {
		return isFixedLengthType(reading.aliases, node.typeAnnotation, new Set())
	}
	if (node.type === "CallExpression") {
		return returnsFixedLength(reading, node)
	}
	return (
		node.type === "Identifier" &&
		Option.exists(resolve(reading.context, node), (variable) => holdsFixedLength(reading, variable))
	)
}

/** `Reflect`, named where no binding of the file shadows it. */
const isReflect = (context: Context, node: AnyNode): boolean =>
	node.type === "Identifier" &&
	node.name === "Reflect" &&
	context.sourceCode.isGlobalReference(node)

/**
 * The list whose elements become a call's arguments, for the builtin forms that take one without spread syntax:
 * Reflect.apply's third argument and Reflect.construct's second, and the second of Function.prototype.apply's two
 * (`f.apply(t, xs)`, `Function.prototype.call.apply(f, xs)`); none for any other call, a method of another name or
 * arity included.
 */
const applyListOf = (context: Context, call: NodeOf<"CallExpression">): Option.Option<AnyNode> => {
	const { callee } = call
	const written = call.arguments
	if (callee.type !== "MemberExpression" || callee.computed) {
		return Option.none()
	}
	const at = (index: number): Option.Option<AnyNode> =>
		Option.filter(Option.fromUndefinedOr(written[index]), (list) => list.type !== "SpreadElement")
	if (isReflect(context, callee.object)) {
		if (isMember(callee, "Reflect", "apply") && written.length === 3) {
			return at(2)
		}
		return isMember(callee, "Reflect", "construct") && written.length >= 2 ? at(1) : Option.none()
	}
	return callee.property.type === "Identifier" &&
		callee.property.name === "apply" &&
		written.length === 2
		? at(1)
		: Option.none()
}

/**
 * No call takes a variable-length list as its arguments. A spread argument, or the list of Function.prototype.apply,
 * Reflect.apply or Reflect.construct, puts every element on the call stack, and V8 refuses about 120,000 of them at
 * Node's default stack. A list whose length is written in source passes: an array literal without a spread, an
 * `as const` tuple, a binding scope analysis finds holding one (a binding with a written tuple type, a constant holding
 * an `as const` tuple or such a call's result, the function's own rest parameter), and the result of a call of a function of this module whose
 * written return type is such a tuple or of one the options name. Every other list is refused, since the syntax gives
 * no length. So a spread of a statically sized tuple is admitted (`on(R, ...key)` with `const key = ["a", "b"] as
 * const`), a spread of a runtime list is refused (`and(...predicates)` over a list a program builds), and an API that
 * must take a runtime list takes it as one list parameter (grizzle's `r.and(predicates)` and `r.or(predicates)`), never
 * as a rest parameter its callers spread into.
 */
export const noSpreadArgument = configured(Options, (context, options) => {
	let reading: Reading = { context, aliases: new Map(), tuples: options.tuples }
	const check = (list: AnyNode): void => {
		if (!isFixedLength(reading, list)) {
			context.report({ node: list, message: MESSAGE })
		}
	}
	const spreads = (written: ReadonlyArray<AnyNode>): void => {
		for (const argument of written) {
			if (argument.type === "SpreadElement") {
				check(argument.argument)
			}
		}
	}
	return {
		Program: (program) => {
			reading = { ...reading, aliases: ownAliasesOf(program) }
		},
		CallExpression: (node) => {
			spreads(node.arguments)
			const list = applyListOf(context, node)
			if (Option.isSome(list)) {
				check(list.value)
			}
		},
		NewExpression: (node) => {
			spreads(node.arguments)
		}
	}
})
