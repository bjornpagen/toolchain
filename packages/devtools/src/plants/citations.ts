import { Array as Arr, Option, String as Str } from "effect"

/**
 * Where every plant lives, from the repository's root: plants/<suite>/<name>.patch, <suite> the directory of the first
 * test that cites it with packages/ and src/ dropped, so packages/testing/src/vitest/adapter.test.ts cites plants under
 * plants/testing/vitest/. A plant is a patch that breaks the code on purpose, and the tests citing it must turn red
 * while it is applied.
 */
export const plantRoot = "plants/"

/** The suffix every plant's name ends with. */
const PATCH = ".patch"

/** A lower-case letter or a digit, the characters a segment of a plant's path opens with. */
const isOpening = (char: string): boolean =>
	(char >= "a" && char <= "z") || (char >= "0" && char <= "9")

/** A character a segment of a plant's path may carry after its first: a letter, a digit, a dot, a dash or an underscore. */
const isSpelling = (char: string): boolean =>
	isOpening(char) || char === "." || char === "-" || char === "_"

/** A segment of a plant's path: a lower-case letter or a digit, then letters, digits, dots, dashes and underscores. */
const isSegment = (segment: string): boolean =>
	Arr.match(Arr.fromIterable(segment), {
		onEmpty: () => false,
		onNonEmpty: ([first, ...rest]) => isOpening(first) && Arr.every(rest, isSpelling)
	})

/**
 * A plant's path as a citation must spell it: under plantRoot, segments that start with a lower-case letter or a digit
 * (so none is `.` or `..`, and none is empty), the last a name ending .patch.
 */
const isPlantPath = (word: string): boolean =>
	Str.startsWith(plantRoot)(word) &&
	Arr.match(Str.split("/")(Str.slice(plantRoot.length)(word)), {
		onEmpty: () => false,
		onNonEmpty: (segments) => {
			const name = Arr.lastNonEmpty(segments)
			return (
				Arr.every(Arr.initNonEmpty(segments), isSegment) &&
				Str.endsWith(PATCH)(name) &&
				isSegment(Str.slice(0, name.length - PATCH.length)(name))
			)
		}
	})

/** A test's citation of one plant: the plant's path, the bug the plant introduces, and the line its tag starts on. */
export interface Citation {
	readonly plant: string
	readonly bug: string
	readonly line: number
}

/** A plant tag the check cannot read: one whose first word is no plant path, or that names no bug. */
export interface Malformed {
	readonly line: number
	readonly text: string
}

/** What one file's comments say about plants: the citations its tags make, and the tags that make none. */
export interface Reading {
	readonly citations: ReadonlyArray<Citation>
	readonly malformed: ReadonlyArray<Malformed>
}

/** What a JSDoc line carries after its marker: its text, without the comment's close, and whether it closes. */
interface Carried {
	readonly text: string
	readonly closed: boolean
}

/** A JSDoc line's text after its marker, read for the comment's close at its end. */
const carriedOf = (text: string): Carried => {
	const trimmed = Str.trimEnd(text)
	return Str.endsWith("*/")(trimmed)
		? { text: Str.trim(Str.slice(0, -"*/".length)(trimmed)), closed: true }
		: { text: Str.trim(trimmed), closed: false }
}

/** The tag a plant citation opens with. */
const TAG = "@plant"

/**
 * A plant tag's line: a JSDoc line (` * @plant …`) or a one-line JSDoc's opening (`/** @plant …`) whose text opens with
 * the tag, followed by white space, the comment's close or nothing; what follows the tag, and whether the line closes
 * the comment.
 */
const tagOf = (line: string): Option.Option<Carried> => {
	const text = Str.trimStart(line)
	const marked = Str.startsWith("/**")(text)
		? Option.some(Str.slice("/**".length)(text))
		: Str.startsWith("*")(text)
			? Option.some(Str.slice("*".length)(text))
			: Option.none()
	return Option.flatMap(
		Option.filter(Option.map(marked, Str.trimStart), Str.startsWith(TAG)),
		(opened) => {
			const after = Str.slice(TAG.length)(opened)
			return Str.isEmpty(after) || Str.isEmpty(Str.trim(Str.slice(0, 1)(after)))
				? Option.some(carriedOf(after))
				: Str.trimEnd(after) === "*/"
					? Option.some({ text: "", closed: true })
					: Option.none()
		}
	)
}

/**
 * A line that carries on the tag above it: a JSDoc line (` * …`) whose marker white space follows, holding text that
 * opens no other tag; what it carries, and whether it closes the comment.
 */
const continuationOf = (line: string): Option.Option<Carried> => {
	const text = Str.trimStart(line)
	const rest = Str.slice("*".length)(text)
	const spaced = Str.startsWith("*")(text) && Str.isEmpty(Str.trim(Str.slice(0, 1)(rest)))
	const body = Str.trimStart(rest)
	return spaced && Str.isNonEmpty(rest) && Str.isNonEmpty(body) && !Str.startsWith("@")(body)
		? Option.some(carriedOf(body))
		: Option.none()
}

/** The words of a text: its runs of characters between white space, as JavaScript's trim reads white space. */
const wordsOf = (text: string): ReadonlyArray<string> =>
	Arr.filter(
		Str.split(" ")(
			Arr.join(
				Arr.map(Arr.fromIterable(text), (char) => (Str.isEmpty(Str.trim(char)) ? " " : char)),
				""
			)
		),
		Str.isNonEmpty
	)

/** A tag being read: where it starts, what it says, the text of its bug so far, and whether its comment has closed. */
interface Open {
	readonly line: number
	readonly text: string
	readonly words: ReadonlyArray<string>
	readonly closed: boolean
}

/** A tag's words once read: a citation when its first word is a plant path and some bug follows it. */
const settled = (open: Open): Reading => {
	const [first = "", ...rest] = Arr.flatMap(open.words, wordsOf)
	return isPlantPath(first) && Arr.isReadonlyArrayNonEmpty(rest)
		? { citations: [{ plant: first, bug: Arr.join(rest, " "), line: open.line }], malformed: [] }
		: { citations: [], malformed: [{ line: open.line, text: open.text }] }
}

/** Two readings, one after the other. */
const joined = (a: Reading, b: Reading): Reading => ({
	citations: Arr.appendAll(a.citations, b.citations),
	malformed: Arr.appendAll(a.malformed, b.malformed)
})

/** The state of the walk over a file's lines: what is read so far, and the tag still open. */
interface Walk {
	readonly read: Reading
	readonly open: Option.Option<Open>
}

/** What a walk has read once its open tag, if any, is settled. */
const closedOut = (walk: Walk): Reading =>
	Option.match(walk.open, {
		onNone: () => walk.read,
		onSome: (open) => joined(walk.read, settled(open))
	})

/** One line's step: it opens a tag, carries on the open one, or settles it. */
const step = (walk: Walk, line: string, index: number): Walk =>
	Option.match(tagOf(line), {
		onSome: (tag) => ({
			read: closedOut(walk),
			open: Option.some({
				line: index + 1,
				text: Str.trim(line),
				words: [tag.text],
				closed: tag.closed
			})
		}),
		onNone: () =>
			Option.match(
				Option.flatMap(
					Option.filter(walk.open, (open) => !open.closed),
					(open) =>
						Option.map(continuationOf(line), (more) => ({
							...open,
							words: Arr.append(open.words, more.text),
							closed: more.closed
						}))
				),
				{
					onNone: () => ({ read: closedOut(walk), open: Option.none() }),
					onSome: (open) => ({ read: walk.read, open: Option.some(open) })
				}
			)
	})

/**
 * What a file's text says about plants. A citation is a JSDoc block tag, the tag's name and then the plant's path from
 * the repository's root, under plants/ and ending .patch, then the bug the plant introduces, which may carry on over
 * the JSDoc lines below it until a blank line, another tag or the comment's close. A tag whose first word is no such
 * path, or that names no bug, is malformed.
 */
export const readingOf = (text: string): Reading => {
	const start: Walk = { read: { citations: [], malformed: [] }, open: Option.none() }
	return closedOut(Arr.reduce(Str.split("\n")(text), start, step))
}
