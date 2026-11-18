import { Array as Arr, Option, String as Str } from "effect"

const WHITESPACE: ReadonlyArray<string> = [" ", "\t", "\n", "\r", "\f", "\v"]

export const isWhitespace = (character: string): boolean => Arr.contains(WHITESPACE, character)

const DIGITS: ReadonlyArray<string> = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]

const isDigit = (character: string): boolean => Arr.contains(DIGITS, character)

const isLetter = (character: string): boolean =>
	(character >= "a" && character <= "z") || (character >= "A" && character <= "Z")

/** A character of a regular-expression word: a letter, a digit or an underscore. */
const isWordCharacter = (character: string): boolean =>
	isLetter(character) || isDigit(character) || character === "_"

const isHexDigit = (character: string): boolean =>
	isDigit(character) ||
	(character >= "a" && character <= "f") ||
	(character >= "A" && character <= "F")

/** The character at an index, when the text has one there. */
const characterAt = (text: string, index: number): Option.Option<string> =>
	index < 0 ? Option.none() : Str.charAt(index)(text)

const characterIs = (text: string, index: number, test: (character: string) => boolean): boolean =>
	Option.exists(characterAt(text, index), test)

/** The words of a whitespace-separated string, each with its offset in the string. */
export const wordsOf = (
	text: string
): ReadonlyArray<Readonly<{ word: string; offset: number }>> => {
	const words: Array<Readonly<{ word: string; offset: number }>> = []
	let word = ""
	let start = 0
	let offset = 0
	for (const character of text) {
		if (isWhitespace(character)) {
			if (word !== "") {
				words.push({ word, offset: start })
			}
			word = ""
		} else {
			start = word === "" ? offset : start
			word = `${word}${character}`
		}
		offset += character.length
	}
	return word === "" ? words : [...words, { word, offset: start }]
}

/** Every index at which `needle` starts in the text, left to right, overlapping occurrences included. */
const occurrencesOf = (text: string, needle: string): ReadonlyArray<number> =>
	Arr.unfold(0, (from) =>
		Option.map(
			Str.indexOf(needle)(Str.slice(from)(text)),
			(found) => [from + found, from + found + 1] as const
		)
	)

/** CSS text as comparisons read it: runs of whitespace are one space, and whitespace just inside a parenthesis,
 * where a formatter breaks a long value or query, is not part of it. */
export const compact = (text: string): string => {
	const collapsed = Arr.join(
		Arr.map(wordsOf(text), ({ word }) => word),
		" "
	)
	return Str.replaceAll(" )", ")")(Str.replaceAll("( ", "(")(collapsed))
}

/** A literal color in CSS text: a hex color, or a color function such as rgb(), hsl() or oklch(). */
const COLOR_FUNCTIONS: ReadonlyArray<string> = [
	"rgb",
	"rgba",
	"hsl",
	"hsla",
	"oklch",
	"oklab",
	"lch",
	"lab",
	"color"
]

const hexRunAt = (text: string, start: number): number => {
	let length = 0
	while (characterIs(text, start + length, isHexDigit)) {
		length += 1
	}
	return length
}

const isHexColorAt = (text: string, index: number): boolean => {
	const run = hexRunAt(text, index + 1)
	return run >= 3 && run <= 8 && !characterIs(text, index + 1 + run, isWordCharacter)
}

export const hasLiteralColor = (text: string): boolean =>
	Arr.some(occurrencesOf(text, "#"), (index) => isHexColorAt(text, index)) ||
	Arr.some(COLOR_FUNCTIONS, (name) =>
		Arr.some(
			occurrencesOf(text, `${name}(`),
			(index) => !characterIs(text, index - 1, isWordCharacter)
		)
	)

/** Digits and dots, at least one: a plain number, without sign or unit. */
const isPlainNumber = (text: string): boolean =>
	Str.isNonEmpty(text) &&
	Arr.every(Arr.fromIterable(text), (character) => isDigit(character) || character === ".")

/** `oklch(L C H)` or `oklch(L C H / A)`, every channel a plain number and the alpha optionally a percentage. */
export const isColorValue = (text: string): boolean => {
	if (!Str.startsWith("oklch(")(text) || !Str.endsWith(")")(text)) {
		return false
	}
	const [channels, alpha, ...rest] = Str.split(" / ")(Str.slice("oklch(".length, -1)(text))
	const parts = Str.split(" ")(channels)
	const alphaIsNumber =
		alpha === undefined || isPlainNumber(Str.endsWith("%")(alpha) ? Str.slice(0, -1)(alpha) : alpha)
	return (
		parts.length === 3 &&
		Arr.every(parts, isPlainNumber) &&
		alphaIsNumber &&
		!Arr.isReadonlyArrayNonEmpty(rest)
	)
}

/** Where a node of a stylesheet starts, 1-based. */
export type CssPosition = Readonly<{ line: number; column: number }>

/** A node of an authored stylesheet. An at-rule written as a statement (`@import "x";`) holds no nodes. Comments are
 * not kept. Recursive, so its type is declared. */
export type CssNode =
	| Readonly<{ kind: "rule"; selector: string; nodes: ReadonlyArray<CssNode>; at: CssPosition }>
	| Readonly<{
			kind: "at-rule"
			name: string
			params: string
			nodes: ReadonlyArray<CssNode>
			at: CssPosition
	  }>
	| Readonly<{ kind: "declaration"; property: string; value: string; at: CssPosition }>

/** What ends a stretch of stylesheet text: a block's opening or closing brace, a semicolon, or the end. */
type Terminator = "open" | "semicolon" | "close" | "end"

/** The text before a terminator, with where its first character that is no whitespace stands. */
type Segment = Readonly<{ text: string; terminator: Terminator; at: CssPosition }>

const TERMINATORS: ReadonlyMap<string, Terminator> = new Map([
	["{", "open"],
	[";", "semicolon"],
	["}", "close"]
])

/** Cuts a stylesheet at its structural characters: braces and semicolons outside strings, comments, parentheses and
 * brackets. Comments are dropped. */
const segmentsOf = (text: string): ReadonlyArray<Segment> => {
	const segments: Array<Segment> = []
	let buffer = ""
	let start: Option.Option<CssPosition> = Option.none()
	let line = 1
	let column = 1
	let depth = 0
	let quote: Option.Option<string> = Option.none()
	let escaped = false
	let comment = false
	let previous = ""
	for (const character of text) {
		const here = { line, column }
		if (comment) {
			comment = !(previous === "*" && character === "/")
			previous = comment ? character : ""
		} else if (Option.isSome(quote)) {
			buffer = `${buffer}${character}`
			const closes = !escaped && character === quote.value
			escaped = !escaped && character === "\\"
			quote = closes ? Option.none() : quote
			previous = character
		} else if (character === "*" && previous === "/") {
			comment = true
			buffer = Str.slice(0, -1)(buffer)
			start = Str.isNonEmpty(Str.trim(buffer)) ? start : Option.none()
			previous = ""
		} else {
			const terminator = depth === 0 ? TERMINATORS.get(character) : undefined
			if (terminator === undefined) {
				depth += character === "(" || character === "[" ? 1 : 0
				depth -= (character === ")" || character === "]") && depth > 0 ? 1 : 0
				quote = character === '"' || character === "'" ? Option.some(character) : Option.none()
				start = Option.isNone(start) && !isWhitespace(character) ? Option.some(here) : start
				buffer = `${buffer}${character}`
			} else {
				segments.push({ text: buffer, terminator, at: Option.getOrElse(start, () => here) })
				buffer = ""
				start = Option.none()
			}
			previous = character
		}
		line += character === "\n" ? 1 : 0
		column = character === "\n" ? 1 : column + 1
	}
	return [
		...segments,
		{ text: buffer, terminator: "end", at: Option.getOrElse(start, () => ({ line, column })) }
	]
}

const isNameCharacter = (character: string): boolean =>
	!isWhitespace(character) && character !== "("

/** A statement or block head that starts with `@`: its name and its params. */
const atRuleHeadOf = (prelude: string): Readonly<{ name: string; params: string }> => {
	const rest = Str.slice(1)(prelude)
	const name = Arr.join(Arr.takeWhile(Arr.fromIterable(rest), isNameCharacter), "")
	return { name, params: Str.trim(Str.slice(name.length)(rest)) }
}

const statementOf = (prelude: string, at: CssPosition): CssNode => {
	if (Str.startsWith("@")(prelude)) {
		return { kind: "at-rule", ...atRuleHeadOf(prelude), nodes: [], at }
	}
	return Option.match(Str.indexOf(":")(prelude), {
		onNone: (): CssNode => ({ kind: "declaration", property: prelude, value: "", at }),
		onSome: (index): CssNode => ({
			kind: "declaration",
			property: Str.trim(Str.slice(0, index)(prelude)),
			value: Str.trim(Str.slice(index + 1)(prelude)),
			at
		})
	})
}

/** The nodes of one block, from a segment to the one that closes it, and the index after it. */
const nodesFrom = (
	segments: ReadonlyArray<Segment>,
	from: number
): Readonly<{ nodes: ReadonlyArray<CssNode>; next: number }> => {
	const nodes: Array<CssNode> = []
	let index = from
	let segment = Arr.get(segments, index)
	while (Option.isSome(segment)) {
		const { terminator, at } = segment.value
		const prelude = Str.trim(segment.value.text)
		index += 1
		if (terminator === "open") {
			const inner = nodesFrom(segments, index)
			index = inner.next
			nodes.push(
				Str.startsWith("@")(prelude)
					? { kind: "at-rule", ...atRuleHeadOf(prelude), nodes: inner.nodes, at }
					: { kind: "rule", selector: prelude, nodes: inner.nodes, at }
			)
		} else {
			if (Str.isNonEmpty(prelude)) {
				nodes.push(statementOf(prelude, at))
			}
			if (terminator !== "semicolon") {
				return { nodes, next: index }
			}
		}
		segment = Arr.get(segments, index)
	}
	return { nodes, next: index }
}

/** Parses an authored stylesheet into its rules, at-rules and declarations; a stray closing brace is skipped. */
export const parseStylesheet = (text: string): ReadonlyArray<CssNode> => {
	const segments = segmentsOf(text)
	const parsed: Array<CssNode> = []
	let index = 0
	while (index < segments.length) {
		const block = nodesFrom(segments, index)
		for (const node of block.nodes) {
			parsed.push(node)
		}
		index = block.next
	}
	return parsed
}

/** A selector list's selectors, split at its top-level commas and trimmed. */
export const selectorsOf = (selector: string): ReadonlyArray<string> => {
	const selectors: Array<string> = []
	let current = ""
	let depth = 0
	let quote: Option.Option<string> = Option.none()
	for (const character of selector) {
		if (Option.isSome(quote)) {
			quote = character === quote.value ? Option.none() : quote
			current = `${current}${character}`
		} else if (character === "," && depth === 0) {
			selectors.push(Str.trim(current))
			current = ""
		} else {
			depth += character === "(" || character === "[" ? 1 : 0
			depth -= (character === ")" || character === "]") && depth > 0 ? 1 : 0
			quote = character === '"' || character === "'" ? Option.some(character) : Option.none()
			current = `${current}${character}`
		}
	}
	return Arr.filter([...selectors, Str.trim(current)], Str.isNonEmpty)
}

/** How a complex selector steps from one compound to the next: into the subtree before it (descendant, child) or
 * across to a sibling (next, subsequent). */
type Combinator = "descendant" | "child" | "next-sibling" | "subsequent-sibling"

const COMBINATORS: ReadonlyMap<string, Combinator> = new Map([
	[">", "child"],
	["+", "next-sibling"],
	["~", "subsequent-sibling"]
])

/** One compound of a complex selector, with the combinator that leads to it: none for the first compound, unless the
 * selector is relative (`> span`, nested or inside `:has()`). */
export type SelectorStep = Readonly<{ combinator: Option.Option<Combinator>; compound: string }>

/** A complex selector's compounds, left to right, each with the combinator that leads to it. */
export const stepsOf = (selector: string): ReadonlyArray<SelectorStep> => {
	const steps: Array<SelectorStep> = []
	let compound = ""
	let combinator: Option.Option<Combinator> = Option.none()
	let depth = 0
	let quote: Option.Option<string> = Option.none()
	for (const character of selector) {
		const explicit = depth === 0 && Option.isNone(quote) ? COMBINATORS.get(character) : undefined
		const breaks = depth === 0 && Option.isNone(quote) && isWhitespace(character)
		if (explicit !== undefined || breaks) {
			if (Str.isNonEmpty(compound)) {
				steps.push({ combinator, compound })
				compound = ""
				combinator = Option.some("descendant")
			}
			combinator = explicit === undefined ? combinator : Option.some(explicit)
		} else {
			if (Option.isSome(quote)) {
				quote = character === quote.value ? Option.none() : quote
			} else {
				depth += character === "(" || character === "[" ? 1 : 0
				depth -= (character === ")" || character === "]") && depth > 0 ? 1 : 0
				quote = character === '"' || character === "'" ? Option.some(character) : Option.none()
			}
			compound = `${compound}${character}`
		}
	}
	return Str.isNonEmpty(compound) ? [...steps, { combinator, compound }] : steps
}

/** One attribute selector: the attribute's name and, when it matches a value, the operator, the value unquoted and
 * the case flag. */
export type AttributeSelector = Readonly<{
	name: string
	match: Option.Option<Readonly<{ operator: string; value: string; flag: Option.Option<string> }>>
}>

/** One simple selector of a compound: an attribute selector, a pseudo-class or pseudo-element with its argument, the
 * nesting selector `&`, or a type, class, id or universal selector. */
type SimpleSelector =
	| Readonly<{ kind: "attribute"; attribute: AttributeSelector }>
	| Readonly<{ kind: "pseudo"; name: string; argument: Option.Option<string> }>
	| Readonly<{ kind: "nesting" }>
	| Readonly<{ kind: "other"; text: string }>

const ATTRIBUTE_OPERATORS: ReadonlyArray<string> = ["~=", "|=", "^=", "$=", "*=", "="]

const isAttributeNameCharacter = (character: string): boolean =>
	!isWhitespace(character) && !Arr.contains(["~", "|", "^", "$", "*", "="], character)

/** A quoted value's text, unescaped, and what follows its closing quote. */
const quotedOf = (text: string, quote: string): Readonly<{ value: string; rest: string }> => {
	let value = ""
	let rest = ""
	let place: "value" | "escaped" | "after" = "value"
	for (const character of Str.slice(1)(text)) {
		if (place === "after") {
			rest = `${rest}${character}`
		} else if (place === "escaped") {
			value = `${value}${character}`
			place = "value"
		} else if (character === "\\") {
			place = "escaped"
		} else if (character === quote) {
			place = "after"
		} else {
			value = `${value}${character}`
		}
	}
	return { value, rest: Str.trim(rest) }
}

/** An unquoted value, up to whitespace, and what follows it. */
const unquotedOf = (text: string): Readonly<{ value: string; rest: string }> => {
	const value = Arr.join(
		Arr.takeWhile(Arr.fromIterable(text), (character) => !isWhitespace(character)),
		""
	)
	return { value, rest: Str.trim(Str.slice(value.length)(text)) }
}

/** An attribute selector from the text between its brackets. */
const attributeOf = (inner: string): AttributeSelector => {
	const trimmed = Str.trim(inner)
	const name = Arr.join(Arr.takeWhile(Arr.fromIterable(trimmed), isAttributeNameCharacter), "")
	const rest = Str.trim(Str.slice(name.length)(trimmed))
	return {
		name,
		match: Option.map(
			Arr.findFirst(ATTRIBUTE_OPERATORS, (operator) => Str.startsWith(operator)(rest)),
			(operator) => {
				const operand = Str.trim(Str.slice(operator.length)(rest))
				const opening = Str.charAt(0)(operand)
				const quoted = Option.filter(opening, (character) => character === '"' || character === "'")
				const { value, rest: after } = Option.match(quoted, {
					onNone: () => unquotedOf(operand),
					onSome: (quote) => quotedOf(operand, quote)
				})
				return {
					operator,
					value,
					flag: Str.isNonEmpty(after) ? Option.some(after) : Option.none()
				}
			}
		)
	}
}

const PIECE_STARTS: ReadonlyArray<string> = ["[", ":", "&", ".", "#"]

/** A compound's simple selectors as written, each starting where the one before ends. */
const piecesOf = (compound: string): ReadonlyArray<string> => {
	const pieces: Array<string> = []
	let piece = ""
	let depth = 0
	let quote: Option.Option<string> = Option.none()
	for (const character of compound) {
		if (Option.isSome(quote)) {
			quote = character === quote.value ? Option.none() : quote
		} else {
			const starts =
				depth === 0 &&
				Arr.contains(PIECE_STARTS, character) &&
				!(character === ":" && piece === ":")
			if (starts && Str.isNonEmpty(piece)) {
				pieces.push(piece)
				piece = ""
			}
			depth += character === "(" || character === "[" ? 1 : 0
			depth -= (character === ")" || character === "]") && depth > 0 ? 1 : 0
			quote = character === '"' || character === "'" ? Option.some(character) : Option.none()
		}
		piece = `${piece}${character}`
	}
	return Str.isNonEmpty(piece) ? [...pieces, piece] : pieces
}

const simpleOf = (piece: string): SimpleSelector => {
	if (Str.startsWith("[")(piece)) {
		return {
			kind: "attribute",
			attribute: attributeOf(Str.slice(1, Str.endsWith("]")(piece) ? -1 : piece.length)(piece))
		}
	}
	if (Str.startsWith(":")(piece)) {
		return Option.match(Str.indexOf("(")(piece), {
			onNone: (): SimpleSelector => ({ kind: "pseudo", name: piece, argument: Option.none() }),
			onSome: (open): SimpleSelector => ({
				kind: "pseudo",
				name: Str.slice(0, open)(piece),
				argument: Option.some(
					Str.slice(open + 1, Str.endsWith(")")(piece) ? -1 : piece.length)(piece)
				)
			})
		})
	}
	return piece === "&" ? { kind: "nesting" } : { kind: "other", text: piece }
}

/** A compound's simple selectors, left to right. */
export const simpleSelectorsOf = (compound: string): ReadonlyArray<SimpleSelector> =>
	Arr.map(piecesOf(compound), simpleOf)

/** Every attribute selector a selector holds, at any depth: inside `:is()`, `:where()`, `:not()` and `:has()` too. */
export const attributeSelectorsOf = (selector: string): ReadonlyArray<AttributeSelector> =>
	Arr.flatMap(selectorsOf(selector), (complex) =>
		Arr.flatMap(stepsOf(complex), (step) =>
			Arr.flatMap(simpleSelectorsOf(step.compound), (simple) => {
				switch (simple.kind) {
					case "attribute":
						return [simple.attribute]
					case "pseudo":
						return Option.match(simple.argument, {
							onNone: () => [],
							onSome: attributeSelectorsOf
						})
					case "nesting":
					case "other":
						return []
				}
			})
		)
	)
