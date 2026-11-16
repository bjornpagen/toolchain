import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
/**
 * The bearer-owners rule (src/oxlint/rules/bearer-owners.ts), searched over one statement each, drawn from a grammar of
 * its contract: a bearer credential built as a template (`Bearer ${token}`, the scheme in any case), as a
 * concatenation that starts with the scheme, or as a `bearerToken(...)` call, bare or on a receiver, beside what is no
 * bearer credential (another scheme, the scheme in a template with no expression, the scheme as prose, another
 * request call), in a file the rule's owners list names and in one it does not. Every statement carries the number of
 * reports the contract gives it, one for a credential outside the owners and none anywhere else, and oxlint's
 * RuleTester, run in the case, must find exactly that many.
 *
 * Oracle: the specification, the rule's JSDoc: a bearer credential is presented only by its provider's adapter.
 * Features: a template, a concatenation, a call, a statement that is no credential, and a credential in an owner.
 */
import { describe, it } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { Duration, Effect, Formatter, Option, Result } from "effect"
import { RuleTester } from "oxlint/plugins-dev"
import { bearerOwners } from "#oxlint/rules/bearer-owners.ts"

/** The file the rule's options name as an adapter, and a file they do not. */
const OWNER = "src/adapters/provider.ts"
const OUTSIDE = "src/app/page.ts"

const OPTIONS = Object.freeze({ owners: [OWNER] })

/** A statement, the reports the contract gives it outside the owners (none for what is no credential), and what it is. */
type Statement = Readonly<{ code: string; reports: number; kind: Feature }>

type Feature =
	| "a template"
	| "a concatenation"
	| "a call"
	| "a statement that is no credential"
	| "a credential in an owner"

/** The preamble every statement reads its names from. */
const PREAMBLE = `declare const token: string
declare const HttpClientRequest: { bearerToken: (token: string) => string; basicAuth: (token: string) => string }
declare const bearerToken: (token: string) => string
`

const SCHEMES = ["Bearer", "bearer", "BEARER"] as const
const OTHERS = ["Basic", "Token", "Bearers"] as const

const credential = (
	scheme: string
): readonly [
	Readonly<{ code: string; kind: Feature }>,
	...Array<Readonly<{ code: string; kind: Feature }>>
] => [
	{ code: `export const a = \`${scheme} \${token}\``, kind: "a template" },
	{ code: `export const a = "${scheme} " + token`, kind: "a concatenation" },
	{ code: `export const a = HttpClientRequest.bearerToken(token)`, kind: "a call" },
	{ code: `export const a = bearerToken(token)`, kind: "a call" }
]

const notCredentials = (other: string): readonly [string, ...Array<string>] => [
	`export const a = \`${other} \${token}\``,
	`export const a = "${other} " + token`,
	`export const a = \`Bearer token\``,
	`export const a = "Bearer token"`,
	`export const a = token + "Bearer "`,
	`export const a = HttpClientRequest.basicAuth(token)`
]

const statement: Gen<Statement> = (source) => {
	if (source.draw(boolean)) {
		const pick = source.draw(element(credential(source.draw(element(SCHEMES)))))
		return { code: pick.code, reports: 1, kind: pick.kind }
	}
	return {
		code: source.draw(element(notCredentials(source.draw(element(OTHERS))))),
		reports: 0,
		kind: "a statement that is no credential"
	}
}

/** A statement and whether its file is an owner: the reports go with the file. */
type Drawn = Readonly<{ statement: Statement; owned: boolean }>

const drawnStatement: Gen<Drawn> = (source) => {
	const owned = source.draw(boolean)
	const one = source.draw(statement)
	return {
		statement: {
			...one,
			reports: owned ? 0 : one.reports,
			kind: owned && one.reports > 0 ? "a credential in an owner" : one.kind
		},
		owned
	}
}

RuleTester.describe = (_text, fn) => fn()
RuleTester.it = (_text, fn) => fn()

const LANGUAGE = { sourceType: "module", parserOptions: { lang: "ts" } } as const

/** What RuleTester makes of a program at a file: none when the rule reports it exactly `reports` times. */
const judged = (code: string, filename: string, reports: number): Option.Option<string> => {
	const ran = Result.try(() =>
		new RuleTester({ languageOptions: LANGUAGE }).run(
			"bearer-owners",
			bearerOwners,
			reports === 0
				? { valid: [{ code, filename, options: [OPTIONS] }], invalid: [] }
				: { valid: [], invalid: [{ code, filename, options: [OPTIONS], errors: reports }] }
		)
	)
	return Result.match(ran, {
		onSuccess: () => Option.none(),
		onFailure: (failure) => Option.some(Formatter.format(failure))
	})
}

describe("bearer-owners", () => {
	it.effect("reports a bearer credential outside the owners and nothing else", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "oxlint/bearer-owners",
					oracle: {
						kind: "specification",
						name: "the rule's stated contract: a bearer credential is presented only by its provider's adapter"
					},
					draw: drawn(drawnStatement),
					literal: Formatter.format,
					coverage: required<Feature>(
						[
							"a template",
							"a concatenation",
							"a call",
							"a statement that is no credential",
							"a credential in an owner"
						],
						{ cases: 200, sense: notesOnly }
					),
					kept: [],
					runs: 200,
					shrink: completeShrink,
					steerEvery: 16,
					caseHang: Duration.minutes(1)
				},
				(one, c) =>
					Effect.sync(() => {
						c.note(one.statement.kind)
						deepStrictEqual(
							judged(
								`${PREAMBLE}${one.statement.code}\n`,
								one.owned ? OWNER : OUTSIDE,
								one.statement.reports
							),
							Option.none()
						)
					})
			)
		)
	)
})
