import { Array as Arr, Option } from "effect"
import { array, element } from "#gen.ts"

/**
 * What the syntax-diagnostics property (syntax.test.ts) draws: a module of statements, each one line ending in its
 * semicolon, and by the specification whether TypeScript's parser refuses it.
 */

/** A statement and whether it parses as a .ts file's. */
export type Statement = Readonly<{ text: string; parses: boolean }>

/** Every statement the property draws from. */
const statements: Arr.NonEmptyReadonlyArray<Statement> = [
	{ text: "const a = 1;", parses: true },
	{ text: "const b = <number>(a);", parses: true },
	{ text: "const d: string = 1;", parses: true },
	{ text: "function f(x: number): number { return x; }", parses: true },
	{ text: "type T = { readonly a: string };", parses: true },
	{ text: "const = 1;", parses: false },
	{ text: "let x = ;", parses: false },
	{ text: "g(1, ;", parses: false },
	{ text: "const s = 'abc", parses: false }
]

/** A module of one to six statements. */
export const modules = array(element(statements), { min: 1, max: 6 })

/** A module's text: its statements, a line each. */
export const textOf = (module: ReadonlyArray<Statement>): string =>
	Arr.join(
		Arr.map(module, (statement) => `${statement.text}\n`),
		""
	)

/**
 * Where the module's first refused statement lies in its text, its first code unit to its last line's end, inclusive:
 * none when every statement parses. Every statement before it is whole, so the parser's first error lies inside it.
 */
export const firstRefusedOf = (
	module: ReadonlyArray<Statement>
): Option.Option<Readonly<{ start: number; end: number }>> =>
	Option.map(
		Arr.findFirstIndex(module, (statement) => !statement.parses),
		(at) => {
			const start = textOf(Arr.take(module, at)).length
			return { start, end: start + Arr.getUnsafe(module, at).text.length }
		}
	)

/** What a drawn module reaches, each a note of the property's. */
export type Situation =
	| "a module that parses"
	| "a type error, which is no syntax error"
	| "a type assertion, which a .tsx file refuses"
	| "a syntax error"
	| "a syntax error after statements that parse"

/** The situations `module` reaches. */
export const situationsOf = (module: ReadonlyArray<Statement>): ReadonlyArray<Situation> => {
	const refused = firstRefusedOf(module)
	const reached: ReadonlyArray<readonly [Situation, boolean]> = [
		["a module that parses", Option.isNone(refused)],
		[
			"a type error, which is no syntax error",
			Arr.some(module, (statement) => statement.text === "const d: string = 1;")
		],
		[
			"a type assertion, which a .tsx file refuses",
			Option.isNone(refused) &&
				Arr.some(module, (statement) => statement.text === "const b = <number>(a);")
		],
		["a syntax error", Option.isSome(refused)],
		["a syntax error after statements that parse", Option.exists(refused, (lies) => lies.start > 0)]
	]
	return Arr.flatMap(reached, ([situation, holds]) => (holds ? [situation] : []))
}
