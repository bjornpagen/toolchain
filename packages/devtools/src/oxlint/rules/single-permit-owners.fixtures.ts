import { array, boolean, element, type Gen, weighted } from "@bjornpagen/testing/gen"
import { Array as Arr, Formatter, Option, Result, String as Str } from "effect"
import { RuleTester } from "oxlint/plugins-dev"
import { SEMAPHORES, singlePermitOwners, WITH_PERMITS } from "#oxlint/rules/single-permit-owners.ts"

/**
 * The programs the single-permit-owners property draws (single-permit-owners.test.ts), from a grammar of the rule's
 * contract read over the constructors and the call its module exports, and what oxlint's RuleTester makes of one: a
 * semaphore made with one permit, an effect run under one permit, and what is no single-permit lock, in a file the
 * rule's owners name or in one they do not.
 */

/** What a statement is, as the property names its situations. */
export type Feature =
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

/** One statement (`$` its own suffix), the reports the contract gives it outside the owners, and what it is. */
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

/** A program: its text, the reports the contract gives it, whether its file is an owner, and its statements. */
export type Program = Readonly<{
	code: string
	reports: number
	owned: boolean
	statements: ReadonlyArray<Statement>
}>

export const programs: Gen<Program> = (source) => {
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

/** The situations a program reaches: each statement's kind (a lock in an owner where its file is one), and several
 * statements. */
export const featuresOf = (program: Program): ReadonlyArray<Feature> => [
	...Arr.map(program.statements, (one) =>
		program.owned && one.reports > 0 ? "a lock in an owner" : one.kind
	),
	...(program.statements.length > 1 ? (["a program of several statements"] as const) : [])
]

/** The names every statement reads. */
const PREAMBLE = `import { Effect, Semaphore } from "effect"
declare const lock: Semaphore.Semaphore
declare const work: Effect.Effect<void>
declare const width: number
declare const permits: number
`

const LANGUAGE = { sourceType: "module", parserOptions: { lang: "ts" } } as const

/** What RuleTester makes of a program at its file: none when the rule reports it exactly as often as the contract
 * says, else RuleTester's failure. */
export const judged = (program: Program): Option.Option<string> => {
	const code = `${PREAMBLE}${program.code}\n`
	const filename = program.owned ? OWNER : OUTSIDE
	const ran = Result.try(() =>
		new RuleTester({ languageOptions: LANGUAGE }).run(
			"single-permit-owners",
			singlePermitOwners,
			program.reports === 0
				? { valid: [{ code, filename, options: [OPTIONS] }], invalid: [] }
				: { valid: [], invalid: [{ code, filename, options: [OPTIONS], errors: program.reports }] }
		)
	)
	return Result.match(ran, {
		onSuccess: () => Option.none(),
		onFailure: (failure) => Option.some(Formatter.format(failure))
	})
}
