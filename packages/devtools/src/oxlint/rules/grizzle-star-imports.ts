import { Array as Arr, Option, Record, String as Str } from "effect"
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
	`grizzle's entries are imported whole, each as one namespace under its own name, and read through it (${entry.alias}.name): \`import * as ${entry.alias} from "${entry.source}"\`, or \`import type * as ${entry.alias} from "${entry.source}"\` where only its types are read. No name is imported from it, no default and not the module alone, under no other name, and nothing is re-exported from it. oxlint --fix rewrites an import and its uses where the name ${entry.alias} is free.`

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

/**
 * Whether the entry's name is free in the module: no binding of any scope is named so but the entry's own namespace
 * import, and no undeclared global of the name is read. Only then does every use the fix writes read the namespace.
 */
const isFree = (context: Context, entry: Entry, own: ReadonlyArray<Specifier>): boolean =>
	Arr.every(context.sourceCode.scopeManager.scopes, (scope) =>
		Option.match(Option.fromUndefinedOr(scope.set.get(entry.alias)), {
			onNone: () =>
				!Arr.some(scope.through, (reference) => reference.identifier.name === entry.alias),
			onSome: (variable) =>
				Arr.every(variable.defs, (definition) =>
					Arr.some(own, (specifier) => specifier === definition.node)
				)
		})
	)

/** The edit that removes an import: the declaration and the line break that ends it. */
const removalOf = (text: string, declaration: Import): Edit => ({
	start: declaration.start,
	end: Str.startsWith("\n", declaration.end)(text) ? declaration.end + 1 : declaration.end,
	text: ""
})

/**
 * The edits that bring a module's imports of one entry to its one form, where they can: the first import becomes the
 * namespace import, `import type` where every name the imports bind is read as a type alone, the others go, and every
 * use of a name a refused import binds reads it off the namespace. None where an import can't be read off the namespace
 * (a default import, an import of the module alone, a name exported again or read as JSX) or the entry's name is taken.
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
	if (
		alone ||
		!isFree(
			context,
			entry,
			Arr.map(admitted, ({ specifier }) => specifier)
		)
	) {
		return Option.none()
	}
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
		...edits
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
 * `export * as`, `import x = require`) are each reported. Its fix, on a module's first refused import of an entry,
 * brings all of the module's imports of the entry to the one form and reads every use of an imported name off the
 * namespace, where the entry's name is free in the module and every use can be so read; a re-export it reports alone,
 * since what replaces it is its readers' to choose.
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
				for (const { entry, declarations } of entryImportsOf(program)) {
					const refused = Arr.filter(declarations, (declaration) => !isAdmitted(declaration, entry))
					const edits = editsOf(context, entry, declarations)
					for (const [index, node] of refused.entries()) {
						const message = messageOf(entry)
						const fixed = index === 0 ? edits : Option.none()
						context.report(
							Option.match(fixed, {
								onNone: () => ({ node, message }),
								onSome: (all) => ({
									node,
									message,
									fix: (fixer) =>
										Arr.map(all, (edit) =>
											fixer.replaceTextRange([edit.start, edit.end], edit.text)
										)
								})
							})
						)
					}
				}
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
