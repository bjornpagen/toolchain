import type { CheckoutDir } from "@bjornpagen/testing/checkout"
import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import type { ScratchDir } from "@bjornpagen/testing/resources"
import { Array as Arr, Effect, FileSystem } from "effect"
import { DiagnosticCategory } from "typescript/sync"
import { failureFrom } from "#shared/devtool.ts"
import { nativeSession, openProject } from "#shared/native-api.ts"

/**
 * The override type's box (preset-types.test.ts): each rule the preset builds from lists under each prefix oxlint
 * resolves to it, refused, beside two rules a block may name; and the program that names each in an override of its
 * own line, checked by the native compiler against the checkout's preset.
 */

/** One cell: the rule an override names, and whether the contract refuses it. */
export type Cell = Readonly<{ rule: string; refused: boolean }>

export type Feature = "a listed rule an override names" | "a rule an override may name"

/** The rules the preset builds from lists, by the name after a prefix. */
const LISTED = [
	"no-restricted-imports",
	"no-restricted-globals",
	"no-restricted-properties",
	"no-unassigned-import"
] as const

/** The prefixes oxlint resolves to one rule (checked on oxlint 1.93.0): none, its plugin's, and TypeScript's two. */
const PREFIXES = ["", "eslint/", "typescript/", "@typescript-eslint/"] as const

/** Rules a block may name: one the preset never sets from lists, and a restricted rule it builds from none. */
const ALLOWED = ["eslint/no-console", "eslint/no-restricted-exports"] as const

/** The box: each listed rule under each prefix, refused, and each rule a block may name. */
export const cells: Gen<Cell> = (source) =>
	source.draw(boolean)
		? {
				rule: `${source.draw(element(PREFIXES))}${source.draw(element(LISTED))}`,
				refused: true
			}
		: { rule: source.draw(element(ALLOWED)), refused: false }

export const featureOf = (cell: Cell): Feature =>
	cell.refused ? "a listed rule an override names" : "a rule an override may name"

/** The program's first case line, 0-based, after its imports and the standard it binds. */
const FIRST_CASE = 3

const programOf = (checkout: string, cells: ReadonlyArray<Cell>): string =>
	Arr.join(
		[
			`import { toolchain } from "${checkout}/src/config.ts"`,
			`import { standard } from "${checkout}/src/preset.ts"`,
			"const { active } = standard(toolchain({ rejected: { rules: {}, diagnostics: {} }, exceptions: [], effectFree: [], packs: {}, bannedPackages: [] }))",
			...Arr.map(cells, (cell, at) => `export const case${at} = active({ "${cell.rule}": "off" })`),
			""
		],
		"\n"
	)

/** The program's compiler options: the strictness the preset's callers check under, and nothing emitted. */
const TSCONFIG = `{
	"compilerOptions": {
		"strict": true,
		"exactOptionalPropertyTypes": true,
		"module": "nodenext",
		"moduleResolution": "nodenext",
		"target": "esnext",
		"noEmit": true,
		"allowImportingTsExtensions": true,
		"skipLibCheck": true,
		"types": []
	},
	"files": ["cases.ts"]
}
`

/** The cells whose lines the compiler finds an error on, by their place in the program. */
export const checkedLines = (dir: ScratchDir, checkout: CheckoutDir, cells: ReadonlyArray<Cell>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const write = (name: string, text: string) =>
				fs
					.writeFileString(`${dir}/${name}`, text)
					.pipe(Effect.mapError(failureFrom(`${name} could not be written`)))
			yield* write("package.json", '{ "type": "module" }\n')
			yield* write("tsconfig.json", TSCONFIG)
			yield* write("cases.ts", programOf(checkout, cells))
			const api = yield* nativeSession({ cwd: dir })
			const project = yield* openProject({ api, config: `${dir}/tsconfig.json` })
			const diagnostics = project.program.getSemanticDiagnostics(`${dir}/cases.ts`)
			return Arr.dedupe(
				Arr.flatMap(diagnostics, (diagnostic) =>
					diagnostic.category === DiagnosticCategory.Error && diagnostic.startPosition !== undefined
						? [diagnostic.startPosition.line - FIRST_CASE]
						: []
				)
			)
		})
	)
