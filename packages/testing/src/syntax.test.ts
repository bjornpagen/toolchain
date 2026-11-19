/**
 * The syntax door's diagnostics (syntax.ts syntaxDiagnosticsOf), over TypeScript's one native parser process the
 * library shares: a module whose every statement parses as a .ts file's has none, a type error and a type assertion
 * (which a .tsx file would refuse) among them; a module with a statement that does not parse has one at least, the
 * first inside that statement, since every statement before it is whole. Oracle: the specification, stated per
 * statement in the roster (syntax.fixtures.ts).
 */
import { Array as Arr, Effect, Option } from "effect"
import { assert } from "#assert.ts"
import { property } from "#property.ts"
import { firstRefusedOf, modules, situationsOf, textOf } from "#syntax.fixtures.ts"
import { syntaxDiagnosticsOf } from "#syntax.ts"

export const syntaxDiagnostics = property.explore(modules, {
	needs: {},
	situations: [
		"a module that parses",
		"a type error, which is no syntax error",
		"a type assertion, which a .tsx file refuses",
		"a syntax error",
		"a syntax error after statements that parse"
	],
	check: (_resources, c) => (module) =>
		Effect.gen(function* () {
			c.noteAll(situationsOf(module))
			const diagnostics = yield* syntaxDiagnosticsOf("/module.ts", textOf(module))
			const refused = firstRefusedOf(module)
			const first = Option.map(Arr.head(diagnostics), (diagnostic) => diagnostic.pos)
			assert.deepEqual(
				Option.map(first, (pos) =>
					Option.exists(refused, (lies) => pos >= lies.start && pos <= lies.end)
				),
				Option.map(refused, () => true),
				"no diagnostic for a module that parses, and the first inside its first refused statement for one that does not"
			)
		}),
	oracle: {
		kind: "specification",
		name: "a module that parses has no syntax diagnostic, a type error none; one that does not has one, the first inside its first refused statement"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/syntax.ts",
			original: "api.transpileModule(text, { fileName: file, reportDiagnostics: true })",
			replacement: "api.transpileModule(text, { fileName: file, reportDiagnostics: false })",
			why: "The parser is asked for no diagnostics, so a module that does not parse reads as one that does; the property fails."
		},
		{
			file: "packages/testing/src/syntax.ts",
			original: "api.transpileModule(text, { fileName: file, reportDiagnostics: true })",
			replacement: `api.transpileModule(text, { fileName: \`\${file}x\`, reportDiagnostics: true })`,
			why: "A .ts file's text is read as a .tsx file's, so its type assertion is refused as an unclosed element; the property fails."
		}
	]
})
