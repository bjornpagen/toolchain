import { array, boolean, element, type Gen, weighted } from "@bjornpagen/testing/gen"
import { CASE_LISTS } from "@bjornpagen/testing/oxlint"
import { Array as Arr, Formatter, Option, Result, String as Str } from "effect"
import { RuleTester } from "oxlint/plugins-dev"
import { noCaseList } from "#oxlint/rules/no-case-list.ts"

/**
 * The programs the no-case-list property draws (no-case-list.test.ts), from a grammar of the spaces the rule's contract
 * reads in a property's spec, and what oxlint's RuleTester makes of one: a list written in the module or imported from
 * a module of the tests, a roster or a dictionary door; one value; the index of a list; a choice of case lists or not;
 * a range its bounds define; each held by a property constructor, the old explore, or property.stateful, which holds no
 * space, in a module of test scope or a source module.
 */

/** What a property's space is, and the module it is drawn in, as the property names its situations. */
export type Feature =
	| "a written list"
	| "an imported list"
	| "one value"
	| "an index of a list"
	| "a space that is no case list"
	| "a module of test scope"
	| "a source module"
	| "a program of several properties"

/** The directory oxlint runs in, and a module of test scope and a source module beneath it, at depth one. */
const CWD = "/repository"
const IN_SCOPE = `${CWD}/test/reads.test.ts`
const SOURCE = `${CWD}/src/reads.ts`

/** The dictionary door the options name. */
const DOOR = "#test/support/keywords.ts"

const OPTIONS = Object.freeze({
	searches: [...CASE_LISTS.searches],
	generators: Arr.map(CASE_LISTS.generators, (generator) => ({
		...generator,
		names: [...generator.names]
	})),
	mints: Arr.map(CASE_LISTS.mints, (mint) => ({ ...mint, names: [...mint.names] })),
	cases: [],
	dictionaries: [DOOR]
})

/** A space as a property's spec holds it: what it declares beside the property, how it is written, the reports it
 * draws in a module of test scope and in a source module, and what it is. `$` names its own locals. */
type Drawn = Readonly<{
	declared: string
	space: string
	inScope: number
	inSource: number
	kind: Feature
}>

/** The modules of the tests a list is imported from, by every spelling the rule reads, from either module. */
const TEST_MODULES = [
	"#test/support/cases.ts",
	"#reads.fixtures.ts",
	"#integration/support/rows.ts",
	"../test/support/cases.ts",
	"@scope/package/test/cases.ts"
] as const

/** Modules whose lists are a roster or a library's: none of the tests. */
const ROSTERS = ["#compiler/core/roster.ts", "../src/roster.ts", "@scope/package/roster"] as const

/** A list written out: two items or more. */
const WRITTEN = ['["a", "b"]', "[1, 2, 3]", "[{ n: 1 }, { n: 2 }]"] as const

/** A list as a space reaches it: what it declares, how it is written, its reports in either module, and what it is. */
type Listed = Readonly<{
	declared: string
	list: string
	inScope: number
	inSource: number
	kind: Feature
}>

/** How a list is reached: written in place, held by a constant, or imported by name or through a namespace. */
const listGen: Gen<Listed> = weighted([
	[
		2,
		(source): Listed => {
			const written = source.draw(element(WRITTEN))
			return source.draw(boolean)
				? { declared: "", list: written, inScope: 1, inSource: 0, kind: "a written list" }
				: {
						declared: `const xs$ = ${written}\n`,
						list: "xs$",
						inScope: 1,
						inSource: 0,
						kind: "a written list"
					}
		}
	],
	[
		2,
		(source): Listed => {
			const module = source.draw(element(TEST_MODULES))
			return source.draw(boolean)
				? {
						declared: `import { xs$ } from "${module}"\n`,
						list: "xs$",
						inScope: 1,
						inSource: 1,
						kind: "an imported list"
					}
				: {
						declared: `import * as cases$ from "${module}"\n`,
						list: "cases$.rows",
						inScope: 1,
						inSource: 1,
						kind: "an imported list"
					}
		}
	],
	[
		1,
		(source): Listed => ({
			declared: `import { xs$ } from "${source.draw(element([...ROSTERS, DOOR]))}"\n`,
			list: "xs$",
			inScope: 0,
			inSource: 0,
			kind: "a space that is no case list"
		})
	]
])

/** The spaces of the grammar. */
const spaces: Gen<Drawn> = weighted([
	[
		3,
		(source) => {
			const list = source.draw(listGen)
			return { ...list, space: `element(${list.list})` }
		}
	],
	[
		2,
		(source) => {
			const list = source.draw(listGen)
			const index = `int(0, ${list.list}.length - 1)`
			return {
				...list,
				space: source.draw(boolean) ? index : `map(${index}, (i) => ${list.list}[i])`,
				kind: list.kind === "a space that is no case list" ? list.kind : "an index of a list"
			}
		}
	],
	[
		2,
		(source): Drawn => ({
			declared: "",
			space: source.draw(
				element(['constant("a")', "int(3, 3)", "int(k, k)", "int(k as number, k)"] as const)
			),
			inScope: 1,
			inSource: 1,
			kind: "one value"
		})
	],
	[
		1,
		(source): Drawn => ({
			declared: "",
			space: `oneOf([constant(1), ${source.draw(element(["constant(2)", "int(5, 5)"] as const))}])`,
			inScope: 1,
			inSource: 1,
			kind: "one value"
		})
	],
	[
		2,
		(source): Drawn => ({
			declared: "",
			space: source.draw(
				element([
					"int(0, 3)",
					"int(0, k)",
					'element(dictionary(["select", "from"]))',
					"oneOf([constant(1), int(0, 9)])",
					"map(int(0, 9), (i) => i * 2)",
					"word(KEYWORDS)"
				] as const)
			),
			inScope: 0,
			inSource: 0,
			kind: "a space that is no case list"
		})
	]
])

/** The names every module reads: the library's constructors, the dictionary's mint, and a bound held by a name. */
const HEADER = `import { property } from "@bjornpagen/testing/property"
import { drawn, explore } from "@bjornpagen/testing/explore"
import { aimed, constant, element, int, map, oneOf } from "@bjornpagen/testing/gen"
import { dictionary, word } from "@bjornpagen/testing/dictionary"
import { KEYWORDS } from "${DOOR}"
declare const k: number
declare const check: unknown
`

/**
 * A search that holds a space, and whether it reads it: a property constructor's first argument (aimed or not), the
 * old `explore`'s spec field `draw`, or `property.stateful`'s machine, which is no space.
 */
type Search = Readonly<{ call: (space: string) => string; reads: boolean }>

const PROPERTY_KINDS = ["explore", "exhaust", "batched", "interleave"] as const

const SEARCHES: readonly [Search, ...Array<Search>] = [
	...Arr.map(PROPERTY_KINDS, (kind): Search => ({
		call: (space) => `property.${kind}(${space}, { situations: [] })`,
		reads: true
	})),
	{
		call: (space) =>
			`property.explore(aimed(${space}, [["a situation", constant(1)]]), { situations: [] })`,
		reads: true
	},
	{ call: (space) => `explore({ suite: "s", draw: drawn(${space}) }, check)`, reads: true },
	{ call: (space) => `property.stateful(${space}, { situations: [] })`, reads: false }
]

/** One property: its space and the search that holds it. */
type Stated = Readonly<{ space: Drawn; search: Search }>

/** A program: its text, the reports the contract gives it, whether its module is of test scope, and its properties. */
export type Program = Readonly<{
	code: string
	reports: number
	inScope: boolean
	stated: ReadonlyArray<Stated>
}>

export const programs: Gen<Program> = (source) => {
	const stated = source.draw(
		array((one): Stated => ({ space: one.draw(spaces), search: one.draw(element(SEARCHES)) }), {
			min: 1,
			max: 3
		})
	)
	const inScope = source.draw(boolean)
	return {
		code: Arr.join(
			Arr.map(stated, ({ space, search }, at) =>
				Str.replaceAll(
					"$",
					String(at)
				)(`${space.declared}export const p$ = ${search.call(space.space)}`)
			),
			"\n"
		),
		reports: Arr.reduce(stated, 0, (sum, { space, search }) =>
			search.reads ? sum + (inScope ? space.inScope : space.inSource) : sum
		),
		inScope,
		stated
	}
}

const LANGUAGE = { sourceType: "module", parserOptions: { lang: "ts" } } as const

/** The situations a program reaches: each property's space (no case list where its search reads none), the module's
 * scope, and several properties. */
export const featuresOf = (program: Program): ReadonlyArray<Feature> => [
	...Arr.map(program.stated, (one): Feature =>
		one.search.reads ? one.space.kind : "a space that is no case list"
	),
	program.inScope ? "a module of test scope" : "a source module",
	...(program.stated.length > 1 ? (["a program of several properties"] as const) : [])
]

/** What RuleTester makes of a program in its module: none when the rule reports it exactly as often as the contract
 * says, else RuleTester's failure. */
export const judged = (program: Program): Option.Option<string> => {
	const code = `${HEADER}${program.code}\n`
	const filename = program.inScope ? IN_SCOPE : SOURCE
	const reports = program.reports
	const ran = Result.try(() =>
		new RuleTester({ languageOptions: LANGUAGE, cwd: CWD }).run(
			"no-case-list",
			noCaseList,
			reports === 0
				? { valid: [{ code, filename, options: [OPTIONS] }], invalid: [] }
				: { valid: [], invalid: [{ code, filename, options: [OPTIONS], errors: reports }] }
		)
	)
	return Result.match(ran, {
		onSuccess: () => Option.none(),
		onFailure: (failure) => Option.some(Formatter.format(failure))
	})
}
