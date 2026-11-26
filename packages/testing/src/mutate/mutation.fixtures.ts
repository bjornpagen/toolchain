import { Array as Arr, Effect, FileSystem } from "effect"
import { array, boolean, element, type Gen } from "#gen.ts"
import { UNRUN_BUDGET } from "#runner/budgets.fixtures.ts"

/**
 * Packages for mutation.test.ts: a runner config whose Mutation is a module of the package, and that module, written
 * where a case runs (a directory holding a test.config.ts is a package a gate runs, so none is kept in the checkout).
 * The module records that it was imported before anything else it does, so a case reads whether a load reached it.
 */

/**
 * A repository's mutation module as a case writes it: the operators of each of its families, the ids of the mutants
 * it judges equivalent, and whether its top level throws once it has recorded its import.
 */
export type Written = Readonly<{
	families: ReadonlyArray<Arr.NonEmptyReadonlyArray<string>>
	equivalent: ReadonlyArray<string>
	throws: boolean
}>

/** Operator names a family states. */
const OPERATOR_NAMES = ["slip-a", "slip-b", "slip-c"] as const

/** Mutant ids a judgment names: ten hex digits each, as mutants.ts idOf gives them. */
const MUTANT_IDS = ["0123456789", "abcdef0123", "ffffffffff"] as const

export const writtenGen: Gen<Written> = (source) => ({
	families: source.draw(
		array(
			(inner) =>
				Arr.prepend(
					inner.draw(array(element(OPERATOR_NAMES), { min: 0, max: 1 })),
					inner.draw(element(OPERATOR_NAMES))
				),
			{ min: 0, max: 2 }
		)
	),
	equivalent: source.draw(array(element(MUTANT_IDS), { min: 0, max: 2 })),
	throws: source.draw(boolean)
})

/** The file the module writes when it is imported. */
export const IMPORTED = "imported"

/** The module's text: it records its import, throws when the case says so, and exports its families and judgments. */
const moduleText = (written: Written): string =>
	Arr.join(
		[
			'const { writeFileSync } = process.getBuiltinModule("node:fs")',
			`writeFileSync(\`\${import.meta.dirname}/${IMPORTED}\`, "")`,
			...(written.throws ? ['throw new Error("the mutation module refuses to load")'] : []),
			`export const families = [${Arr.join(
				Arr.map(
					written.families,
					(operators) =>
						`{ operators: [${Arr.join(
							Arr.map(operators, (operator) => `"${operator}"`),
							", "
						)}], applies: () => true, rules: [() => undefined] }`
				),
				", "
			)}]`,
			`export const equivalent = [${Arr.join(
				Arr.map(
					written.equivalent,
					(mutant) => `{ file: "src/f.ts", mutant: "${mutant}", why: "judged by the case" }`
				),
				", "
			)}]`,
			""
		],
		"\n"
	)

/**
 * Writes into `directory` a runner config whose Mutation is `./mutation.ts`, loaded by a dynamic import, and that
 * module. Each import of the config is the file URL this module resolves (a file URL holds no quote), so the config
 * loads the same modules the case does.
 */
export const writtenPackage = (directory: string, written: Written) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		yield* fs.writeFileString(
			`${directory}/test.config.ts`,
			Arr.join(
				[
					`import { Layer } from "${import.meta.resolve("effect")}"`,
					`import { defineRunner } from "${import.meta.resolve("#runner/config.ts")}"`,
					`export default defineRunner({ budget: { kind: "cpu", millis: ${String(UNRUN_BUDGET)} }, include: [], smallStack: [], conditions: [], environment: [], layer: Layer.empty, mutation: () => import("./mutation.ts") })`,
					""
				],
				"\n"
			)
		)
		yield* fs.writeFileString(`${directory}/mutation.ts`, moduleText(written))
	})

/** What mutate's load must give back of a written module: a refusal when it throws, else its families and judgments. */
export const expectedOf = (written: Written) =>
	written.throws
		? { refused: true, families: [], equivalent: [] }
		: {
				refused: false,
				families: Arr.map(written.families, (operators) => Arr.copy(operators)),
				equivalent: Arr.copy(written.equivalent)
			}
