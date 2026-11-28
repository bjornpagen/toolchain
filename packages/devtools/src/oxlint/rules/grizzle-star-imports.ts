import { Array as Arr, Option, Order, Record, String as Str } from "effect"
import type { AnyNode, Context, CreateRule, NodeOf } from "#oxlint/rule.ts"

/** grizzle's package, whose root and every entry beneath it the rule reads. */
const PACKAGE = "@bjornpagen/grizzle"

type Reference = ReturnType<
	Context["sourceCode"]["getDeclaredVariables"]
>[number]["references"][number]
type Import = NodeOf<"ImportDeclaration">
type Specifier = Import["specifiers"][number]

/** One text edit of a fix: the source range it replaces and the text it writes there. */
type Edit = Readonly<{ start: number; end: number; text: string }>

/** A grizzle entry as a module imports it: its specifier, and the one name its namespace is imported under. */
type Entry = Readonly<{ source: string; alias: string }>

const isLowercaseWord = (text: string): boolean =>
	text.length > 0 && Arr.every(Str.split(text, ""), (letter) => letter >= "a" && letter <= "z")

/**
 * The entry a module specifier names, where it names one of grizzle's: the package's root, imported as `g`, or
 * `@bjornpagen/grizzle/<entry>` of one lowercase word, imported as `g` and the entry capitalized: gRuntime, gCompile,
 * gClient. The name follows from the entry, so a new entry has its name without the rule changing.
 */
export const entryOf = (source: string): Option.Option<Entry> => {
	if (source === PACKAGE) {
		return Option.some({ source, alias: "g" })
	}
	const entry = Str.slice(PACKAGE.length + 1)(source)
	return Str.startsWith(`${PACKAGE}/`)(source) && isLowercaseWord(entry)
		? Option.some({ source, alias: `g${Str.capitalize(entry)}` })
		: Option.none()
}

/** The refusal of every other way to reach an entry, naming the one way. */
export const messageOf = (entry: Entry): string =>
	`grizzle's entries are imported whole, each as one namespace under its own name, and read through it (${entry.alias}.name): \`import * as ${entry.alias} from "${entry.source}"\`, or \`import type * as ${entry.alias} from "${entry.source}"\` where only its types are read. No name is imported from it, no default and not the module alone, under no other name, and nothing is re-exported from it. oxlint --fix rewrites an import and its uses, renaming any other binding of ${entry.alias} apart.`

/** Whether an import is the entry's one form: a namespace under the entry's name, alone. */
const isAdmitted = (declaration: Import, entry: Entry): boolean =>
	declaration.specifiers.length === 1 &&
	Arr.every(
		declaration.specifiers,
		(specifier) =>
			specifier.type === "ImportNamespaceSpecifier" && specifier.local.name === entry.alias
	)

/** The text that reads an export off the entry's namespace: `g.name`, or `g["name"]` for a name no identifier spells. */
const readOf = (context: Context, entry: Entry, specifier: Specifier): Option.Option<string> => {
	if (specifier.type === "ImportNamespaceSpecifier") {
		return Option.some(entry.alias)
	}
	if (specifier.type === "ImportDefaultSpecifier") {
		return Option.none()
	}
	const { imported } = specifier
	return Option.some(
		imported.type === "Identifier"
			? `${entry.alias}.${imported.name}`
			: `${entry.alias}[${context.sourceCode.getText(imported)}]`
	)
}

/**
 * The edit that makes one use of an imported name read `read`: the identifier replaced, or a shorthand property given
 * its key (`{ x }` becomes `{ x: g.x }`). None where no edit can: the name exported again from this module (an export
 * specifier), or read as a JSX element, whose closing tag names it too.
 */
const useEditOf = (reference: Reference, read: string): Option.Option<Edit> => {
	const { identifier } = reference
	const { parent } = identifier
	if (parent.type === "ExportSpecifier" || Str.startsWith("JSX")(identifier.type)) {
		return Option.none()
	}
	if (parent.type === "Property" && parent.shorthand && parent.value === identifier) {
		return Option.some({
			start: parent.start,
			end: parent.end,
			text: `${identifier.name}: ${read}`
		})
	}
	return Option.some({ start: identifier.start, end: identifier.end, text: read })
}

/** A specifier beside its import, as the fix reads both. */
type Imported = Readonly<{ declaration: Import; specifier: Specifier }>

/** Whether a specifier reads types alone: its import's `import type { … }`, or its own `{ type x }`. */
const readsTypesAlone = ({ declaration, specifier }: Imported): boolean =>
	declaration.importKind === "type" ||
	(specifier.type === "ImportSpecifier" && specifier.importKind === "type")

type Variable = ReturnType<Context["sourceCode"]["getDeclaredVariables"]>[number]

/** Every binding of the entry's name in the module that is no namespace import of the entry: each the fix renames. */
const shadowsOf = (
	context: Context,
	entry: Entry,
	own: ReadonlyArray<Specifier>
): ReadonlyArray<Variable> =>
	Arr.flatMap(context.sourceCode.scopeManager.scopes, (scope) =>
		Option.match(Option.fromUndefinedOr(scope.set.get(entry.alias)), {
			onNone: () => [],
			onSome: (variable) =>
				Arr.every(variable.defs, (definition) =>
					Arr.some(own, (specifier) => specifier === definition.node)
				)
					? []
					: [variable]
		})
	)

/** Whether the module names `name` at all: a binding of it in any scope, or a read of it no binding resolves. */
const namesAnywhere = (context: Context, name: string): boolean =>
	Arr.some(
		context.sourceCode.scopeManager.scopes,
		(scope) =>
			scope.set.has(name) ||
			Arr.some(scope.references, (reference) => reference.identifier.name === name)
	)

/** Whether the module reads an undeclared global of `name`, which no rename can move apart from the namespace. */
const readsGlobal = (context: Context, name: string): boolean =>
	Arr.some(context.sourceCode.scopeManager.scopes, (scope) =>
		Arr.some(
			scope.references,
			(reference) => reference.resolved === null && reference.identifier.name === name
		)
	)

/** The first of `<name>1`, `<name>2`, … the module names nowhere: a name a shadowing binding is renamed to, free in
 * every scope, so each of its reads still reads it and none reads anything else. */
const freshNameOf = (context: Context, name: string): string => {
	for (let n = 1; ; n += 1) {
		if (!namesAnywhere(context, `${name}${n}`)) {
			return `${name}${n}`
		}
	}
}

/**
 * The edit that renames one identifier of a binding from `name` to `fresh`: a shorthand property given its key (`{ g }`
 * is `{ g: g1 }`, `{ g = 1 }` is `{ g: g1 = 1 }`), an import or an export by the binding's own name given an alias
 * (`import { g }` is `import { g as g1 }`, `export { g }` is `export { g1 as g }`), and any other the new name alone.
 * The edit spans the name alone: a binding's node spans its type annotation too (`g: number`).
 */
const renameEditOf = (
	identifier: Variable["identifiers"][number],
	name: string,
	fresh: string
): Edit => {
	const { parent } = identifier
	const at = { start: identifier.start, end: identifier.start + name.length }
	if (
		parent.type === "Property" &&
		parent.shorthand &&
		(parent.value === identifier ||
			(parent.value.type === "AssignmentPattern" && parent.value.left === identifier))
	) {
		return { ...at, text: `${name}: ${fresh}` }
	}
	if (parent.type === "ImportSpecifier" && parent.imported.start === parent.local.start) {
		return { ...at, text: `${name} as ${fresh}` }
	}
	if (parent.type === "ExportSpecifier" && parent.exported.start === parent.local.start) {
		return { ...at, text: `${fresh} as ${name}` }
	}
	return { ...at, text: fresh }
}

/** The edits that rename a binding apart from the entry's name: its declaration and every read of it, each once. */
const renamedApart = (variable: Variable, name: string, fresh: string): ReadonlyArray<Edit> => {
	const byStart = new Map<number, Variable["identifiers"][number]>()
	for (const identifier of variable.identifiers) {
		byStart.set(identifier.start, identifier)
	}
	for (const reference of variable.references) {
		byStart.set(reference.identifier.start, reference.identifier)
	}
	return Arr.map([...byStart.values()], (identifier) => renameEditOf(identifier, name, fresh))
}

/** The edit that removes an import: the declaration and the line break that ends it. */
const removalOf = (text: string, declaration: Import): Edit => ({
	start: declaration.start,
	end: Str.startsWith("\n", declaration.end)(text) ? declaration.end + 1 : declaration.end,
	text: ""
})

/**
 * The edits that bring a module's imports of one entry to its one form, where they can: the first import becomes the
 * namespace import, `import type` where every name the imports bind is read as a type alone, the others go, and every
 * use of a name a refused import binds reads it off the namespace, every binding of the entry's name renamed apart
 * first (shadowsOf, renamedApart). None where an import can't be read off the namespace (a default import, an import of
 * the module alone, a name exported again or read as JSX) or the module reads an undeclared global of the entry's name.
 */
const editsOf = (
	context: Context,
	entry: Entry,
	declarations: Arr.NonEmptyReadonlyArray<Import>
): Option.Option<ReadonlyArray<Edit>> => {
	const [first, ...rest] = declarations
	const imported = Arr.flatMap(declarations, (declaration) =>
		Arr.map(declaration.specifiers, (specifier): Imported => ({ declaration, specifier }))
	)
	const admitted = Arr.filter(imported, ({ declaration }) => isAdmitted(declaration, entry))
	const refused = Arr.filter(imported, ({ declaration }) => !isAdmitted(declaration, entry))
	const alone = Arr.some(declarations, (declaration) => declaration.specifiers.length === 0)
	if (alone || readsGlobal(context, entry.alias)) {
		return Option.none()
	}
	const fresh = freshNameOf(context, entry.alias)
	const apart = Arr.flatMap(
		shadowsOf(
			context,
			entry,
			Arr.map(admitted, ({ specifier }) => specifier)
		),
		(variable) => renamedApart(variable, entry.alias, fresh)
	)
	const uses = Option.all(
		Arr.flatMap(refused, ({ specifier }) =>
			Option.match(readOf(context, entry, specifier), {
				onNone: () => [Option.none<Edit>()],
				onSome: (read) =>
					Arr.flatMap(context.sourceCode.getDeclaredVariables(specifier), (variable) =>
						Arr.map(variable.references, (reference) => useEditOf(reference, read))
					)
			})
		)
	)
	const kind = Arr.every(imported, readsTypesAlone) ? "import type" : "import"
	const namespace: Edit = {
		start: first.start,
		end: first.end,
		text: `${kind} * as ${entry.alias} from ${context.sourceCode.getText(first.source)}`
	}
	const { text } = context.sourceCode
	return Option.map(uses, (edits) => [
		namespace,
		...Arr.map(rest, (declaration) => removalOf(text, declaration)),
		...edits,
		...apart
	])
}

/** A module's imports of one entry, in their order. */
type EntryImports = Readonly<{ entry: Entry; declarations: Arr.NonEmptyReadonlyArray<Import> }>

/** A module's imports of grizzle's entries, by entry. */
const entryImportsOf = (program: NodeOf<"Program">): ReadonlyArray<EntryImports> => {
	const imports = Arr.flatMap(program.body, (statement) =>
		statement.type === "ImportDeclaration"
			? Option.toArray(
					Option.map(entryOf(statement.source.value), (entry) => ({
						entry,
						declaration: statement
					}))
				)
			: []
	)
	return Arr.map(Record.values(Arr.groupBy(imports, ({ entry }) => entry.source)), (group) => ({
		entry: group[0].entry,
		declarations: Arr.map(group, ({ declaration }) => declaration)
	}))
}

/**
 * Every import of a grizzle entry is one namespace import under the entry's own name (entryOf): `import * as g from
 * "@bjornpagen/grizzle"`, `import * as gRuntime from "@bjornpagen/grizzle/runtime"`, or `import type * as …` where only
 * its types are read, which loads nothing. A named import, type-only or not, a default import, an import of the module
 * alone, a namespace under another name, and a re-export of the entry (`export { x } from`, `export * from`,
 * `export * as`, `import x = require`) are each reported. Its fix, one for the whole module on its first refused
 * import, brings every entry's imports to the one form and reads every use of an imported name off its namespace, so
 * one run of oxlint --fix leaves nothing it could fix: a binding of an entry's name in any scope that is no namespace
 * import of the entry, a parameter `g` or a local `gRuntime`, is renamed apart first, its declaration and every read of
 * it, to the first `<name>1`, `<name>2`, … the module names nowhere. An entry is left reported alone where a use can't
 * be read off the namespace (a name exported again or read as JSX, a default import, an import of the module alone) or
 * the module reads an undeclared global of its name; a re-export too, since what replaces it is its readers' to choose.
 */
export const grizzleStarImports: CreateRule = {
	meta: { type: "problem", fixable: "code" },
	create: (context) => {
		const reportEntry = (node: AnyNode, source: string): void => {
			for (const entry of Option.toArray(entryOf(source))) {
				context.report({ node, message: messageOf(entry) })
			}
		}
		return {
			Program: (program) => {
				const imports = entryImportsOf(program)
				const refused = Arr.flatMap(imports, ({ entry, declarations }) =>
					Arr.map(
						Arr.filter(declarations, (declaration) => !isAdmitted(declaration, entry)),
						(node) => ({ node, message: messageOf(entry) })
					)
				)
				const edits = Arr.flatMap(imports, ({ entry, declarations }) =>
					Option.getOrElse(editsOf(context, entry, declarations), () => [])
				)
				const [first, ...rest] = Arr.sort(
					refused,
					Order.mapInput(Order.Number, ({ node }: { readonly node: Import }) => node.start)
				)
				for (const report of rest) {
					context.report(report)
				}
				if (first === undefined) {
					return
				}
				context.report(
					Arr.isReadonlyArrayNonEmpty(edits)
						? {
								...first,
								fix: (fixer) =>
									Arr.map(edits, (edit) =>
										fixer.replaceTextRange([edit.start, edit.end], edit.text)
									)
							}
						: first
				)
			},
			ExportNamedDeclaration: (node) => {
				if (node.source !== null) {
					reportEntry(node, node.source.value)
				}
			},
			ExportAllDeclaration: (node) => {
				reportEntry(node, node.source.value)
			},
			TSImportEqualsDeclaration: (node) => {
				if (node.moduleReference.type === "TSExternalModuleReference") {
					reportEntry(node, node.moduleReference.expression.value)
				}
			}
		}
	}
}
