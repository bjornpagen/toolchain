import { boolean, characterOf, type Gen, int, oneOf, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Formatter, Option, Result, String as Str } from "effect"
import { RuleTester } from "oxlint/plugins-dev"
import { bearerOwners } from "#oxlint/rules/bearer-owners.ts"

/**
 * The statements the bearer-owners property draws (bearer-owners.test.ts), from a grammar of the rule's contract, and
 * what oxlint's RuleTester makes of one: a bearer credential built as a template, as a concatenation that starts with
 * the scheme in any case, or as a `bearerToken(...)` call, beside statements that are no credential, in a file the
 * rule's owners name or in one they do not.
 */

/** The file the rule's options name as an adapter, and a file they do not. */
const OWNER = "src/adapters/provider.ts"
const OUTSIDE = "src/app/page.ts"

const OPTIONS = Object.freeze({ owners: [OWNER] })

/** What a statement is, as the property names its situations. */
type Feature =
	| "a template"
	| "a concatenation"
	| "a call"
	| "a statement that is no credential"
	| "a credential in an owner"

/** A statement, the reports the contract gives it outside the owners (none for what is no credential), and what it is. */
type Statement = Readonly<{ code: string; reports: number; kind: Feature }>

/** The preamble every statement reads its names from. */
const PREAMBLE = `declare const token: string
declare const HttpClientRequest: { bearerToken: (token: string) => string; basicAuth: (token: string) => string }
declare const bearerToken: (token: string) => string
`

/** The scheme the rule reads, which it compares in any case. */
const SCHEME = "bearer"

/** The letters a near scheme adds or changes. */
const ALPHABET = "abcdefghijklmnopqrstuvwxyz"

const LETTERS = Str.split("")(ALPHABET)

/** A word in any case: each of its letters drawn upper or lower. */
const casingOf =
	(word: string): Gen<string> =>
	(source) =>
		Arr.join(
			Arr.map(Str.split("")(word), (letter) =>
				source.draw(boolean) ? Str.toUpperCase(letter) : letter
			),
			""
		)

/** The scheme in any case. */
const schemes: Gen<string> = casingOf(SCHEME)

/** A lowercase letter other than `letter`. */
const otherLetterThan = (letter: string): Gen<string> =>
	characterOf(Str.split("")(Str.replace(letter, "")(ALPHABET)))

/**
 * A scheme that is not the bearer scheme, in any case, by construction: the scheme with a letter more, a letter less
 * or a letter changed, which the rule must not read as the scheme.
 */
const nearSchemes: Gen<string> = (source) => {
	const scheme = source.draw(schemes)
	const at = source.draw(int(0, SCHEME.length - 1))
	const before = Str.slice(0, at)(scheme)
	const after = Str.slice(at + 1)(scheme)
	return source.draw(
		oneOf<string>([
			(inner) => `${scheme}${inner.draw(characterOf(LETTERS))}`,
			() => `${before}${after}`,
			(inner) =>
				`${before}${inner.draw(otherLetterThan(Arr.getUnsafe(Str.split("")(SCHEME), at)))}${after}`
		])
	)
}

/** A bearer credential, outside the owners one report. */
const credentials: Gen<Statement> = oneOf<Statement>([
	(source) => ({
		code: `export const a = \`${source.draw(schemes)} \${token}\``,
		reports: 1,
		kind: "a template"
	}),
	(source) => ({
		code: `export const a = "${source.draw(schemes)} " + token`,
		reports: 1,
		kind: "a concatenation"
	}),
	() => ({
		code: "export const a = HttpClientRequest.bearerToken(token)",
		reports: 1,
		kind: "a call"
	}),
	() => ({ code: "export const a = bearerToken(token)", reports: 1, kind: "a call" })
])

/**
 * What is no bearer credential: another scheme as a template or a concatenation, the scheme in a template with no
 * expression or as prose, the scheme after the token, and another request call.
 */
const notCredentials: Gen<string> = oneOf<string>([
	(source) => `export const a = \`${source.draw(nearSchemes)} \${token}\``,
	(source) => `export const a = "${source.draw(nearSchemes)} " + token`,
	(source) => `export const a = \`${source.draw(schemes)} token\``,
	(source) => `export const a = "${source.draw(schemes)} token"`,
	(source) => `export const a = token + "${source.draw(schemes)} "`,
	() => "export const a = HttpClientRequest.basicAuth(token)"
])

const statements: Gen<Statement> = weighted<Statement>([
	[1, credentials],
	[
		1,
		(source) => ({
			code: source.draw(notCredentials),
			reports: 0,
			kind: "a statement that is no credential"
		})
	]
])

/** A statement and whether its file is an owner: the reports go with the file. */
export type Drawn = Readonly<{ statement: Statement; owned: boolean }>

/** A statement, in an owner or not. */
export const drawnStatements: Gen<Drawn> = (source) => {
	const owned = source.draw(boolean)
	const one = source.draw(statements)
	return {
		statement: {
			...one,
			reports: owned ? 0 : one.reports,
			kind: owned && one.reports > 0 ? "a credential in an owner" : one.kind
		},
		owned
	}
}

const LANGUAGE = { sourceType: "module", parserOptions: { lang: "ts" } } as const

/** What RuleTester makes of a drawn statement in its file: none when the rule reports it exactly as often as the
 * contract says, else RuleTester's failure. */
export const judged = (drawn: Drawn): Option.Option<string> => {
	const code = `${PREAMBLE}${drawn.statement.code}\n`
	const filename = drawn.owned ? OWNER : OUTSIDE
	const ran = Result.try(() =>
		new RuleTester({ languageOptions: LANGUAGE }).run(
			"bearer-owners",
			bearerOwners,
			drawn.statement.reports === 0
				? { valid: [{ code, filename, options: [OPTIONS] }], invalid: [] }
				: {
						valid: [],
						invalid: [{ code, filename, options: [OPTIONS], errors: drawn.statement.reports }]
					}
		)
	)
	return Result.match(ran, {
		onSuccess: () => Option.none(),
		onFailure: (failure) => Option.some(Formatter.format(failure))
	})
}
