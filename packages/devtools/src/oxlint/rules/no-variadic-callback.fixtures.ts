/**
 * What no-variadic-callback.test.ts reads: its box of calls, each a callee handing an argument a builtin, and what
 * oxlint's RuleTester makes of one.
 */
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Formatter, Option, Result } from "effect"
import { RuleTester } from "oxlint/plugins-dev"
import { noVariadicCallback } from "#oxlint/rules/no-variadic-callback.ts"

/** A callee a case hands its builtin to, by whether it passes its callback more than the element. */
export type Callee =
	| "an array's reduce"
	| "an array's map"
	| "Effect's Arr.reduce"
	| "a namespace import of effect/Array"
	| "a function imported from effect/Array"
	| "a function passing exactly its arguments"
	| "a method named map on another receiver"

/** A builtin a case hands its callee: three that read past their first argument, one that does not. */
export type Builtin =
	| "Math.max"
	| "Number.parseInt"
	| "parseInt"
	| "String.fromCharCode"
	| "Math.abs"

/** A case: a callee, the builtin handed to it, and whether a binding of the builtin's holder shadows the global. */
export interface CallCase {
	readonly callee: Callee
	readonly builtin: Builtin
	readonly shadowed: boolean
}

const CALLEES = [
	"an array's reduce",
	"an array's map",
	"Effect's Arr.reduce",
	"a namespace import of effect/Array",
	"a function imported from effect/Array",
	"a function passing exactly its arguments",
	"a method named map on another receiver"
] as const satisfies ReadonlyArray<Callee>

const BUILTINS = [
	"Math.max",
	"Number.parseInt",
	"parseInt",
	"String.fromCharCode",
	"Math.abs"
] as const satisfies ReadonlyArray<Builtin>

/** Every case of the box: each callee, each builtin, each shadowed or not. */
const CALL_CASES: Arr.NonEmptyReadonlyArray<CallCase> = Arr.flatMap(CALLEES, (callee) =>
	Arr.flatMap(BUILTINS, (builtin) =>
		Arr.map([false, true] as const, (shadowed): CallCase => ({ callee, builtin, shadowed }))
	)
)

export const callCases: Gen<CallCase> = (source) => source.draw(element(CALL_CASES))

/**
 * The callees the rule reads as passing their callback more than the element (its JSDoc): every method of a passing
 * name, whatever its receiver, since the syntax shows no receiver's type (Effect's Option.map passes the value alone,
 * and a lambda costs it nothing), and every function of Effect's Array module.
 */
const PASSING: ReadonlySet<Callee> = new Set([
	"an array's reduce",
	"an array's map",
	"Effect's Arr.reduce",
	"a namespace import of effect/Array",
	"a function imported from effect/Array",
	"a method named map on another receiver"
])

/** The builtins that read past their first argument (the rule's JSDoc). */
const READING: ReadonlySet<Builtin> = new Set([
	"Math.max",
	"Number.parseInt",
	"parseInt",
	"String.fromCharCode"
])

/** The reports the contract gives a case: one where a passing callee is handed a reading builtin no binding shadows. */
const reportsOf = (c: CallCase): number =>
	PASSING.has(c.callee) && READING.has(c.builtin) && !c.shadowed ? 1 : 0

/** The call a case writes, handing `b` to its callee. */
const callOf = (callee: Callee, b: string): string => {
	switch (callee) {
		case "an array's reduce":
			return `xs.reduce(${b}, 0)`
		case "an array's map":
			return `xs.map(${b})`
		case "Effect's Arr.reduce":
			return `Arr.reduce(xs, 0, ${b})`
		case "a namespace import of effect/Array":
			return `A.map(xs, ${b})`
		case "a function imported from effect/Array":
			return `reduce(xs, 0, ${b})`
		case "a function passing exactly its arguments":
			return `fold(${b})`
		case "a method named map on another receiver":
			return `Option.map(Option.some(1), ${b})`
	}
}

/** The binding a shadowed case declares of its builtin's holder: the global's name, a parameter of the case's function. */
const HOLDERS: Readonly<Record<Builtin, string>> = {
	"Math.max": "Math",
	"Number.parseInt": "Number",
	parseInt: "parseInt",
	"String.fromCharCode": "String",
	"Math.abs": "Math"
}

const HEADER = Arr.join(
	[
		'import { Array as Arr, Option } from "effect"',
		'import * as A from "effect/Array"',
		'import { reduce } from "effect/Array"',
		"declare const xs: ReadonlyArray<number>",
		"declare const fold: (f: (a: number, b: number) => number) => number",
		""
	],
	"\n"
)

/** The module a case is: its call, at the top level, or inside a function whose parameter shadows the holder. */
const codeOf = (c: CallCase): string => {
	const call = callOf(c.callee, c.builtin)
	return c.shadowed
		? `${HEADER}export const f = (${HOLDERS[c.builtin]}: never) => ${call}\n`
		: `${HEADER}export const v = ${call}\n`
}

const LANGUAGE = { sourceType: "module", parserOptions: { lang: "ts" } } as const

/** What RuleTester makes of a case: none when the rule reports it exactly as often as the contract says, else its failure. */
export const judged = (c: CallCase): Option.Option<string> => {
	const code = codeOf(c)
	const reports = reportsOf(c)
	const ran = Result.try(() =>
		new RuleTester({ languageOptions: LANGUAGE }).run(
			"no-variadic-callback",
			noVariadicCallback,
			reports === 0
				? { valid: [{ code }], invalid: [] }
				: { valid: [], invalid: [{ code, errors: reports }] }
		)
	)
	return Result.match(ran, {
		onSuccess: () => Option.none(),
		onFailure: (failure) => Option.some(Formatter.format(failure))
	})
}

/** The situations a case reaches. */
export type CallFeature =
	| "a passing callee handed a reading builtin"
	| "a callee passing exactly its arguments"
	| "a builtin of one argument"
	| "a shadowed holder"

export const featuresOf = (c: CallCase): ReadonlyArray<CallFeature> => [
	...(PASSING.has(c.callee) && READING.has(c.builtin) && !c.shadowed
		? (["a passing callee handed a reading builtin"] as const)
		: []),
	...(PASSING.has(c.callee) ? [] : (["a callee passing exactly its arguments"] as const)),
	...(READING.has(c.builtin) ? [] : (["a builtin of one argument"] as const)),
	...(c.shadowed ? (["a shadowed holder"] as const) : [])
]
