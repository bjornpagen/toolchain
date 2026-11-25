import { Array as Arr, Console, Effect, Order, Schema, String as Str } from "effect"
import type { TestAnnotation } from "vitest"
import type {
	Reporter,
	SerializedError,
	TestCase,
	TestModule,
	TestRunEndReason,
	Vitest
} from "vitest/node"

/** The annotation an exploration's residual line arrives at the reporter as. */
export const RESIDUAL = "residual"

/** The annotation an exhaustion's line arrives at the reporter as. */
export const EXHAUSTED = "exhausted"

/** The annotation a search's oracle kind arrives at the reporter as, for the count of oracles by kind. */
export const ORACLE = "oracle"

/** The key of a test's meta under which the library's setup (searches-setup) leaves how many searches the test ran. */
export const SEARCHES_KEY = "bjornpagen.testing.searches"

declare module "vitest" {
	interface TaskMeta {
		/** How many searches the test ran, which the library's setup writes once the test is done; absent where the
		 * setup did not run, as for a test that was skipped. */
		"bjornpagen.testing.searches"?: number
	}
}

/**
 * Files whose test cases may run no search, and why: paths relative to the Vitest root, where one that ends in "/"
 * names a directory and holds every file beneath it, and any other names one file.
 */
const Exemption = Schema.Struct({
	files: Schema.NonEmptyArray(Schema.NonEmptyString),
	reason: Schema.NonEmptyString
})

/**
 * Whether a package's test cases must each run a search. Banned: a test case that passes having run none is an
 * example (a person chose its inputs and wrote its verdict), and fails the run, unless its file is exempt, each set of
 * files with its reason (the README's mirror, a performance gate, a type batch's population runner). Allowed: the
 * package's tests are not held to it.
 */
export const Examples = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("banned"), exempt: Schema.Array(Exemption) }),
	Schema.Struct({ kind: Schema.Literal("allowed") })
])

export type Examples = typeof Examples.Type

/** What the reporter is given: the package's stance on examples. */
const ReporterOptions = Schema.Struct({ examples: Examples })

const decodeReporterOptions = Schema.decodeUnknownEffect(ReporterOptions)

/** Whether an exempt path, relative to `root`, names the file or a directory above it. */
const isAt =
	(root: string, file: string) =>
	(path: string): boolean => {
		const named = `${root}/${path}`
		return Str.endsWith("/")(path) ? Str.startsWith(named)(file) : file === named
	}

/** Whether the examples the package allows admit a test case of `file`, under the Vitest root `root`: examples are
 * allowed, or the file is exempt. */
const admitsExample = (examples: Examples, root: string, file: string): boolean => {
	switch (examples.kind) {
		case "allowed":
			return true
		case "banned":
			return Arr.some(examples.exempt, (exemption) => Arr.some(exemption.files, isAt(root, file)))
	}
}

/** What the check reads of a finished test case: how it ended, its file, and how many searches it ran. */
export type Finished = Readonly<{
	state: "passed" | "failed" | "skipped" | "pending"
	file: string
	searches: number
}>

/**
 * Whether a finished test case is an example the package does not admit: it passed, it ran no search, and the package
 * bans examples in its file. A case that failed is already a failure, and one skipped or still pending ran nothing to
 * judge.
 */
export const isBannedExample = (examples: Examples, root: string, finished: Finished): boolean =>
	finished.state === "passed" &&
	finished.searches === 0 &&
	!admitsExample(examples, root, finished.file)

/** A path relative to `root`; a file outside it keeps its absolute path. */
const relativeTo =
	(root: string) =>
	(file: string): string =>
		Str.startsWith(`${root}/`)(file) ? Str.slice(root.length + 1)(file) : file

/** The error a passing test case that ran no search fails the run with, as Vitest reports an error it caught. */
const exampleError = (testCase: TestCase, root: string) => ({
	name: "ExampleTestCase",
	message: `${relativeTo(root)(testCase.module.moduleId)} > ${testCase.fullName}: this test case ran no search, so a person chose its inputs and wrote its verdict: it is an example, and examples are banned. State the property against an oracle and search it with explore, exhaust or interleave from @bjornpagen/testing, or delete the case if a search already catches what it catches. A file whose cases cannot be searches is exempt, with its reason, in the Vitest config's examples.exempt.`
})

/**
 * Where the run the reporter watches stands: between runs (none started yet, or the last one ended), or running, with
 * how many test cases it has executed so far: passed or failed, since a skipped or pending case executed nothing.
 */
type Watched = Readonly<{ kind: "between" }> | Readonly<{ kind: "running"; executed: number }>

/**
 * Why a run that executed no test case fails: it verified nothing, whatever it was told. A run whose test cases a
 * filter skipped every one of, or whose files hold none, ends with none executed; a run whose workers never start (a
 * maxWorkers of 0: edullm's gate unit, pinned to 8 CPUs, derived VITEST_MAX_WORKERS=0 from nproc/16, 2026-11-24) never
 * ends at all, its event loop drained under a run Vitest still awaits, and Node exits 0 as the loop empties.
 */
export const noTestRan = {
	ended:
		"this run executed no test case, so it verified nothing: a filter that matches none, or files that hold none, is no pass",
	unended:
		"this run never ended: Node's event loop drained before Vitest ran its tests (a maxWorkers of 0 starts no worker), so it verified nothing"
} as const

/** One line of the residual table, and the bound it is ordered by, Infinity for a risk that is unknown. */
type Row = Readonly<{ line: string; risk: number }>

/** The table of one run's searches, or nothing when no search ran. */
const tableOf = (
	rows: ReadonlyArray<Row>,
	proofs: ReadonlyArray<string>,
	oracles: ReadonlyMap<string, number>
): ReadonlyArray<string> => [
	...(Arr.isReadonlyArrayNonEmpty(rows)
		? [
				"residual risk, riskiest first:",
				...Arr.map(
					Arr.sort(
						rows,
						Order.mapInput(Order.Number, (row: Row) => -row.risk)
					),
					(row) => `  ${row.line}`
				)
			]
		: []),
	...(Arr.isReadonlyArrayNonEmpty(proofs)
		? [
				"exhausted, each a proof inside its box:",
				...Arr.map(Arr.sort(proofs, Order.String), (line) => `  ${line}`)
			]
		: []),
	...(oracles.size > 0
		? [
				`oracles, by kind: ${Arr.join(
					Arr.map(
						Arr.sort(
							Arr.fromIterable(oracles.entries()),
							Order.mapInput(Order.String, ([kind]: readonly [string, number]) => kind)
						),
						([kind, searches]) => `${kind === "unstated" ? "not stated" : kind} ${searches}`
					),
					", "
				)}`
			]
		: [])
]

/**
 * The run's search table, printed at its end: every exploration's residual, riskiest first by its bound, an unknown
 * risk first of all; then every exhaustion's proof, by suite; then how many searches state an oracle of each kind, and
 * how many state none. Each measures a generator and its features, never the program, and each line names the search's
 * oracle. A search leaves its line on its test as an annotation (`searched`), and the table collects them, so it needs
 * nothing from the test processes but Vitest's own reporting. Each run collects its own rows and lets them go once it
 * has printed them, so a watch mode's reruns never pile up. It prints through Vitest's logger, so it goes where the
 * run's other output goes.
 *
 * The reporter fails a run that executed no test case (noTestRan): one that ended with none passed or failed, and one
 * whose event loop drained before it ended, which Node would exit 0. Either verified nothing, whatever Vitest's worker
 * setting, its filters or its files, so neither is a pass.
 *
 * Where the package bans examples, the reporter also fails the run for every test case that passed having run no
 * search, outside the files the package exempts: the library's setup (searches-setup), which `defineTestConfig` runs in
 * every test process, leaves in each test's meta how many times it started explore, exhaust or interleave, so the
 * check is what a test ran, never how its source reads, and a search reached through any helper, or one the test
 * expects to fail, counts. A case that failed is already a failure, and one skipped ran nothing to judge. Each such
 * case is an error Vitest caught, named by its file and full name, so the run fails however its tests ended. A config
 * that bans examples without that setup fails every passing case, never passes one unread.
 *
 * A package whose tests run searches names it in its Vitest config, beside the library's global setup, which chooses
 * the run's seed, with its stance on examples; Vitest loads it by name, through the same loader as the tests, so a
 * package that has the library in its node_modules, as TypeScript source, loads it as the tests load the library. A
 * package that bans examples builds its config with `defineTestConfig`, which also runs the setup that records each
 * test's searches; one that allows them may name the reporter itself:
 *
 * @example
 * export default defineConfig({
 * 	test: {
 * 		globalSetup: ["@bjornpagen/testing/vitest/global-setup"],
 * 		reporters: [
 * 			"default",
 * 			["@bjornpagen/testing/vitest/reporter", { examples: { kind: "allowed" } }]
 * 		]
 * 	}
 * })
 */
export default class ResidualReporter implements Reporter {
	readonly #examples: Examples
	#rows: Array<Row> = []
	#proofs: Array<string> = []
	#oracles = new Map<string, number>()
	#watched: Watched = { kind: "between" }
	#print: (table: string) => void = (table) => Effect.runSync(Console.log(table))
	#fail: (testCase: TestCase) => void = () => undefined
	#refuse: (why: string) => void = (why) => {
		Effect.runSync(Console.error(why))
		process.exitCode = 1
	}

	/** Takes the reporter's options as Vitest hands them, decoded, so a config that names the reporter without its
	 * stance on examples fails to start rather than skip the check. */
	constructor(options: unknown) {
		this.#examples = Effect.runSync(decodeReporterOptions(options)).examples
	}

	onInit(vitest: Vitest): void {
		this.#print = (table) => {
			vitest.logger.log(table)
		}
		this.#fail = (testCase) => {
			vitest.state.catchError(
				exampleError(testCase, testCase.project.config.root),
				"Example Test Case"
			)
		}
		this.#refuse = (why) => {
			vitest.logger.error(why)
			process.exitCode = 1
		}
		process.on("beforeExit", () => {
			if (this.#watched.kind === "running") {
				this.#watched = { kind: "between" }
				this.#refuse(noTestRan.unended)
			}
		})
	}

	/** Lets go of the rows a run collected, so a watch mode's reruns never pile up. */
	#emptied(): void {
		this.#rows = []
		this.#proofs = []
		this.#oracles = new Map()
	}

	onTestRunStart(): void {
		this.#emptied()
		this.#watched = { kind: "running", executed: 0 }
	}

	onTestCaseResult(testCase: TestCase): void {
		const finished: Finished = {
			state: testCase.result().state,
			file: testCase.module.moduleId,
			searches: testCase.meta()[SEARCHES_KEY] ?? 0
		}
		if (
			this.#watched.kind === "running" &&
			(finished.state === "passed" || finished.state === "failed")
		) {
			this.#watched = { kind: "running", executed: this.#watched.executed + 1 }
		}
		if (isBannedExample(this.#examples, testCase.project.config.root, finished)) {
			this.#fail(testCase)
		}
	}

	onTestCaseAnnotate(_testCase: TestCase, annotation: TestAnnotation): void {
		if (annotation.type === RESIDUAL) {
			this.#rows.push({
				line: annotation.message,
				risk: Number(annotation.attachment?.body ?? Number.POSITIVE_INFINITY)
			})
		}
		if (annotation.type === EXHAUSTED) {
			this.#proofs.push(annotation.message)
		}
		if (annotation.type === ORACLE) {
			const kind = String(annotation.attachment?.body ?? "unstated")
			this.#oracles.set(kind, (this.#oracles.get(kind) ?? 0) + 1)
		}
	}

	onTestRunEnd(
		_modules: ReadonlyArray<TestModule>,
		_errors: ReadonlyArray<SerializedError>,
		reason: TestRunEndReason
	): void {
		const table = tableOf(this.#rows, this.#proofs, this.#oracles)
		const watched = this.#watched
		this.#emptied()
		this.#watched = { kind: "between" }
		if (Arr.isReadonlyArrayNonEmpty(table)) {
			this.#print(Arr.join(table, "\n"))
		}
		if (watched.kind === "running" && watched.executed === 0 && reason !== "interrupted") {
			this.#refuse(noTestRan.ended)
		}
	}
}

/** The residual reporter as a value, for a config that builds its reporters itself, as `defineTestConfig` does. */
export const residualReporter = (examples: Examples): Reporter => new ResidualReporter({ examples })
