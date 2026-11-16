/**
 * Operator mutation (mutate/operators.ts) end to end on real worker images: a checkout's file is mutated by the
 * library's operators, each mutant typed by the package's own tsconfig (the one with a type error invalid), each valid
 * one run against the properties whose coverage pass ran its function, in a process started from the mutant's image:
 * killed by a check that asserts what the function returns, survived when only checks that call it without asserting
 * ran it, uncovered when no check ran it; and the run refuses when a check runs the file in a child process without a
 * worker tree, where the file's probe never reaches. Oracle: the specification, stated in the search.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { layer } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import {
	Array as Arr,
	Duration,
	Effect,
	FileSystem,
	Formatter,
	Option,
	Order,
	Path,
	Schema,
	Stream,
	String as Str
} from "effect"
import { ChildProcess, type ChildProcessSpawner } from "effect/process"
import { drawn, explore } from "#explore.ts"
import { required } from "#features.ts"
import { array, element, type Gen } from "#gen.ts"
import { noFamilies, OPERATORS } from "#mutants.ts"
import type { Loading } from "#mutate/checkout.ts"
import { imagesOf } from "#mutate/image.ts"
import { realPathOf } from "#mutate/mutated.ts"
import { type MutantJudged, MutationRefused, mutationOf } from "#mutate/operators.ts"
import type { MutantPool } from "#mutate/pool.ts"
import type { Subject } from "#mutate/schedule.ts"
import { treesOf } from "#mutate/tree.ts"
import { Property, PropertyId } from "#property.ts"
import { runnerLimits } from "#runner/limits.ts"
import type { CaseResult } from "#runner/protocol.ts"
import { notesOnly } from "#sense.ts"
import { boundedShrink } from "#shrink.ts"
import { searched } from "#vitest/searched.ts"

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
const POPULATION: ReadonlyArray<string> = [
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

/** A case: the checks, each a property, and how their workers load the code. */
type Run = Readonly<{ checks: Arr.NonEmptyReadonlyArray<Check>; loading: Loading }>

const checkGen: Gen<Check> = (source) => ({
	strict: source.draw(element([true, false])),
	calls: Arr.dedupe(source.draw(array(element(FUNCTIONS), { min: 0, max: 3 }))),
	child: source.draw(element([false, true]))
})

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

const passed: CaseResult = {
	decisions: 0,
	sketchDecisions: 0,
	overrun: false,
	notes: [],
	measures: [],
	trace: [],
	outcome: { kind: "passed", kept: { kind: "nothing" }, shown: { kind: "unshown" } },
	millis: 0
}

/**
 * A pool whose workers are processes started from their image, flags, root and environment: a case of property
 * `check<i>` runs that check, and fails unless it prints green.
 */
const processPool = Effect.map(
	Effect.context<ChildProcessSpawner.ChildProcessSpawner>(),
	(services): MutantPool<never> => ({
		width: 4,
		lease: (image) =>
			Effect.succeed({
				evaluate: (batches) =>
					Effect.forEach(batches, (batch) =>
						Effect.forEach(batch, (order) =>
							Effect.scoped(
								Effect.gen(function* () {
									const handle = yield* ChildProcess.make(
										process.execPath,
										[...image.execArgv, `${order.property}.ts`],
										{ cwd: image.root, env: image.env, extendEnv: true, stdin: "ignore" }
									)
									const [printed] = yield* Effect.all(
										[
											Stream.mkString(Stream.decodeText(handle.stdout)),
											Stream.runDrain(handle.stderr),
											handle.exitCode
										],
										{ concurrency: "unbounded" }
									)
									const result: CaseResult =
										Str.trim(printed) === "green"
											? passed
											: { ...passed, outcome: { kind: "lost", report: printed } }
									return result
								})
							).pipe(Effect.orDie, Effect.provideContext(services))
						)
					),
				width: Effect.succeed(1)
			})
	})
)

/** A property whose one case is its check, run on its evaluator: red when the case does not pass. */
const checkProperty = new Property({
	kind: "explore",
	guide: { kind: "notes" },
	oracle: { kind: "unstated" },
	kills: [],
	search: (run) =>
		Effect.map(
			run.evaluator.evaluate(
				[
					[
						{
							property: run.id,
							chooser: { kind: "simplest" },
							drawn: { kind: "unsteered" },
							keep: "nothing",
							sense: { kind: "notes" },
							deadline: run.limits.deadline,
							print: "failing"
						}
					]
				],
				() => true
			),
			(results) =>
				Arr.every(Arr.flatten(results), (result) => result.outcome.kind === "passed")
					? { kind: "exhausted", cases: 1, box: "the check", measures: [] }
					: {
							kind: "failed",
							finding: { kind: "lost", phase: "floor", where: run.id, report: "red" }
						}
		),
	replay: () => Effect.succeed({ kind: "exhausted", cases: 1, box: "the check", measures: [] }),
	evaluate: () => Effect.succeed([])
})

/** A judged mutant as the measurement reports it. */
const reportOf = ({ mutant, verdict }: MutantJudged<string>) =>
	`${mutant.fn} ${mutant.operator} ${mutant.original} -> ${mutant.replacement}: ${verdict.kind}`

/** What the measurement must say of a mutant, by its function, its operator and which checks call the function. */
const expectedOf = (run: Run, { mutant }: MutantJudged<string>) => {
	const said = `${mutant.fn} ${mutant.operator} ${mutant.original} -> ${mutant.replacement}`
	if (mutant.operator === "fallback") {
		return `${said}: invalid`
	}
	const calling = Arr.filter(run.checks, (check) => Arr.some(check.calls, (fn) => fn === mutant.fn))
	if (!Arr.isReadonlyArrayNonEmpty(calling)) {
		return `${said}: uncovered`
	}
	return `${said}: ${Arr.some(calling, (check) => check.strict) ? "killed" : "survived"}`
}

layer(NodeServices.layer, { excludeTestServices: true })("operator mutation", (it) => {
	it.effect(
		"kills, misses, sets aside and leaves uncovered each mutant as the checks that ran it decide, or refuses an unprobed check",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "operator mutation",
						oracle: {
							kind: "specification",
							name: "invalid when mistyped, uncovered when no check calls its function, killed when a strict one does, survived otherwise; refused when a check runs the file in a child without a tree"
						},
						draw: drawn((source): Run => ({
							checks: Arr.prepend(
								source.draw(array(checkGen, { min: 0, max: 1 })),
								source.draw(checkGen)
							),
							loading: source.draw(element(["in-process", "tree"]))
						})),
						literal: Formatter.format,
						coverage: required<
							| "killed"
							| "survived"
							| "uncovered"
							| "invalid"
							| "refused"
							| "a child in a tree"
							| "tree"
						>(
							[
								"killed",
								"survived",
								"uncovered",
								"invalid",
								"refused",
								"a child in a tree",
								"tree"
							],
							{
								cases: 40,
								sense: notesOnly
							}
						),
						kept: [],
						runs: 8,
						shrink: boundedShrink(20),
						steerEvery: 4,
						caseHang: Duration.minutes(3)
					},
					(run, c) =>
						Effect.scoped(
							Effect.gen(function* () {
								if (run.loading === "tree") {
									c.note("tree")
								}
								if (run.loading === "tree" && Arr.some(run.checks, (check) => check.child)) {
									c.note("a child in a tree")
								}
								const fs = yield* FileSystem.FileSystem
								const path = yield* Path.Path
								const made = yield* fs.makeTempDirectoryScoped({
									prefix: "toolchain-operators-test-"
								})
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
									yield* fs.makeDirectory(path.dirname(path.join(checkout, file)), {
										recursive: true
									})
									yield* fs.writeFileString(path.join(checkout, file), text)
								}
								const git = yield* ChildProcess.make(
									"sh",
									[
										"-c",
										"git init -q && git add . && git -c user.name=t -c user.email=t@t commit -qm c"
									],
									{ cwd: checkout, extendEnv: true, stdin: "ignore" }
								)
								yield* Effect.all(
									[Stream.runDrain(git.stdout), Stream.runDrain(git.stderr), git.exitCode],
									{ concurrency: "unbounded" }
								)
								const pool = yield* processPool
								const trees = yield* treesOf(checkout)
								const images = yield* imagesOf(checkout, trees)
								const subjects = Arr.map(run.checks, (_, index): Subject => ({
									id: PropertyId(`check${String(index)}`),
									property: checkProperty,
									loading: run.loading
								}))
								const measured = yield* Effect.result(
									mutationOf(pool, images, {
										witnesses: { seed: 1, limits: runnerLimits },
										checkout,
										pkg: checkout,
										subjects,
										files: ["src/f.ts"],
										families: noFamilies,
										operators: new Set(OPERATORS),
										sample: Option.none(),
										seed: 1
									})
								)
								const refuses =
									run.loading === "in-process" && Arr.some(run.checks, (check) => check.child)
								if (measured._tag === "Failure") {
									c.note("refused")
									deepStrictEqual(
										{ refused: Schema.is(MutationRefused)(measured.failure), expected: refuses },
										{ refused: true, expected: true }
									)
									return
								}
								const judged = measured.success
								c.noteAll(Arr.map(judged, ({ verdict }) => verdict.kind))
								deepStrictEqual(
									{
										refused: false,
										population: Arr.sort(
											Arr.map(judged, ({ mutant }) => `${mutant.fn} ${mutant.operator}`),
											Order.String
										),
										verdicts: Arr.map(judged, reportOf)
									},
									{
										refused: refuses,
										population: Arr.copy(POPULATION),
										verdicts: Arr.map(judged, (one) => expectedOf(run, one))
									}
								)
							})
						)
				)
			)
	)
})
