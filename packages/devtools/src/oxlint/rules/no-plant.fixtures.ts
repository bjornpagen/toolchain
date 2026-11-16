import {
	array,
	characterOf,
	codePoint,
	element,
	type Gen,
	oneOf,
	string,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Formatter, Option, Result, String as Str } from "effect"
import { RuleTester } from "oxlint/plugins-dev"
import { noPlant, PLANT_HEADERS, PLANT_TAG } from "#oxlint/rules/no-plant.ts"

/**
 * The programs the no-plant property draws (no-plant.test.ts), from a grammar of the rule's contract read over the tag
 * and headers its module exports, and what oxlint's RuleTester makes of one: comments that cite a plant (the tag as a
 * word anywhere on a line, a line that begins past its lead with a prose header), written as a JSDoc block, a block or
 * a line comment, beside comments that cite none (a longer word that begins with the tag or a header, a header in the
 * middle of a line, a plant spoken of in prose).
 */

/** What a comment is, as the property names its situations. */
export type Feature =
	| "a tag cited"
	| "a prose header cited"
	| "a comment that cites none"
	| "a program of several comments"

/** How a comment is written: a JSDoc block, a block, or one line comment. */
type Form = "jsdoc" | "block" | "line"

const forms: Gen<Form> = element(["jsdoc", "block", "line"] as const)

/** One comment: the lines it says, how it is written, the reports the contract gives it, and what it is. */
type Said = Readonly<{ lines: ReadonlyArray<string>; form: Form; reports: number; kind: Feature }>

/** Prose a comment says around a citation, or none. */
const prose: Gen<string> = element([
	"",
	"the gate refuses a dangling reference",
	"a mutant the suite kills",
	"a plant is a kill now"
] as const)

/**
 * A character that continues a word, so a name it follows is longer than the tag or header before it: a letter of
 * either case, a digit, or a joiner.
 */
const wordCharacter: Gen<string> = oneOf<string>([
	codePoint(0x61, 0x7a),
	codePoint(0x41, 0x5a),
	codePoint(0x30, 0x39),
	characterOf(["-", "_"])
])

/** What follows a cited tag: a character that ends a word (or the line's end), then what the citation says. */
const afterTag: Gen<string> = (source) =>
	`${source.draw(element(["", " ", ":", "(", ".", ","] as const))}${source.draw(element(["", " plants/x.patch breaks it", " a.patch"] as const))}`

const tagLine: Gen<string> = (source) =>
	`${source.draw(prose)} ${PLANT_TAG}${source.draw(afterTag)}`

const headerLine: Gen<string> = (source) =>
	`${source.draw(element(PLANT_HEADERS))}${source.draw(element([" (~/.cache/plants): a.patch", ", each applied and reverted:", " a.patch"] as const))}`

/**
 * A stem the rule reads as a word: the tag, or a header without the colon that ends it, so a word that begins with one
 * and goes on is drawn for every header.
 */
const stems: Gen<string> = element([
	PLANT_TAG,
	...Arr.map(PLANT_HEADERS, (header) => Arr.headNonEmpty(Str.split(":")(header)))
])

/**
 * A line that holds a near word and cites nothing: a longer word that begins with the tag or a header (two word
 * characters more, so no stem with one more character is itself a header), a header in the middle of a line, or prose
 * alone.
 */
const nearLine: Gen<string> = oneOf<string>([
	(source) =>
		`${source.draw(stems)}${source.draw(string(wordCharacter, { min: 2, max: 4 }))} ${source.draw(prose)}`,
	(source) => `The ${source.draw(element(PLANT_HEADERS))} header is gone`,
	prose
])

const said: Gen<Said> = weighted([
	[
		3,
		(source): Said => ({
			lines: [source.draw(tagLine)],
			form: source.draw(forms),
			reports: 1,
			kind: "a tag cited"
		})
	],
	[
		3,
		(source): Said => ({
			lines: [source.draw(headerLine)],
			form: source.draw(forms),
			reports: 1,
			kind: "a prose header cited"
		})
	],
	[
		4,
		(source): Said => ({
			lines: source.draw(array(nearLine, { min: 1, max: 3 })),
			form: source.draw(forms),
			reports: 0,
			kind: "a comment that cites none"
		})
	]
])

/** A comment as written: a JSDoc block, a block or a line comment per line, around what it says. */
const written = (one: Said, at: number): string => {
	const declaration = `export const value${String(at)} = ${String(at)}`
	switch (one.form) {
		case "jsdoc":
			return `/**\n${Arr.join(
				Arr.map(one.lines, (line) => ` * ${line}`),
				"\n"
			)}\n */\n${declaration}`
		case "block":
			return `/* ${Arr.join(one.lines, "\n   ")} */\n${declaration}`
		case "line":
			return `// ${Arr.join(one.lines, " ")}\n${declaration}`
	}
}

/** A program: its text, the reports the contract gives it, and its comments. */
export type Program = Readonly<{ code: string; reports: number; comments: ReadonlyArray<Said> }>

export const programs: Gen<Program> = (source) => {
	const comments = source.draw(array(said, { min: 1, max: 3 }))
	return {
		code: Arr.join(Arr.map(comments, written), "\n"),
		reports: Arr.reduce(comments, 0, (sum, one) => sum + one.reports),
		comments
	}
}

/** The situations a program reaches: each comment's kind, and several comments. */
export const featuresOf = (program: Program): ReadonlyArray<Feature> => [
	...Arr.map(program.comments, (one) => one.kind),
	...(program.comments.length > 1 ? (["a program of several comments"] as const) : [])
]

const LANGUAGE = { sourceType: "module", parserOptions: { lang: "ts" } } as const

/** What RuleTester makes of a program: none when the rule reports it exactly as often as the contract says, else
 * RuleTester's failure. */
export const judged = (program: Program): Option.Option<string> => {
	const code = `${program.code}\n`
	const ran = Result.try(() =>
		new RuleTester({ languageOptions: LANGUAGE }).run(
			"no-plant",
			noPlant,
			program.reports === 0
				? { valid: [{ code }], invalid: [] }
				: { valid: [], invalid: [{ code, errors: program.reports }] }
		)
	)
	return Result.match(ran, {
		onSuccess: () => Option.none(),
		onFailure: (failure) => Option.some(Formatter.format(failure))
	})
}
