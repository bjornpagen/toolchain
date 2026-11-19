/**
 * Source mutation operators (mutants.ts): programs built from statements whose mutants are known yield exactly those,
 * each at its own text, place, id and function; a family's mutants appear at each of its sites, each edit once
 * however many rules propose it; and a kill applies at the one place its original stands, stale wherever it stands
 * otherwise. Oracles are stated per property.
 */
import { Array as Arr, Effect, Option, Result, String as Str } from "effect"
import { deepStrictEqual, strictEqual } from "#assert.ts"
import {
	appliesToSql,
	counted,
	type Counts,
	droppedShape,
	elementEditsOf,
	expectedOf,
	familyCase,
	killCase,
	literalGen,
	literalProgram,
	literalsText,
	literalText,
	placeOf,
	placesIn,
	programFile,
	programGen,
	statementsText,
	renamedOf,
	renamesOf,
	renamingFamily,
	SHAPES,
	unspaced
} from "#mutants.fixtures.ts"
import { applied, killApplied, mutantsOf, noFamilies } from "#mutants.ts"
import { property } from "#property.ts"

/**
 * The operators against programs built from statements whose mutants are known: each statement shape names exactly the
 * operators it must yield and how many of each, its identifiers distinct so no mutant is the statement unchanged. Every
 * mutant must replace the text it names, sit at the line and column it names, carry an id no other mutant carries, and
 * name the function it sits in; and the program's operators must be exactly the sum of its statements'. A program
 * holding markup is a TSX module (programFile), whose markup only a TSX parse reads.
 */
export const statementMutants = property.explore(programGen, {
	needs: {},
	situations: [...SHAPES],
	check: (_resources, c) => (statements) =>
		Effect.gen(function* () {
			c.noteAll(Arr.map(statements, (statement) => statement.shape))
			const text = statementsText(statements)
			const file = programFile(statements)
			const mutants = yield* mutantsOf([{ file, text }], noFamilies)
			for (const mutant of mutants) {
				strictEqual(mutant.source, text)
				strictEqual(mutant.file, file)
				strictEqual(mutant.fn, "run")
				strictEqual(Str.slice(mutant.start, mutant.end)(text), mutant.original)
				strictEqual(
					applied(mutant),
					`${Str.slice(0, mutant.start)(text)}${mutant.replacement}${Str.slice(mutant.end)(text)}`
				)
				deepStrictEqual({ line: mutant.line, column: mutant.column }, placeOf(text, mutant.start))
			}
			strictEqual(
				Arr.dedupe(Arr.map(mutants, (mutant) => mutant.id)).length,
				mutants.length,
				"every mutant's id is its own"
			)
			deepStrictEqual(
				counted(Arr.map(mutants, (mutant): Counts => [[mutant.operator, 1]])),
				counted(Arr.map(statements, (statement) => expectedOf(statement.shape))),
				"the program's operators are its statements'"
			)
		}),
	oracle: {
		kind: "specification",
		name: "a table of the mutants each statement shape must yield"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/mutants.ts",
			original:
				'const CHAINS = [\n\t[ts.SyntaxKind.AmpersandAmpersandToken, "conjunct", " && "],\n\t[ts.SyntaxKind.BarBarToken, "disjunct", " || "]\n] as const',
			replacement: 'const CHAINS = [[ts.SyntaxKind.BarBarToken, "disjunct", " || "]] as const',
			why: "An && chain yields no conjunct mutant; the property fails."
		},
		{
			file: "packages/testing/src/mutants.ts",
			original: `at: path.join(root, \`source-\${index}\${path.extname(source.file)}\`)`,
			replacement: `at: path.join(root, \`source-\${index}.ts\`)`,
			why: "Every source is parsed as a TypeScript module, so a TSX module's markup is read as type assertions and comparisons and its mutants are not its code's, as every .tsx file given to `mutate` was; the property fails."
		}
	]
})

/**
 * A family's mutants are added at each of its sites in the files it applies to, each edit once however many rules
 * propose it.
 */
export const familyMutants = property.explore(familyCase, {
	needs: {},
	situations: [
		"a file the family skips",
		"a site in a file it applies to",
		"several sites in one file",
		"a rule proposed twice"
	],
	check:
		(_resources, c) =>
		({ files, rules }) =>
			Effect.gen(function* () {
				const expected = renamedOf(files)
				if (Arr.some(files, (file) => !appliesToSql(file.name))) {
					c.note("a file the family skips")
				}
				if (Arr.isReadonlyArrayNonEmpty(expected)) {
					c.note("a site in a file it applies to")
				}
				if (
					Arr.some(
						files,
						(file) =>
							appliesToSql(file.name) && Arr.filter(file.literals, (l) => l === "a").length > 1
					)
				) {
					c.note("several sites in one file")
				}
				if (rules > 1) {
					c.note("a rule proposed twice")
				}
				const mutants = yield* mutantsOf(
					Arr.map(files, (file) => ({ file: file.name, text: literalsText(file.literals) })),
					[renamingFamily(appliesToSql, rules)]
				)
				deepStrictEqual(renamesOf(mutants), expected)
			}),
	oracle: {
		kind: "second-implementation",
		name: 'each "a" literal of each file the family applies to, replaced by "b" alone'
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/mutants.ts",
			original: "\t\t\tif (Str.slice(start, end)(text) !== replacement && !proposed.has(edit)) {",
			replacement: "\t\t\tif (Str.slice(start, end)(text) !== replacement) {",
			why: "An edit proposed twice, by two rules or by two visits, is a mutant each time; the property fails."
		}
	]
})

/** A kill applies at the one place its original stands, and is stale wherever it stands otherwise. */
export const killAppliedOnce = property.explore(killCase, {
	needs: {},
	situations: ["applied", "nowhere", "repeated"],
	check:
		(_resources, c) =>
		({ parts, original }) =>
			Effect.sync(() => {
				const text = Arr.join(parts, "")
				const places = placesIn(text, original)
				const result = killApplied(
					{ file: "a.ts", original, replacement: "<reverted>", why: "the fix reverted" },
					text
				)
				if (places.length === 1) {
					c.note("applied")
					const [at = 0] = places
					deepStrictEqual(
						result,
						Result.succeed(
							`${Str.slice(0, at)(text)}<reverted>${Str.slice(at + original.length)(text)}`
						)
					)
				} else {
					c.note(places.length === 0 ? "nowhere" : "repeated")
					deepStrictEqual(
						Result.isFailure(result) ? Option.some(result.failure.found) : Option.none(),
						Option.some(places.length)
					)
				}
			}),
	oracle: {
		kind: "second-implementation",
		name: "the text split at every place the original stands"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/mutants.ts",
			original: "\treturn places.length === 1 && at !== undefined",
			replacement: "\treturn places.length >= 1 && at !== undefined",
			why: "A kill whose original stands in several places applies at the first of them, never stale; the property fails."
		}
	]
})

/**
 * An array literal's element mutants: one an element, each dropping that element with the separator that joins it to
 * its neighbour, so the literal that is left holds the other elements in order with no hole; each as long as its
 * element and separator, never the literal; and each beginning outside every element, the place a coverage map reads.
 */
export const elementMutants = property.explore(literalGen, {
	needs: {},
	situations: [
		"the first element",
		"a later element",
		"an element a function",
		"a trailing comma",
		"a separator over lines"
	],
	check: (_resources, c) => (literal) =>
		Effect.gen(function* () {
			c.note("the first element")
			c.note("a later element")
			if (Arr.contains(literal.items, "() => a")) {
				c.note("an element a function")
			}
			if (literal.trailing) {
				c.note("a trailing comma")
			}
			if (Arr.some(literal.joins, (join) => Str.includes("\n")(join))) {
				c.note("a separator over lines")
			}
			const { text, at } = literalProgram(literal)
			const mutants = yield* mutantsOf([{ file: "program.ts", text }], noFamilies)
			const edits = Arr.map(mutants, ({ operator, start, original, replacement }) => ({
				operator,
				start,
				original,
				replacement
			}))
			deepStrictEqual(
				edits,
				Arr.map(elementEditsOf(literal, at), (edit) => ({ operator: "element", ...edit }))
			)
			const literalEnd = at + literalText(literal).length
			deepStrictEqual(
				Arr.map(mutants, (mutant) =>
					unspaced(
						Str.slice(
							at,
							literalEnd - mutant.original.length + mutant.replacement.length
						)(applied(mutant))
					)
				),
				Arr.map(literal.items, (_, index) => droppedShape(literal, index))
			)
		}),
	oracle: {
		kind: "specification",
		name: "each element dropped with the separator next to it, the bracket kept: the others in order, no hole"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/mutants.ts",
			original: '\t\t\tadd("element", { start: left.end, end: right.end }, "")',
			replacement:
				'\t\t\tadd("element", { start: node.getStart(source), end: node.end }, "[" + Arr.join(Arr.remove(Arr.map(node.elements, (e) => source.text.slice(e.getStart(source), e.end)), index + 1), ", ") + "]")',
			why: "A later element's mutant replaces the whole literal, so a literal of n elements yields n copies of itself and a table of thousands exhausts the heap."
		},
		{
			file: "packages/testing/src/mutants.ts",
			original:
				'\t\t\t\tadd("element", { start: node.getStart(source), end: right.getStart(source) }, "[")',
			replacement:
				'\t\t\t\tadd("element", { start: left.getStart(source), end: right.getStart(source) }, "")',
			why: "The first element's mutant begins at the element, so a coverage map reads it inside the element: an unrun function there makes it uncovered."
		},
		{
			file: "packages/testing/src/mutants.ts",
			original: '\t\t\tadd("element", { start: left.end, end: right.end }, "")',
			replacement: '\t\t\tadd("element", { start: right.getStart(source), end: right.end }, "")',
			why: "A later element is dropped without its separator, leaving a hole in the literal or a comma of its own."
		}
	]
})
