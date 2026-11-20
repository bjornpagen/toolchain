import { element, type Gen, subset } from "@bjornpagen/testing/gen"
import type { ScratchDir } from "@bjornpagen/testing/resources"
import { Array as Arr, Effect, FileSystem, Option, Schema } from "effect"
import { NO_CATEGORIES, oxlintDiagnostics } from "#oxlint/prove.ts"
import { configOf, heldRulesOf } from "#preset.fixtures.ts"
import { failureFrom } from "#shared/devtool.ts"

/**
 * The os box (environment.test.ts): a library module's import of Node's os module, by either of its specifiers, as a
 * named import, a re-export or a type import of some of its exports, or as its default or namespace import read for
 * them; and the codes oxlint reports on the module under the no-restricted-imports rule the preset builds for a library
 * file, beside what the environment's contract says it reports.
 */

/** The exports a module names: the constants table, and two values that read the machine. */
const NAMES = ["constants", "cpus", "hostname"] as const

type Name = (typeof NAMES)[number]

/** The os module's two specifiers. */
const SPECIFIERS = ["node:os", "os"] as const

/** How a module takes the names: each by name, as a re-export or as a type, or through the default export or the
 * namespace, which hold every value of the module. */
const FORMS = ["named", "re-export", "type", "default", "namespace"] as const

export type OsImport = Readonly<{
	specifier: (typeof SPECIFIERS)[number]
	form: (typeof FORMS)[number]
	names: ReadonlyArray<Name>
}>

type Feature =
	| "an import of the constants table alone"
	| "an import of a value that reads the machine"
	| "the default export or the namespace"
	| "a type import"
	| "the bare specifier"

/** The box: each specifier, each form, and each non-empty set of the names. */
export const osImports: Gen<OsImport> = (source) => ({
	specifier: source.draw(element(SPECIFIERS)),
	form: source.draw(element(FORMS)),
	names: source.draw(subset(NAMES, { min: 1, max: NAMES.length }))
})

/** The library the case's project names, and the case's module in it. */
const LIBRARY = "src"
const MODULE = `${LIBRARY}/reads.ts`

/** The code oxlint gives an import the rule refuses. */
const REFUSAL = "eslint(no-restricted-imports)"

/** Whether the module imports a value of os that is not its constants table: a named import or re-export of another
 * export, or the default export or the namespace, which hold them all. */
const readsTheMachine = (cell: OsImport): boolean => {
	switch (cell.form) {
		case "named":
		case "re-export":
			return Arr.some(cell.names, (name) => name !== "constants")
		case "type":
			return false
		case "default":
		case "namespace":
			return true
	}
}

export const osFeaturesOf = (cell: OsImport): ReadonlyArray<Feature> => [
	...((): ReadonlyArray<Feature> => {
		switch (cell.form) {
			case "named":
			case "re-export":
				return readsTheMachine(cell)
					? ["an import of a value that reads the machine"]
					: ["an import of the constants table alone"]
			case "type":
				return ["a type import"]
			case "default":
			case "namespace":
				return ["the default export or the namespace"]
		}
	})(),
	...(cell.specifier === "os" ? ["the bare specifier" as const] : [])
]

/** What the contract says oxlint reports on the module, by code: the environment's import ban wherever it reads a value
 * of os that is not the constants table, since a type import reads nothing; nothing otherwise. */
export const osRefusalsOf = (cell: OsImport): ReadonlyArray<Option.Option<string>> =>
	readsTheMachine(cell) ? [Option.some(REFUSAL)] : []

/** The module's text: its import of the names and a read of each. */
const moduleOf = (cell: OsImport): string => {
	const listed = Arr.join(cell.names, ", ")
	const from = `from "${cell.specifier}"`
	switch (cell.form) {
		case "named":
			return `import { ${listed} } ${from}\nexport const reads = [${listed}]\n`
		case "re-export":
			return `export { ${listed} } ${from}\n`
		case "type":
			return `import type { ${listed} } ${from}\nexport type Reads = [${Arr.join(
				Arr.map(cell.names, (name) => `typeof ${name}`),
				", "
			)}]\n`
		case "default":
			return `import os ${from}\nexport const reads = [${Arr.join(
				Arr.map(cell.names, (name) => `os.${name}`),
				", "
			)}]\n`
		case "namespace":
			return `import * as os ${from}\nexport const reads = [${Arr.join(
				Arr.map(cell.names, (name) => `os.${name}`),
				", "
			)}]\n`
	}
}

/** The oxlint configuration the module runs under: no category, and the imports rule exactly as the preset holds a
 * library file to it, for a project whose library is LIBRARY and that states no lists of its own. */
const configText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
	plugins: [],
	categories: NO_CATEGORIES,
	rules: {
		"eslint/no-restricted-imports": heldRulesOf(
			configOf({
				root: {
					restrictedImports: { paths: [], patterns: [] },
					restrictedGlobals: [],
					restrictedProperties: []
				},
				restrictions: [],
				library: [LIBRARY],
				readers: [],
				effectFree: []
			}),
			MODULE
		)["eslint/no-restricted-imports"]
	}
})

/** The codes oxlint reports on the import's module, each once (none for a diagnostic without one, such as a parse
 * error's), written with its configuration into the scratch directory. */
export const osReportedOf = (dir: ScratchDir, cell: OsImport) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const write = (name: string, text: string) =>
			fs
				.writeFileString(`${dir}/${name}`, text)
				.pipe(Effect.mapError(failureFrom(`${name} could not be written`)))
		const config = yield* configText.pipe(
			Effect.mapError(failureFrom("the configuration does not encode as JSON"))
		)
		yield* write(".oxlintrc.json", config)
		yield* fs
			.makeDirectory(`${dir}/${LIBRARY}`)
			.pipe(Effect.mapError(failureFrom(`${LIBRARY} could not be made`)))
		yield* write(MODULE, moduleOf(cell))
		const diagnostics = yield* oxlintDiagnostics({
			config: `${dir}/.oxlintrc.json`,
			cwd: dir,
			files: [MODULE]
		})
		return Arr.dedupe(Arr.map(diagnostics, (diagnostic) => Option.fromUndefinedOr(diagnostic.code)))
	})
