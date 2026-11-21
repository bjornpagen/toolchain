import { Option, String as Str } from "effect"
import { type AnyNode, problem } from "#oxlint/rule.ts"

const isLower = (character: string): boolean => character >= "a" && character <= "z"

const isUpper = (character: string): boolean => character >= "A" && character <= "Z"

const isDigit = (character: string): boolean => character >= "0" && character <= "9"

/** The character of `text` at `at`, or "" before its start or past its end. */
const characterAt = (text: string, at: number): string =>
	at < 0 ? "" : Str.slice(at, at + 1)(text)

/**
 * Whether a word of `text` begins at `at`: at the text's start, after a character that is no ASCII letter or digit
 * (`pg_catalog.md5`, `Content-MD5`), at an upper-case letter after a lower-case one or a digit (`computeMd5`), or at an
 * upper-case letter after an upper-case one that a lower-case one follows (`HMACMd5`); never inside a word (`cmd5`).
 */
const beginsWord = (text: string, at: number): boolean => {
	const before = characterAt(text, at - 1)
	if (!isLower(before) && !isUpper(before) && !isDigit(before)) {
		return true
	}
	return isUpper(characterAt(text, at)) && (!isUpper(before) || isLower(characterAt(text, at + 1)))
}

/** The name refused, as a lower-cased text spells it. */
const REFUSED = "md5"

/** Whether a text names the refused digest at the start of a word, in any case. */
const namesRefused = (text: string): boolean => {
	const lower = Str.toLowerCase(text)
	const from = (start: number): boolean =>
		Option.match(Str.indexOf(REFUSED)(Str.slice(start)(lower)), {
			onNone: () => false,
			onSome: (offset) => beginsWord(text, start + offset) || from(start + offset + 1)
		})
	return from(0)
}

const MESSAGE =
	"Every digest is SHA-256, never MD5. Hash with SHA-256. Where an outside system defines the MD5 this code computes or reads (an integration's own digest, a provider's header), name the file in an override of oxlint.config.ts with its reason beside it, never in an inline suppression."

/**
 * MD5 named by code: an identifier, a string or a template's text with a word that begins with it, in any case (`md5(`
 * in SQL, `Digest.md5`, `createHash("md5")`, `Content-MD5`, `md5sum`). Every digest a repository computes is SHA-256:
 * one algorithm, and not one whose collisions anyone can compute. MD5 stays only where an outside system defines it,
 * and a file that integrates with one is an override in the repository's oxlint.config.ts, with its reason. A comment
 * is no code: a doc that says a provider's ETag is an MD5 computes nothing.
 */
export const sha256Digests = problem((context) => {
	const check = (node: AnyNode, text: string): void => {
		if (namesRefused(text)) {
			context.report({ node, message: MESSAGE })
		}
	}
	return {
		Identifier: (node) => check(node, node.name),
		PrivateIdentifier: (node) => check(node, node.name),
		JSXIdentifier: (node) => check(node, node.name),
		Literal: (node) => {
			if (typeof node.value === "string") {
				check(node, node.value)
			}
		},
		TemplateElement: (node) => check(node, node.value.raw)
	}
})
