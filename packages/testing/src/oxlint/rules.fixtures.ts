/**
 * What rules.test.ts's properties draw and judge with: each rule's grammar of programs (the names and shapes its module
 * exports, written in every spelling the rule reads, beside the neighbours its contract leaves alone), each site
 * carrying the reports its rule's stated contract gives it, and the judge, oxlint's RuleTester run in the case itself.
 */
import {
	Array as Arr,
	Effect,
	FileSystem,
	Formatter,
	Option,
	Path,
	Record,
	Result,
	String as Str
} from "effect"
import { RuleTester } from "oxlint/plugins-dev"
import { assert } from "#assert.ts"
import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	int,
	type Space,
	subset,
	weighted
} from "#gen.ts"
import plugin from "#oxlint/plugin.ts"
import { COMPARISONS, PREDICATES, TRUTHS } from "#oxlint/rules/no-boolean-assert.ts"
import { CLAMPED, type Clamp, LENGTH } from "#oxlint/rules/no-clamped-count.ts"
import {
	ERROR_NAMES,
	ERROR_SUFFIXES,
	MATCHES,
	PRETTY_PRINTS,
	PROPERTY_MATCHERS,
	REJECTIONS,
	RENDERINGS,
	THROW_MATCHERS
} from "#oxlint/rules/no-error-prose.ts"
import { TABLES } from "#oxlint/rules/no-example-table.ts"
import { RUNS, SEED_FIELD, SEEDED } from "#oxlint/rules/no-fixed-seed.ts"
import { ARMS, CHOICES } from "#oxlint/rules/no-implicit-weight.ts"
import {
	COLLECTION_CONSTRUCTORS,
	HASH_COLLECTIONS,
	ITERATIONS,
	LISTINGS,
	PROJECTIONS
} from "#oxlint/rules/no-ordered-unordered.ts"
import { CONCURRENCY, DEFAULT_WIDTH } from "#oxlint/rules/no-restated-concurrency.ts"
import { CONCURRENT, FLAKY, LAYERS, RETRY } from "#oxlint/rules/no-retry-or-concurrency.ts"
import { EQUALITY_OPERATORS, SERIALIZATIONS } from "#oxlint/rules/no-serialized-comparison.ts"
import { SLEEPS } from "#oxlint/rules/no-sleep-wait.ts"
import {
	DICTIONARY_MINT,
	DICTIONARY_MODULES,
	VERDICT_KEYS
} from "#oxlint/rules/no-verdict-table.ts"
import {
	CLOCK_READS,
	DATE_READS,
	LIVE_MODULES,
	LIVE_READS,
	VITEST_TIMEOUTS
} from "#oxlint/rules/no-wall-clock-verdict.ts"
import { VITEST_MODULES } from "#oxlint/rules/test-module-shape.ts"
import { EQUALITIES, ORDERED_EQUALITIES, TEST_ROOTS } from "#oxlint/syntax.ts"
import { type Kill, type Property, property } from "#property.ts"

/** The assertion functions every program names, as @effect/vitest's utilities and the testing library's assert door
 * both export them. */
const ASSERTIONS =
	"assertEquals, assertExitSuccess, assertFalse, assertInclude, assertMatch, assertNone, assertSome, assertTrue, deepStrictEqual, strictEqual"

/** What every program's header imports beside its assertions. */
const IMPORTS = `import { Array as Arr, Cause, Chunk, Clock, DateTime, Duration, Effect, Equal, Exit, Formatter, HashMap, HashSet, Inspectable, Iterable, Option, Order, pipe, Predicate, Random, Record, Result, Schedule } from "effect"
import { TestClock } from "effect/testing"
import { describe, flakyTest, it, layer } from "@effect/vitest"
import { expect, test } from "vitest"
import { boolean, constant, element, int, oneOf, proportional, subset, weighted } from "@bjornpagen/testing/gen"
`

/**
 * The imports a program starts from, so each name resolves as it does in a real test file: its assertions from
 * @effect/vitest's utilities and node's `assert`, or from the testing library's assert door, which exports both.
 */
const HEADERS: Gen<string> = element([
	`${IMPORTS}import { ${ASSERTIONS} } from "@effect/vitest/utils"\nimport assert from "node:assert"\n`,
	`${IMPORTS}import { assert, ${ASSERTIONS} } from "@bjornpagen/testing/assert"\n`
])

/** The placeholder of a site's own suffix, so the locals of two sites of one program never share a name. */
const OWN = "§"

/**
 * One statement of a drawn program, or a few that belong together, with the number of times its rule's contract says
 * the rule reports it, and its text once the rule's fixes are applied (its own text for a rule that fixes nothing).
 * `code` and `fixed` name their own locals with OWN.
 */
type Site = Readonly<{ code: string; reports: number; fixed: string }>

const site = (code: string, reports: number): Site => ({ code, reports, fixed: code })

/** A site the rule fixes: its text, its reports, and its text once fixed. */
const fixedSite = (code: string, reports: number, fixed: string): Site => ({ code, reports, fixed })

/** A drawn program: its sites, its text, its text once fixed and the reports the contract gives it in all. */
export type Program = Readonly<{
	code: string
	fixed: string
	reports: number
	sites: ReadonlyArray<Site>
}>

/** The text of a program's sites, each site's locals suffixed by its place. */
const sitesText = (sites: ReadonlyArray<Site>, text: (s: Site) => string): string =>
	Arr.join(
		Arr.map(sites, (s, at) => Str.replaceAll(OWN, String(at))(text(s))),
		"\n"
	)

/** Programs of one to three sites. */
export const programOf =
	(sites: Gen<Site>): Gen<Program> =>
	(source) => {
		const drawnSites = source.draw(array(sites, { min: 1, max: 3 }))
		return {
			code: sitesText(drawnSites, (s) => s.code),
			fixed: sitesText(drawnSites, (s) => s.fixed),
			reports: Arr.reduce(drawnSites, 0, (sum, s) => sum + s.reports),
			sites: drawnSites
		}
	}

/** A path of a list as a program spells it: Effect's Array under the header's `Arr`, every other name as it is. */
const spelled = (path: string): string =>
	Str.startsWith("Array.")(path) ? `Arr.${Str.slice("Array.".length)(path)}` : path

/** A site's second value: its locals under the site's suffix and one more letter, apart from the first value's. */
const second = <A extends Readonly<{ declared: string; written: string }>>(value: A): A => ({
	...value,
	declared: Str.replaceAll(OWN, `${OWN}e`)(value.declared),
	written: Str.replaceAll(OWN, `${OWN}e`)(value.written)
})

/** The last name of a dotted path. */
const lastOf = (path: string): string => Arr.lastNonEmpty(Str.split(path, "."))

/** One name of a list a rule exports. */
const oneOf = (names: ReadonlyArray<string>): Gen<string> =>
	element(Option.getOrThrow(Option.liftPredicate(names, Arr.isReadonlyArrayNonEmpty)))

/** Names no rule reads, for values and receivers: neither an error's name nor one of its endings. */
const PLAIN = ["count", "value", "total", "row", "item"] as const

/** How a call to an assertion is written: a bare function, a method of node's `assert`, or an `expect(…)` matcher. */
type Spelling = "bare" | "assert" | "expect"

const spellings: Gen<Spelling> = element(["bare", "assert", "expect"] as const)

/** An assertion named `name` over `actual` and the rest of its arguments, written as `spelling` writes it. */
const asserted = (
	spelling: Spelling,
	name: string,
	actual: string,
	rest: ReadonlyArray<string>
): string => {
	switch (spelling) {
		case "bare":
			return `${name}(${Arr.join([actual, ...rest], ", ")})`
		case "assert":
			return `assert.${name}(${Arr.join([actual, ...rest], ", ")})`
		case "expect":
			return `expect(${actual}).${name}(${Arr.join(rest, ", ")})`
	}
}

/** How RuleTester parses each program: a TypeScript module. */
const LANGUAGE = { sourceType: "module", parserOptions: { lang: "ts" } } as const

/** One of the testing plugin's rules, by its name. */
export type RuleName = keyof typeof plugin.rules

/** The one message a rule reports under. */
const messageIdOf = (name: RuleName): string =>
	Option.getOrThrow(Arr.head(Record.keys(plugin.rules[name].meta?.messages ?? {})))

/**
 * What oxlint's RuleTester makes of a program after a header under one rule: none when the rule reports it exactly as
 * many times as its contract says, each under its message, and its fixes turn it into its fixed text, else what the
 * tester threw.
 */
const judged = (
	name: RuleName,
	header: string,
	program: Program,
	filename: Option.Option<string>
): Option.Option<string> => {
	const code = `${header}${program.code}\n`
	const fixed = `${header}${program.fixed}\n`
	const named = Option.match(filename, {
		onNone: () => ({}),
		onSome: (file) => ({ filename: file })
	})
	const ran = Result.try(() =>
		new RuleTester({ languageOptions: LANGUAGE }).run(
			name,
			plugin.rules[name],
			program.reports === 0
				? { valid: [{ code, ...named }], invalid: [] }
				: {
						valid: [],
						invalid: [
							{
								code,
								...named,
								output: fixed === code ? null : fixed,
								errors: Array.from({ length: program.reports }, () => ({
									messageId: messageIdOf(name)
								}))
							}
						]
					}
		)
	)
	return Result.match(ran, {
		onSuccess: () => Option.none(),
		onFailure: (failure) => Option.some(Formatter.format(failure))
	})
}

/** A finite timeout as a test may write one: a literal, a name, a value computed at load. */
const FINITE_TIMERS = element(["60_000", "limit", "process.env.CI ? 0 : 60_000"] as const)

/** A timeout of none, as Vitest reads one. */
const NO_TIMERS = element(["0", "Infinity", "Number.POSITIVE_INFINITY"] as const)

/**
 * Every form a test API takes a timer in, given `timer`, each once, so a site of them reaches every form, and its text
 * once the rule's fix deletes the timer: a test's or a suite's third argument and options, alone or beside another
 * option, first or last, a table's, a hook's second argument, a layer's options, a wait's, and options a `const` holds,
 * which the fix leaves `{}`.
 */
const timedCalls = (timer: string): ReadonlyArray<readonly [code: string, fixed: string]> => [
	[`it("case ${OWN}", () => check(), ${timer})`, `it("case ${OWN}", () => check())`],
	[
		`test("case ${OWN}", { timeout: ${timer} }, () => check())`,
		`test("case ${OWN}", () => check())`
	],
	[
		`describe("suite ${OWN}", () => check(), { timeout: ${timer} })`,
		`describe("suite ${OWN}", () => check())`
	],
	[
		`it.effect("case ${OWN}", () => Effect.void, ${timer})`,
		`it.effect("case ${OWN}", () => Effect.void)`
	],
	[
		`it.each([1])("case ${OWN}", (n) => check(n), ${timer})`,
		`it.each([1])("case ${OWN}", (n) => check(n))`
	],
	[`beforeAll(() => check(), ${timer})`, `beforeAll(() => check())`],
	[`afterEach(() => check(), ${timer})`, `afterEach(() => check())`],
	[
		`layer(Live${OWN}, { timeout: ${timer} })("suite ${OWN}", (it) => check(it))`,
		`layer(Live${OWN})("suite ${OWN}", (it) => check(it))`
	],
	[`vi.waitFor(() => check(), { timeout: ${timer} })`, `vi.waitFor(() => check())`],
	[`expect.poll(() => check(), { timeout: ${timer} })`, `expect.poll(() => check())`],
	[
		`it("case ${OWN}", { retry: 0, timeout: ${timer} }, () => check())`,
		`it("case ${OWN}", { retry: 0 }, () => check())`
	],
	[
		`it("case ${OWN}", { timeout: ${timer}, retry: 0 }, () => check())`,
		`it("case ${OWN}", { retry: 0 }, () => check())`
	],
	[
		`const options${OWN} = { timeout: ${timer} }\nit("case ${OWN}", options${OWN}, () => check())`,
		`const options${OWN} = {}\nit("case ${OWN}", options${OWN}, () => check())`
	]
]

/** A reference that reads the clock, a Date of now, or a near name of either, which reads nothing; and a Vitest
 * timeout, finite (a literal, a name, a value computed at load) or none (0, Infinity), or a near name of one. */
const clockSites: Gen<Site> = weighted([
	[4, (s) => site(`const now${OWN} = ${spelled(s.draw(oneOf(CLOCK_READS)))}`, 1)],
	[1, (s) => site(`const now${OWN} = new ${s.draw(oneOf(DATE_READS))}()`, 1)],
	[1, (s) => site(`const now${OWN} = ${s.draw(oneOf(DATE_READS))}()`, 1)],
	[2, (s) => site(`const near${OWN} = ${spelled(s.draw(oneOf(CLOCK_READS)))}Of`, 0)],
	[
		2,
		(s) => {
			const member = lastOf(s.draw(oneOf(CLOCK_READS)))
			return site(
				`const local${OWN} = { ${member}: 0 }\nconst near${OWN} = local${OWN}.${member}`,
				0
			)
		}
	],
	[1, (s) => site(`const day${OWN} = new ${s.draw(oneOf(DATE_READS))}(${s.draw(int(0, 9))})`, 0)],
	[
		2,
		(s) =>
			site(
				`import { ${s.draw(oneOf(LIVE_READS))} as read${OWN} } from "${s.draw(oneOf(LIVE_MODULES))}"`,
				1
			)
	],
	[
		1,
		(s) =>
			site(
				`import { liveSleep as sleep${OWN}, stopwatch as watch${OWN} } from "${s.draw(oneOf(LIVE_MODULES))}"`,
				0
			)
	],
	[1, (s) => site(`import { ${s.draw(oneOf(LIVE_READS))} as near${OWN} } from "#clock.ts"`, 0)],
	[
		3,
		(s) => {
			const key = s.draw(oneOf(VITEST_TIMEOUTS))
			const timeout = `${key}: ${s.draw(element(["60_000", "1", "limit", "process.env.CI ? 0 : 60_000", "Infinity", "Number.POSITIVE_INFINITY"] as const))}`
			return s.draw(element([false, true] as const))
				? fixedSite(
						`const config${OWN} = { test: { include: ["a"], ${timeout} } }`,
						1,
						`const config${OWN} = { test: { include: ["a"], ${key}: 0 } }`
					)
				: fixedSite(
						`const config${OWN} = { test: { ${timeout} } }`,
						1,
						`const config${OWN} = { test: { ${key}: 0 } }`
					)
		}
	],
	[2, (s) => site(`const config${OWN} = { test: { ${s.draw(oneOf(VITEST_TIMEOUTS))}: 0 } }`, 0)],
	[
		1,
		(s) => {
			const key = s.draw(oneOf(VITEST_TIMEOUTS))
			return fixedSite(
				`const unbounded${OWN} = 0\nconst config${OWN} = { test: { ${key}: unbounded${OWN} } }`,
				1,
				`const unbounded${OWN} = 0\nconst config${OWN} = { test: { ${key}: 0 } }`
			)
		}
	],
	[1, (s) => site(`const near${OWN} = { ${s.draw(oneOf(VITEST_TIMEOUTS))}Ms: 60_000 }`, 0)],
	[
		8,
		(s) => {
			const bounded = s.draw(element([true, false] as const))
			const calls = timedCalls(s.draw(bounded ? FINITE_TIMERS : NO_TIMERS))
			const code = Arr.join(
				Arr.map(calls, ([written]) => written),
				"\n"
			)
			return bounded
				? fixedSite(
						code,
						calls.length,
						Arr.join(
							Arr.map(calls, ([, fixed]) => fixed),
							"\n"
						)
					)
				: site(code, 0)
		}
	],
	[
		2,
		(s) =>
			site(
				s.draw(
					element([
						`it("case ${OWN}", () => check())`,
						`beforeAll(() => check())`,
						`run${OWN}("case ${OWN}", () => check(), 60_000)`,
						`const options${OWN} = { retry: 0 }\nit("case ${OWN}", options${OWN}, () => check())`
					] as const)
				),
				0
			)
	]
])

/** The names of a list written bare, with no module before them. */
const bareOf = (names: ReadonlyArray<string>): ReadonlyArray<string> =>
	Arr.filter(names, (name) => !Str.includes(".")(name))

/** A call that waits for time to pass, under its own name or an import alias, or a near form that waits for nothing. */
export const sleepSites: Gen<Site> = weighted([
	[4, (s) => site(`const wait${OWN} = ${spelled(s.draw(oneOf(SLEEPS)))}(1)`, 1)],
	[
		1,
		(s) =>
			site(
				`import { ${s.draw(oneOf(bareOf(SLEEPS)))} as wait${OWN} } from "node:timers/promises"\nawait wait${OWN}(1)`,
				1
			)
	],
	[2, (s) => site(`const held${OWN} = ${spelled(s.draw(oneOf(SLEEPS)))}`, 0)],
	[
		2,
		(s) => {
			const member = lastOf(s.draw(oneOf(SLEEPS)))
			return site(
				`const local${OWN} = { ${member}: (n: number) => n }\nconst near${OWN} = local${OWN}.${member}(1)`,
				0
			)
		}
	]
])

/** The module of a dotted path, its first name. */
const moduleOf = (path: string): string => Arr.headNonEmpty(Str.split(path, "."))

/**
 * How a clamping constructor is named: the header's module (`Arr` for Effect's Array), a namespace import of
 * effect/<Module>, or its own name imported from effect/<Module>.
 */
const clampedCallee = (path: string): Gen<readonly [imports: string, callee: string]> =>
	element([
		["", spelled(path)],
		[`import * as Mod${OWN} from "effect/${moduleOf(path)}"\n`, `Mod${OWN}.${lastOf(path)}`],
		[`import { ${lastOf(path)} as made${OWN} } from "effect/${moduleOf(path)}"\n`, `made${OWN}`]
	] as const)

/** A count or a range's end as written: a literal or a `const` holding one, an expression, a parameter. */
type Count =
	| Readonly<{ kind: "literal" | "const"; value: number }>
	| Readonly<{ kind: "expression" | "parameter" }>

const countGen: Gen<Count> = weighted<Count>([
	[3, (s) => ({ kind: "literal", value: s.draw(element([-1, 0, 1, 2, 3, 1.5] as const)) })],
	[2, (s) => ({ kind: "const", value: s.draw(element([-1, 0, 1, 2, 3, 1.5] as const)) })],
	[1, constant<Count>({ kind: "expression" })],
	[1, constant<Count>({ kind: "parameter" })]
])

/** The integer a count writes, as the contract reads one: a literal or a `const` of a whole number. */
const integerOf = (count: Count): Option.Option<number> =>
	(count.kind === "literal" || count.kind === "const") && Number.isInteger(count.value)
		? Option.some(count.value)
		: Option.none()

/** Whether a count states a positive whole number: the contract's one count no clamping constructor normalizes. */
const statesPositive = (count: Count): boolean => Option.exists(integerOf(count), (n) => n >= 1)

/** A count as a site writes it under `tag`: what it declares, what it writes, and the parameter it needs, if any. */
type WrittenCount = Readonly<{
	declared: string
	written: string
	parameters: ReadonlyArray<string>
}>

const writtenCount = (count: Count, tag: string): WrittenCount => {
	const name = `${tag}${OWN}`
	switch (count.kind) {
		case "literal":
			return { declared: "", written: String(count.value), parameters: [] }
		case "const":
			return { declared: `const ${name} = ${count.value}\n`, written: name, parameters: [] }
		case "expression":
			return { declared: `const ${name} = 3\n`, written: `${name} - 1`, parameters: [] }
		case "parameter":
			return { declared: "", written: name, parameters: [`${name}: number`] }
	}
}

/** A site of a call made inside a function of the counts' parameters, after the counts' declarations. */
const callSite = (
	imports: string,
	counts: ReadonlyArray<WrittenCount>,
	call: string,
	reports: number
): Site =>
	site(
		`${imports}${Arr.join(
			Arr.map(counts, (count) => count.declared),
			""
		)}const rows${OWN} = (${Arr.join(
			Arr.flatMap(counts, (count) => count.parameters),
			", "
		)}) => ${call}`,
		reports
	)

/** The function a clamping constructor's data-first call takes beside its count, at the other place. */
const besideCount = (at: number): string => (at === 0 ? "(i: number) => i" : `"x"`)

/** A call to a clamping constructor as its clamp reads it, with the reports its contract gives it. */
const clampedCall =
	(callee: string, clamp: Clamp, imports: string): Gen<Site> =>
	(source) => {
		switch (clamp.kind) {
			case "count": {
				const count = source.draw(countGen)
				const written = writtenCount(count, "count")
				if (source.draw(boolean)) {
					const args =
						clamp.dataFirst === 0
							? [written.written, besideCount(0)]
							: [besideCount(1), written.written]
					return callSite(
						imports,
						[written],
						`${callee}(${Arr.join(args, ", ")})`,
						statesPositive(count) ? 0 : 1
					)
				}
				return clamp.dataLast === "piped"
					? callSite(imports, [], `pipe(3, ${callee}((i: number) => i))`, 1)
					: callSite(
							imports,
							[written],
							`${callee}(${written.written})`,
							statesPositive(count) ? 0 : 1
						)
			}
			case "ends": {
				const start = source.draw(countGen)
				const startWritten = writtenCount(start, "start")
				if (source.draw(boolean)) {
					return callSite(
						imports,
						[startWritten],
						`${callee}(${startWritten.written})`,
						clamp.endless ? 0 : 1
					)
				}
				const end = source.draw(countGen)
				const endWritten = writtenCount(end, "end")
				const states = Option.exists(
					Option.all([integerOf(start), integerOf(end)]),
					([from, to]) => from <= to
				)
				return callSite(
					imports,
					[startWritten, endWritten],
					`${callee}(${startWritten.written}, ${endWritten.written})`,
					states ? 0 : 1
				)
			}
			case "length": {
				const made = `${callee}((i: number) => i`
				return source.draw(
					weighted<Site>([
						[1, constant(callSite(imports, [], `${made})`, 0))],
						[1, constant(callSite(imports, [], `${made}, {})`, 0))],
						[
							3,
							(s) => {
								const count = s.draw(countGen)
								const written = writtenCount(count, "count")
								return callSite(
									imports,
									[written],
									`${made}, { ${LENGTH}: ${written.written} })`,
									statesPositive(count) ? 0 : 1
								)
							}
						],
						[
							1,
							constant(
								callSite(
									imports,
									[writtenCount({ kind: "parameter" }, "options")],
									`${made}, options${OWN})`,
									1
								)
							)
						]
					])
				)
			}
		}
	}

/** One clamping constructor of the rule's list, with its clamp. */
const clampedOf = element(
	Option.getOrThrow(Option.liftPredicate(CLAMPED, Arr.isReadonlyArrayNonEmpty))
)

/** A call to a drawn clamping constructor, a near name of one, and a method of that name on a local value. */
export const clampedSites: Gen<Site> = weighted([
	[
		6,
		(s) => {
			const [path, clamp] = s.draw(clampedOf)
			const [imports, callee] = s.draw(clampedCallee(path))
			return s.draw(clampedCall(callee, clamp, imports))
		}
	],
	[1, (s) => site(`const rows${OWN} = ${spelled(s.draw(clampedOf)[0])}Of(0, -1)`, 0)],
	[
		1,
		(s) => {
			const member = lastOf(s.draw(clampedOf)[0])
			return site(
				`const local${OWN} = { ${member}: (a: number, b: number) => [a, b] }\nconst near${OWN} = local${OWN}.${member}(0, -1)`,
				0
			)
		}
	]
])

/** Options a choice lists, each as a program writes it: literals and generators alike, since the rule reads their text. */
const OPTION_TEXTS = [
	`"a"`,
	`"b"`,
	`""`,
	"0",
	"1",
	"true",
	"constant(1)",
	"int(0, 3)",
	"boolean"
] as const

/** One to four distinct options, and, when `repeated`, one of them written a second time at a drawn place. */
const listedGen =
	(repeated: boolean): Gen<ReadonlyArray<string>> =>
	(source) => {
		const distinct = source.draw(subset(OPTION_TEXTS, { min: 1, max: 4 }))
		if (!repeated) {
			return distinct
		}
		const again = source.draw(
			element(Option.getOrThrow(Option.liftPredicate(distinct, Arr.isReadonlyArrayNonEmpty)))
		)
		const at = source.draw(int(0, distinct.length))
		return [...Arr.take(distinct, at), again, ...Arr.drop(distinct, at)]
	}

/** A written list as a site passes it: inline, held by a `const`, with `as const` or not, after a spread or not. */
const listSite =
	(items: ReadonlyArray<string>): Gen<readonly [declared: string, written: string]> =>
	(source) => {
		const spread = source.draw(boolean) ? ["...more"] : []
		const list = `[${Arr.join([...spread, ...items], ", ")}]${source.draw(boolean) ? " as const" : ""}`
		return source.draw(boolean) ? [`const options${OWN} = ${list}\n`, `options${OWN}`] : ["", list]
	}

/** A choice over a written list, a choice whose arms pair drawn weights with options, and the neighbours left alone. */
export const weightSites: Gen<Site> = weighted([
	[
		4,
		(s) => {
			const repeated = s.draw(boolean)
			const [declared, written] = s.draw(listSite(s.draw(listedGen(repeated))))
			return site(
				`${declared}const choice${OWN} = ${s.draw(oneOf(CHOICES))}(${written})`,
				repeated ? 1 : 0
			)
		}
	],
	[
		3,
		(s) => {
			const repeated = s.draw(boolean)
			const arms = Arr.map(
				s.draw(listedGen(repeated)),
				(option) => `[${s.draw(int(1, 3))}, ${option}]`
			)
			const [declared, written] = s.draw(listSite(arms))
			return site(
				`${declared}const choice${OWN} = ${s.draw(oneOf(ARMS))}(${written})`,
				repeated ? 1 : 0
			)
		}
	],
	[
		1,
		(s) => {
			const weight = s.draw(int(1, 3))
			const arms = Arr.map(s.draw(listedGen(false)), (option) => `[${weight}, ${option}]`)
			return site(`const choice${OWN} = ${s.draw(oneOf(ARMS))}([${Arr.join(arms, ", ")}])`, 0)
		}
	],
	[
		1,
		(s) =>
			site(
				`const choice${OWN} = ${s.draw(oneOf(CHOICES))}Of([${Arr.join(s.draw(listedGen(true)), ", ")}])`,
				0
			)
	],
	[
		1,
		(s) =>
			site(
				`const picked${OWN} = subset([${Arr.join(s.draw(listedGen(true)), ", ")}], { min: 0, max: 2 })`,
				0
			)
	],
	[
		1,
		(s) =>
			site(
				`const choose${OWN} = (options: ReadonlyArray<number>) => ${s.draw(oneOf(CHOICES))}(options)`,
				0
			)
	]
])

/** A seed as a site writes it: the declaration it needs, if any, and the seed itself. */
type Written = readonly [declared: string, written: string]

/** A seed a test writes: a literal, negated or not, of a number, a bigint or a string, or a `const` holding one. */
const fixedSeeds: Gen<Written> = weighted<Written>([
	[2, (s) => ["", String(s.draw(int(0, 99)))]],
	[1, (s) => ["", `-${s.draw(int(1, 99))}`]],
	[1, (s) => ["", `"seed${s.draw(int(0, 9))}"`]],
	[1, (s) => ["", `${s.draw(int(0, 99))}n`]],
	[1, (s) => [`const SEED${OWN} = ${s.draw(int(0, 99))}\n`, `SEED${OWN}`]]
])

/** A seed that comes from the run: a field of it, or what a stream gives. */
const runSeeds: Gen<string> = element(["run.seed", "caseSeed(stream, 0)"] as const)

/** A seed of either kind, and whether the contract counts it fixed. */
type Seed = readonly [declared: string, written: string, fixed: boolean]

const seedGen: Gen<Seed> = weighted<Seed>([
	[3, (s) => [...s.draw(fixedSeeds), true]],
	[2, (s) => ["", s.draw(runSeeds), false]]
])

/** The arguments of a seeded call: the seed at the place its callee takes one, others from the run. */
const seededCall = (callee: string, at: number | "any", seed: string): string => {
	if (at === "any") {
		return `${spelled(callee)}(program, ${seed})`
	}
	const others = Arr.map(
		Array.from({ length: at + 1 }, (_, i) => i),
		(place) => (place === at ? seed : "run.seed")
	)
	return `${spelled(callee)}(${Arr.join([...others, "run.seed"], ", ")})`
}

/** A run or a seeded call given a drawn seed, a fixed seed at a place no callee reads one, and a `seed` field of data. */
export const seedSites: Gen<Site> = weighted([
	[
		3,
		(s) => {
			const [declared, written, fixed] = s.draw(seedGen)
			return site(
				`${declared}const run${OWN} = ${spelled(s.draw(oneOf(RUNS)))}({ ${SEED_FIELD}: ${written}, source: "environment" })`,
				fixed ? 1 : 0
			)
		}
	],
	[
		3,
		(s) => {
			const [callee, at] = s.draw(
				element(Option.getOrThrow(Option.liftPredicate(SEEDED, Arr.isReadonlyArrayNonEmpty)))
			)
			const [declared, written, fixed] = s.draw(seedGen)
			return site(
				`${declared}const words${OWN} = ${seededCall(callee, at, written)}`,
				fixed ? 1 : 0
			)
		}
	],
	[
		1,
		(s) => {
			const [callee, at] = s.draw(
				element(Option.getOrThrow(Option.liftPredicate(SEEDED, Arr.isReadonlyArrayNonEmpty)))
			)
			return typeof at === "number"
				? site(
						`const words${OWN} = ${spelled(callee)}(${Arr.join([...Array.from({ length: at + 1 }, () => "run.seed"), "41"], ", ")})`,
						0
					)
				: site(`const words${OWN} = ${spelled(callee)}(program)`, 0)
		}
	],
	[1, (s) => site(`const sketch${OWN} = { ${SEED_FIELD}: ${s.draw(int(0, 99))}, moves: 3 }`, 0)]
])

/** A subject an assertion checks, and whether a narrower assertion states it. */
type Subject = Readonly<{ declared: string; written: string; narrowable: boolean }>

/** A predicate call, data first or data last, a comparison by an operator a narrower equality states, and their negation. */
const narrowableGen: Gen<Subject> = weighted<Subject>([
	[
		3,
		(s) => {
			const predicate = spelled(s.draw(oneOf(PREDICATES)))
			return {
				declared: "",
				written: s.draw(element([`${predicate}(x, y)`, `${predicate}("T")(x)`] as const)),
				narrowable: true
			}
		}
	],
	[2, (s) => ({ declared: "", written: `x ${s.draw(oneOf(COMPARISONS))} y`, narrowable: true })]
])

/** A value no narrower assertion states: a plain flag, an ordering, a call of no predicate, a predicate's near name. */
const plainSubjectGen: Gen<Subject> = weighted<Subject>([
	[1, constant<Subject>({ declared: "", written: "flag", narrowable: false })],
	[
		1,
		(s) => ({
			declared: "",
			written: `x ${s.draw(element(["<", "<=", ">", ">="] as const))} y`,
			narrowable: false
		})
	],
	[1, constant<Subject>({ declared: "", written: "isPrime(x)", narrowable: false })],
	[
		1,
		(s) => ({
			declared: "",
			written: `${spelled(s.draw(oneOf(PREDICATES)))}Of(x)`,
			narrowable: false
		})
	]
])

/** A subject as written, negated, or held by a `const`: each keeps whether it is narrowable. */
const subjectGen: Gen<Subject> = (source) => {
	const inner = source.draw(
		weighted([
			[1, narrowableGen],
			[1, plainSubjectGen]
		])
	)
	switch (source.draw(element(["as written", "negated", "held"] as const))) {
		case "as written":
			return inner
		case "negated":
			return { ...inner, written: `!(${inner.written})` }
		case "held":
			return {
				declared: `const fact${OWN} = ${inner.written}\n`,
				written: `fact${OWN}`,
				narrowable: inner.narrowable
			}
	}
}

/** A truth assertion or an equality with a boolean over a drawn subject, with a message or none. */
export const booleanSites: Gen<Site> = weighted([
	[
		3,
		(s) => {
			const subject = s.draw(subjectGen)
			const spelling = s.draw(spellings)
			const name = s.draw(oneOf(TRUTHS))
			const message = s.draw(element([false, true] as const))
			const call =
				spelling === "expect"
					? `expect(${subject.written}${message ? `, "states the fact"` : ""}).${name}()`
					: asserted(spelling, name, subject.written, message ? [`"states the fact"`] : [])
			return site(`${subject.declared}${call}`, subject.narrowable && !message ? 1 : 0)
		}
	],
	[
		3,
		(s) => {
			const subject = s.draw(subjectGen)
			const spelling = s.draw(spellings)
			const name = s.draw(oneOf(EQUALITIES))
			const literal = s.draw(element(["true", "false"] as const))
			const message = s.draw(element([false, true] as const))
			const flipped = spelling !== "expect" && s.draw(element([false, true] as const))
			const call =
				spelling === "expect"
					? `expect(${subject.written}${message ? `, "states the fact"` : ""}).${name}(${literal})`
					: flipped
						? asserted(spelling, name, literal, [
								subject.written,
								...(message ? [`"states the fact"`] : [])
							])
						: asserted(spelling, name, subject.written, [
								literal,
								...(message ? [`"states the fact"`] : [])
							])
			return site(`${subject.declared}${call}`, subject.narrowable && !message ? 1 : 0)
		}
	],
	[
		1,
		(s) =>
			site(
				asserted(s.draw(spellings), s.draw(oneOf(EQUALITIES)), s.draw(narrowableGen).written, [
					"1"
				]),
				0
			)
	]
])

/** An error's name: one the rule names whole, or a word with one of its endings. */
const errorNameGen: Gen<string> = weighted([
	[1, oneOf(ERROR_NAMES)],
	[1, (s) => `parse${s.draw(oneOf(ERROR_SUFFIXES))}`]
])

/** A text an assertion checks, and whether the contract reads it as an error's text. */
type Text = Readonly<{ declared: string; written: string; errorText: boolean }>

const textGen: Gen<Text> = (source) => {
	const plain = source.draw(element(PLAIN))
	const inner = source.draw(
		weighted<Readonly<{ written: string; errorText: boolean }>>([
			[
				2,
				(s) => ({
					written: `${s.draw(
						weighted([
							[1, errorNameGen],
							[1, element(PLAIN)]
						])
					)}.message`,
					errorText: true
				})
			],
			[1, (s) => ({ written: `${spelled(s.draw(oneOf(PRETTY_PRINTS)))}(cause)`, errorText: true })],
			[1, (s) => ({ written: `${s.draw(errorNameGen)}.toString()`, errorText: true })],
			[
				1,
				(s) => ({
					written: `${spelled(s.draw(oneOf(RENDERINGS)))}(${s.draw(errorNameGen)})`,
					errorText: true
				})
			],
			[1, constant({ written: `${plain}.toString()`, errorText: false })],
			[
				1,
				(s) => ({ written: `${spelled(s.draw(oneOf(RENDERINGS)))}(${plain})`, errorText: false })
			],
			[1, constant({ written: plain, errorText: false })]
		])
	)
	return source.draw(element([false, true] as const))
		? {
				declared: `const text${OWN} = ${inner.written}\n`,
				written: `text${OWN}`,
				errorText: inner.errorText
			}
		: { declared: "", ...inner }
}

/** A matcher of a thrown error, and whether it is written text or an object holding a `message`. */
const throwMatcherGen: Gen<readonly [written: string, prose: boolean]> = element([
	[`"empty input"`, true],
	["/empty/", true],
	["`empty input`", true],
	[`{ message: "empty input" }`, true],
	["ParseFailure", false],
	[`{ name: "ParseFailure" }`, false]
] as const)

/** A matcher of a rejection, and whether it is a pattern or an object holding a `message`: written text is its message. */
const rejectionMatcherGen: Gen<readonly [written: string, prose: boolean]> = element([
	["/empty/", true],
	[`{ message: "empty input" }`, true],
	[`"why it must throw"`, false],
	["ParseFailure", false]
] as const)

/** Each family of assertion over error text, each judged as the contract judges it. */
export const proseSites: Gen<Site> = weighted([
	[
		3,
		(s) => {
			const actual = s.draw(textGen)
			const expected = second(
				s.draw(
					weighted<Text>([
						[1, textGen],
						[1, constant<Text>({ declared: "", written: `"todo not found"`, errorText: false })]
					])
				)
			)
			const call = asserted(s.draw(spellings), s.draw(oneOf(EQUALITIES)), actual.written, [
				expected.written
			])
			return site(
				`${actual.declared}${expected.declared}${call}`,
				actual.errorText !== expected.errorText ? 1 : 0
			)
		}
	],
	[
		2,
		(s) => {
			const actual = s.draw(textGen)
			const call = asserted(s.draw(spellings), s.draw(oneOf(MATCHES)), actual.written, ["/found/"])
			return site(`${actual.declared}${call}`, actual.errorText ? 1 : 0)
		}
	],
	[
		2,
		(s) => {
			const [matcher, prose] = s.draw(throwMatcherGen)
			const name = s.draw(oneOf(THROW_MATCHERS))
			return site(
				s.draw(element([false, true] as const))
					? `await expect(promise).rejects.${name}(${matcher})`
					: asserted(s.draw(spellings), name, `() => parse("")`, [matcher]),
				prose ? 1 : 0
			)
		}
	],
	[
		1,
		(s) => {
			const [matcher, prose] = s.draw(rejectionMatcherGen)
			return site(
				asserted(s.draw(spellings), s.draw(oneOf(REJECTIONS)), `() => parse("")`, [matcher]),
				prose ? 1 : 0
			)
		}
	],
	[
		1,
		(s) => {
			const field = s.draw(element(["message", "code"] as const))
			return site(
				asserted(s.draw(spellings), s.draw(oneOf(PROPERTY_MATCHERS)), "failure", [
					`"${field}"`,
					`"boom"`
				]),
				field === "message" ? 1 : 0
			)
		}
	]
])

/** A compared value, and whether the contract counts it serialized or a rendered template. */
type Compared = Readonly<{
	declared: string
	written: string
	serialized: boolean
	rendered: boolean
}>

const comparedGen: Gen<Compared> = (source) => {
	const plain = source.draw(element(PLAIN))
	const inner = source.draw(
		weighted<Readonly<{ written: string; serialized: boolean; rendered: boolean }>>([
			[
				3,
				(s) => ({
					written: `${spelled(s.draw(oneOf(SERIALIZATIONS)))}(${plain})`,
					serialized: true,
					rendered: false
				})
			],
			[1, constant({ written: `${plain}.toString()`, serialized: true, rendered: false })],
			[1, constant({ written: `${plain}.toString(16)`, serialized: false, rendered: false })],
			[
				1,
				(s) => ({
					written: `${spelled(s.draw(oneOf(RENDERINGS)))}(${s.draw(errorNameGen)})`,
					serialized: false,
					rendered: false
				})
			],
			[1, constant({ written: `\`\${${plain}}-\${other}\``, serialized: false, rendered: true })],
			[1, constant({ written: "`plain`", serialized: false, rendered: false })],
			[1, constant({ written: `"42"`, serialized: false, rendered: false })],
			[1, constant({ written: plain, serialized: false, rendered: false })]
		])
	)
	return source.draw(element([false, true] as const))
		? {
				declared: `const shown${OWN} = ${inner.written}\n`,
				written: `shown${OWN}`,
				serialized: inner.serialized,
				rendered: inner.rendered
			}
		: { declared: "", ...inner }
}

/** An equality assertion or an equality operator over drawn values, and an operator that compares nothing. */
export const serializedSites: Gen<Site> = weighted([
	[
		3,
		(s) => {
			const actual = s.draw(comparedGen)
			const expected = second(s.draw(comparedGen))
			const call = asserted(s.draw(spellings), s.draw(oneOf(EQUALITIES)), actual.written, [
				expected.written
			])
			return site(
				`${actual.declared}${expected.declared}${call}`,
				actual.serialized || expected.serialized || actual.rendered ? 1 : 0
			)
		}
	],
	[
		2,
		(s) => {
			const left = s.draw(comparedGen)
			const right = second(s.draw(comparedGen))
			return site(
				`${left.declared}${right.declared}const same${OWN} = ${left.written} ${s.draw(oneOf(EQUALITY_OPERATORS))} ${right.written}`,
				left.serialized || right.serialized ? 1 : 0
			)
		}
	],
	[
		1,
		(s) => {
			const joined = s.draw(comparedGen)
			return site(`${joined.declared}const joined${OWN} = ${joined.written} + unit`, 0)
		}
	]
])

/** Sources whose own order a listing keeps: an array, a typed array, a string, an array-like literal, a value. */
const orderedSources: Gen<string> = element([
	"[3, 1, 2]",
	"new Uint8Array(4)",
	"bytes",
	`"text"`,
	"{ length: 3 }",
	"chunk"
] as const)

/** An unordered collection, spelled by its constructor or its hash module, as written or held by a `const`. */
const collectionGen: Gen<readonly [declared: string, written: string]> = (source) => {
	const built = source.draw(
		weighted<string>([
			[1, (s) => `new ${s.draw(oneOf(COLLECTION_CONSTRUCTORS))}(ids)`],
			[1, (s) => `${s.draw(oneOf(HASH_COLLECTIONS))}.make(1, 2)`]
		])
	)
	return source.draw(element([false, true] as const))
		? [`const seen${OWN} = ${built}\n`, `seen${OWN}`]
		: ["", built]
}

/** A compared side, and whether it holds a projection of an unordered collection, as the contract reads one. */
type Projected = Readonly<{ declared: string; written: string; projection: boolean }>

const projectedGen: Gen<Projected> = weighted<Projected>([
	[
		3,
		(s) => ({
			declared: "",
			written: `${spelled(s.draw(oneOf(PROJECTIONS)))}(record)`,
			projection: true
		})
	],
	[
		2,
		(s) => ({
			declared: `const keys${OWN} = ${spelled(s.draw(oneOf(PROJECTIONS)))}(record)\n`,
			written: `keys${OWN}`,
			projection: true
		})
	],
	[
		1,
		(s) => ({
			declared: `const keys${OWN} = Arr.sort(${spelled(s.draw(oneOf(PROJECTIONS)))}(record), Order.String)\n`,
			written: `keys${OWN}`,
			projection: false
		})
	],
	[2, (s) => ({ declared: "", written: `index.${s.draw(oneOf(ITERATIONS))}()`, projection: true })],
	[
		1,
		(s) => ({ declared: "", written: `index.${s.draw(oneOf(ITERATIONS))}(1)`, projection: false })
	],
	[
		2,
		(s) => {
			const [declared, written] = s.draw(collectionGen)
			return s.draw(element([false, true] as const))
				? { declared, written: `[...${written}]`, projection: true }
				: { declared, written: `${spelled(s.draw(oneOf(LISTINGS)))}(${written})`, projection: true }
		}
	],
	[
		2,
		(s) => ({
			declared: "",
			written: `${spelled(s.draw(oneOf(LISTINGS)))}(${s.draw(orderedSources)})`,
			projection: false
		})
	],
	[1, constant<Projected>({ declared: "", written: "[...items, 1]", projection: false })],
	[1, constant<Projected>({ declared: "", written: "[1, 2]", projection: false })]
])

/** A side as it is, or held in an object literal's field or an array literal's item: a holder holds what it holds. */
const sideGen: Gen<Projected> = (source) => {
	const inner = source.draw(projectedGen)
	switch (source.draw(element(["as it is", "in a field", "in an item"] as const))) {
		case "as it is":
			return inner
		case "in a field":
			return { ...inner, written: `{ names: ${inner.written} }` }
		case "in an item":
			return { ...inner, written: `[${inner.written}, 0]` }
	}
}

/** An ordered equality over drawn sides, and an equality that compares by identity, which no order reaches. */
export const orderedSites: Gen<Site> = weighted([
	[
		4,
		(s) => {
			const actual = s.draw(sideGen)
			const expected = second(s.draw(sideGen))
			const call = asserted(s.draw(spellings), s.draw(oneOf(ORDERED_EQUALITIES)), actual.written, [
				expected.written
			])
			return site(
				`${actual.declared}${expected.declared}${call}`,
				actual.projection || expected.projection ? 1 : 0
			)
		}
	],
	[
		1,
		(s) => {
			const unordered = Arr.filter(EQUALITIES, (name) => !Arr.contains(ORDERED_EQUALITIES, name))
			const side = s.draw(sideGen)
			return site(
				`${side.declared}${asserted(s.draw(spellings), s.draw(oneOf(unordered)), side.written, ["[1, 2]"])}`,
				0
			)
		}
	]
])

/**
 * Rows a test takes, and whether they are written out: an array literal of rows or a `const` holding one, an empty one
 * the code pushes written rows into; or none written: an empty literal, an accumulator program code fills or pushes
 * computed values into, or rows made.
 */
const rowsGen: Gen<readonly [declared: string, written: string, writtenOut: boolean]> = element([
	["", "[1, 2]", true],
	["", "[]", false],
	[`const rows${OWN} = [{ input: 1, output: 2 }]\n`, `rows${OWN}`, true],
	[
		`const rows${OWN}: Array<{ input: number }> = []\nrows${OWN}.push({ input: 1 }, { input: -2 })\n`,
		`rows${OWN}`,
		true
	],
	[`const rows${OWN}: Array<number> = []\nfill(rows${OWN})\n`, `rows${OWN}`, false],
	[`const rows${OWN}: Array<number> = []\nrows${OWN}.push(compute())\n`, `rows${OWN}`, false],
	["", "rowsOf(3)", false]
] as const)

/** A test's path: a root the contract reads, and a modifier between the root and the rest, or none. */
const testPathGen: Gen<string> = (source) =>
	`${source.draw(oneOf(TEST_ROOTS))}${source.draw(element(["", ".effect"] as const))}`

/**
 * A table test over drawn rows, a tagged-template table, a near modifier, and a for…of over rows in or out of a test:
 * in its callback, in the generator of an `Effect.gen` it returns, of an `Effect.fn("name")` handed it as its body,
 * directly or by a `const`, of an `Effect.gen` under a further wrapper or piped through one, of one a declaration of the
 * body runs, and of one a statement runs; never in a helper the body calls by name, nor in an effect no test runs.
 */
export const tableSites: Gen<Site> = weighted([
	[
		3,
		(s) => {
			const [declared, rows, writtenOut] = s.draw(rowsGen)
			return site(
				`${declared}${s.draw(testPathGen)}.${s.draw(oneOf(TABLES))}(${rows})("case ${OWN}", (row) => check(row))`,
				writtenOut ? 1 : 0
			)
		}
	],
	[
		1,
		(s) =>
			site(
				`${s.draw(testPathGen)}.${s.draw(oneOf(TABLES))}\`\n\ta | b\n\t\${1} | \${2}\n\`("case ${OWN}", ({ a, b }) => check(a, b))`,
				1
			)
	],
	[
		1,
		(s) =>
			site(
				`${s.draw(testPathGen)}.${s.draw(oneOf(TABLES))}Of([1, 2])("case ${OWN}", (row) => check(row))`,
				0
			)
	],
	[
		3,
		(s) => {
			const [declared, rows, writtenOut] = s.draw(rowsGen)
			const root = s.draw(oneOf(TEST_ROOTS))
			return s.draw(element([false, true] as const))
				? site(
						`${declared}${root}("case ${OWN}", () => {\n\tfor (const v of ${rows}) {\n\t\tcheck(v)\n\t}\n})`,
						writtenOut ? 1 : 0
					)
				: site(
						`${declared}${root}.effect("case ${OWN}", () =>\n\tEffect.gen(function* () {\n\t\tfor (const v of ${rows}) {\n\t\t\tyield* check(v)\n\t\t}\n\t})\n)`,
						writtenOut ? 1 : 0
					)
		}
	],
	[
		3,
		(s) => {
			const [declared, rows, writtenOut] = s.draw(rowsGen)
			const root = s.draw(oneOf(TEST_ROOTS))
			const loop = (indent: string) =>
				`${indent}for (const v of ${rows}) {\n${indent}\tyield* check(v)\n${indent}}`
			return site(
				`${declared}${s.draw(
					element([
						`${root}.effect("case ${OWN}", Effect.fn("case ${OWN}")(function* (ctx) {\n${loop("\t")}\n}))`,
						`const body${OWN} = Effect.fn("case ${OWN}")(function* (ctx) {\n${loop("\t")}\n})\n${root}.effect("case ${OWN}", body${OWN})`,
						`${root}.effect("case ${OWN}", () =>\n\tEffect.scoped(\n\t\tEffect.gen(function* () {\n${loop("\t\t\t")}\n\t\t})\n\t)\n)`,
						`${root}.effect("case ${OWN}", () =>\n\tEffect.gen(function* () {\n${loop("\t\t")}\n\t}).pipe(Effect.scoped)\n)`,
						`${root}("case ${OWN}", () => {\n\tconst ran${OWN} = Effect.runSync(\n\t\tEffect.gen(function* () {\n${loop("\t\t\t")}\n\t\t})\n\t)\n})`,
						`${root}("case ${OWN}", () => {\n\tEffect.runSync(\n\t\tEffect.gen(function* () {\n${loop("\t\t\t")}\n\t\t})\n\t)\n})`
					] as const)
				)}`,
				writtenOut ? 1 : 0
			)
		}
	],
	[
		1,
		constant(
			site(`const helper${OWN} = () => {\n\tfor (const v of [1, 2]) {\n\t\tcheck(v)\n\t}\n}`, 0)
		)
	],
	[
		1,
		constant(
			site(
				`const outside${OWN} = Effect.gen(function* () {\n\tfor (const v of [1, 2]) {\n\t\tyield* check(v)\n\t}\n})`,
				0
			)
		)
	],
	[
		1,
		(s) =>
			site(
				`${s.draw(oneOf(TEST_ROOTS))}("case ${OWN}", () => {\n\tconst run = () => {\n\t\tfor (const v of [1, 2]) {\n\t\t\tcheck(v)\n\t\t}\n\t}\n\trun()\n})`,
				0
			)
	]
])

/** A test's options: a retry, a concurrency that is not false, one that is, and a timeout, each kept or left by a draw. */
const optionsGen: Gen<readonly [written: string, refused: number]> = (source) => {
	const kept = source.draw(
		subset(
			[
				[`${RETRY}: 3`, 1],
				[`${CONCURRENT}: true`, 1],
				[`${CONCURRENT}: sometimes`, 1],
				[`${CONCURRENT}: false`, 0],
				["timeout: 1000", 0]
			] as const,
			{ min: 1, max: 3 }
		)
	)
	return [
		`{ ${Arr.join(
			Arr.map(kept, ([option]) => option),
			", "
		)} }`,
		Arr.reduce(kept, 0, (sum, [, refused]) => sum + refused)
	]
}

/** A flaky test, a test or a layer given drawn options, a concurrent modifier, and options of a call that runs no test. */
export const retrySites: Gen<Site> = weighted([
	[
		1,
		(s) =>
			site(
				`const checked${OWN} = ${s.draw(element(["", "it."] as const))}${FLAKY}(check, "5 seconds")`,
				1
			)
	],
	[
		3,
		(s) => {
			const [options, refused] = s.draw(optionsGen)
			const held = s.draw(element([false, true] as const))
			const passed = held ? `options${OWN}` : options
			const declared = held ? `const options${OWN} = ${options}\n` : ""
			return site(
				s.draw(element([false, true] as const))
					? `${declared}${s.draw(testPathGen)}("case ${OWN}", ${passed}, () => Effect.void)`
					: `${declared}${s.draw(testPathGen)}("case ${OWN}", () => Effect.void, ${passed})`,
				refused
			)
		}
	],
	[
		2,
		(s) => {
			const [options, refused] = s.draw(optionsGen)
			const layered = s.draw(oneOf(["it.layer", ...LAYERS]))
			return site(`${layered}(TodoLayer, ${options})("todos ${OWN}", (it) => {})`, refused)
		}
	],
	[
		1,
		(s) =>
			site(
				s.draw(element([false, true] as const))
					? `${s.draw(oneOf(TEST_ROOTS))}.${CONCURRENT}("case ${OWN}", () => {})`
					: `${s.draw(oneOf(TEST_ROOTS))}.${CONCURRENT}.each([1])("case ${OWN}", () => {})`,
				1
			)
	],
	[1, (s) => site(`const fibers${OWN} = Effect.forEach(tasks, run, ${s.draw(optionsGen)[0]})`, 0)]
])

/** The header of a test module's programs: the property constructors and a harness's, and no runner of Vitest's. */
const MODULE_HEADER = `import { family, property } from "@bjornpagen/testing/property"
import { deepStrictEqual } from "@bjornpagen/testing/assert"
import { Database } from "@bjornpagen/testing/resources"
import { aimedHarness } from "#test/support/harness.ts"
`

/** A property's spec as a test module writes it, its fields abridged to what the rule reads: none. */
const SPEC =
	"{ space: drawn, needs: {}, situations: [], check: () => () => Effect.void, kept: [], kills: [] }"

/** A module of the tests' own, or a vocabulary's, that an import names. */
const OWN_MODULES = ["#test/support/cases.ts", "@bjornpagen/testing/gen", "effect"] as const

/**
 * The top-level statements of a test module: an import (of a module of the tests, or of a runner of Vitest's), a type
 * declaration exported or not, an exported property (a constructor of `property`, a family, a harness's constructor,
 * several declarators) beside what a test module may not hold: an exported value that is no call, a suite or a test
 * of Vitest's called or exported, a const of its own, an exported let, a destructuring, a function, a re-export.
 */
const moduleSites: Gen<Site> = weighted([
	[2, (s) => site(`import { item${OWN} } from "${s.draw(element(OWN_MODULES))}"`, 0)],
	[
		2,
		(s) => {
			const module = s.draw(oneOf(VITEST_MODULES))
			return site(
				`import { it as it${OWN} } from "${s.draw(element([module, `${module}/utils`] as const))}"`,
				1
			)
		}
	],
	[
		2,
		(s) =>
			site(
				s.draw(
					element([
						`type Row${OWN} = readonly [number, string]`,
						`export type Row${OWN} = number`,
						`interface Shape${OWN} { readonly n: number }`,
						`export interface Shape${OWN} { readonly n: number }`
					] as const)
				),
				0
			)
	],
	[
		4,
		(s) =>
			site(
				s.draw(
					element([
						`export const p${OWN} = property.${s.draw(element(["explore", "exhaust", "batched", "interleave", "stateful"] as const))}(${SPEC})`,
						`export const f${OWN} = family({ one: property.explore(${SPEC}) })`,
						`export const h${OWN} = aimedHarness({ db: Database.fresh(template) })`,
						`export const a${OWN} = property.explore(${SPEC}), b${OWN} = aimedHarness({})`
					] as const)
				),
				0
			)
	],
	[
		3,
		(s) =>
			site(
				s.draw(
					element([
						`export const v${OWN} = 3`,
						`export const v${OWN} = [property.explore(${SPEC})]`,
						`export const t${OWN} = ${s.draw(oneOf(TEST_ROOTS))}("case ${OWN}", () => {})`,
						`export const t${OWN} = it.effect("case ${OWN}", () => Effect.void)`,
						`${s.draw(oneOf(TEST_ROOTS))}("case ${OWN}", () => {})`,
						`const p${OWN} = property.explore(${SPEC})`,
						`export let p${OWN} = property.explore(${SPEC})`,
						`export const { p${OWN} } = aimedHarness({})`,
						`export function make${OWN}() {\n\treturn property.explore(${SPEC})\n}`,
						`export { p as q${OWN} } from "#test/support/properties.ts"`,
						`export * from "#test/support/properties${OWN}.ts"`
					] as const)
				),
				1
			)
	]
])

/** Programs of a test module's statements, with a default export or without, which a module holds once at most. */
export const modulePrograms: Gen<Program> = (source) => {
	const program = source.draw(programOf(moduleSites))
	if (!source.draw(boolean)) {
		return program
	}
	const exported = site(`export default property.explore(${SPEC})`, 1)
	return {
		code: `${program.code}\n${exported.code}`,
		fixed: `${program.fixed}\n${exported.fixed}`,
		reports: program.reports + exported.reports,
		sites: Arr.append(program.sites, exported)
	}
}

/** A row's input, written. */
const INPUTS = ["1", '"a"', "-2", "[1, 2]"] as const

/** A verdict written into the test, and one computed. */
const WRITTEN = [
	"2",
	'"refused"',
	"true",
	"null",
	"undefined",
	"-1",
	"`done`",
	"[1]",
	"{ ok: true }"
] as const
const COMPUTED = ["model(input)", "String(input)", "reference.and", "[input]"] as const

/** Keys that are no verdict's, near the verdict keys. */
const NEAR_KEYS = ["output", "expectation", "result", "answers"] as const

/** Two rows or three of an object table, each `{ input, <key>: <verdict> }`, and whether every verdict is written. */
const objectRowsGen =
	(key: string): Gen<readonly [rows: string, written: boolean]> =>
	(source) => {
		const rows = source.draw(
			array(
				(row) => {
					const written = row.draw(boolean)
					return [
						`{ input: ${row.draw(element(INPUTS))}, ${key}: ${row.draw(element(written ? WRITTEN : COMPUTED))} }`,
						written
					] as const
				},
				{ min: 2, max: 3 }
			)
		)
		return [
			`[${Arr.join(
				Arr.map(rows, ([row]) => row),
				", "
			)}]`,
			Arr.every(rows, ([, written]) => written)
		]
	}

/** Two rows or three of a tuple table, the verdict last, and whether every verdict is written. */
const tupleRowsGen: Gen<readonly [rows: string, written: boolean]> = (source) => {
	const rows = source.draw(
		array(
			(row) => {
				const written = row.draw(boolean)
				return [
					`[${row.draw(element(INPUTS))}, ${row.draw(element(written ? WRITTEN : COMPUTED))}]`,
					written
				] as const
			},
			{ min: 2, max: 3 }
		)
	)
	return [
		`[${Arr.join(
			Arr.map(rows, ([row]) => row),
			", "
		)}]`,
		Arr.every(rows, ([, written]) => written)
	]
}

/**
 * Tables of a test: object rows under a verdict key or a near one, tuple rows declared under a type that labels the
 * last member with a verdict key (directly, through an alias, or by `satisfies`) or with another label or none, a list
 * of one row, and a table one of whose rows is no verdict row. A table is reported when every row writes its verdict.
 */
const verdictSites: Gen<Site> = weighted([
	[
		3,
		(s) => {
			const [rows, written] = s.draw(objectRowsGen(s.draw(oneOf(VERDICT_KEYS))))
			return site(`const rows${OWN} = ${rows}`, written ? 1 : 0)
		}
	],
	[1, (s) => site(`const rows${OWN} = ${s.draw(objectRowsGen(s.draw(element(NEAR_KEYS))))[0]}`, 0)],
	[
		3,
		(s) => {
			const [rows, written] = s.draw(tupleRowsGen)
			const verdict = s.draw(boolean)
			const label = verdict ? s.draw(oneOf(VERDICT_KEYS)) : s.draw(element(NEAR_KEYS))
			const tuple = `readonly [input: unknown, ${label}: unknown]`
			const declared = s.draw(
				element([
					`const rows${OWN}: ReadonlyArray<${tuple}> = ${rows}`,
					`type Row${OWN} = ${tuple}\nconst rows${OWN}: ReadonlyArray<Row${OWN}> = ${rows}`,
					`const rows${OWN} = ${rows} as const satisfies ReadonlyArray<${tuple}>`
				] as const)
			)
			return site(declared, verdict && written ? 1 : 0)
		}
	],
	[1, (s) => site(`const rows${OWN} = ${s.draw(tupleRowsGen)[0]}`, 0)],
	[
		1,
		(s) =>
			site(
				`const rows${OWN} = [{ input: 1, ${s.draw(oneOf(VERDICT_KEYS))}: ${s.draw(element(WRITTEN))} }]`,
				0
			)
	],
	[
		1,
		(s) =>
			site(
				`const rows${OWN} = [{ input: 1, ${s.draw(oneOf(VERDICT_KEYS))}: 2 }, { input: 2, total: 3 }]`,
				0
			)
	]
])

/**
 * Programs of verdict tables, in a module that is no dictionary door or in one: a door imports the dictionary's mint
 * (by name or the whole module), and its lists are vocabularies, so none of its sites is reported. A module that
 * imports another name of the dictionary's module is no door.
 */
export const verdictPrograms: Gen<Program> = (source) => {
	const program = source.draw(programOf(verdictSites))
	const module = source.draw(oneOf(DICTIONARY_MODULES))
	const door = source.draw(
		element([
			{ line: "", door: false },
			{ line: `import { ${DICTIONARY_MINT} } from "${module}"\n`, door: true },
			{ line: `import * as vocabulary from "${module}"\n`, door: true },
			{ line: `import { word } from "${module}"\n`, door: false }
		] as const)
	)
	const sites = door.door ? Arr.map(program.sites, (s) => ({ ...s, reports: 0 })) : program.sites
	return {
		code: `${door.line}${program.code}`,
		fixed: `${door.line}${program.fixed}`,
		reports: Arr.reduce(sites, 0, (sum, s) => sum + s.reports),
		sites
	}
}

/** An options object's other properties, before or after the width. */
const OTHER_OPTIONS = ["discard: true", 'suite: "s"', "runs: 3"] as const

/**
 * Widths stated in an options object: the default width written out (by name or by string key, alone, first, last or
 * between others, on one line or on several, the object handed last or alone), which the fix deletes with its comma,
 * beside a width that is not the default (a larger number, "unbounded", a name, an expression).
 */
export const concurrencySites: Gen<Site> = weighted([
	[
		3,
		(s) => {
			const key = s.draw(element([CONCURRENCY, `"${CONCURRENCY}"`] as const))
			const width = `${key}: ${String(DEFAULT_WIDTH)}`
			const before = s.draw(subset(OTHER_OPTIONS, { min: 0, max: 2 }))
			const after = s.draw(subset(OTHER_OPTIONS, { min: 0, max: 2 }))
			const others = [...before, ...after]
			const multiline = s.draw(boolean)
			const separator = multiline ? ",\n\t" : ", "
			const [open, close] = multiline ? ["{\n\t", "\n}"] : ["{ ", " }"]
			const options = `${open}${Arr.join([...before, width, ...after], separator)}${close}`
			if (!Arr.isReadonlyArrayNonEmpty(others)) {
				return s.draw(boolean)
					? fixedSite(
							`const r${OWN} = Effect.forEach(items, run, ${options})`,
							1,
							`const r${OWN} = Effect.forEach(items, run)`
						)
					: fixedSite(
							`const r${OWN} = configure(${options})`,
							1,
							`const r${OWN} = configure(${open}${close})`
						)
			}
			return fixedSite(
				`const r${OWN} = Effect.forEach(items, run, ${options})`,
				1,
				`const r${OWN} = Effect.forEach(items, run, ${open}${Arr.join(others, separator)}${close})`
			)
		}
	],
	[
		2,
		(s) =>
			site(
				`const r${OWN} = Effect.forEach(items, run, { ${CONCURRENCY}: ${s.draw(element(["4", '"unbounded"', "width", `${String(DEFAULT_WIDTH)} + 1`, `"${String(DEFAULT_WIDTH)}"`] as const))} })`,
				0
			)
	]
])

/** One case of a rule's property: the imports a program starts from, and the program. */
export type RuleCase = Readonly<{
	header: string
	program: Program
	filename: Option.Option<string>
}>

/** A Vitest config's timeout as its test block may state it, or leave it out: the literal 0, a finite one, Infinity, a
 * name bound to 0, or none at all. */
const CONFIG_TIMEOUTS = element(["absent", "0", "60_000", "Infinity", "bound"] as const)

/** A Vitest configuration file's name, at the root or in a package, as VITEST_CONFIGS globs them. */
const CONFIG_FILES = element([
	"vitest.config.ts",
	"vite.config.mts",
	"packages/a/vitest.unit.config.ts",
	"vitest.workspace.ts"
] as const)

/**
 * A Vitest config's test block, an include beside it or not and each of testTimeout and hookTimeout drawn
 * (CONFIG_TIMEOUTS): reported once for the keys it leaves out, which the fix adds as `0` before its first property,
 * and once for each key stated as anything but the literal 0, which the fix writes as `0`.
 */
const vitestConfigSites: Gen<Site> = (s) => {
	const include = s.draw(boolean)
	const drawn = Arr.map(VITEST_TIMEOUTS, (key) => [key, s.draw(CONFIG_TIMEOUTS)] as const)
	const stated = Arr.filter(drawn, ([, value]) => value !== "absent")
	const missing = Arr.filter(drawn, ([, value]) => value === "absent")
	const kept = include ? ['include: ["a"]'] : []
	const props = [
		...kept,
		...Arr.map(stated, ([key, value]) => `${key}: ${value === "bound" ? `unbounded${OWN}` : value}`)
	]
	const fixedProps = [...kept, ...Arr.map(stated, ([key]) => `${key}: 0`)]
	const written = Arr.map(missing, ([key]) => `${key}: 0`)
	const block = (properties: ReadonlyArray<string>): string =>
		Arr.isReadonlyArrayEmpty(properties) ? "{}" : `{ ${Arr.join(properties, ", ")} }`
	const binding = Arr.some(stated, ([, value]) => value === "bound")
		? `const unbounded${OWN} = 0\n`
		: ""
	return fixedSite(
		`${binding}export const config${OWN} = { test: ${block(props)} }`,
		(Arr.isReadonlyArrayEmpty(missing) ? 0 : 1) +
			Arr.filter(stated, ([, value]) => value !== "0").length,
		`${binding}export const config${OWN} = { test: ${block([...written, ...fixedProps])} }`
	)
}

/** Programs of a Vitest configuration file, of one drawn name. */
const inVitestConfigs =
	(programs: Gen<Program>): Space<RuleCase> =>
	(source) => ({
		header: "",
		program: source.draw(programs),
		filename: Option.some(source.draw(CONFIG_FILES))
	})

/** Programs of a test's body, after the imports of one drawn header. */
export const inTests =
	(programs: Gen<Program>): Space<RuleCase> =>
	(source) => ({
		header: source.draw(HEADERS),
		program: source.draw(programs),
		filename: Option.none()
	})

/** Programs of a test module's top level, after the header of a module of properties. */
export const inModule =
	(programs: Gen<Program>): Space<RuleCase> =>
	(source) => ({ header: MODULE_HEADER, program: source.draw(programs), filename: Option.none() })

/** The clock rule's programs: a test's body, and a Vitest configuration file's test blocks. */
export const clockCases: Space<RuleCase> = weighted([
	[3, inTests(programOf(clockSites))],
	[1, inVitestConfigs(programOf(vitestConfigSites))]
])

/**
 * A rule's property: programs of its grammar after a header, each judged by RuleTester against the reports and the
 * fixes its contract gives, every site noted as reported or left alone, and a program of several sites noted as such.
 */
export const ruleProperty = (
	name: RuleName,
	space: Space<RuleCase>,
	kills: ReadonlyArray<Kill>
): Property =>
	property.explore(space, {
		needs: {},
		situations: ["a site reported", "a site left alone", "a program of several sites"],
		check:
			(_resources, c) =>
			({ header, program, filename }) =>
				Effect.sync(() => {
					for (const s of program.sites) {
						c.note(s.reports > 0 ? "a site reported" : "a site left alone")
					}
					if (program.sites.length > 1) {
						c.note("a program of several sites")
					}
					assert.deepEqual(judged(name, header, program, filename), Option.none())
				}),
		oracle: {
			kind: "specification",
			name: `${name}'s stated contract over the names and shapes its module exports`
		},
		kept: [],
		kills
	})

/** A kill a stale-kill case's test module states: of the checkout's one target file or of a file it does not hold, and the original it names. */
export type CaseKill = Readonly<{ held: boolean; original: string }>

/**
 * A stale-kill case: the text of a checkout's one target file, a few parts over an alphabet whose originals overlap
 * (mutants.fixtures.ts killCase's), and the kills a test module of the checkout states, each over that file or over one
 * the checkout does not hold.
 */
export type StaleKillCase = Readonly<{
	parts: ReadonlyArray<string>
	kills: ReadonlyArray<CaseKill>
}>

export const staleKillCases: Gen<StaleKillCase> = (source) => ({
	parts: source.draw(array(element(["x", "y", "xy", " "]), { min: 0, max: 6 })),
	kills: source.draw(
		array(
			(s): CaseKill => ({
				held: s.draw(
					weighted([
						[4, constant(true)],
						[1, constant(false)]
					])
				),
				original: s.draw(element(["x", "xy", "yx"]))
			}),
			{ min: 1, max: 3 }
		)
	)
})

/** The target file a case's kills name where they name the one the checkout holds, and the one they name where not. */
const TARGET = "src/target.ts"
const ABSENT = "src/absent.ts"

/** The test module a case's kills stand in, beside the target. */
const MODULE = "src/module.test.ts"

/**
 * What oxlint's RuleTester makes of a case's test module under no-stale-kill, in a checkout of its own (a directory
 * holding `.git` and the case's target file): none when the rule reports exactly the kills `stale` says, each under its
 * message, else what the tester threw.
 */
export const staleKillJudged = (c: StaleKillCase, stale: (kill: CaseKill) => boolean) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const checkout = yield* fs.makeTempDirectoryScoped({ prefix: "toolchain-stale-kill-" })
		yield* fs.makeDirectory(path.join(checkout, ".git"))
		yield* fs.makeDirectory(path.join(checkout, "src"))
		yield* fs.writeFileString(path.join(checkout, TARGET), Arr.join(c.parts, ""))
		const code = `export const kills = [\n${Arr.join(
			Arr.map(
				c.kills,
				(kill) =>
					`\t{ file: "${kill.held ? TARGET : ABSENT}", original: "${kill.original}", replacement: "z", why: "w" }`
			),
			",\n"
		)}\n]\n`
		const filename = path.join(checkout, MODULE)
		const reports = Arr.filter(c.kills, stale).length
		const ran = Result.try(() =>
			new RuleTester({ languageOptions: LANGUAGE }).run(
				"no-stale-kill",
				plugin.rules["no-stale-kill"],
				reports === 0
					? { valid: [{ code, filename }], invalid: [] }
					: {
							valid: [],
							invalid: [
								{
									code,
									filename,
									errors: Array.from({ length: reports }, () => ({ messageId: "stale" }))
								}
							]
						}
			)
		)
		return Result.match(ran, {
			onSuccess: () => Option.none<string>(),
			onFailure: (failure) => Option.some(Formatter.format(failure))
		})
	})
