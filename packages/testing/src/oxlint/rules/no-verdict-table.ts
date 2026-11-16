import { Array as Arr, Option, Result } from "effect"
import { type AnyNode, type Context, refusal } from "#oxlint/rule.ts"
import { keyOf } from "#oxlint/syntax.ts"

/** The keys a row states its verdict under, an object's property or a tuple's label: the output a person wrote. */
export const VERDICT_KEYS: ReadonlyArray<string> = ["expected", "verdict", "outcome", "answer"]

/**
 * The modules a Dictionary is minted through, as the code imports them, and the mint's name. import-doors lets only a
 * dictionary door import the mint, so a module that imports it (by name or with the whole module) is a door, and its
 * lists are closed vocabularies of the domain (a language's keywords), not chosen cases.
 */
export const DICTIONARY_MODULES: ReadonlyArray<string> = [
	"@bjornpagen/testing/dictionary",
	"#dictionary.ts"
]

export const DICTIONARY_MINT = "dictionary"

/** Whether an import declaration reaches the dictionary mint: a named import of it, or the whole module. */
const importsMint = (statement: AnyNode): boolean =>
	statement.type === "ImportDeclaration" &&
	Arr.contains(DICTIONARY_MODULES, statement.source.value) &&
	Arr.some(
		statement.specifiers,
		(specifier) =>
			specifier.type === "ImportNamespaceSpecifier" ||
			(specifier.type === "ImportSpecifier" &&
				(specifier.imported.type === "Identifier"
					? specifier.imported.name
					: specifier.imported.value) === DICTIONARY_MINT)
	)

/** An expression as written, through type assertions, `satisfies` and parentheses. */
const bare = (node: AnyNode): AnyNode =>
	node.type === "TSAsExpression" ||
	node.type === "TSSatisfiesExpression" ||
	node.type === "TSTypeAssertion" ||
	node.type === "ParenthesizedExpression"
		? bare(node.expression)
		: node

/**
 * A verdict written into the test: a literal, a negated one, `undefined`, a template without expressions, or an array
 * or object literal of written verdicts. A verdict computed (a model's answer, an oracle's, a value the case drew) is
 * none: a row of computed verdicts is a check, not a table.
 */
const isWritten = (expression: AnyNode): boolean => {
	const node = bare(expression)
	if (node.type === "Literal") {
		return !("regex" in node)
	}
	if (node.type === "Identifier") {
		return node.name === "undefined"
	}
	if (node.type === "UnaryExpression") {
		return node.operator === "-" && isWritten(node.argument)
	}
	if (node.type === "TemplateLiteral") {
		return node.expressions.length === 0
	}
	if (node.type === "ArrayExpression") {
		return Arr.every(node.elements, (element) => element !== null && isWritten(element))
	}
	return (
		node.type === "ObjectExpression" &&
		Arr.every(
			node.properties,
			(property) => property.type === "Property" && isWritten(property.value)
		)
	)
}

/** An object row: an object literal that states a written verdict under one of the verdict keys. */
const isObjectRow = (node: AnyNode): boolean =>
	node.type === "ObjectExpression" &&
	Arr.some(
		node.properties,
		(property) =>
			property.type === "Property" &&
			Option.exists(keyOf(property), (key) => Arr.contains(VERDICT_KEYS, key)) &&
			isWritten(property.value)
	)

/** The type annotations a list literal is declared under: the `as` or `satisfies` around it, and the type of the
 * constant or variable it initializes. */
const declaredTypesOf = (list: AnyNode): ReadonlyArray<AnyNode> => {
	const parent = list.parent
	if (parent === null) {
		return []
	}
	if (parent.type === "TSAsExpression" || parent.type === "TSSatisfiesExpression") {
		return [parent.typeAnnotation, ...declaredTypesOf(parent)]
	}
	if (parent.type === "ParenthesizedExpression") {
		return declaredTypesOf(parent)
	}
	return parent.type === "VariableDeclarator" &&
		parent.init === list &&
		parent.id.type === "Identifier" &&
		parent.id.typeAnnotation !== null &&
		parent.id.typeAnnotation !== undefined
		? [parent.id.typeAnnotation.typeAnnotation]
		: []
}

/** The module's own type aliases by name, which a declared type is read through. */
const ownAliasesOf = (context: Context): ReadonlyMap<string, AnyNode> =>
	new Map(
		Arr.filterMap(context.sourceCode.ast.body, (statement) => {
			const node =
				statement.type === "ExportNamedDeclaration" && statement.declaration !== null
					? statement.declaration
					: statement
			return node.type === "TSTypeAliasDeclaration"
				? Result.succeed([node.id.name, node.typeAnnotation] as const)
				: Result.failVoid
		})
	)

/**
 * The place of a tuple's member a type labels with a verdict key, at any depth: 1 for `ReadonlyArray<readonly [input:
 * string, expected: number]>`, and through the module's own aliases (`Array<Row>`, `type Row = readonly [query: Q,
 * answer: A]`).
 */
const verdictPlaceOf = (
	type: AnyNode,
	aliases: ReadonlyMap<string, AnyNode>,
	seen: ReadonlySet<string>
): Option.Option<number> => {
	if (type.type === "TSTupleType") {
		return Option.orElse(
			Arr.findFirstIndex(
				type.elementTypes,
				(member) =>
					member.type === "TSNamedTupleMember" && Arr.contains(VERDICT_KEYS, member.label.name)
			),
			() =>
				Arr.findFirst(type.elementTypes, (member) =>
					verdictPlaceOf(
						member.type === "TSNamedTupleMember" ? member.elementType : member,
						aliases,
						seen
					)
				)
		)
	}
	if (type.type === "TSArrayType") {
		return verdictPlaceOf(type.elementType, aliases, seen)
	}
	if (type.type === "TSTypeOperator") {
		return verdictPlaceOf(type.typeAnnotation, aliases, seen)
	}
	if (type.type !== "TSTypeReference") {
		return Option.none()
	}
	const name = type.typeName.type === "Identifier" ? type.typeName.name : ""
	const own = aliases.get(name)
	return Option.orElse(
		own === undefined || seen.has(name)
			? Option.none()
			: verdictPlaceOf(own, aliases, new Set([...seen, name])),
		() =>
			Arr.findFirst(type.typeArguments?.params ?? [], (argument) =>
				verdictPlaceOf(argument, aliases, seen)
			)
	)
}

/** A tuple row with a written verdict at the place its type labels. */
const isTupleRow = (row: AnyNode, place: number): boolean => {
	const node = bare(row)
	return (
		node.type === "ArrayExpression" &&
		Option.exists(
			Option.fromUndefinedOr(node.elements[place]),
			(verdict) => verdict !== null && isWritten(verdict)
		)
	)
}

/** The rows of the least table: a list of one row is a value, not a table. */
const TABLE_ROWS = 2

/**
 * Verdict tables in test scope: a list literal of inputs paired with the verdicts a person wrote, a row being an
 * object literal with a written verdict (a literal) under `expected`, `verdict`, `outcome` or `answer`, or a tuple with
 * a written verdict at the member its list's declared type labels with one of them
 * (`ReadonlyArray<readonly [input: string, expected: number]>`, through the module's own type aliases); a table is
 * two rows or more and nothing else but spreads. A table checks only the rows someone thought of, against answers someone
 * wrote. A dictionary door's lists (a module that imports the `dictionary` mint) are vocabularies and pass; a source
 * roster lies outside test scope, where the preset runs the rule. It reads syntax alone.
 */
export const noVerdictTable = refusal(
	"verdictTable",
	"This is a verdict table: inputs paired with the answers a person wrote check only the rows someone thought of. Draw the inputs from a generator and check them against an oracle (a second implementation, a law, a model); a closed vocabulary of the domain is a Dictionary minted in its door.",
	(context, refuse) => {
		const isDoor = Arr.some(context.sourceCode.ast.body, importsMint)
		const aliases = ownAliasesOf(context)
		return isDoor
			? {}
			: {
					ArrayExpression: (node) => {
						const places = Arr.filterMap(declaredTypesOf(node), (type) =>
							Result.fromOption(verdictPlaceOf(type, aliases, new Set()), () => undefined)
						)
						const rows = Arr.filter(
							node.elements,
							(element) => element !== null && element.type !== "SpreadElement"
						)
						const isRow = (row: AnyNode | null): boolean =>
							row !== null &&
							(isObjectRow(bare(row)) || Arr.some(places, (place) => isTupleRow(row, place)))
						if (rows.length >= TABLE_ROWS && Arr.every(rows, isRow)) {
							refuse(node)
						}
					}
				}
	}
)
