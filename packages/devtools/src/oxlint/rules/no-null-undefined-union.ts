import { Array as Arr, Option } from "effect"
import { type AnyNode, type Context, type NodeOf, problem, type TypeNode } from "#oxlint/rule.ts"
import { bindingOf, parametersOf } from "#oxlint/syntax.ts"

/**
 * oxlint's typings declare a binding's `optional` as never true, while the parser sets it on an optional parameter;
 * the flag is read as the value it is at run time.
 */
const isSet = (flag: unknown): boolean => flag === true

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

/** The absences a written type spells. */
type Absences = Readonly<{ null: boolean; undefined: boolean }>

const NONE: Absences = { null: false, undefined: false }

const both = (left: Absences, right: Absences): Absences => ({
	null: left.null || right.null,
	undefined: left.undefined || right.undefined
})

/**
 * The absences a written type spells, read off its `null` and `undefined` keywords through unions and intersections,
 * and through the module's own aliases (`type Maybe<T> = T | null`). Never off a type's text: matching it
 * false-positives on the literal "null" and on names that merely contain the word. Another module's alias or a
 * library's (React's `ReactNode`) is that module's contract, and spells nothing here.
 */
const absencesOf = (aliases: OwnAliases, type: TypeNode, seen: ReadonlySet<string>): Absences => {
	if (type.type === "TSNullKeyword") {
		return { null: true, undefined: false }
	}
	if (type.type === "TSUndefinedKeyword") {
		return { null: false, undefined: true }
	}
	if (type.type === "TSUnionType" || type.type === "TSIntersectionType") {
		return Arr.reduce(type.types, NONE, (found, member) =>
			both(found, absencesOf(aliases, member, seen))
		)
	}
	if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") {
		return NONE
	}
	const { name } = type.typeName
	const alias = aliases.get(name)
	return alias === undefined || seen.has(name)
		? NONE
		: absencesOf(aliases, alias.typeAnnotation, new Set([...seen, name]))
}

/** Whether a written type spells both absences, or spells null where the position already admits undefined. */
const spellsBoth = (aliases: OwnAliases, type: TypeNode, omittable: boolean): boolean => {
	const absences = absencesOf(aliases, type, new Set())
	return absences.null && (omittable || absences.undefined)
}

/** A boundary whose written type the rule reads: its name, its written type, and whether a caller may leave it out. */
type Boundary = Readonly<{
	kind: "Parameter" | "Property"
	name: AnyNode
	type: TypeNode
	omittable: boolean
}>

/** A parameter's boundary: a parameter property's parameter, an optional one or one with a default, which a caller may
 * leave out, so for the caller its type already has an undefined arm. */
const parameterBoundary = (parameter: AnyNode): Option.Option<Boundary> => {
	const binding = bindingOf(parameter)
	const target = binding.type === "AssignmentPattern" ? binding.left : binding
	if (target.type === "RestElement") {
		return Option.map(Option.fromNullishOr(target.typeAnnotation), (annotation) => ({
			kind: "Parameter",
			name: target,
			type: annotation.typeAnnotation,
			omittable: false
		}))
	}
	if (
		target.type !== "Identifier" &&
		target.type !== "ObjectPattern" &&
		target.type !== "ArrayPattern"
	) {
		return Option.none()
	}
	return Option.map(Option.fromNullishOr(target.typeAnnotation), (annotation) => ({
		kind: "Parameter",
		name: target,
		type: annotation.typeAnnotation,
		omittable: binding.type === "AssignmentPattern" || isSet(target.optional)
	}))
}

const nameOf = (context: Context, node: AnyNode): string =>
	node.type === "Identifier" ? node.name : context.sourceCode.getText(node)

/** The function a return type annotation belongs to, by its name where one is written. */
const functionNameOf = (node: AnyNode): string => {
	if (
		(node.type === "FunctionDeclaration" || node.type === "FunctionExpression") &&
		node.id !== null
	) {
		return node.id.name
	}
	if (node.type === "TSMethodSignature" && node.key.type === "Identifier") {
		return node.key.name
	}
	const { parent } = node
	if (parent?.type === "VariableDeclarator" && parent.id.type === "Identifier") {
		return parent.id.name
	}
	if (
		(parent?.type === "MethodDefinition" || parent?.type === "Property") &&
		parent.key.type === "Identifier"
	) {
		return parent.key.name
	}
	return "(anonymous)"
}

/** A function, a method, a signature or a function type's written return type. */
const returnTypeOf = (node: AnyNode): Option.Option<TypeNode> => {
	if (
		node.type === "FunctionDeclaration" ||
		node.type === "FunctionExpression" ||
		node.type === "ArrowFunctionExpression" ||
		node.type === "TSDeclareFunction" ||
		node.type === "TSEmptyBodyFunctionExpression" ||
		node.type === "TSFunctionType" ||
		node.type === "TSConstructorType" ||
		node.type === "TSMethodSignature" ||
		node.type === "TSCallSignatureDeclaration" ||
		node.type === "TSConstructSignatureDeclaration"
	) {
		const annotation = node.returnType
		return annotation === null || annotation === undefined
			? Option.none()
			: Option.some(annotation.typeAnnotation)
	}
	return Option.none()
}

/**
 * A type at a function or object boundary never holds both null and undefined: three states every reader must
 * handle. It reads the types as written: a parameter's, a property signature's, a class property's and a function's,
 * a method's or a signature's return type, when the written type spells both, through unions, intersections and the
 * module's own aliases. An omittable parameter (optional, or with a default) or an optional property already has the
 * undefined arm, so it may not add null. A type the code does not write (an inferred return, another module's alias)
 * is the checker's, not this rule's; local variables stay free.
 */
export const noNullUndefinedUnion = problem((context) => {
	let aliases: OwnAliases = new Map()
	const checkBoundary = (boundary: Boundary): void => {
		if (!spellsBoth(aliases, boundary.type, boundary.omittable)) {
			return
		}
		const name = nameOf(context, boundary.name)
		const reason = boundary.omittable
			? "can be omitted and also admits null"
			: "admits both null and undefined"
		context.report({
			node: boundary.name,
			message: `${boundary.kind} '${name}' ${reason}: three states for every reader. Pick one absence: optional (undefined) or nullable (null), or an Option.`
		})
	}
	const property = (
		key: AnyNode,
		annotation: Option.Option<NodeOf<"TSTypeAnnotation">>,
		optional: boolean
	): void => {
		if (Option.isSome(annotation)) {
			checkBoundary({
				kind: "Property",
				name: key,
				type: annotation.value.typeAnnotation,
				omittable: optional
			})
		}
	}
	return {
		Program: (program) => {
			aliases = ownAliasesOf(program)
		},
		TSPropertySignature: (node) => {
			property(node.key, Option.fromNullishOr(node.typeAnnotation), node.optional)
		},
		PropertyDefinition: (node) => {
			property(node.key, Option.fromNullishOr(node.typeAnnotation), isSet(node.optional))
		},
		"*": (node) => {
			for (const boundary of Arr.getSomes(Arr.map(parametersOf(node), parameterBoundary))) {
				checkBoundary(boundary)
			}
			const returned = returnTypeOf(node)
			if (Option.isSome(returned) && spellsBoth(aliases, returned.value, false)) {
				context.report({
					node: returned.value,
					message: `Function '${functionNameOf(node)}' returns both null and undefined: three states for every caller. Return one absence (undefined or null) or an Option.`
				})
			}
		}
	}
})
