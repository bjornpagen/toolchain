import { Array as Arr, Option, String as Str } from "effect"
import type { AnyNode, Context, Expression, NodeOf, TypeNode } from "#oxlint/rule.ts"
import { isFileAt } from "#oxlint/rule.ts"
import { authoredSql } from "#oxlint/sql-text.ts"
import { ancestorsOf } from "#oxlint/syntax.ts"

/**
 * How the SQL and Drizzle rules recognise Drizzle without types: by imports. oxlint's JS plugins see one file's syntax
 * and scopes, so a value is Drizzle's when the file says so: an identifier bound by an import from `drizzle-orm` (or
 * one of its subpaths), a member of a namespace import of it, or a binding of this file whose declaration traces back
 * to one. A value that arrives untraced (a callback's parameter with no annotation, an import from the repository's own
 * modules) is no evidence either way, and each rule states what it does then.
 */

type Scope = ReturnType<Context["sourceCode"]["getScope"]>

type Variable = Scope["variables"][number]

/** What an import binding imports: its module's specifier, and the name it imports (`*` for a namespace import,
 * `default` for a default one). */
type Imported = Readonly<{ specifier: string; name: string }>

/** Whether a module specifier is Drizzle's: the package or one of its subpaths. */
export const isDrizzleModule = (specifier: string): boolean =>
	specifier === "drizzle-orm" || Str.startsWith("drizzle-orm/")(specifier)

/** A global the environment declares, which no file of the program does. */
const isGlobal = (variable: Variable): boolean =>
	variable.scope.type === "global" && !Arr.isArrayNonEmpty(variable.defs)

/** The variable an identifier names where it stands: the nearest scope's of its name; none for a global. */
export const variableOf = (
	context: Context,
	identifier: NodeOf<"Identifier">
): Option.Option<Variable> => {
	for (
		let scope: Scope | null = context.sourceCode.getScope(identifier);
		scope !== null;
		scope = scope.upper
	) {
		const found = scope.set.get(identifier.name)
		if (found !== undefined) {
			return isGlobal(found) ? Option.none() : Option.some(found)
		}
	}
	return Option.none()
}

/** What a variable imports, none for a variable no import binds. */
const importOf = (variable: Variable): Option.Option<Imported> =>
	Arr.findFirst(variable.defs, (def) => {
		if (def.type !== "ImportBinding" || def.parent?.type !== "ImportDeclaration") {
			return Option.none()
		}
		const specifier = def.parent.source.value
		const binding = def.node
		if (binding.type === "ImportSpecifier") {
			const imported = binding.imported
			return Option.some({
				specifier,
				name: imported.type === "Identifier" ? imported.name : imported.value
			})
		}
		if (binding.type === "ImportNamespaceSpecifier") {
			return Option.some({ specifier, name: "*" })
		}
		return binding.type === "ImportDefaultSpecifier"
			? Option.some({ specifier, name: "default" })
			: Option.none()
	})

/** The import an identifier is bound by where it stands. */
const importedIdentifier = (
	context: Context,
	identifier: NodeOf<"Identifier">
): Option.Option<Imported> => Option.flatMap(variableOf(context, identifier), importOf)

/** The export `object.property` reads when `object` is bound by a namespace import. */
const memberOfNamespace = (
	context: Context,
	object: AnyNode,
	property: AnyNode
): Option.Option<Imported> =>
	object.type === "Identifier" && property.type === "Identifier"
		? Option.flatMap(importedIdentifier(context, object), (imported) =>
				imported.name === "*"
					? Option.some({ specifier: imported.specifier, name: property.name })
					: Option.none()
			)
		: Option.none()

/**
 * The import an expression names: an identifier an import binds, or `namespace.name` (or `namespace.name` in a type,
 * `namespace.Name`) on a namespace import, which names the module's export `name`.
 */
export const importedAt = (context: Context, node: AnyNode): Option.Option<Imported> => {
	if (node.type === "Identifier") {
		return importedIdentifier(context, node)
	}
	if (node.type === "MemberExpression" && !node.computed) {
		return memberOfNamespace(context, node.object, node.property)
	}
	return node.type === "TSQualifiedName"
		? memberOfNamespace(context, node.left, node.right)
		: Option.none()
}

/** Whether an expression names one of the exports of a module `isModule` takes. */
const namesExportOf = (
	context: Context,
	node: AnyNode,
	isModule: (specifier: string) => boolean,
	names: ReadonlyArray<string>
): boolean =>
	Option.exists(
		importedAt(context, node),
		(imported) => isModule(imported.specifier) && Arr.contains(names, imported.name)
	)

/** Whether an expression names one of Drizzle's exports. */
export const isDrizzleExport = (
	context: Context,
	node: AnyNode,
	names: ReadonlyArray<string>
): boolean => namesExportOf(context, node, isDrizzleModule, names)

/** A Drizzle `sql` tagged template: its tag is Drizzle's `sql`, by import. */
export const isDrizzleSqlTemplate = (
	context: Context,
	node: AnyNode
): node is NodeOf<"TaggedTemplateExpression"> =>
	node.type === "TaggedTemplateExpression" && isDrizzleExport(context, node.tag, ["sql"])

/** The text a template part carries, as the template writes it between interpolations. */
const partText = (quasi: NodeOf<"TemplateElement">): string => quasi.value.cooked ?? quasi.value.raw

/** A template's authored SQL (src/oxlint/sql-text.ts): its literal parts, interpolations standing as ` ? `. */
export const authoredSqlOf = (template: NodeOf<"TemplateLiteral">): string =>
	authoredSql(Arr.map(template.quasis, partText))

/** A template's interpolations, each with the literal text written right before it. */
export const interpolationsOf = (
	template: NodeOf<"TemplateLiteral">
): ReadonlyArray<Readonly<{ expression: Expression; before: string }>> =>
	Arr.flatMap(template.expressions, (expression, index) => {
		const quasi = template.quasis[index]
		return quasi === undefined ? [] : [{ expression, before: partText(quasi) }]
	})

/** The expression beneath assertions and non-null marks. */
export const unwrapped = (expression: Expression): Expression =>
	expression.type === "TSAsExpression" ||
	expression.type === "TSSatisfiesExpression" ||
	expression.type === "TSTypeAssertion" ||
	expression.type === "TSNonNullExpression"
		? unwrapped(expression.expression)
		: expression

/** The value a binding of this file is declared with: a variable's initializer, none for any other binding. */
export const initializersOf = (variable: Variable): ReadonlyArray<Expression> =>
	Arr.flatMap(variable.defs, (def) =>
		def.type === "Variable" && def.node.type === "VariableDeclarator" && def.node.init !== null
			? [def.node.init]
			: []
	)

/** The types the bindings of a variable are annotated with: a parameter's or a variable's annotation, none for an
 * unannotated binding. */
export const annotationsOf = (variable: Variable): ReadonlyArray<TypeNode> =>
	Arr.flatMap(variable.defs, (def) => {
		if (def.type !== "Parameter" && def.type !== "Variable") {
			return []
		}
		const annotation = "typeAnnotation" in def.name ? def.name.typeAnnotation : undefined
		return annotation === null || annotation === undefined ? [] : [annotation.typeAnnotation]
	})

/** The identifier a type reference names first: `Name` of `Name<…>`, `ns` of `ns.Name<…>`. */
const typeNameRoot = (name: AnyNode): Option.Option<NodeOf<"Identifier">> => {
	if (name.type === "Identifier") {
		return Option.some(name)
	}
	return name.type === "TSQualifiedName" ? typeNameRoot(name.left) : Option.none()
}

/** Whether a type, or a member of a union type, refers to a type a module `isModule` takes exports. */
const refersToModuleType = (
	context: Context,
	type: TypeNode,
	isModule: (specifier: string) => boolean
): boolean => {
	if (type.type === "TSUnionType") {
		return Arr.some(type.types, (member) => refersToModuleType(context, member, isModule))
	}
	if (type.type !== "TSTypeReference") {
		return false
	}
	return Option.exists(
		Option.flatMap(typeNameRoot(type.typeName), (root) => importedIdentifier(context, root)),
		(imported) => isModule(imported.specifier)
	)
}

/**
 * Whether an expression is a value of a module's, by the file's evidence: a call of one of the module's exports, an
 * instance one of them constructs, a property or a method's result read off such a value, a binding declared with
 * one, or a binding annotated with one of the module's types. A cyclic binding ends the walk.
 */
export const isValueOf = (
	context: Context,
	expression: Expression,
	isModule: (specifier: string) => boolean,
	seen: Set<AnyNode>
): boolean => {
	const inner = unwrapped(expression)
	if (seen.has(inner)) {
		return false
	}
	seen.add(inner)
	const traced = (next: Expression): boolean => isValueOf(context, next, isModule, seen)
	if (inner.type === "CallExpression" || inner.type === "NewExpression") {
		const callee = inner.callee
		if (Option.exists(importedAt(context, callee), (imported) => isModule(imported.specifier))) {
			return true
		}
		return callee.type === "MemberExpression" && traced(callee.object)
	}
	if (inner.type === "MemberExpression") {
		return traced(inner.object)
	}
	if (inner.type === "AwaitExpression") {
		return traced(inner.argument)
	}
	return (
		inner.type === "Identifier" &&
		Option.exists(
			variableOf(context, inner),
			(variable) =>
				Option.exists(importOf(variable), (imported) => isModule(imported.specifier)) ||
				Arr.some(initializersOf(variable), traced) ||
				Arr.some(annotationsOf(variable), (type) => refersToModuleType(context, type, isModule))
		)
	)
}
/** The name the top-level variable whose initializer holds `node` declares, exported or not. */
export const topLevelNameOf = (node: AnyNode): Option.Option<string> =>
	Arr.findFirst(ancestorsOf(node), (ancestor) => {
		if (ancestor.type !== "VariableDeclarator" || ancestor.id.type !== "Identifier") {
			return Option.none()
		}
		const holder = ancestor.parent.parent
		const atTop =
			holder !== null &&
			(holder.type === "Program" ||
				(holder.type === "ExportNamedDeclaration" && holder.parent.type === "Program"))
		return atTop ? Option.some(ancestor.id.name) : Option.none()
	})

/** Whether a node sits inside a function, below its file's top level. */
export const isEnclosedByFunction = (node: AnyNode): boolean =>
	Arr.some(
		ancestorsOf(node),
		(ancestor) =>
			ancestor.type === "ArrowFunctionExpression" ||
			ancestor.type === "FunctionExpression" ||
			ancestor.type === "FunctionDeclaration"
	)

/** A repository-relative path in a rule's options: one ending in "/" names a directory and every file beneath it, any
 * other one file. A linted file's name is absolute. */
const isAtPath = (filename: string, path: string): boolean =>
	Str.endsWith("/")(path)
		? Str.startsWith(path)(filename) || Str.includes(`/${path}`)(filename)
		: isFileAt(filename, path)

/** Whether a linted file is at one of the paths. */
export const isAtAny = (filename: string, paths: ReadonlyArray<string>): boolean =>
	Arr.some(paths, (path) => isAtPath(filename, path))

/** A report's text: what is wrong, then what to do instead. */
export const advice = (message: string, suggestion: string): string => `${message} ${suggestion}`
