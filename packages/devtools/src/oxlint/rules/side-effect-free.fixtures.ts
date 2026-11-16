import {
	aimed,
	array,
	boolean,
	constant,
	element,
	type Gen,
	map,
	option,
	type Weighted,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Formatter, Option, Result, String as Str } from "effect"
import { RuleTester } from "oxlint/plugins-dev"
import {
	BUILTIN_CALLS,
	CALLABLE_GLOBALS,
	FORBIDDEN,
	MARKS,
	MATH_FUNCTIONS,
	PURE_GLOBALS,
	sideEffectFree
} from "#oxlint/rules/side-effect-free.ts"

/**
 * The programs and proofs' modules the side-effect-free properties draw (side-effect-free.test.ts), from a grammar of
 * the rule's contract read over the lists its module exports, and what oxlint's RuleTester makes of each: a program's
 * functions, marked or not, each site carrying the reports the contract gives it, and a proof's own module, each claim
 * of the options kept or broken.
 */

/** The placeholder of a site's own suffix, so the locals of two sites of one function never share a name. */
const OWN = "§"

/** The module the drawn programs import proven functions from, and the file that proves them. */
const PROVEN_SPECIFIER = "#proven/module.ts"
const PROVEN_FILE = "proven/module.ts"

/**
 * The options every case runs under: one module of other files, which proves a function, a factory, a function that
 * calls its argument's `compute`, and a constant.
 */
const OPTIONS = Object.freeze({
	modules: [
		{
			file: PROVEN_FILE,
			specifiers: [PROVEN_SPECIFIER],
			functions: [
				{ name: "proven", returns: "values", invokes: [] },
				{ name: "provenFactory", returns: "functions", invokes: [] },
				{
					name: "provenHigher",
					returns: "values",
					invokes: [{ parameter: 0, property: "compute" }]
				}
			],
			constants: ["provenConstant"]
		}
	]
})

/**
 * What every program starts from: the proven module's functions, constant and one it does not list; a module variable;
 * module constants proven (a frozen literal, a primitive, a marked call's result) and one not (a literal unfrozen); and
 * a marked function, factory and function calling its argument's callback, of its own, which the drawn sites call.
 */
const HEADER = `import { proven, provenConstant, provenFactory, provenHigher, unlisted } from "${PROVEN_SPECIFIER}"
let outer = 0
/* @__NO_SIDE_EFFECTS__ */
const helper = (value: number): number => value + 1
/* @__NO_SIDE_EFFECTS__ */
const factory = () => (value: number): number => value * 2
/* @__NO_SIDE_EFFECTS__ */
const higher = (spec: { readonly f: (x: number) => number }): number => spec.f(1)
const frozen = Object.freeze({ n: 1 })
const text = "t"
const made = helper(1)
const loose = { n: 1 }
`

/**
 * The clauses of the contract a site of a marked function breaks, each reported where it stands and each by its own
 * path through the rule: the roster the marked-function property requires each of, so every refusal the rule makes is
 * checked, not only a refusal.
 */
const INSIDE = [
	"an outer variable written",
	"an outer variable read",
	"a property written",
	"a property changed",
	"a property deleted",
	"a parameter called",
	"a global called",
	"a global's method called",
	"a builtin call no proof covers",
	"Math.random called",
	"a value frozen it does not build",
	"toString called on a value",
	"an unproven constant read",
	"what a call returns called",
	"an unlisted import called",
	"a forbidden node"
] as const

/**
 * The clauses a call site breaks wherever it stands, in a marked function or not: a callback literal whose body breaks
 * the contract, and a callback no proof covers (a parameter, a function that calls a callback of its own, a spread).
 */
const ANYWHERE = [
	"a callback literal that breaks the contract",
	"a callback no proof covers"
] as const

type Anywhere = (typeof ANYWHERE)[number]

export type Refusal = (typeof INSIDE)[number] | Anywhere

const REFUSALS: Arr.NonEmptyReadonlyArray<Refusal> = [...INSIDE, ...ANYWHERE]

/** Whether the rule reports a site that breaks `refusal` outside a marked function too. */
const isAnywhere = (refusal: Refusal): refusal is Anywhere =>
	Arr.some(ANYWHERE, (each) => each === refusal)

/**
 * One statement of a function's body: one the contract proves, which draws no report, or one that breaks a clause of
 * it, with the reports it draws in a marked function (and anywhere, when its clause is a callback's).
 */
type Site =
	| Readonly<{ kind: "proven"; code: string }>
	| Readonly<{ kind: "refused"; code: string; refusal: Refusal; reports: number }>

/** The reports a site draws in a function marked or not. */
const reportsOf =
	(marked: boolean) =>
	(site: Site): number => {
		switch (site.kind) {
			case "proven":
				return 0
			case "refused":
				return marked || isAnywhere(site.refusal) ? site.reports : 0
		}
	}

/** A statement the contract proves. */
const proven = (code: string): Site => ({ kind: "proven", code })

/** A statement that breaks a clause of the contract, with the reports it draws. */
type Form = readonly [code: string, reports: number]

/** A list the rule exports, which its module states non-empty. */
const nonEmpty = <A>(items: ReadonlyArray<A>): Arr.NonEmptyReadonlyArray<A> =>
	Option.getOrThrow(Option.liftPredicate(items, Arr.isReadonlyArrayNonEmpty))

/** One name of a list the rule exports. */
const nameOf = (names: ReadonlyArray<string>): Gen<string> => element(nonEmpty(names))

/** The first of the marks, the one a drawn proof's module writes. */
const FIRST_MARK = Arr.headNonEmpty(nonEmpty(MARKS))

/** A proven call of the language's own: an object of BUILTIN_CALLS and one of its proven properties. */
const builtinCall: Gen<string> = (source) => {
	const [object, properties] = source.draw(
		element(nonEmpty(Arr.filter([...BUILTIN_CALLS], ([each]) => each !== "Object")))
	)
	return `${object}.${source.draw(nameOf(properties))}(p${OWN}.n)`
}

/** Each forbidden node type's site, a statement holding exactly one node of that type and nothing else refused. */
const FORBIDDEN_SITES: ReadonlyArray<readonly [string, string]> = [
	["ThisExpression", `const t${OWN} = function () { return this }`],
	["AwaitExpression", `const w${OWN} = async () => await 1`],
	["YieldExpression", `const y${OWN} = function* () { yield 1 }`],
	["ThrowStatement", `if (p${OWN}.n < 0) { throw 0 }`],
	["TaggedTemplateExpression", `const tag${OWN} = (x: TemplateStringsArray) => x\ntag${OWN}\`x\``],
	["ImportExpression", `const i${OWN} = () => import("x")`],
	["NewExpression", `const a${OWN} = new Array(1)`],
	["ClassExpression", `const c${OWN} = class {}`],
	["MetaProperty", `const u${OWN} = import.meta`],
	["DebuggerStatement", "debugger"]
]

/** The sites of the node types FORBIDDEN names that a statement of a module function can hold. */
const forbiddenCodes = Object.freeze(
	Arr.filterMap(FORBIDDEN_SITES, ([type, code]) =>
		FORBIDDEN.has(type) ? Result.succeed(code) : Result.failVoid
	)
)

/** Sites the contract proves: none reports. */
const provenSites: Gen<Site> = weighted([
	[2, () => proven(`const l${OWN} = p${OWN}.n + 1`)],
	[2, () => proven(`let m${OWN} = 0\nm${OWN} += p${OWN}.n`)],
	[2, () => proven(`let [a${OWN}, b${OWN}] = [1, 2]\n;[a${OWN}, b${OWN}] = [b${OWN}, a${OWN}]`)],
	[2, (s) => proven(`const g${OWN} = ${s.draw(nameOf(PURE_GLOBALS))}`)],
	[2, (s) => proven(`const k${OWN} = ${s.draw(builtinCall)}`)],
	[2, () => proven(`const f${OWN} = Object.freeze({ n: p${OWN}.n })`)],
	[2, () => proven(`const h${OWN} = (x: number) => x * 2\nh${OWN}(1)`)],
	[1, () => proven(`function d${OWN}() { return 1 }\nd${OWN}()`)],
	[2, () => proven(`const e${OWN} = helper(p${OWN}.n)`)],
	[2, () => proven(`const r${OWN} = factory()(1)`)],
	[2, () => proven(`const v${OWN} = proven(1) + provenFactory()(1)`)],
	[1, () => proven(`const i${OWN} = ((x: number) => x)(1)`)],
	[1, () => proven(`const j${OWN} = p${OWN}.n\nconst o${OWN} = j${OWN}`)],
	[2, (s) => proven(`const ma${OWN} = Math.${s.draw(nameOf(MATH_FUNCTIONS))}(p${OWN}.n)`)],
	[2, (s) => proven(`const cv${OWN} = ${s.draw(nameOf(CALLABLE_GLOBALS))}(p${OWN}.n)`)],
	[2, () => proven(`const ts${OWN} = (p${OWN}.n + 1).toString() + (2n ** 3n).toString(16)`)],
	[2, () => proven(`const rc${OWN} = frozen.n + text.length + made + provenConstant`)],
	[1, () => proven(`const pc${OWN} = p${OWN}.toString()`)],
	[2, () => proven(`const hc${OWN} = higher({ f: (x: number) => x + frozen.n })`)],
	[2, () => proven(`const ph${OWN} = provenHigher({ compute: (x: number) => Math.max(x, 2) })`)],
	[1, () => proven(`const hp${OWN} = higher({ f: helper })`)]
])

/** The statements that break each clause, each with its weight and the reports it draws. */
const BROKEN: { readonly [R in Refusal]: Arr.NonEmptyReadonlyArray<Weighted<Form>> } = {
	"an outer variable written": [[2, () => ["outer += 1", 1]]],
	"an outer variable read": [[2, () => [`const o${OWN} = outer`, 1]]],
	"a property written": [
		[2, () => [`p${OWN}.n = 1`, 1]],
		[1, () => [`;[p${OWN}.n] = [1]`, 1]]
	],
	"a property changed": [[2, () => [`p${OWN}.n++`, 1]]],
	"a property deleted": [[1, () => [`delete p${OWN}.n`, 1]]],
	"a parameter called": [[2, () => [`const c${OWN} = cb${OWN}()`, 1]]],
	"a global called": [[2, () => [`const x${OWN} = parseInt("1")`, 2]]],
	"a global's method called": [[2, () => ["console.log(1)", 2]]],
	"a builtin call no proof covers": [[1, () => [`const y${OWN} = Object.assign({}, {})`, 1]]],
	"Math.random called": [[2, () => [`const mr${OWN} = Math.random()`, 1]]],
	"a value frozen it does not build": [[2, () => [`const z${OWN} = Object.freeze(p${OWN})`, 1]]],
	"toString called on a value": [[2, () => [`const ft${OWN} = frozen.toString()`, 1]]],
	"an unproven constant read": [[2, () => [`const lo${OWN} = loose.n`, 1]]],
	"a callback literal that breaks the contract": [
		[2, () => [`const hb${OWN} = higher({ f: (x: number) => x + outer })`, 1]],
		[1, () => [`const pb${OWN} = provenHigher({ compute: () => outer })`, 1]]
	],
	"a callback no proof covers": [
		[1, () => [`const hl${OWN} = higher(p${OWN})`, 1]],
		[1, () => [`const hh${OWN} = higher({ f: higher })`, 1]],
		[1, () => [`const hs${OWN} = higher({ ...frozen, f: helper })`, 1]]
	],
	"what a call returns called": [[2, () => [`const q${OWN} = helper(1)(2)`, 1]]],
	"an unlisted import called": [[2, () => [`const w${OWN} = unlisted(1)`, 1]]],
	"a forbidden node": [[3, (s) => [s.draw(nameOf(forbiddenCodes)), 1]]]
}

/** The sites that break `refusal`, each as often as its statement weighs. */
const refusedForms = (refusal: Refusal): Arr.NonEmptyReadonlyArray<Weighted<Site>> =>
	Arr.map(BROKEN[refusal], ([weight, form]): Weighted<Site> => [
		weight,
		map(form, ([code, reports]): Site => ({ kind: "refused", code, refusal, reports }))
	])

/** A site that breaks `refusal`. */
const brokenSites = (refusal: Refusal): Gen<Site> => weighted(refusedForms(refusal))

/** Sites the contract refuses, each clause as often as its statements weigh. */
const refusedSites: Gen<Site> = weighted(Arr.flatMap(REFUSALS, (refusal) => refusedForms(refusal)))

const anySite: Gen<Site> = weighted<Site>([
	[1, provenSites],
	[1, refusedSites]
])

/** A function of a program: whether it is marked, by which of MARKS, and its sites. */
type Drawn = Readonly<{ mark: Option.Option<string>; sites: Arr.NonEmptyReadonlyArray<Site> }>

/** A function whose first site is drawn from `first`, marked or not as `marks` draws it. */
const functionOf =
	(marks: Gen<Option.Option<string>>, first: Gen<Site>): Gen<Drawn> =>
	(source) => ({
		mark: source.draw(marks),
		sites: [source.draw(first), ...source.draw(array(anySite, { min: 0, max: 2 }))]
	})

const anyMark: Gen<Option.Option<string>> = option(nameOf(MARKS))

const marked: Gen<Option.Option<string>> = map(nameOf(MARKS), Option.some)

const unmarked: Gen<Option.Option<string>> = constant(Option.none())

/** A program: its functions, whether it closes with a mark on no function, and its text and reports. */
export type Program = Readonly<{
	functions: Arr.NonEmptyReadonlyArray<Drawn>
	stray: boolean
	code: string
	reports: number
}>

/** A function's text: its mark, its parameters and its sites, each site's locals under the function's place. */
const textOf = (drawnOne: Drawn, at: number): string => {
	const mark = Option.match(drawnOne.mark, {
		onNone: () => "",
		onSome: (each) => `/* ${each} */\n`
	})
	const body = Arr.join(
		Arr.map(drawnOne.sites, (each, place) => Str.replaceAll(OWN, `${at}_${place}`)(each.code)),
		"\n"
	)
	const named = Arr.join(
		Arr.map(
			drawnOne.sites,
			(_each, place) => `p${at}_${place}: { n: number }, cb${at}_${place}: () => number`
		),
		", "
	)
	return `${mark}const fn${at} = (${named}): number => {\n${body}\nreturn 0\n}`
}

/** A program whose first function is drawn from `first`, then up to two more of any kind. */
const programOf =
	(first: Gen<Drawn>): Gen<Program> =>
	(source) => {
		const functions: Arr.NonEmptyReadonlyArray<Drawn> = [
			source.draw(first),
			...source.draw(array(functionOf(anyMark, anySite), { min: 0, max: 2 }))
		]
		const stray = source.draw(boolean)
		const reports =
			Arr.reduce(functions, 0, (sum, each) =>
				Arr.reduce(
					each.sites,
					sum,
					(inner, one) => inner + reportsOf(Option.isSome(each.mark))(one)
				)
			) + (stray ? 1 : 0)
		const code = Arr.join(
			[
				HEADER,
				...Arr.map(functions, textOf),
				...(stray ? [`/* ${FIRST_MARK} */\nexport const stray = 1`] : [])
			],
			"\n"
		)
		return { functions, stray, code, reports }
	}

/** What a program holds, as the marked-function property names its situations. */
export type Feature =
	| `${Refusal} in a marked function`
	| `${Anywhere} outside a marked function`
	| "a proven site in a marked function"
	| "an unmarked function"
	| "a misplaced mark"
	| "a program of several functions"

/** What a site of a marked function is: proven, or the clause it breaks. */
const inMarked = (site: Site): Feature => {
	switch (site.kind) {
		case "proven":
			return "a proven site in a marked function"
		case "refused":
			return `${site.refusal} in a marked function`
	}
}

/** What a site of an unmarked function is, when the rule reports it there too: a callback's clause. */
const outsideMarked = (site: Site): ReadonlyArray<Feature> =>
	site.kind === "refused" && isAnywhere(site.refusal)
		? [`${site.refusal} outside a marked function`]
		: []

/**
 * The marked-function property's space: programs of up to three functions, each marked or not, of up to three sites
 * each; aimed, for each clause a site may break, at a program whose first function is marked and breaks it, and for
 * each clause of a callback, at a program whose first function is unmarked and breaks it, which the rule reports there
 * too.
 */
export const programs = aimed(programOf(functionOf(anyMark, anySite)), [
	...Arr.map(REFUSALS, (refusal): readonly [Feature, Gen<Program>] => [
		`${refusal} in a marked function`,
		programOf(functionOf(marked, brokenSites(refusal)))
	]),
	...Arr.map(ANYWHERE, (refusal): readonly [Feature, Gen<Program>] => [
		`${refusal} outside a marked function`,
		programOf(functionOf(unmarked, brokenSites(refusal)))
	])
])

/** A proof's own module: the proven functions and constant as the options claim them, or one claim broken. */
export type Home = Readonly<{ code: string; reports: number; broken: boolean }>

/** The proof's module's declarations, each as the options claim it or broken, by name. */
const HOME_PARTS = {
	proven: [
		`/* ${FIRST_MARK} */\nexport const proven = (value: number): number => value`,
		"export const proven = (value: number): number => value"
	],
	provenFactory: [
		`/* ${FIRST_MARK} */\nexport const provenFactory = () => (value: number): number => value`,
		`/* ${FIRST_MARK} */\nexport const provenFactory = (): number => 1`
	],
	provenHigher: [
		`/* ${FIRST_MARK} */\nexport const provenHigher = (spec: { readonly compute: (x: number) => number }): number => spec.compute(1)`,
		`/* ${FIRST_MARK} */\nexport const provenHigher = (spec: { readonly other: (x: number) => number }): number => spec.other(1)`
	],
	provenConstant: ["export const provenConstant = 3", "export const provenConstant = [3].length"]
} as const

export const homes: Gen<Home> = (source) => {
	const parts = Arr.map(
		[
			HOME_PARTS.proven,
			HOME_PARTS.provenFactory,
			HOME_PARTS.provenHigher,
			HOME_PARTS.provenConstant
		],
		(choices) => {
			const broken = source.draw(
				weighted<boolean>([
					[3, () => false],
					[1, () => true]
				])
			)
			return { code: broken ? choices[1] : choices[0], broken }
		}
	)
	const broken = Arr.filter(parts, (part) => part.broken).length
	return {
		code: Arr.join(
			Arr.map(parts, (part) => part.code),
			"\n"
		),
		reports: broken,
		broken: broken > 0
	}
}

/** How RuleTester parses each program: a TypeScript module. */
const LANGUAGE = { sourceType: "module", parserOptions: { lang: "ts" } } as const

/** What RuleTester makes of a text at a file: none when the rule reports it exactly `reports` times, else its failure. */
const judged = (code: string, filename: string, reports: number): Option.Option<string> => {
	const ran = Result.try(() =>
		new RuleTester({ languageOptions: LANGUAGE }).run(
			"side-effect-free",
			sideEffectFree,
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

/** The situations a program reaches: each site of a marked function, by the clause it breaks or as proven, each
 * unmarked function and the call sites in it the rule reports anyway, a stray mark, several functions. */
export const featuresOf = (program: Program): ReadonlyArray<Feature> => [
	...Arr.flatMap(program.functions, (each) =>
		Option.isSome(each.mark)
			? Arr.map(each.sites, inMarked)
			: ["an unmarked function" as const, ...Arr.flatMap(each.sites, outsideMarked)]
	),
	...(program.stray ? (["a misplaced mark"] as const) : []),
	...(program.functions.length > 1 ? (["a program of several functions"] as const) : [])
]

/** What RuleTester makes of a drawn program in a module of its own. */
export const judgedProgram = (program: Program): Option.Option<string> =>
	judged(program.code, "src/drawn.ts", program.reports)

/** What RuleTester makes of a drawn proof's module, at the file the options name. */
export const judgedHome = (home: Home): Option.Option<string> =>
	judged(home.code, PROVEN_FILE, home.reports)
