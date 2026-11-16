import { Array as Arr, String as Str } from "effect"
import { withoutLead } from "#oxlint/comments.ts"
import { type Comment, problem } from "#oxlint/rule.ts"

/** The tag a comment cited a plant with, the word plant after an at sign, then its patch and what it breaks. */
export const PLANT_TAG = "@plant"

/** The prose headers a comment cited plants under: `Plants (…): …`, `Plants, each applied …`, `Plant: …`. */
export const PLANT_HEADERS: Arr.NonEmptyReadonlyArray<string> = ["Plants", "Plant:"]

/** The characters besides letters that continue a word: a name's digits and joiners. */
const WORD_MARKS: ReadonlyArray<string> = [
	"0",
	"1",
	"2",
	"3",
	"4",
	"5",
	"6",
	"7",
	"8",
	"9",
	"-",
	"_"
]

/** Whether a character continues a word, so a name it follows is longer than the one looked for: a letter (a character
 * with two cases) or a word mark. */
const isWordCharacter = (character: string): boolean => {
	const lower: string = Str.toLowerCase(character)
	return lower !== Str.toUpperCase(character) || Arr.contains(WORD_MARKS, character)
}

/** Whether a text begins with a word: the word, and no word character after it. */
const beginsWithWord = (text: string, word: string): boolean =>
	Str.startsWith(word)(text) && !isWordCharacter(Str.slice(word.length, word.length + 1)(text))

/** Whether a line cites a plant: it holds the tag as a word anywhere (some text past an occurrence of the tag begins
 * with no word character), or begins, past its lead, with a prose header. */
const citesPlant = (line: string): boolean =>
	Arr.some(
		Arr.drop(Str.split(PLANT_TAG)(line), 1),
		(after) => !isWordCharacter(Str.slice(0, 1)(after))
	) ||
	Arr.some(PLANT_HEADERS, (header) =>
		Str.endsWith(":")(header)
			? Str.startsWith(header)(withoutLead(line))
			: beginsWithWord(withoutLead(line), header)
	)

const isPlantCitation = (comment: Comment): boolean =>
	comment.type !== "Shebang" && Arr.some(Str.split("\n")(comment.value), citesPlant)

/**
 * A plant cited in a comment, in every file: the plant tag (PLANT_TAG), or a prose header that begins a comment's line with
 * `Plants` or `Plant:`. Plants, hand patches a runner applies to the working tree, are gone: a bug a property must
 * catch is a kill on that property (`kills: [{ file, original, replacement, why }]`), which the runner applies and
 * gates, and a comment that cites one documents what nothing checks.
 */
export const noPlant = problem((context) => ({
	Program: () => {
		for (const comment of context.sourceCode.getAllComments()) {
			if (isPlantCitation(comment)) {
				context.report({
					node: comment,
					message:
						"This comment cites a plant. Plants are gone: state the bug as a kill on the property that must catch it (`kills: [{ file, original, replacement, why }]`), which the runner applies and gates, and delete the citation."
				})
			}
		}
	}
}))
