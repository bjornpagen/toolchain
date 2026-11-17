import { Array as Arr, Effect, FileSystem, Path } from "effect"
import { array, element, type Gen } from "#gen.ts"
import { type Equivalent, mutantsOf, noFamilies } from "#mutants.ts"
import type { Loading } from "#mutate/checkout.ts"
import { realPathOf } from "#mutate/mutated.ts"
import type { MutantJudged } from "#mutate/operators.ts"
import { shell } from "#mutate/processes.fixtures.ts"

/** The mutated file: three functions, one whose fallback dropped is a type error. */
const TARGET_TEXT = Arr.join(
	[
		"export const f = (x: number): number => x + 1",
		"export const g = (x: number): number => x - 1",
		"export const h = (x: number | undefined): number => x ?? 0",
		""
	],
	"\n"
)

/** The functions of the file, and the call a strict check asserts of each. */
const FUNCTIONS = ["f", "g", "h"] as const

type Fn = (typeof FUNCTIONS)[number]

const ASSERTED: Readonly<Record<Fn, string>> = {
	f: "f(1) === 2",
	g: "g(5) === 4",
	h: "h(undefined) === 0"
}

/** The library's mutants of the file, by function and operator, which the run must find. */
export const POPULATION: ReadonlyArray<string> = [
	"f bound",
	"f bound",
	"g bound",
	"g bound",
	"g operand-swap",
	"h bound",
	"h bound",
	"h fallback"
]

/** A check: whether it asserts what it calls, what it calls, and whether it runs the file in a child process. */
type Check = Readonly<{ strict: boolean; calls: ReadonlyArray<Fn>; child: boolean }>

/**
 * Which of the file's mutants a case judges equivalent: every mutant of each function named. And a judgment besides
 * that names no current mutant: none, one of the mutated file (stale, so the run refuses), or one of a file the run
 * does not mutate (never read, so it changes nothing).
 */
type Judged = Readonly<{
	functions: ReadonlyArray<Fn>
	stale: "none" | "this file" | "another file"
}>

/** A case: the checks, each a property, how their workers load the code, and the run's equivalent judgments. */
export type Run = Readonly<{
	checks: Arr.NonEmptyReadonlyArray<Check>
	loading: Loading
	judged: Judged
}>

export const checkGen: Gen<Check> = (source) => ({
	strict: source.draw(element([true, false])),
	calls: Arr.dedupe(source.draw(array(element(FUNCTIONS), { min: 0, max: 3 }))),
	child: source.draw(element([false, true]))
})

export const judgedGen: Gen<Judged> = (source) => ({
	functions: Arr.dedupe(source.draw(array(element(FUNCTIONS), { min: 0, max: 3 }))),
	stale: source.draw(element(["none", "this file", "another file"]))
})

/** An id no mutant has: ids are ten hex digits (mutants.ts idOf). */
const NO_MUTANT = "not-a-mutant"

/**
 * The run's equivalent judgments: every mutant of each judged function, by the ids the library gives the target's
 * mutants, and the stale judgment the case names.
 */
export const equivalentOf = (judged: Judged) =>
	Effect.map(
		mutantsOf([{ file: "src/f.ts", text: TARGET_TEXT }], noFamilies),
		(mutants): ReadonlyArray<Equivalent> => [
			...Arr.map(
				Arr.filter(mutants, (mutant) => Arr.some(judged.functions, (fn) => fn === mutant.fn)),
				(mutant): Equivalent => ({
					file: "src/f.ts",
					mutant: mutant.id,
					why: `the case judges ${mutant.fn}'s mutants equivalent`
				})
			),
			...(judged.stale === "none"
				? []
				: [
						{
							file: judged.stale === "this file" ? "src/f.ts" : "src/other.ts",
							mutant: NO_MUTANT,
							why: "a judgment of a mutant no file has"
						}
					])
		]
	)

/** The code that calls a check's functions and prints green when every assertion holds. */
const callsOf = (check: Check) =>
	`import { f, g, h } from "./src/f.ts"\nconst held = [${Arr.join(
		Arr.map(check.calls, (fn) => (check.strict ? ASSERTED[fn] : `${ASSERTED[fn]} || true`)),
		", "
	)}]\nconsole.log(held.every((x) => x) && [f, g, h].length === 3 ? "green" : "red")\n`

/** The files of check `index`: itself, and the file its child runs when it runs one. */
const checkFiles = (check: Check, index: number): ReadonlyArray<readonly [string, string]> =>
	check.child
		? [
				[`run${String(index)}.ts`, callsOf(check)],
				[
					`check${String(index)}.ts`,
					`import { spawnSync } from "node:child_process"\nconst ran = spawnSync(process.execPath, ["run${String(index)}.ts"], { encoding: "utf8" })\nconsole.log(ran.status === 0 ? ran.stdout.trim() : "red")\n`
				]
			]
		: [[`check${String(index)}.ts`, callsOf(check)]]

/** A judged mutant as the measurement reports it. */
export const reportOf = ({ mutant, verdict }: MutantJudged<string>) =>
	`${mutant.fn} ${mutant.operator} ${mutant.original} -> ${mutant.replacement}: ${verdict.kind}`

/**
 * What the measurement must say of a mutant, by whether the case judges its function's mutants equivalent, its
 * function, its operator and which checks call the function.
 */
export const expectedOf = (run: Run, { mutant }: MutantJudged<string>) => {
	const said = `${mutant.fn} ${mutant.operator} ${mutant.original} -> ${mutant.replacement}`
	if (Arr.some(run.judged.functions, (fn) => fn === mutant.fn)) {
		return `${said}: equivalent`
	}
	if (mutant.operator === "fallback") {
		return `${said}: invalid`
	}
	const calling = Arr.filter(run.checks, (check) => Arr.some(check.calls, (fn) => fn === mutant.fn))
	if (!Arr.isReadonlyArrayNonEmpty(calling)) {
		return `${said}: uncovered`
	}
	return `${said}: ${Arr.some(calling, (check) => check.strict) ? "killed" : "survived"}`
}

/**
 * Whether a run must refuse: a judgment of the mutated file names none of its mutants, or a check runs the file in a
 * child process from workers that load it in process.
 */
export const refusesOf = (run: Run) =>
	run.judged.stale === "this file" ||
	(run.loading === "in-process" && Arr.some(run.checks, (check) => check.child))

/** A checkout of the target, its tsconfig and the run's checks, committed, in a directory of the scope's. */
export const checkoutOf = (run: Run) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const made = yield* fs.makeTempDirectoryScoped({ prefix: "toolchain-operators-test-" })
		const checkout = yield* realPathOf(made)
		const files: ReadonlyArray<readonly [string, string]> = [
			["package.json", `{"type":"module"}`],
			[
				"tsconfig.json",
				`{"compilerOptions":{"strict":true,"noEmit":true,"target":"esnext","module":"nodenext","types":[],"lib":["esnext"]},"include":["src/f.ts"]}`
			],
			["src/f.ts", TARGET_TEXT],
			...Arr.flatMap(run.checks, checkFiles)
		]
		for (const [file, text] of files) {
			yield* fs.makeDirectory(path.dirname(path.join(checkout, file)), { recursive: true })
			yield* fs.writeFileString(path.join(checkout, file), text)
		}
		yield* shell(
			checkout,
			"git init -q && git add . && git -c user.name=t -c user.email=t@t commit -qm c"
		)
		return checkout
	})
