import { Array as Arr, Option, String as Str } from "effect"
import type { Comment } from "#oxlint/rule.ts"

const LEADING_TRIVIA: ReadonlyArray<string> = [" ", "\t", "\r", "\n", "*"]

/** Where a text's leading spaces, line breaks and asterisks end, looking from `at`. */
const leadEnd = (text: string, at: number): number =>
	Option.exists(Str.charAt(text, at), (character) => Arr.contains(LEADING_TRIVIA, character))
		? leadEnd(text, at + 1)
		: at

/** A text without its leading spaces, line breaks and asterisks: what a comment line says past its decoration; a
 * comment's lead is its value without them. It reads the lead and slices the rest, never splitting the text into
 * characters and joining them back, which was a tenth of grizzle's root lint (2.5 of 25 s on its one JS thread). */
export const withoutLead = (text: string): string => Str.slice(leadEnd(text, 0))(text)

/** The directives that switch a check off at the comment's place: a linter's, Effect's and fallow's. */
const SUPPRESSIONS: ReadonlyArray<string> = [
	"oxlint-disable",
	"oxlint-enable",
	"eslint-disable",
	"eslint-enable",
	"@effect-diagnostics",
	"fallow-ignore"
]

/** A comment any of whose lines begins, past its leading spaces and asterisks, with a suppression directive. */
export const isSuppression = (comment: Comment): boolean =>
	Arr.some(Str.split("\n")(comment.value), (line) => {
		const said = withoutLead(line)
		return Arr.some(SUPPRESSIONS, (directive) => Str.startsWith(directive)(said))
	})
