import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, element, type Gen, weighted } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
/**
 * The no-plant rule (src/oxlint/rules/no-plant.ts), searched over programs of one comment or several, drawn from a
 * grammar of its contract: a comment that cites a plant (the tag as a word anywhere on a line, a line that begins past
 * its lead with a prose header), written as a JSDoc block, a block or a line comment, beside comments that cite none
 * (a longer word that begins with the tag or a header, a header in the middle of a line, a plant spoken of in prose).
 * Every comment carries the reports the contract gives it, one for a citation and none else, and oxlint's RuleTester,
 * run in the case, must find exactly that many.
 *
 * Oracle: the specification, the rule's JSDoc read over the tag and headers its module exports (PLANT_TAG,
 * PLANT_HEADERS). Features: a tag cited, a prose header cited, a comment that cites none, a program of several comments.
 */
import { describe, it } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { Array as Arr, Duration, Effect, Formatter, Option, Result } from "effect"
import { RuleTester } from "oxlint/plugins-dev"
import { noPlant, PLANT_HEADERS, PLANT_TAG } from "#oxlint/rules/no-plant.ts"

type Feature =
	| "a tag cited"
	| "a prose header cited"
	| "a comment that cites none"
	| "a program of several comments"

/** How a comment is written: a JSDoc block, a block, or one line comment. */
type Form = "jsdoc" | "block" | "line"

const forms: Gen<Form> = element(["jsdoc", "block", "line"] as const)

/** One comment: the lines it says, how it is written, the reports the contract gives it, and what it is. */
type Said = Readonly<{ lines: ReadonlyArray<string>; form: Form; reports: number; kind: Feature }>

/** Prose a comment says around a citation. */
const PROSE = ["the gate refuses a dangling reference", "a mutant the suite kills", ""] as const

const tagLine: Gen<string> = (source) =>
	`${source.draw(element(PROSE))} ${PLANT_TAG}${source.draw(element([" plants/x.patch breaks it", "", ": a.patch"] as const))}`

const headerLine: Gen<string> = (source) => {
	const header = source.draw(element(PLANT_HEADERS))
	return `${header}${source.draw(element([" (~/.cache/plants): a.patch", ", each applied and reverted:", " a.patch"] as const))}`
}

/** A line that holds a near word: a longer word that begins with the tag or a header, or a header mid-line. */
const nearLine: Gen<string> = (source) =>
	source.draw(
		element([
			`${PLANT_TAG}s are gone`,
			`${PLANT_TAG}ed rules stay`,
			`${PLANT_TAG}_name holds`,
			"Plantsy says",
			"Planted rules, each a kill",
			"PlantsKept are none",
			`The ${Arr.headNonEmpty(PLANT_HEADERS)} header is gone`,
			"a plant is a kill now",
			""
		] as const)
	)

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

type Program = Readonly<{ code: string; reports: number; comments: ReadonlyArray<Said> }>

const programs: Gen<Program> = (source) => {
	const comments = source.draw(array(said, { min: 1, max: 3 }))
	return {
		code: Arr.join(Arr.map(comments, written), "\n"),
		reports: Arr.reduce(comments, 0, (sum, one) => sum + one.reports),
		comments
	}
}

RuleTester.describe = (_text, fn) => fn()
RuleTester.it = (_text, fn) => fn()

const LANGUAGE = { sourceType: "module", parserOptions: { lang: "ts" } } as const

/** What RuleTester makes of a program: none when the rule reports it exactly `reports` times. */
const judged = (code: string, reports: number): Option.Option<string> => {
	const ran = Result.try(() =>
		new RuleTester({ languageOptions: LANGUAGE }).run(
			"no-plant",
			noPlant,
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

describe("no-plant", () => {
	it.effect("reports exactly the comments that cite a plant", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "oxlint/no-plant",
					oracle: {
						kind: "specification",
						name: "the rule's stated contract over the tag and prose headers its module exports"
					},
					draw: drawn(programs),
					literal: Formatter.format,
					coverage: required<Feature>(
						[
							"a tag cited",
							"a prose header cited",
							"a comment that cites none",
							"a program of several comments"
						],
						{ cases: 200, sense: notesOnly }
					),
					kept: [],
					runs: 200,
					shrink: completeShrink,
					steerEvery: 16,
					caseHang: Duration.minutes(1)
				},
				(program, c) =>
					Effect.sync(() => {
						for (const one of program.comments) {
							c.note(one.kind)
						}
						if (program.comments.length > 1) {
							c.note("a program of several comments")
						}
						deepStrictEqual(judged(`${program.code}\n`, program.reports), Option.none())
					})
			)
		)
	)
})
