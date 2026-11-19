import { isTestScope } from "@bjornpagen/testing/scope"
import { Array as Arr, Option, Schema, String as Str } from "effect"
import { type AnyNode, configured, type Context, isFileAt, type NodeOf } from "#oxlint/rule.ts"

/**
 * What a generator draws: the members of the list it is handed (`element`), the one value it is handed (`constant`),
 * an integer between the two bounds it is handed (`int`), one value for each value of the generator it is handed
 * (`map`, `span`, `drawn`, `sketched`, `aimed`), or a value of one of the generators it is handed (`oneOf`,
 * `weighted`, `proportional`).
 */
const Draws = Schema.Literals(["list", "value", "range", "each", "union"])

/**
 * Where a search holds its space: an argument of its call, by its place (`property.explore(space, spec)` holds it at
 * 0), or a field of the spec it is handed first (`exhaust({ generator }, check)` holds it in `generator`).
 */
const Holds = Schema.Union([
	Schema.Struct({ argument: Schema.Int }),
	Schema.Struct({ field: Schema.String })
])

type Holds = typeof Holds.Type

/** An export, by the module it is imported from and its names there. */
const Exported = Schema.Struct({ module: Schema.String, names: Schema.Array(Schema.String) })

type Draws = typeof Draws.Type

/**
 * The searches and generators by the module they are imported from, as the code imports it
 * (`@bjornpagen/testing/property`), each search by the name it is called by (`exhaust`, or `property.explore` for a
 * member of a named import) with where it holds its space (the first argument of `property.explore`, `exhaust`'s
 * spec field `generator`, `explore`'s `draw`), each generator with what it draws, and the mints of a dictionary (`dictionary(items)`), whose
 * list is a vocabulary of the domain: the testing library's own (its oxlint module's CASE_LISTS) beside a repository's
 * own search helpers and generators. Then the files whose own lists are lists of cases beyond test scope, whose lists
 * always are: a directory (`src/planted/`), or one file, from the repository root; and the dictionary doors in test
 * scope, as the code imports them, whose exports are dictionaries.
 */
const Options = Schema.Struct({
	searches: Schema.Array(
		Schema.Struct({ module: Schema.String, name: Schema.String, space: Holds })
	),
	generators: Schema.Array(
		Schema.Struct({ module: Schema.String, names: Schema.Array(Schema.String), draws: Draws })
	),
	mints: Schema.Array(Exported),
	cases: Schema.Array(Schema.String),
	dictionaries: Schema.Array(Schema.String)
})

type Scope = ReturnType<Context["sourceCode"]["getScope"]>

type Variable = Scope["variables"][number]

/** Where a list of cases is written: in this file at a node, or in a module of the tests this file imports it from. */
type Origin =
	| Readonly<{ kind: "written"; list: AnyNode }>
	| Readonly<{ kind: "imported"; module: string }>

/**
 * What makes a space a list of cases: the members of a list of cases, the indices of one (`int(0, xs.length - 1)`),
 * or one value (`constant(x)`, `int(n, n)`).
 */
type CaseList =
	| Readonly<{ kind: "members"; origin: Origin }>
	| Readonly<{ kind: "indices"; origin: Origin }>
	| Readonly<{ kind: "single" }>

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

/**
 * A linted file's path from the directory oxlint runs in (the repository's root or a package's), where test scope's
 * directories are read; a file outside it keeps its absolute path, and is read whole.
 */
const relativePathOf = (filename: string, cwd: string): string =>
	Str.startsWith(`${cwd}/`)(filename) ? Str.slice(cwd.length + 1)(filename) : filename

/** A path's segments with `.` and `..` resolved; a `..` above the start is kept. */
const normalized = (segments: ReadonlyArray<string>): ReadonlyArray<string> =>
	Arr.reduce(segments, [], (kept: ReadonlyArray<string>, segment): ReadonlyArray<string> => {
		if (segment === "." || segment === "") {
			return kept
		}
		return segment === ".." && Option.exists(Arr.last(kept), (last) => last !== "..")
			? Arr.dropRight(kept, 1)
			: Arr.append(kept, segment)
	})

/**
 * The path a module specifier names, as far as its text tells: a relative specifier resolved against the importing
 * file's directory; a subpath import (`#test/support/cases.ts`) as the path it spells past its `#`, which is the
 * directory the repositories' import maps name; a package's specifier as its subpath past the package's name
 * (`@scope/package/test/cases.ts` as `test/cases.ts`).
 */
const pathOfSpecifier = (importer: string, specifier: string): string => {
	if (Str.startsWith("#")(specifier)) {
		return Str.slice(1)(specifier)
	}
	const segments = Str.split("/")(specifier)
	if (Str.startsWith("./")(specifier) || Str.startsWith("../")(specifier)) {
		return Arr.join(normalized([...Arr.dropRight(Str.split("/")(importer), 1), ...segments]), "/")
	}
	return Arr.join(Arr.drop(segments, Str.startsWith("@")(specifier) ? 2 : 1), "/")
}

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

/**
 * The export a callee names, by its module and name: an imported name, a member of a namespace import, or a member of
 * a named import under its dotted name (`property.explore`).
 */
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
	return Option.map(Option.flatMap(resolve(context, callee.object), importedOf), (imported) => ({
		module: imported.module,
		name: Option.match(imported.name, {
			onNone: () => method,
			onSome: (name) => `${name}.${method}`
		})
	}))
}

/**
 * no-case-list: a search's space is never a list of cases. A test is an example when a person chose its inputs and
 * wrote its verdict, and a list of cases run through a search is one: the search only replays what the list holds. For
 * every call of a search the options name, the space its spec holds is refused when it is a case list:
 *
 * - `element` over a list of cases: an array literal of a test scope module, or of a file the options name as cases;
 *   held by a constant, or computed from one by a call (`nonEmpty(cases)`, `Arr.filter(cases, …)`); an array literal
 *   of spreads alone writes nothing of its own; or a list imported, by name or through a namespace import, from a
 *   module whose specifier names test scope (`#test/support/cases.ts`, `#chance.fixtures.ts`) and no dictionary;
 * - `constant`, one value, which is one case, and a range of one value, `int(n, n)`;
 * - a range whose bound is a list of cases' length (`int(0, xs.length - 1)`), which exhausts the list by its index;
 * - a generator that draws one value for each of another's (`map`, `span`, `drawn`, `sketched`) over a case list;
 * - a choice among generators (`oneOf`, `weighted`, `proportional`) whose every option is a case list.
 *
 * A space built from bounds (`int(0, 3)`, `array(g, { min, max })`), from a dictionary, or from a roster the source
 * declares is a generator and passes, as does a product of generators (`record`, `array`); a list handed to a
 * dictionary's mint is a vocabulary, and a dictionary door's exports are dictionaries. It reads syntax alone: a
 * search or a generator is the export the options name, imported by name or reached through an import's member, and
 * a name is followed to the constant, or the property of a constant's object literal, that holds it, in this file, or
 * to the specifier of the module it is imported from. A list a package or a source module exports is its roster or
 * dictionary, which passes.
 */
export const noCaseList = configured(Options, (context, options) => {
	const path = relativePathOf(context.filename, context.cwd)
	const ownListsAreCases = isTestScope(path) || isAtAny(context.filename, options.cases)
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
	/** A call of a dictionary's mint, whose list is a vocabulary. */
	const isMint = (callee: AnyNode): boolean =>
		Option.exists(exportOf(context, callee), ({ module, name }) =>
			Arr.some(options.mints, (mint) => mint.module === module && Arr.contains(mint.names, name))
		)
	const holdsOf = (callee: AnyNode): Option.Option<Holds> =>
		Option.flatMap(exportOf(context, callee), ({ module, name }) =>
			Option.map(
				Arr.findFirst(
					options.searches,
					(search) => search.module === module && search.name === name
				),
				(search) => search.space
			)
		)
	/** The module of the tests a binding is imported from: a specifier naming test scope and no dictionary. */
	const caseModuleOf = (identifier: AnyNode): Option.Option<string> =>
		Option.filter(
			Option.map(
				Option.flatMap(resolve(context, identifier), importedOf),
				(imported) => imported.module
			),
			(module) =>
				!Arr.contains(options.dictionaries, module) && isTestScope(pathOfSpecifier(path, module))
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
	/** The root binding of a member chain, or the identifier itself. */
	const rootOf = (node: AnyNode): AnyNode =>
		node.type === "MemberExpression" ? rootOf(node.object) : node
	/** Where the list of cases that an expression is, holds or is computed from is written. */
	const originOf = (expression: AnyNode, seen: Set<AnyNode>): Option.Option<Origin> => {
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
				return ownListsAreCases ? Option.some({ kind: "written", list: node }) : Option.none()
			}
			return Arr.findFirst(node.elements, (element) =>
				element?.type === "SpreadElement" ? originOf(element.argument, seen) : Option.none()
			)
		}
		if (node.type === "Identifier" || node.type === "MemberExpression") {
			return Option.orElse(
				Option.flatMap(heldBy(node), (held) => originOf(held, seen)),
				() =>
					Option.map(caseModuleOf(rootOf(node)), (module): Origin => ({ kind: "imported", module }))
			)
		}
		return node.type === "CallExpression" && !isMint(node.callee)
			? Arr.findFirst(node.arguments, (argument) =>
					isFunctionLiteral(bare(argument)) ? Option.none() : originOf(argument, seen)
				)
			: Option.none()
	}
	/** The list of cases whose length a range's bound reads: `xs.length`, or `xs.length - k`. */
	const lengthOriginOf = (bound: AnyNode): Option.Option<Origin> => {
		const node = bare(bound)
		if (node.type === "BinaryExpression" && node.operator === "-") {
			return lengthOriginOf(node.left)
		}
		return node.type === "MemberExpression" &&
			!node.computed &&
			node.property.type === "Identifier" &&
			node.property.name === "length"
			? originOf(node.object, new Set())
			: Option.none()
	}
	/** Whether a range's two bounds are one value: the same text, through type assertions. */
	const isDegenerate = (lo: AnyNode, hi: AnyNode): boolean =>
		context.sourceCode.getText(bare(lo)) === context.sourceCode.getText(bare(hi))
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
		const [first, second] = node.arguments
		switch (draws.value) {
			case "list":
				return first === undefined
					? Option.none()
					: Option.map(originOf(first, new Set()), (origin): CaseList => ({
							kind: "members",
							origin
						}))
			case "value":
				return Option.some({ kind: "single" })
			case "range":
				if (first === undefined || second === undefined) {
					return Option.none()
				}
				return isDegenerate(first, second)
					? Option.some({ kind: "single" })
					: Option.map(
							Option.orElse(lengthOriginOf(second), () => lengthOriginOf(first)),
							(origin): CaseList => ({ kind: "indices", origin })
						)
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
	const fieldOf = (
		spec: NodeOf<"ObjectExpression">,
		name: string
	): Option.Option<Readonly<{ at: AnyNode; space: AnyNode }>> =>
		Arr.findLast(spec.properties, (property) =>
			property.type === "Property" && Option.contains(propertyNameOf(property), name)
				? Option.some({ at: property, space: property.value })
				: Option.none()
		)
	/** A search call's space, where it holds it, and the node a report points at: the argument, or the spec's field. */
	const spaceOf = (
		call: NodeOf<"CallExpression">,
		holds: Holds
	): Option.Option<Readonly<{ at: AnyNode; space: AnyNode }>> => {
		if ("argument" in holds) {
			return Option.map(Option.fromUndefinedOr(call.arguments[holds.argument]), (space) => ({
				at: space,
				space
			}))
		}
		return Option.flatMap(Option.flatMap(Arr.head(call.arguments), specOf), (spec) =>
			fieldOf(spec, holds.field)
		)
	}
	const whereOf = (origin: Origin): string => {
		switch (origin.kind) {
			case "written":
				return `a list of cases written in the tests (line ${String(origin.list.loc.start.line)})`
			case "imported":
				return `a list of cases that ${origin.module}, a module of the tests, exports`
		}
	}
	const messageOf = (list: CaseList): string => {
		const suggestion =
			"Draw the space from a generator its bounds define, from a dictionary of the values the code branches on, or from a roster the source declares; a case list belongs nowhere."
		switch (list.kind) {
			case "single":
				return `This search's space is one value: its one case is an example, which a person chose and whose verdict a person wrote. ${suggestion}`
			case "members":
				return `This search's space is ${whereOf(list.origin)}: a person chose every input, so the search replays examples. ${suggestion}`
			case "indices":
				return `This search's space is the index of ${whereOf(list.origin)}: it exhausts a list a person chose, so the search replays examples. ${suggestion}`
		}
	}
	return {
		CallExpression: (node) => {
			const found = Option.flatMap(
				Option.flatMap(holdsOf(node.callee), (holds) => spaceOf(node, holds)),
				({ at, space }) => Option.map(caseListOf(space, new Set()), (list) => ({ at, list }))
			)
			if (Option.isSome(found)) {
				context.report({ node: found.value.at, message: messageOf(found.value.list) })
			}
		}
	}
})
