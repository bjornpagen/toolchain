import { Array as Arr, Schema, String as Str } from "effect"
import { isDrizzleSqlTemplate } from "#oxlint/drizzle.ts"
import { configured, isFileAt } from "#oxlint/rule.ts"

/** The source directories, by repository-relative path, whose Drizzle `sql` templates write no cast as text, and the
 * modules there that may: a Drizzle repository's cast leaves. */
const Options = Schema.Struct({
	sources: Schema.Array(Schema.String),
	writers: Schema.Array(Schema.String)
})

/** The report, naming the writers a cast belongs in. */
const messageOf = (writers: ReadonlyArray<string>): string =>
	`This Drizzle \`sql\` template holds a \`::\` cast as SQL text spells it, outside any quoted SQL string, identifier or comment. A cast is written as text only by this rule's writers (${Arr.isReadonlyArrayNonEmpty(writers) ? Arr.join(writers, ", ") : "none in this repository"}): print the SQL from an AST, or call a typed cast function of a cast leaf.`

/** The position after the quote that closes a quoted run opened before `from`: a doubled quote is the quote itself. */
const closing = (text: string, from: number, quote: string): number => {
	let at = from
	while (at < text.length) {
		if (text[at] === quote) {
			if (text[at + 1] !== quote) {
				return at + 1
			}
			at += 2
		} else {
			at += 1
		}
	}
	return text.length
}

/** The position after a block comment opened before `from`: block comments nest. */
const commentEnd = (text: string, from: number): number => {
	let depth = 1
	let at = from
	while (at < text.length && depth > 0) {
		if (text[at] === "/" && text[at + 1] === "*") {
			depth += 1
			at += 2
		} else if (text[at] === "*" && text[at + 1] === "/") {
			depth -= 1
			at += 2
		} else {
			at += 1
		}
	}
	return at
}

const isTagStart = (ch: string | undefined): boolean =>
	ch !== undefined && ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_")

const isTagPart = (ch: string | undefined): boolean =>
	isTagStart(ch) || (ch !== undefined && ch >= "0" && ch <= "9")

/** The length of the dollar-quote tag opening at `at`, `$$` or `$tag$`; 0 where a `$` opens no quote, as a
 * parameter's does. */
const dollarTagLength = (text: string, at: number): number => {
	if (text[at + 1] === "$") {
		return 2
	}
	if (!isTagStart(text[at + 1])) {
		return 0
	}
	let end = at + 1
	while (isTagPart(text[end])) {
		end += 1
	}
	return text[end] === "$" ? end + 1 - at : 0
}

/** Whether the `length` characters at `at` are the ones at `from`. */
const sameRun = (text: string, at: number, from: number, length: number): boolean => {
	for (let i = 0; i < length; i++) {
		if (text[at + i] !== text[from + i]) {
			return false
		}
	}
	return true
}

/** The position after the tag that closes a dollar-quoted body whose `length`-character tag opens at `open`. */
const dollarEnd = (text: string, open: number, length: number): number => {
	for (let at = open + length; at < text.length; at++) {
		if (text[at] === "$" && sameRun(text, at, open, length)) {
			return at + length
		}
	}
	return text.length
}

/** The position after the line a line comment at `from` ends. */
const lineEnd = (text: string, from: number): number => {
	for (let at = from; at < text.length; at++) {
		if (text[at] === "\n") {
			return at + 1
		}
	}
	return text.length
}

/**
 * Whether `text`, read as SQL as PostgreSQL's scanner reads it, holds a `::` token: outside its quoted strings and
 * identifiers, its dollar-quoted bodies and its comments.
 */
const holdsCast = (text: string): boolean => {
	let at = 0
	while (at < text.length) {
		const ch = text[at]
		const next = text[at + 1]
		const tag = ch === "$" ? dollarTagLength(text, at) : 0
		if (ch === "'" || ch === '"') {
			at = closing(text, at + 1, ch)
		} else if (ch === "-" && next === "-") {
			at = lineEnd(text, at + 2)
		} else if (ch === "/" && next === "*") {
			at = commentEnd(text, at + 2)
		} else if (tag > 0) {
			at = dollarEnd(text, at, tag)
		} else if (ch === ":" && next === ":") {
			return true
		} else {
			at += 1
		}
	}
	return false
}

/** Whether a file lies in one of the directories, at a "/" boundary. */
const isUnder = (filename: string, directories: ReadonlyArray<string>): boolean =>
	Arr.some(
		directories,
		(directory) =>
			Str.startsWith(`${directory}/`)(filename) || Str.includes(`/${directory}/`)(filename)
	)

/**
 * A cast written as SQL text in a source: a Drizzle `sql` template (its tag imported from drizzle-orm) whose text, as
 * Drizzle sends it, its interpolations standing for one neutral character each, holds a `::` as PostgreSQL's scanner
 * reads it. A cast is written only by the writers: a Drizzle repository renders one only in its cast leaves, which hold
 * the PostgreSQL type registry and its typed cast functions. Only the templates are read, never a string literal or
 * an untagged template, so a `::` in a regular expression, an ARN or prose is no SQL. The rule is the core's, since
 * every kind of repository runs it; one with no SQL lists no sources.
 */
export const noRawSql = configured(Options, (context, options) => {
	if (
		!isUnder(context.filename, options.sources) ||
		Arr.some(options.writers, (writer) => isFileAt(context.filename, writer))
	) {
		return {}
	}
	const message = messageOf(options.writers)
	return {
		TaggedTemplateExpression: (node) => {
			if (
				holdsCast(
					Arr.join(
						Arr.map(node.quasi.quasis, (q) => q.value.cooked ?? q.value.raw),
						"0"
					)
				) &&
				isDrizzleSqlTemplate(context, node)
			) {
				context.report({ node, message })
			}
		}
	}
})
