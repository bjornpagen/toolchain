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
	expectedOf,
	familyCase,
	killCase,
	literalsText,
	placeOf,
	placesIn,
	programGen,
	programOf,
	renamedOf,
	renamesOf,
	renamingFamily,
	SHAPES
} from "#mutants.fixtures.ts"
import { applied, killApplied, mutantsOf, noFamilies } from "#mutants.ts"
import { property } from "#property.ts"

/**
 * The operators against programs built from statements whose mutants are known: each statement shape names exactly the
 * operators it must yield and how many of each, its identifiers distinct so no mutant is the statement unchanged. Every
 * mutant must replace the text it names, sit at the line and column it names, carry an id no other mutant carries, and
 * name the function it sits in; and the program's operators must be exactly the sum of its statements'.
 */
export const statementMutants = property.explore(programGen, {
	needs: {},
	situations: [...SHAPES],
	check: (_resources, c) => (statements) =>
		Effect.gen(function* () {
			c.noteAll(Arr.map(statements, (statement) => statement.shape))
			const text = programOf(statements)
			const mutants = yield* mutantsOf([{ file: "program.ts", text }], noFamilies)
			for (const mutant of mutants) {
				strictEqual(mutant.source, text)
				strictEqual(mutant.file, "program.ts")
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
