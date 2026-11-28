/**
 * The grizzle-star-imports rule (src/oxlint/rules/grizzle-star-imports.ts), over a box of modules: grizzle's root and two
 * of its entries, and a module of another package, each reached in every shape: a namespace under the entry's name,
 * type-only or not; a namespace under another name; named imports, type-only, mixed, or split over two imports; a
 * default import; an import of the module alone; a re-export by name, type-only, of everything, or as a namespace; named
 * imports whose namespace name a local, a parameter or nested parameters take (renamed apart to the first free name,
 * the next one where the first is taken too), or an undeclared global reads; an import beside another entry's, both
 * fixed in one run; and named imports exported again or read as JSX. Every case
 * carries what the contract gives it: an entry's one form draws nothing, every other shape of an entry's one report per
 * import naming the one form, with the text its fix leaves where the rule can fix it, and a module of another package
 * nothing in any shape. oxlint's RuleTester, run in the case, must find exactly that.
 *
 * Oracle: the specification, the rule's JSDoc read over the box. Features: an entry's one form, a refused import fixed,
 * a refused import reported alone, a module of another package.
 */
import { assert } from "@bjornpagen/testing/assert"
import { finite } from "@bjornpagen/testing/gen"
import { property } from "@bjornpagen/testing/property"
import { Effect, Option } from "effect"
import { featuresOf, importCases, judged } from "#oxlint/rules/grizzle-star-imports.fixtures.ts"

/** Reports every shape of an entry but its one form, and fixes each one that can be read off the namespace. */
export const grizzleStarImports = property.exhaust(finite(importCases), {
	needs: {},
	situations: [
		"the entry's one form",
		"a refused import, fixed",
		"a refused import, reported alone",
		"a module of another package"
	],
	check: (_resources, c) => (importCase) =>
		Effect.sync(() => {
			c.noteAll(featuresOf(importCase))
			assert.deepEqual(judged(importCase), Option.none())
		}),
	oracle: {
		kind: "specification",
		name: "the rule's stated contract over a box of modules and the shapes they are reached in"
	},
	box: "grizzle's root, two of its entries and a module of another package, each reached in every shape of import and re-export",
	kept: [],
	kills: [
		{
			file: "packages/devtools/src/oxlint/rules/grizzle-star-imports.ts",
			original:
				'\t\t\tspecifier.type === "ImportNamespaceSpecifier" && specifier.local.name === entry.alias\n',
			replacement:
				'\t\t\tspecifier.local.name === entry.alias || specifier.type !== "ImportNamespaceSpecifier"\n',
			why: 'A named import is admitted: `import { x } from "@bjornpagen/grizzle"` passes unreported, a name read bare where the namespace should be.'
		},
		{
			file: "packages/devtools/src/oxlint/rules/grizzle-star-imports.ts",
			original:
				'\tdeclaration.importKind === "type" ||\n\t(specifier.type === "ImportSpecifier" && specifier.importKind === "type")\n',
			replacement: "\tfalse\n",
			why: "A type-only named import is fixed into a value namespace import: `import type { T }` becomes `import * as g`, so a module that read grizzle's types alone now loads the entry."
		},
		{
			file: "packages/devtools/src/oxlint/rules/grizzle-star-imports.ts",
			original:
				'\t\t\tspecifier.type === "ImportNamespaceSpecifier" && specifier.local.name === entry.alias\n',
			replacement: '\t\t\tspecifier.type === "ImportNamespaceSpecifier"\n',
			why: 'A namespace under another name is admitted: `import * as other from "@bjornpagen/grizzle"` passes, so one entry is read under as many names as modules choose.'
		},
		{
			file: "packages/devtools/src/oxlint/rules/grizzle-star-imports.ts",
			original:
				"\t\t\t\tif (node.source !== null) {\n\t\t\t\t\treportEntry(node, node.source.value)\n\t\t\t\t}\n",
			replacement: "",
			why: 'A re-export by name is admitted: `export { x } from "@bjornpagen/grizzle"` passes, so a module hands grizzle\'s names on under its own door.'
		},
		{
			file: "packages/devtools/src/oxlint/rules/grizzle-star-imports.ts",
			original:
				"\treturn Arr.map([...byStart.values()], (identifier) => renameEditOf(identifier, name, fresh))\n",
			replacement: "\treturn []\n",
			why: "The fix skips a binding that shadows the entry's name: under a parameter `g`, `x` becomes `g.x`, which reads the parameter, and the module is left reading the wrong value."
		},
		{
			file: "packages/devtools/src/oxlint/rules/grizzle-star-imports.ts",
			original: "\t\t\tscope.set.has(name) ||\n",
			replacement: "\t\t\tfalse ||\n",
			why: "A name a binding of the module holds reads as free: a shadowing binding is renamed to `g1` where a `g1` stands beside it, and the two bindings collide."
		},
		{
			file: "packages/devtools/src/oxlint/rules/grizzle-star-imports.ts",
			original: "\t\t\t\tconst edits = Arr.flatMap(imports, ({ entry, declarations }) =>\n",
			replacement:
				"\t\t\t\tconst edits = Arr.flatMap(Arr.take(imports, 1), ({ entry, declarations }) =>\n",
			why: "A run fixes one entry of a module, so a module importing two entries is left refused after a run of oxlint --fix, which converges only by being run again."
		},
		{
			file: "packages/devtools/src/oxlint/rules/grizzle-star-imports.ts",
			original:
				'\tif (parent.type === "Property" && parent.shorthand && parent.value === identifier) {\n',
			replacement: "\tif (false) {\n",
			why: "A shorthand property's use is replaced in place: `{ x }` becomes `{ g.x }`, which does not parse."
		}
	]
})
