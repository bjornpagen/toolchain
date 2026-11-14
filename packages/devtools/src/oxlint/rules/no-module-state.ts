import { Array as Arr, Option, Result, String as Str } from "effect"
import { type AnyNode, type Context, type NodeOf, problem, type TypeNode } from "#oxlint/rule.ts"
import { isIdentifierIn, isMemberOf } from "#oxlint/syntax.ts"

/** The keyed collections a module builds with `new`: their writes are methods (set, add, delete, clear). A WeakMap or
 * WeakSet is none of them: keyed by object identity, it is a handle registry whose entries die with their keys, so no
 * run sees another's. */
const KEYED_COLLECTIONS: ReadonlyArray<string> = ["Map", "Set"]

/** The written types a write changes in place, by the name a reference spells, and what each holds. */
const MUTABLE_TYPES: ReadonlyMap<string, string> = new Map([
	["Array", "a mutable array"],
	["Map", "a mutable Map"],
	["Set", "a mutable Set"],
	["Record", "a record with a writable index signature"]
])

/** A RegExp's one writable property, lastIndex, is its cursor under the g and y flags; a literal without them never
 * reads it. */
const CURSOR_FLAGS: ReadonlyArray<string> = ["g", "y"]

/** The objects a write reaches the process through. */
const GLOBAL_OBJECTS: ReadonlyArray<string> = ["globalThis", "global"]

/** The reflective APIs that write a property by name. */
const REFLECTIVE_WRITERS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
	["Object", ["assign", "defineProperty", "defineProperties"]],
	["Reflect", ["set", "defineProperty"]]
]

const SUGGESTION =
	"Pass the value in, make it a readonly constant (a readonly type, `as const` or Object.freeze), or hold state that outlives one run in a Ref inside a Layer of the runtime."

/** A module's own types by name: its top-level type aliases and interfaces, which a written type is read through. */
type OwnTypes = ReadonlyMap<string, AnyNode>

/** The module's top-level type aliases and interfaces, exported ones included. */
const ownTypesOf = (program: NodeOf<"Program">): OwnTypes =>
	new Map(
		Arr.filterMap(program.body, (statement): Result.Result<readonly [string, AnyNode], void> => {
			const node =
				statement.type === "ExportNamedDeclaration" && statement.declaration !== null
					? statement.declaration
					: statement
			return node.type === "TSTypeAliasDeclaration" || node.type === "TSInterfaceDeclaration"
				? Result.succeed([node.id.name, node])
				: Result.failVoid
		})
	)

/** A written member's name, for the message. */
const keyNameOf = (context: Context, key: AnyNode): string =>
	key.type === "Identifier" ? key.name : context.sourceCode.getText(key)

/** What a type literal's or an interface's members let a write change: a writable index signature, or a property
 * signature without `readonly`. */
const membersMutability = (
	context: Context,
	members: ReadonlyArray<AnyNode>
): Option.Option<string> =>
	Arr.findFirst(members, (member) => {
		if (member.type === "TSIndexSignature" && !member.readonly) {
			return Option.some("a record with a writable index signature")
		}
		return member.type === "TSPropertySignature" && !member.readonly
			? Option.some(`a value whose property '${keyNameOf(context, member.key)}' is writable`)
			: Option.none()
	})

/**
 * What a written type lets a write change in place, read off the type as written: an array or a tuple without
 * `readonly`, a type literal with a writable member, Array, Map, Set or Record, and either of the module's own aliases
 * and interfaces read through. A union or an intersection holds what any member holds. Readonly, ReadonlyArray,
 * ReadonlyMap, ReadonlySet and every other type a name spells (a library's, another module's) hold nothing a write is
 * known to change.
 */
const typeMutability = (
	context: Context,
	own: OwnTypes,
	type: TypeNode,
	seen: ReadonlySet<string>
): Option.Option<string> => {
	if (type.type === "TSArrayType") {
		return Option.some("a mutable array")
	}
	if (type.type === "TSTupleType") {
		return Option.some("a mutable tuple")
	}
	if (type.type === "TSTypeLiteral") {
		return membersMutability(context, type.members)
	}
	if (type.type === "TSUnionType" || type.type === "TSIntersectionType") {
		return Arr.findFirst(type.types, (member) => typeMutability(context, own, member, seen))
	}
	if (type.type !== "TSTypeReference" || type.typeName.type !== "Identifier") {
		return Option.none()
	}
	const { name } = type.typeName
	const declared = own.get(name)
	if (declared === undefined || seen.has(name)) {
		return Option.fromUndefinedOr(MUTABLE_TYPES.get(name))
	}
	if (declared.type === "TSInterfaceDeclaration") {
		return membersMutability(context, declared.body.body)
	}
	return declared.type === "TSTypeAliasDeclaration"
		? typeMutability(context, own, declared.typeAnnotation, new Set([...seen, name]))
		: Option.none()
}

/** `as const`, which makes the value it asserts readonly through and through. */
const isConstAssertion = (type: TypeNode): boolean =>
	type.type === "TSTypeReference" && isIdentifierIn(type.typeName, ["const"])

/**
 * What a constant's value lets a write change in place, read off the value as written: an array literal, an object
 * literal with a property that is no method or getter, a Map or Set it builds with `new`, a regular expression with a
 * cursor; an assertion is read by the type it asserts, and `as const` and Object.freeze make the value readonly. Any
 * other value (a call's result, a function, a primitive) holds nothing the syntax shows a write can change.
 */
const valueMutability = (
	context: Context,
	own: OwnTypes,
	value: AnyNode
): Option.Option<string> => {
	if (value.type === "TSSatisfiesExpression" || value.type === "TSNonNullExpression") {
		return valueMutability(context, own, value.expression)
	}
	if (value.type === "TSAsExpression" || value.type === "TSTypeAssertion") {
		return isConstAssertion(value.typeAnnotation)
			? Option.none()
			: typeMutability(context, own, value.typeAnnotation, new Set())
	}
	if (value.type === "ArrayExpression") {
		return Option.some("a mutable array")
	}
	if (value.type === "ObjectExpression") {
		return Arr.findFirst(value.properties, (property) => {
			if (property.type === "SpreadElement") {
				return Option.some("a value whose spread properties are writable")
			}
			return property.kind === "get" || property.method
				? Option.none()
				: Option.some(`a value whose property '${keyNameOf(context, property.key)}' is writable`)
		})
	}
	if (value.type === "NewExpression") {
		return value.callee.type === "Identifier" && Arr.contains(KEYED_COLLECTIONS, value.callee.name)
			? Option.some(`a mutable ${value.callee.name}`)
			: Option.none()
	}
	return value.type === "Literal" &&
		"regex" in value &&
		Arr.some(CURSOR_FLAGS, (flag) => Str.includes(flag)(value.regex.flags))
		? Option.some("a regular expression whose lastIndex is its cursor")
		: Option.none()
}

/** What a module-level constant holds that a write can change in place: its written type's, when it has one, which
 * says what the value admits; else its value's. */
const constantMutability = (
	context: Context,
	own: OwnTypes,
	declarator: NodeOf<"VariableDeclarator">
): Option.Option<string> => {
	const annotation = declarator.id.typeAnnotation
	if (annotation !== null && annotation !== undefined) {
		return typeMutability(context, own, annotation.typeAnnotation, new Set())
	}
	return declarator.init === null ? Option.none() : valueMutability(context, own, declarator.init)
}

/** The globals a file declares itself, in `declare global { var name: … }`: the process anchor's module. */
const declaredGlobalsOf = (program: NodeOf<"Program">): ReadonlyArray<string> =>
	Arr.flatMap(program.body, (statement) => {
		if (statement.type !== "TSModuleDeclaration" || !statement.global) {
			return []
		}
		return Arr.flatMap(statement.body.body, (inner) =>
			inner.type === "VariableDeclaration"
				? Arr.filterMap(inner.declarations, (declarator) =>
						declarator.id.type === "Identifier"
							? Result.succeed(declarator.id.name)
							: Result.failVoid
					)
				: []
		)
	})

/** The global object, named where no binding of the file shadows it. */
const isGlobalObject = (context: Context, node: AnyNode): boolean =>
	isIdentifierIn(node, GLOBAL_OBJECTS) && context.sourceCode.isGlobalReference(node)

/** `globalThis.name` or `globalThis["name"]`: the property a write to the global object names. */
const globalPropertyOf = (context: Context, target: AnyNode): Option.Option<string> => {
	if (target.type !== "MemberExpression" || !isGlobalObject(context, target.object)) {
		return Option.none()
	}
	const { property } = target
	if (!target.computed && property.type === "Identifier") {
		return Option.some(property.name)
	}
	return Option.some(
		property.type === "Literal" && typeof property.value === "string"
			? property.value
			: "[computed]"
	)
}

/**
 * A module holds no state that every request of the process shares. It refuses a module-level `let` or `var`, a
 * module-level constant whose written type or value a write can change in place, and a write to the global object
 * unless the same file declares that global in `declare global`, as a process anchor's module does. It reads syntax
 * alone: a constant's written type says what it admits (`Readonly<{ items: Array<string> }>` is a value, its array the
 * reader's to leave alone; one of the module's own aliases or interfaces is read through, a type of another module or
 * library is taken at its word), and without one its value does: an array literal, an object literal with a writable
 * property, a Map or Set built with `new`, a regular expression with a cursor. `as const` and Object.freeze make a
 * value readonly; a call's result is the callee's to type. An ambient declaration declares no state.
 */
export const noModuleState = problem((context) => {
	let own: OwnTypes = new Map()
	let declaredGlobals: ReadonlyArray<string> = []
	const report = (node: AnyNode, message: string): void => {
		context.report({ node, message: `${message} ${SUGGESTION}` })
	}
	const statement = (node: AnyNode): void => {
		if (node.type !== "VariableDeclaration" || node.declare === true) {
			return
		}
		for (const declarator of node.declarations) {
			if (node.kind === "let" || node.kind === "var") {
				report(
					declarator.id,
					`Module-level '${node.kind}' is state shared by every run in the process.`
				)
			} else {
				const held = constantMutability(context, own, declarator)
				if (Option.isSome(held)) {
					report(
						declarator.id,
						`Module-level constant holds ${held.value}, shared by every run in the process.`
					)
				}
			}
		}
	}
	const globalWrite = (node: AnyNode, target: AnyNode): void => {
		const property = globalPropertyOf(context, target)
		if (Option.isSome(property) && !Arr.contains(declaredGlobals, property.value)) {
			report(
				node,
				`Write to the global object's '${property.value}', which this module does not declare in \`declare global\`.`
			)
		}
	}
	return {
		Program: (program) => {
			own = ownTypesOf(program)
			declaredGlobals = declaredGlobalsOf(program)
			for (const node of program.body) {
				statement(
					node.type === "ExportNamedDeclaration" && node.declaration !== null
						? node.declaration
						: node
				)
			}
		},
		AssignmentExpression: (node) => {
			globalWrite(node, node.left)
		},
		UpdateExpression: (node) => {
			globalWrite(node, node.argument)
		},
		UnaryExpression: (node) => {
			if (node.operator === "delete") {
				globalWrite(node, node.argument)
			}
		},
		CallExpression: (node) => {
			const [first] = node.arguments
			const reflective = Arr.some(REFLECTIVE_WRITERS, ([object, methods]) =>
				isMemberOf(node.callee, object, methods)
			)
			if (reflective && first !== undefined && isGlobalObject(context, first)) {
				report(node, "Reflective write to the global object; its property cannot be checked.")
			}
		}
	}
})
