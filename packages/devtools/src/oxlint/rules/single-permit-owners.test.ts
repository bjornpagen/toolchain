import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, boolean, element, type Gen, weighted } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
/**
 * The single-permit-owners rule (src/oxlint/rules/single-permit-owners.ts), searched over programs of one statement or
 * several, drawn from a grammar of its contract: a semaphore made with one permit by each constructor its module
 * exports, an effect run under one permit (a semaphore's method, Semaphore's function), beside what is no single-permit
 * lock (more permits, a width held by a name, one permit taken by `withPermit`, a near name), in a file the rule's
 * owners name and in one they do not. Every statement carries the reports the contract gives it, one for a lock outside
 * the owners and none else, and oxlint's RuleTester, run in the case, must find exactly that many.
 *
 * Oracle: the specification, the rule's JSDoc read over the constructors and the call its module exports (SEMAPHORES,
 * WITH_PERMITS). Features: a lock made, a lock taken, a statement that is no lock, a lock in an owner, a program of
 * several statements.
 */
import { describe, it } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { Array as Arr, Duration, Effect, Formatter, Option, Result, String as Str } from "effect"
import { RuleTester } from "oxlint/plugins-dev"
import { SEMAPHORES, singlePermitOwners, WITH_PERMITS } from "#oxlint/rules/single-permit-owners.ts"

type Feature =
	| "a lock made"
	| "a lock taken"
	| "a statement that is no lock"
	| "a lock in an owner"
	| "a program of several statements"

/** The file the rule's options name as an owner, and one they do not. */
const OWNER = "test/support/pg.ts"
const OUTSIDE = "test/support/other.ts"

const OPTIONS = Object.freeze({
	owners: [{ file: OWNER, reason: "a session's wire takes one turn at a time" }]
})

/** One statement, the reports the contract gives it outside the owners, and what it is. */
type Statement = Readonly<{ code: string; reports: number; kind: Feature }>

/** One of the constructors the rule's module exports. */
const constructors: Gen<string> = element(
	Option.getOrThrow(Option.liftPredicate(SEMAPHORES, Arr.isReadonlyArrayNonEmpty))
)

const statements: Gen<Statement> = weighted([
	[
		3,
		(source): Statement => ({
			code: `const lock$ = ${source.draw(constructors)}(1)`,
			reports: 1,
			kind: "a lock made"
		})
	],
	[
		3,
		(source): Statement => ({
			code: source.draw(boolean)
				? `const run$ = lock.${WITH_PERMITS}(1)(work)`
				: `const run$ = Semaphore.${WITH_PERMITS}(lock, 1)(work)`,
			reports: 1,
			kind: "a lock taken"
		})
	],
	[
		4,
		(source): Statement => ({
			code: source.draw(
				element([
					`const lock$ = ${source.draw(constructors)}(2)`,
					`const lock$ = ${source.draw(constructors)}(width)`,
					`const run$ = lock.${WITH_PERMITS}(2)(work)`,
					`const run$ = Semaphore.${WITH_PERMITS}(lock, permits)(work)`,
					"const run$ = lock.withPermit(work)",
					"const lock$ = Semaphore.makeLater(1)",
					"const run$ = lock.withPermitsIfAvailable(1)(work)"
				] as const)
			),
			reports: 0,
			kind: "a statement that is no lock"
		})
	]
])

type Program = Readonly<{
	code: string
	reports: number
	owned: boolean
	statements: ReadonlyArray<Statement>
}>

const programs: Gen<Program> = (source) => {
	const drawnStatements = source.draw(array(statements, { min: 1, max: 3 }))
	const owned = source.draw(boolean)
	return {
		code: Arr.join(
			Arr.map(drawnStatements, (one, at) => Str.replaceAll("$", String(at))(one.code)),
			"\n"
		),
		reports: owned ? 0 : Arr.reduce(drawnStatements, 0, (sum, one) => sum + one.reports),
		owned,
		statements: drawnStatements
	}
}

/** The names every statement reads. */
const PREAMBLE = `import { Effect, Semaphore } from "effect"
declare const lock: Semaphore.Semaphore
declare const work: Effect.Effect<void>
declare const width: number
declare const permits: number
`

RuleTester.describe = (_text, fn) => fn()
RuleTester.it = (_text, fn) => fn()

const LANGUAGE = { sourceType: "module", parserOptions: { lang: "ts" } } as const

/** What RuleTester makes of a program at a file: none when the rule reports it exactly `reports` times. */
const judged = (code: string, filename: string, reports: number): Option.Option<string> => {
	const ran = Result.try(() =>
		new RuleTester({ languageOptions: LANGUAGE }).run(
			"single-permit-owners",
			singlePermitOwners,
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

describe("single-permit-owners", () => {
	it.effect("reports exactly the single-permit locks outside the owners", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "oxlint/single-permit-owners",
					oracle: {
						kind: "specification",
						name: "the rule's stated contract over the constructors and the call its module exports"
					},
					draw: drawn(programs),
					literal: Formatter.format,
					coverage: required<Feature>(
						[
							"a lock made",
							"a lock taken",
							"a statement that is no lock",
							"a lock in an owner",
							"a program of several statements"
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
						for (const one of program.statements) {
							c.note(program.owned && one.reports > 0 ? "a lock in an owner" : one.kind)
						}
						if (program.statements.length > 1) {
							c.note("a program of several statements")
						}
						deepStrictEqual(
							judged(
								`${PREAMBLE}${program.code}\n`,
								program.owned ? OWNER : OUTSIDE,
								program.reports
							),
							Option.none()
						)
					})
			)
		)
	)
})
