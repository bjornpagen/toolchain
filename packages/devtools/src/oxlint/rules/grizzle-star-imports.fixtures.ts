/**
 * What grizzle-star-imports.test.ts reads: its box of modules, each importing or re-exporting one module in one shape,
 * and what oxlint's RuleTester makes of one, its reports and the text its fix leaves.
 */
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Formatter, Option, Result } from "effect"
import { RuleTester } from "oxlint/plugins-dev"
import { grizzleStarImports, messageOf } from "#oxlint/rules/grizzle-star-imports.ts"

/** A module a case reaches: grizzle's root and two of its entries, and a module of another package beside them. */
export type Module =
	| "@bjornpagen/grizzle"
	| "@bjornpagen/grizzle/runtime"
	| "@bjornpagen/grizzle/http"
	| "@bjornpagen/grizzle-text/base/result"

/** The shape a case reaches its module in. */
export type Shape =
	| "a namespace under the entry's name"
	| "a type-only namespace under the entry's name"
	| "a namespace under another name"
	| "named imports"
	| "a type-only named import"
	| "a value and a type imported by name"
	| "two imports of one module"
	| "a default import"
	| "an import of the module alone"
	| "a re-export by name"
	| "a type-only re-export"
	| "a re-export of everything"
	| "a namespace re-export"
	| "an import whose name is taken"
	| "an import whose name a parameter shadows"
	| "an import whose name nested scopes shadow"
	| "an import whose name and next free name are taken"
	| "an import whose name is read as an undeclared global"
	| "an import beside another entry's"
	| "a name exported again"
	| "a name read as JSX"

/** A case: the module and the shape it is reached in. */
export interface ImportCase {
	readonly module: Module
	readonly shape: Shape
}

const MODULES = [
	"@bjornpagen/grizzle",
	"@bjornpagen/grizzle/runtime",
	"@bjornpagen/grizzle/http",
	"@bjornpagen/grizzle-text/base/result"
] as const satisfies ReadonlyArray<Module>

const SHAPES = [
	"a namespace under the entry's name",
	"a type-only namespace under the entry's name",
	"a namespace under another name",
	"named imports",
	"a type-only named import",
	"a value and a type imported by name",
	"two imports of one module",
	"a default import",
	"an import of the module alone",
	"a re-export by name",
	"a type-only re-export",
	"a re-export of everything",
	"a namespace re-export",
	"an import whose name is taken",
	"an import whose name a parameter shadows",
	"an import whose name nested scopes shadow",
	"an import whose name and next free name are taken",
	"an import whose name is read as an undeclared global",
	"an import beside another entry's",
	"a name exported again",
	"a name read as JSX"
] as const satisfies ReadonlyArray<Shape>

/** Every case of the box: each module in each shape. */
const IMPORT_CASES: Arr.NonEmptyReadonlyArray<ImportCase> = Arr.flatMap(MODULES, (module) =>
	Arr.map(SHAPES, (shape): ImportCase => ({ module, shape }))
)

export const importCases: Gen<ImportCase> = (source) => source.draw(element(IMPORT_CASES))

/** The name the contract gives each module's namespace: g, then the entry capitalized; the other package's any name. */
const ALIASES: Readonly<Record<Module, string>> = {
	"@bjornpagen/grizzle": "g",
	"@bjornpagen/grizzle/runtime": "gRuntime",
	"@bjornpagen/grizzle/http": "gHttp",
	"@bjornpagen/grizzle-text/base/result": "g"
}

/**
 * A shape's module and what the contract gives it: its code, the reports it draws from one of grizzle's entries, and
 * the text the fix leaves there (none where the rule reports it without a fix, or does not report it).
 */
type Written = Readonly<{ code: string; reports: number; fixed: Option.Option<string> }>

/** The module a case writes over the specifier `s` and the namespace name `a`, and what the contract gives it. */
const writtenOf = (shape: Shape, s: string, a: string): Written => {
	const refused = (code: string, reports: number, fixed: string): Written => ({
		code,
		reports,
		fixed: Option.some(fixed)
	})
	const unfixed = (code: string): Written => ({ code, reports: 1, fixed: Option.none() })
	switch (shape) {
		case "a namespace under the entry's name":
			return {
				code: `import * as ${a} from "${s}"\nexport const v = ${a}.x\n`,
				reports: 0,
				fixed: Option.none()
			}
		case "a type-only namespace under the entry's name":
			return {
				code: `import type * as ${a} from "${s}"\nexport type T = ${a}.T\n`,
				reports: 0,
				fixed: Option.none()
			}
		case "a namespace under another name":
			return refused(
				`import * as other from "${s}"\nexport const v = other.x\nexport type T = other.T\n`,
				1,
				`import * as ${a} from "${s}"\nexport const v = ${a}.x\nexport type T = ${a}.T\n`
			)
		case "named imports":
			return refused(
				`import { x, y as z } from "${s}"\nexport const v = [x, z, { x }]\n`,
				1,
				`import * as ${a} from "${s}"\nexport const v = [${a}.x, ${a}.y, { x: ${a}.x }]\n`
			)
		case "a type-only named import":
			return refused(
				`import type { T } from "${s}"\nexport const f = (t: T): T => t\n`,
				1,
				`import type * as ${a} from "${s}"\nexport const f = (t: ${a}.T): ${a}.T => t\n`
			)
		case "a value and a type imported by name":
			return refused(
				`import { type T, x } from "${s}"\nexport const v: T = x\n`,
				1,
				`import * as ${a} from "${s}"\nexport const v: ${a}.T = ${a}.x\n`
			)
		case "two imports of one module":
			return refused(
				`import { x } from "${s}"\nimport type { T } from "${s}"\nexport const v: T = x\n`,
				2,
				`import * as ${a} from "${s}"\nexport const v: ${a}.T = ${a}.x\n`
			)
		case "a default import":
			return unfixed(`import d from "${s}"\nexport const v = d\n`)
		case "an import of the module alone":
			return unfixed(`import "${s}"\n`)
		case "a re-export by name":
			return unfixed(`export { x } from "${s}"\n`)
		case "a type-only re-export":
			return unfixed(`export type { T } from "${s}"\n`)
		case "a re-export of everything":
			return unfixed(`export * from "${s}"\n`)
		case "a namespace re-export":
			return unfixed(`export * as ${a} from "${s}"\n`)
		case "an import whose name is taken":
			return refused(
				`import { x } from "${s}"\nconst ${a} = 1\nexport const v = [x, ${a}, { ${a} }]\n`,
				1,
				`import * as ${a} from "${s}"\nconst ${a}1 = 1\nexport const v = [${a}.x, ${a}1, { ${a}: ${a}1 }]\n`
			)
		case "an import whose name a parameter shadows":
			return refused(
				`import { x } from "${s}"\nexport const f = (${a}: number) => x + ${a}\n`,
				1,
				`import * as ${a} from "${s}"\nexport const f = (${a}1: number) => ${a}.x + ${a}1\n`
			)
		case "an import whose name nested scopes shadow":
			return refused(
				`import { x } from "${s}"\nexport const f = (${a}: number) => [${a}, (${a}: string) => [${a}, x]]\n`,
				1,
				`import * as ${a} from "${s}"\nexport const f = (${a}1: number) => [${a}1, (${a}1: string) => [${a}1, ${a}.x]]\n`
			)
		case "an import whose name and next free name are taken":
			return refused(
				`import { x } from "${s}"\nconst ${a} = 1\nexport const h = (${a}1: number) => [x, ${a}]\n`,
				1,
				`import * as ${a} from "${s}"\nconst ${a}2 = 1\nexport const h = (${a}1: number) => [${a}.x, ${a}2]\n`
			)
		case "an import whose name is read as an undeclared global":
			return unfixed(`import { x } from "${s}"\nexport const v = [x, ${a}]\n`)
		case "an import beside another entry's":
			return refused(
				`import { x } from "${s}"\nimport { Db } from "@bjornpagen/grizzle/compile"\nexport const v = [x, Db]\n`,
				2,
				`import * as ${a} from "${s}"\nimport * as gCompile from "@bjornpagen/grizzle/compile"\nexport const v = [${a}.x, gCompile.Db]\n`
			)
		case "a name exported again":
			return unfixed(`import { x } from "${s}"\nexport { x }\n`)
		case "a name read as JSX":
			return unfixed(`import { X } from "${s}"\nexport const e = <X />\n`)
	}
}

/** The module of another package the box holds beside grizzle's entries. */
const OTHER_PACKAGE = "@bjornpagen/grizzle-text/base/result"

/**
 * What the contract gives a case: an entry's shape as writtenOf states it; at the other package's module nothing in any
 * shape but the one beside an entry, whose entry's import alone is refused and fixed.
 */
const expectedOf = (c: ImportCase): Written => {
	const written = writtenOf(c.shape, c.module, ALIASES[c.module])
	if (c.module !== OTHER_PACKAGE) {
		return written
	}
	return c.shape === "an import beside another entry's"
		? {
				code: written.code,
				reports: 1,
				fixed: Option.some(
					`import { x } from "${c.module}"\nimport * as gCompile from "@bjornpagen/grizzle/compile"\nexport const v = [x, gCompile.Db]\n`
				)
			}
		: { code: written.code, reports: 0, fixed: Option.none() }
}

/** The situations a case reaches. */
export type ImportFeature =
	| "the entry's one form"
	| "a refused import, fixed"
	| "a refused import, reported alone"
	| "a module of another package"

/** The situation a case reaches. */
export const featuresOf = (c: ImportCase): ReadonlyArray<ImportFeature> => {
	const written = writtenOf(c.shape, c.module, ALIASES[c.module])
	if (c.module === "@bjornpagen/grizzle-text/base/result") {
		return ["a module of another package"]
	}
	if (written.reports === 0) {
		return ["the entry's one form"]
	}
	return Option.isSome(written.fixed)
		? ["a refused import, fixed"]
		: ["a refused import, reported alone"]
}

const LANGUAGE = { sourceType: "module", parserOptions: { lang: "tsx" } } as const

/**
 * What RuleTester makes of a case: none when the rule reports it exactly as the contract says, the message naming the
 * entry's one form, and its fix leaves exactly the contract's text; else its failure. A module of another package draws
 * no report in any shape.
 */
export const judged = (c: ImportCase): Option.Option<string> => {
	const alias = ALIASES[c.module]
	const written = expectedOf(c)
	const reports = written.reports
	const compile = {
		message: messageOf({ source: "@bjornpagen/grizzle/compile", alias: "gCompile" })
	}
	const own = { message: messageOf({ source: c.module, alias }) }
	const errors =
		c.shape === "an import beside another entry's"
			? c.module === OTHER_PACKAGE
				? [compile]
				: [own, compile]
			: Array.from({ length: reports }, () => own)
	const filename = "/repository/module.tsx"
	const ran = Result.try(() =>
		new RuleTester({ languageOptions: LANGUAGE }).run(
			"grizzle-star-imports",
			grizzleStarImports,
			reports === 0
				? { valid: [{ code: written.code, filename }], invalid: [] }
				: {
						valid: [],
						invalid: [
							{
								code: written.code,
								filename,
								errors,
								output: Option.getOrNull(written.fixed)
							}
						]
					}
		)
	)
	return Result.match(ran, {
		onSuccess: () => Option.none(),
		onFailure: (error) => Option.some(Formatter.format(error))
	})
}
