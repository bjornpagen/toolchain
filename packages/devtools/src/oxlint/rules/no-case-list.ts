import { Array as Arr, Option, Schema, String as Str } from "effect"
import { type AnyNode, configured, type Context, isFileAt, type NodeOf } from "#oxlint/rule.ts"
import { isTestFile } from "#shared/tests.ts"

/**
 * What a generator draws: the members of the list it is handed (`element`), the one value it is handed (`constant`),
 * one value for each value of the generator it is handed (`map`, `span`, `drawn`, `sketched`), or a value of one of the
 * generators it is handed (`oneOf`, `weighted`, `proportional`).
 */
const Draws = Schema.Literals(["list", "value", "each", "union"])

type Draws = typeof Draws.Type

/**
 * The searches and generators by the module they are imported from, as the code imports it (`@bjornpagen/testing/explore`),
 * each search with the property of its spec that holds its space (`exhaust`'s `generator`, `explore`'s `draw`) and
 * each generator with what it draws; and the files whose own lists are lists of cases, beside the test files, whose
 * lists always are: a directory (`test/`), or one file, from the repository root.
 */
const Options = Schema.Struct({
	searches: Schema.Array(
		Schema.Struct({ module: Schema.String, name: Schema.String, space: Schema.String })
	),
	generators: Schema.Array(
		Schema.Struct({ module: Schema.String, names: Schema.Array(Schema.String), draws: Draws })
	),
	cases: Schema.Array(Schema.String)
})

type Scope = ReturnType<Context["sourceCode"]["getScope"]>

type Variable = Scope["variables"][number]

/** What makes a space a list of cases: a list written in the tests it draws from, or the one value it holds. */
type CaseList = Readonly<{ kind: "written"; list: AnyNode }> | Readonly<{ kind: "single" }>

/** An expression as written, through type assertions, `satisfies` and non-null assertions. */
const bare = (node: AnyNode): AnyNode =>
	node.type === "TSAsExpression" ||
	node.type === "TSSatisfiesExpression" ||
	node.type === "TSNonNullExpression" ||
	node.type === "TSTypeAssertion"
		? bare(node.expression)
		: node

const isFunctionLiteral = (node: AnyNode): boolean =>
	node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression"

/** A literal that is no generator and no list: a weight, a label. */
const isPrimitiveLiteral = (node: AnyNode): boolean =>
	(node.type === "Literal" && !("regex" in node)) ||
	node.type === "TemplateLiteral" ||
	node.type === "UnaryExpression"

/** Whether a file is one of the paths: a directory and every file beneath it, or one file. */
const isAtAny = (filename: string, paths: ReadonlyArray<string>): boolean =>
	Arr.some(paths, (path) => {
		const directory = Str.endsWith("/")(path) ? Str.slice(0, -1)(path) : path
		return (
			isFileAt(filename, path) ||
			Str.startsWith(`${directory}/`)(filename) ||
			Str.includes(`/${directory}/`)(filename)
		)
	})

/** A property's name as written, when it is an identifier or a string. */
const propertyNameOf = (property: NodeOf<"Property">): Option.Option<string> => {
	if (property.computed) {
		return Option.none()
	}
	const { key } = property
	if (key.type === "Identifier") {
		return Option.some(key.name)
	}
	return key.type === "Literal" && typeof key.value === "string"
		? Option.some(key.value)
		: Option.none()
}

/** The variable an identifier names where it stands: the nearest scope's of its name; none for a global. */
const resolve = (context: Context, identifier: AnyNode): Option.Option<Variable> => {
	if (identifier.type !== "Identifier") {
		return Option.none()
	}
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

/** What an import binding names: its module's specifier, and the export it names, or every export for a namespace. */
type Imported = Readonly<{ module: string; name: Option.Option<string> }>

const importedOf = (variable: Variable): Option.Option<Imported> =>
	Arr.findFirst(variable.defs, (definition) => {
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
	})

/** The export a callee names, by its module and name: an imported name, or a member of a namespace import. */
const exportOf = (
	context: Context,
	callee: AnyNode
): Option.Option<Readonly<{ module: string; name: string }>> => {
	if (callee.type === "Identifier") {
		return Option.flatMap(Option.flatMap(resolve(context, callee), importedOf), (imported) =>
			Option.map(imported.name, (name) => ({ module: imported.module, name }))
		)
	}
	if (
		callee.type !== "MemberExpression" ||
		callee.computed ||
		callee.property.type !== "Identifier"
	) {
		return Option.none()
	}
	const method = callee.property.name
	return Option.flatMap(Option.flatMap(resolve(context, callee.object), importedOf), (imported) =>
		Option.isNone(imported.name)
			? Option.some({ module: imported.module, name: method })
			: Option.none()
	)
}

/**
 * no-case-list: a search's space is never a list of cases. A test is an example when a person chose its inputs and
 * wrote its verdict, and a list of cases run through `exhaust` or `explore` is one: the search only replays what the
 * list holds. For every call of a search the options name, the space its spec holds is refused when it is a case list:
 *
 * - `element` over a list written in the tests: an array literal of a test file, or of a file the options name as
 *   cases; held by a constant, or computed from one by a call (`nonEmpty(cases)`, `Arr.filter(cases, …)`); an array
 *   literal of spreads alone writes nothing of its own;
 * - `constant`, one value, which is one case;
 * - a generator that draws one value for each of another's (`map`, `span`, `drawn`, `sketched`) over a case list;
 * - a choice among generators (`oneOf`, `weighted`, `proportional`) whose every option is a case list.
 *
 * A space built from bounds (`int(0, 3)`, `array(g, { min, max })`), from a dictionary, or from a roster the source
 * declares is a generator and passes, as does a product of generators (`record`, `array`). It reads syntax alone: a
 * search or a generator is the export the options name, imported by name or reached through a namespace import of its
 * module, and a name is followed to the constant, or the property of a constant's object literal, that holds it, in
 * this file. A list another module exports is that module's roster or dictionary, which this file cannot read, so it
 * passes.
 */
export const noCaseList = configured(Options, (context, options) => {
	const ownListsAreCases = isTestFile(context.filename) || isAtAny(context.filename, options.cases)
	const drawsOf = (callee: AnyNode): Option.Option<Draws> =>
		Option.flatMap(exportOf(context, callee), ({ module, name }) =>
			Option.map(
				Arr.findFirst(
					options.generators,
					(generator) => generator.module === module && Arr.contains(generator.names, name)
				),
				(generator) => generator.draws
			)
		)
	const spaceNameOf = (callee: AnyNode): Option.Option<string> =>
		Option.flatMap(exportOf(context, callee), ({ module, name }) =>
			Option.map(
				Arr.findFirst(
					options.searches,
					(search) => search.module === module && search.name === name
				),
				(search) => search.space
			)
		)
	/** The value a constant of this file holds, through a property of its object literal for `object.property`. */
	const heldBy = (node: AnyNode): Option.Option<AnyNode> => {
		if (node.type === "MemberExpression") {
			if (node.computed || node.property.type !== "Identifier") {
				return Option.none()
			}
			const name = node.property.name
			return Option.flatMap(heldBy(node.object), (object) => {
				const literal = bare(object)
				return literal.type === "ObjectExpression"
					? Arr.findLast(literal.properties, (property) =>
							property.type === "Property" && Option.contains(propertyNameOf(property), name)
								? Option.some(property.value)
								: Option.none()
						)
					: Option.none()
			})
		}
		return Option.flatMap(resolve(context, node), (variable) =>
			Arr.findFirst(variable.defs, (definition) => {
				const declarator = definition.node
				const declaration = definition.parent
				return definition.type === "Variable" &&
					declarator.type === "VariableDeclarator" &&
					declaration?.type === "VariableDeclaration" &&
					declaration.kind === "const" &&
					declarator.init !== null
					? Option.some(declarator.init)
					: Option.none()
			})
		)
	}
	/** The list written in the tests that an expression is, holds or is computed from. */
	const writtenListOf = (expression: AnyNode, seen: Set<AnyNode>): Option.Option<AnyNode> => {
		const node = bare(expression)
		if (seen.has(node)) {
			return Option.none()
		}
		seen.add(node)
		if (node.type === "ArrayExpression") {
			const written = Arr.some(
				node.elements,
				(element) => element !== null && element.type !== "SpreadElement"
			)
			if (written) {
				return ownListsAreCases ? Option.some(node) : Option.none()
			}
			return Arr.findFirst(node.elements, (element) =>
				element?.type === "SpreadElement" ? writtenListOf(element.argument, seen) : Option.none()
			)
		}
		if (node.type === "Identifier" || node.type === "MemberExpression") {
			return Option.flatMap(heldBy(node), (held) => writtenListOf(held, seen))
		}
		return node.type === "CallExpression"
			? Arr.findFirst(node.arguments, (argument) =>
					isFunctionLiteral(bare(argument)) ? Option.none() : writtenListOf(argument, seen)
				)
			: Option.none()
	}
	/** The generators a choice offers: its arguments, through the lists that hold them, without the weights beside them;
	 * a function written in place is a generator of its own, and so an option that is no case list. */
	const optionsOf = (
		expressions: ReadonlyArray<AnyNode>,
		seen: Set<AnyNode>
	): ReadonlyArray<AnyNode> =>
		Arr.flatMap(expressions, (expression) => {
			const node = bare(expression)
			if (isPrimitiveLiteral(node) || seen.has(node)) {
				return []
			}
			seen.add(node)
			if (node.type === "ArrayExpression") {
				return optionsOf(
					Arr.filter(node.elements, (element) => element !== null),
					seen
				)
			}
			if (node.type === "Identifier") {
				const held = heldBy(node)
				return Option.exists(held, (value) => bare(value).type === "ArrayExpression")
					? optionsOf(Option.toArray(held), seen)
					: [node]
			}
			return [node]
		})
	/** Whether a space is a case list, and what makes it one. */
	const caseListOf = (expression: AnyNode, seen: Set<AnyNode>): Option.Option<CaseList> => {
		const node = bare(expression)
		if (seen.has(node)) {
			return Option.none()
		}
		seen.add(node)
		if (node.type === "Identifier") {
			return Option.flatMap(heldBy(node), (held) => caseListOf(held, seen))
		}
		if (node.type !== "CallExpression") {
			return Option.none()
		}
		const draws = drawsOf(node.callee)
		if (Option.isNone(draws)) {
			return Option.none()
		}
		const [first] = node.arguments
		switch (draws.value) {
			case "list":
				return first === undefined
					? Option.none()
					: Option.map(writtenListOf(first, new Set()), (list): CaseList => ({
							kind: "written",
							list
						}))
			case "value":
				return Option.some({ kind: "single" })
			case "each":
				return Arr.findFirst(node.arguments, (argument) =>
					isFunctionLiteral(bare(argument)) || isPrimitiveLiteral(bare(argument))
						? Option.none()
						: caseListOf(argument, seen)
				)
			case "union": {
				const lists = Arr.map(optionsOf(node.arguments, new Set()), (option) =>
					caseListOf(option, seen)
				)
				return Arr.isReadonlyArrayNonEmpty(lists) && Arr.every(lists, Option.isSome)
					? Arr.headNonEmpty(lists)
					: Option.none()
			}
		}
	}
	/** The spec object a search is handed, as written or held by a constant. */
	const specOf = (expression: AnyNode): Option.Option<NodeOf<"ObjectExpression">> => {
		const node = bare(expression)
		if (node.type === "ObjectExpression") {
			return Option.some(node)
		}
		return node.type === "Identifier" ? Option.flatMap(heldBy(node), specOf) : Option.none()
	}
	/** The property of a spec that holds its space, and the space. */
	const spaceOf = (
		spec: NodeOf<"ObjectExpression">,
		name: string
	): Option.Option<Readonly<{ property: AnyNode; space: AnyNode }>> =>
		Arr.findLast(spec.properties, (property) =>
			property.type === "Property" && Option.contains(propertyNameOf(property), name)
				? Option.some({ property, space: property.value })
				: Option.none()
		)
	const messageOf = (list: CaseList): string => {
		const suggestion =
			"Draw the space from a generator its bounds define, from a dictionary of the values the code branches on, or from a roster the source declares; a case list belongs nowhere."
		if (list.kind === "single") {
			return `This search's space is one value: its one case is an example, which a person chose and whose verdict a person wrote. ${suggestion}`
		}
		return `This search's space is a list of cases written in the tests (line ${String(list.list.loc.start.line)}): a person chose every input, so the search replays examples. ${suggestion}`
	}
	return {
		CallExpression: (node) => {
			const [spec] = node.arguments
			const name = spaceNameOf(node.callee)
			if (Option.isNone(name) || spec === undefined) {
				return
			}
			const found = Option.flatMap(
				Option.flatMap(specOf(spec), (literal) => spaceOf(literal, name.value)),
				({ property, space }) =>
					Option.map(caseListOf(space, new Set()), (list) => ({ property, list }))
			)
			if (Option.isSome(found)) {
				context.report({ node: found.value.property, message: messageOf(found.value.list) })
			}
		}
	}
})
