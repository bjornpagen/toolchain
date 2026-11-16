import { regex } from "arkregex"
import { Array as Arr, Option, Result, String as Str } from "effect"
import type { Parsed } from "#codemod/syntax.ts"

/** A line of a JSDoc block that starts a plant citation: the plant tag, or prose naming plants. */
const PLANT_START = regex("^\\s*\\*\\s*(?:@plant\\b|(?:-\\s+)?Plants?\\b)")

/** A line that ends the paragraph above it: a blank JSDoc line, a list item, a tag, or the block's end. */
const PARAGRAPH_END = regex("^\\s*\\*\\s*$|^\\s*\\*\\s*-\\s|^\\s*\\*\\s*@|^\\s*\\*/\\s*$")

/** A blank line of a JSDoc block. */
const BLANK = regex("^\\s*\\*\\s*$")

/** The last line of a JSDoc block. */
const CLOSING = regex("^\\s*\\*/\\s*$")

/** A JSDoc block with nothing in it. */
const EMPTY = regex("^/\\*[\\s*]*/$")

/** A JSDoc line's margin, the star and a space after it. */
const MARGIN = regex("^\\s*\\*\\s?")

/** What a JSDoc walk keeps, what it removed, and whether it is inside a plant citation. */
type PlantWalk = Readonly<{
	kept: ReadonlyArray<string>
	removed: ReadonlyArray<string>
	inPlant: boolean
}>

/**
 * A JSDoc block with its plant citations removed: each plant tag and each paragraph or list item that names plants, to its
 * end. The plants become kills elsewhere; what was removed is kept for the report, so the lane that writes kills reads
 * which property cited which plant.
 */
const withoutPlants = (
	header: string
): Readonly<{ header: string; removed: ReadonlyArray<string> }> => {
	const lines = Str.split(header, "\n")
	const walked = Arr.reduce(
		lines,
		{ kept: [], removed: [], inPlant: false },
		(state: PlantWalk, line): PlantWalk => {
			const starts = PLANT_START.test(line)
			const inPlant = starts || (state.inPlant && !PARAGRAPH_END.test(line))
			return inPlant
				? { ...state, removed: [...state.removed, line], inPlant }
				: { ...state, kept: [...state.kept, line], inPlant }
		}
	)
	const collapsed = Arr.filter(walked.kept, (line, i) => {
		const next = walked.kept[i + 1]
		return !(BLANK.test(line) && next !== undefined && (BLANK.test(next) || CLOSING.test(next)))
	})
	const text = Arr.join(collapsed, "\n")
	return {
		header: EMPTY.test(text) ? "" : text,
		removed: Arr.map(walked.removed, (line) => Str.trim(Str.replace(MARGIN, "")(line)))
	}
}

/** A module's header: the comments before its first statement. */
export const headerOf = (parsed: Parsed): string =>
	Option.match(Arr.head(parsed.tree.statements), {
		onNone: () => "",
		onSome: (first) => Str.trim(Str.slice(0, first.getStart(parsed.tree))(parsed.text))
	})

/** A JSDoc block, anywhere in a module. */
const JSDOC = regex("/\\*\\*[\\s\\S]*?\\*/", "g")

/**
 * A module's text with the plant citations of every JSDoc block removed (its header's, its declarations'), and a block
 * that cited nothing else removed whole, with what was removed for the report.
 */
export const withoutPlantsIn = (
	text: string
): Readonly<{ text: string; removed: ReadonlyArray<string> }> => {
	const blocks = Arr.filterMap(Arr.fromIterable(Str.matchAll(JSDOC)(text)), (match) =>
		match.index === undefined
			? Result.failVoid
			: Result.succeed({ start: match.index, block: match[0] })
	)
	return Arr.reduceRight(
		blocks,
		{ text, removed: Arr.empty<string>() },
		(acc: Readonly<{ text: string; removed: ReadonlyArray<string> }>, { start, block }) => {
			const end = start + block.length
			const cleaned = withoutPlants(block)
			if (!Arr.isReadonlyArrayNonEmpty(cleaned.removed)) {
				return acc
			}
			const after = Str.slice(end)(acc.text)
			const rest = Str.isEmpty(cleaned.header) ? Str.replace(LEADING_NEWLINE, "")(after) : after
			return {
				text: `${Str.slice(0, start)(acc.text)}${cleaned.header}${rest}`,
				removed: [...cleaned.removed, ...acc.removed]
			}
		}
	)
}

/** The line break right after a removed block. */
const LEADING_NEWLINE = regex("^[ \t]*\n")
