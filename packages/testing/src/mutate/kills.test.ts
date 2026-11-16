/**
 * The kill gate (mutate/kills.ts), on real worker images: each kill is applied to its file in a checkout and its
 * property's check runs on a process started from the kill's image, the module hook for a property that loads the code
 * in process, a worker tree for one that needs Checkout.dir; a kill whose original stands anywhere but once is stale; a
 * kill the check catches is killed, whether the check runs the file in its own process or, from a tree, in a child; a
 * kill it misses survives, its probe saying whether the property's process loaded the mutant at all, which a check
 * that runs the file in a child without a tree never does. Oracle: the specification, stated in the search.
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
	Path,
	Stream,
	String as Str
} from "effect"
import { ChildProcess, type ChildProcessSpawner } from "effect/process"
import { drawn, explore } from "#explore.ts"
import { required } from "#features.ts"
import { array, element } from "#gen.ts"
import type { Loading } from "#mutate/checkout.ts"
import { imagesOf } from "#mutate/image.ts"
import { type Judged, killsOf } from "#mutate/kills.ts"
import { type RealPath, realPathOf } from "#mutate/mutated.ts"
import type { MutantPool } from "#mutate/pool.ts"
import type { Subject } from "#mutate/schedule.ts"
import { treesOf } from "#mutate/tree.ts"
import { type Kill, Property, PropertyId } from "#property.ts"
import { runnerLimits } from "#runner/limits.ts"
import type { CaseResult } from "#runner/protocol.ts"
import { notesOnly } from "#sense.ts"
import { boundedShrink } from "#shrink.ts"
import { searched } from "#vitest/searched.ts"

/** The file the kills mutate. */
const TARGET = "src/f.ts"

const TARGET_TEXT = "export const f = (x: number): number => x + 1\n"

/** The kills a case draws from, by what each is. */
const KILL_NAMES = [
	"a bug",
	"no bug",
	"an original standing twice",
	"an original standing nowhere",
	"a file not in the checkout"
] as const

type KillName = (typeof KILL_NAMES)[number]

/** Each kill a case draws from. */
const KILLS: Readonly<Record<KillName, Kill>> = {
	"a bug": { file: TARGET, original: "x + 1", replacement: "x + 2", why: "a bug" },
	"no bug": { file: TARGET, original: "x + 1", replacement: "1 + x", why: "no bug" },
	"an original standing twice": { file: TARGET, original: "x", replacement: "y", why: "twice" },
	"an original standing nowhere": {
		file: TARGET,
		original: "x * 9",
		replacement: "x",
		why: "nowhere"
	},
	"a file not in the checkout": {
		file: "src/missing.ts",
		original: "x + 1",
		replacement: "x + 2",
		why: "missing"
	}
}

/** How a property's check runs the file: in its own process, or in a child process it starts. */
const CHECKS = ["direct", "child"] as const

type CheckKind = (typeof CHECKS)[number]

/** A case: the property's check, how its workers load the code, and its kills. */
type Gate = Readonly<{
	check: CheckKind
	loading: Loading
	kills: Arr.NonEmptyReadonlyArray<KillName>
}>

/** The checkout: the target, a check that imports it, and one that runs it in a child process. */
const CHECKOUT: ReadonlyArray<readonly [string, string]> = [
	["package.json", `{"type":"module"}`],
	[TARGET, TARGET_TEXT],
	["src/run-f.ts", `import { f } from "./f.ts"\nconsole.log(f(1))\n`],
	["direct.ts", `import { f } from "./src/f.ts"\nconsole.log(f(1) === 2 ? "green" : "red")\n`],
	[
		"child.ts",
		`import { spawnSync } from "node:child_process"\nconst ran = spawnSync(process.execPath, ["src/run-f.ts"], { encoding: "utf8" })\nconsole.log(ran.status === 0 && ran.stdout.trim() === "2" ? "green" : "red")\n`
	]
]

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
 * A pool whose workers are processes started from their image: a case of property `direct` or `child` runs that check
 * with the image's flags in the image's root, and fails unless the check prints green.
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
										{ cwd: image.root, extendEnv: true, stdin: "ignore" }
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
const checkProperty = (kills: ReadonlyArray<Kill>): Property =>
	new Property({
		kind: "explore",
		guide: { kind: "notes" },
		needs: {},
		oracle: { kind: "unstated" },
		kills,
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

/** A judged kill, as the gate reports it. */
const reportOf = (judged: Judged) => {
	switch (judged.verdict.kind) {
		case "killed":
			return `${judged.kill.why}: killed`
		case "survived":
			return `${judged.kill.why}: survived, ${judged.verdict.loaded ? "loaded" : "never loaded"}`
		case "stale":
			return `${judged.kill.why}: stale, found ${String(judged.verdict.stale.found)}`
	}
}

/** What the gate must say of a kill: by the count of its original in its file, and where the check runs it. */
const expectedOf = (gate: Gate, name: KillName) => {
	const kill = KILLS[name]
	const found = kill.file === TARGET ? Str.split(kill.original)(TARGET_TEXT).length - 1 : 0
	if (found !== 1) {
		return `${kill.why}: stale, found ${String(found)}`
	}
	const reaches = gate.check === "direct" || gate.loading === "tree"
	if (name === "a bug" && reaches) {
		return `${kill.why}: killed`
	}
	return `${kill.why}: survived, ${reaches ? "loaded" : "never loaded"}`
}

/** A checkout of CHECKOUT, committed, in a directory of the scope's. */
const checkoutOf = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const made = yield* fs.makeTempDirectoryScoped({ prefix: "toolchain-kills-test-" })
	const directory: RealPath = yield* realPathOf(made)
	for (const [file, text] of CHECKOUT) {
		yield* fs.makeDirectory(path.dirname(path.join(directory, file)), { recursive: true })
		yield* fs.writeFileString(path.join(directory, file), text)
	}
	const handle = yield* ChildProcess.make(
		"sh",
		["-c", "git init -q && git add . && git -c user.name=t -c user.email=t@t commit -qm checkout"],
		{ cwd: directory, extendEnv: true, stdin: "ignore" }
	)
	yield* Effect.all(
		[Stream.runDrain(handle.stdout), Stream.runDrain(handle.stderr), handle.exitCode],
		{
			concurrency: "unbounded"
		}
	)
	return directory
})

layer(NodeServices.layer, { excludeTestServices: true })("the kill gate", (it) => {
	it.effect(
		"kills what the check catches wherever it runs the file, finds stale kills, and says whether a survivor was loaded",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "kill gate",
						oracle: {
							kind: "specification",
							name: "stale unless the original stands once; killed when the check catches it where it runs the file; a survivor loaded exactly when the check runs the file in its process or from a tree"
						},
						draw: drawn((source): Gate => ({
							check: source.draw(element(CHECKS)),
							loading: source.draw(element(["in-process", "tree"])),
							kills: Arr.prepend(
								source.draw(array(element(KILL_NAMES), { min: 0, max: 2 })),
								source.draw(element(KILL_NAMES))
							)
						})),
						literal: Formatter.format,
						coverage: required<KillName | CheckKind | Loading>(
							[...KILL_NAMES, ...CHECKS, "in-process", "tree"],
							{ cases: 60, sense: notesOnly }
						),
						kept: [],
						runs: 16,
						shrink: boundedShrink(30),
						steerEvery: 8,
						caseHang: Duration.minutes(2)
					},
					(gate, c) =>
						Effect.scoped(
							Effect.gen(function* () {
								c.noteAll([...gate.kills, gate.check, gate.loading])
								const checkout = yield* checkoutOf
								const trees = yield* treesOf(checkout)
								const images = yield* imagesOf(checkout, trees)
								const subject: Subject = {
									id: PropertyId(gate.check),
									property: checkProperty(Arr.map(gate.kills, (name) => KILLS[name])),
									loading: gate.loading
								}
								const pool = yield* processPool
								const judged = yield* killsOf(
									pool,
									{ seed: 1, limits: runnerLimits },
									checkout,
									images,
									[subject]
								)
								deepStrictEqual(
									Arr.map(judged, reportOf),
									Arr.map(gate.kills, (name) => expectedOf(gate, name))
								)
							})
						)
				)
			)
	)
})
