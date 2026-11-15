import {
	Array as Arr,
	Console,
	Duration,
	Effect,
	FileSystem,
	Option,
	Result,
	Stream,
	String as Str
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import {
	findingsOf,
	findingText,
	planOf,
	readTree,
	type Targets,
	type Trial
} from "#plants/tree.ts"
import { invocationOf } from "#shared/arguments.ts"
import { DevtoolFailure, failureFrom } from "#shared/devtool.ts"
import { covers, relativeTo, Repository } from "#shared/repository.ts"
import { runDevtool } from "#shared/run.ts"

/**
 * What a plant's trial says of one test that cites it:
 * - `red`: the test fails while the plant is planted and passes without it, as a plant must make it;
 * - `green`: the test passes while the plant is planted, so the bug the plant introduces is one no test catches;
 * - `stale`: the plant no longer applies to the tree, so it plants nothing until it is made again;
 * - `unjudged`: the test fails with no plant planted, so a red under the plant says nothing.
 */
type Verdict = "red" | "green" | "stale" | "unjudged"

/** One verdict: the plant, the test, and what the test did while the plant was planted. */
interface Judged {
	readonly plant: string
	readonly test: string
	readonly verdict: Verdict
}

/** A child run to completion: its exit status, its output on both streams in one log, and how long it took. */
interface Ran {
	readonly status: number
	readonly log: string
	readonly took: Duration.Duration
}

/** Runs `command` with `args` in `cwd` to completion, its stdin empty and both streams kept, in this process's environment. */
const runToEnd = Effect.fn("runToEnd")(function* (
	cwd: string,
	command: string,
	args: ReadonlyArray<string>
) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const [took, [stdout, stderr, status]] = yield* Effect.timed(
		Effect.scoped(
			Effect.flatMap(
				spawner.spawn(ChildProcess.make(command, args, { cwd, stdin: "ignore", extendEnv: true })),
				(handle) =>
					Effect.all(
						[
							Stream.mkString(Stream.decodeText(handle.stdout)),
							Stream.mkString(Stream.decodeText(handle.stderr)),
							handle.exitCode
						],
						{ concurrency: "unbounded" }
					)
			)
		)
	).pipe(Effect.mapError(failureFrom(`${command} ${Arr.join(args, " ")} could not be run`)))
	const ran: Ran = { status, log: `${stdout}${stderr}`, took }
	return ran
})

/** Runs git with `args` at the repository's root, failing unless it exits 0, and answers its output. */
const git = Effect.fn("git")(function* (args: ReadonlyArray<string>) {
	const { root } = yield* Repository
	const ran = yield* runToEnd(root, "git", args)
	if (ran.status !== 0) {
		return yield* DevtoolFailure.make({
			detail: `git ${Arr.join(args, " ")} exited with ${String(ran.status)}:\n${ran.log}`
		})
	}
	return ran.log
})

/** The files a plant changes, by path from the root, as git reads its patch. */
const touchedBy = Effect.fn("touchedBy")(function* (plant: string) {
	const numstat = yield* git(["apply", "--numstat", plant])
	return Arr.flatMap(Str.split("\n")(numstat), (line) =>
		Option.toArray(Option.fromNullishOr(Str.split("\t")(line)[2]))
	)
})

/** The files among `paths` that differ from HEAD or that git does not track, as `git status` lists them. */
const changedAmong = Effect.fn("changedAmong")(function* (paths: ReadonlyArray<string>) {
	const status = yield* git(["status", "--porcelain", "--untracked-files=all", "--", ...paths])
	return Arr.filter(Str.split("\n")(status), Str.isNonEmpty)
})

/**
 * Where `test` runs: the workspace package whose root holds it, whose own `test` script (its Vitest) runs it, and the
 * test's path from that root; or a failure naming the test no package holds.
 */
const runnerOf = Effect.fn("runnerOf")(function* (test: string) {
	const { root, packages } = yield* Repository
	const file = `${root}/${test}`
	return yield* Option.match(
		Arr.findFirst(packages, (selected) => covers({ selected, file })),
		{
			onNone: () =>
				Effect.fail(
					DevtoolFailure.make({
						detail: `${test} is in no workspace package, so no package's Vitest runs it`
					})
				),
			onSome: (holder) => Effect.succeed({ cwd: holder, file: relativeTo(holder)(file) })
		}
	)
})

/** A file name for a log of `test`, under a stem: the test's path with each separator a dash. */
const logName = (stem: string, test: string): string =>
	`${stem}--${Str.replaceAll("/", "-")(test)}.log`

/**
 * Runs `test` alone through its package's test script, as `pnpm -s test <file>` in the package runs it, writes its log
 * under `logs` and answers whether it passed.
 */
const runTest = Effect.fn("runTest")(function* (logs: string, stem: string, test: string) {
	const fs = yield* FileSystem.FileSystem
	const runner = yield* runnerOf(test)
	const ran = yield* runToEnd(runner.cwd, "pnpm", ["-s", "test", runner.file])
	const log = `${logs}/${logName(stem, test)}`
	yield* fs
		.writeFileString(log, ran.log)
		.pipe(Effect.mapError(failureFrom(`${log} could not be written`)))
	return { passed: ran.status === 0, took: ran.took, log }
})

/** A plant's name: the last segment of its path, without .patch. */
const stemOf = (plant: string): string =>
	Str.replace(".patch", "")(Arr.lastNonEmpty(Str.split("/")(plant)))

/**
 * One trial: the plant planted, each of its tests run, and the plant taken out again, whatever the runs did or however
 * they ended. Every test that passes without plants answers red or green; one that fails without them is unjudged and
 * not run. A plant that no longer applies is stale for every test. Once the plant is out, its files must be as they were
 * before it went in, or the run stops.
 */
const trialOf = Effect.fn("trialOf")(function* (
	logs: string,
	baseline: ReadonlyMap<string, boolean>,
	trial: Trial
) {
	const { root } = yield* Repository
	const judged = (test: string, verdict: Verdict): Judged => ({
		plant: trial.plant,
		test,
		verdict
	})
	const applies = yield* Effect.map(
		runToEnd(root, "git", ["apply", "--check", trial.plant]),
		(ran) => ran.status === 0
	)
	if (!applies) {
		return Arr.map(trial.tests, (test) => judged(test, "stale"))
	}
	const touched = yield* touchedBy(trial.plant)
	const unplant = Effect.andThen(git(["apply", "--reverse", trial.plant]), () =>
		Effect.flatMap(changedAmong(touched), (left) =>
			Arr.isReadonlyArrayNonEmpty(left)
				? Effect.die(
						DevtoolFailure.make({
							detail: `${trial.plant} came out but left its files changed:\n${Arr.join(left, "\n")}`
						})
					)
				: Effect.void
		)
	)
	return yield* Effect.acquireUseRelease(
		git(["apply", trial.plant]),
		() =>
			Effect.forEach(trial.tests, (test) =>
				baseline.get(test) === true
					? Effect.map(runTest(logs, stemOf(trial.plant), test), (ran) =>
							judged(test, ran.passed ? "green" : "red")
						)
					: Effect.succeed(judged(test, "unjudged"))
			),
		() => Effect.orDie(unplant)
	)
})

/** The command line: every plant (--all), or the tests and plants named, by path from the repository's root. */
const targetsOf = Effect.gen(function* () {
	const { root } = yield* Repository
	const invocation = yield* invocationOf(["--all"])
	const named = Arr.map(invocation.paths, relativeTo(root))
	const targets: Result.Result<Targets, string> = invocation.flags.has("--all")
		? Arr.isReadonlyArrayNonEmpty(named)
			? Result.fail("--all runs every plant: name no test or plant beside it")
			: Result.succeed({ kind: "all" })
		: Arr.isReadonlyArrayNonEmpty(named)
			? Result.succeed({ kind: "named", names: named })
			: Result.fail(
					"pnpm plants (--all | <test or plant>...): name the tests whose plants to run, or the plants, or pass --all"
				)
	return yield* Result.match(targets, {
		onFailure: (detail) => Effect.fail(DevtoolFailure.make({ detail })),
		onSuccess: (chosen) => Effect.succeed(chosen)
	})
})

/** A verdict's line: the verdict, the plant and the test. */
const lineOf = (judged: Judged): string =>
	`${Str.padEnd(9)(judged.verdict)}${judged.plant}  ${judged.test}`

/**
 * `pnpm plants`: each plant planted in turn, the tests that cite it run against it, and the plant taken out again.
 *
 *   pnpm plants <test or plant>...
 *   pnpm plants --all
 *
 * A test named runs against each plant it cites; a plant named runs against every test that cites it; --all runs every
 * plant a test cites. It refuses to start while the check finds anything (check.ts beside it) or while any file a plant
 * changes differs from HEAD, so taking a plant out restores exactly what was there. Each test first runs once with no
 * plant planted; then each plant, one at a time, goes in, its tests run one at a time through their package's test
 * script, and it comes out, on success, failure or interruption alike. Plants go into the working tree, so a run in a
 * checkout others share breaks their tree while a plant is in: run it in a clone of your own.
 *
 * It prints one line per plant and test, red, green, stale or unjudged, and the directory of every run's log, and exits
 * 0 when every line is red and 1 otherwise: a green plant is a bug no test catches, a stale one plants nothing, and an
 * unjudged one's test fails with no plant at all.
 */
const main = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const targets = yield* targetsOf
	const tree = yield* readTree
	const findings = findingsOf(tree)
	if (Arr.isReadonlyArrayNonEmpty(findings)) {
		return yield* DevtoolFailure.make({
			detail: `The plant check finds ${String(findings.length)} things, so no plant runs:\n${Arr.join(Arr.map(findings, findingText), "\n")}`
		})
	}
	const trials = yield* Result.match(planOf(tree, targets), {
		onFailure: (unknown) =>
			Effect.fail(
				DevtoolFailure.make({
					detail: `Neither a test citing a plant nor a plant a test cites: ${Arr.join(unknown, ", ")}`
				})
			),
		onSuccess: (planned) => Effect.succeed(planned)
	})
	const touchedLists = yield* Effect.forEach(trials, (trial) => touchedBy(trial.plant))
	const dirty = yield* changedAmong(Arr.dedupe(Arr.flatten(touchedLists)))
	if (Arr.isReadonlyArrayNonEmpty(dirty)) {
		return yield* DevtoolFailure.make({
			detail: `Files the plants change differ from HEAD, so taking a plant out could not restore them: commit or set them aside first.\n${Arr.join(dirty, "\n")}`
		})
	}
	const logs = yield* fs
		.makeTempDirectory({ prefix: "toolchain-plants-" })
		.pipe(Effect.mapError(failureFrom("The log directory could not be made")))
	const tests = Arr.dedupe(Arr.flatMap(trials, (trial) => trial.tests))
	yield* Console.log(
		`${String(trials.length)} plants against ${String(tests.length)} tests; logs in ${logs}`
	)
	const baselines = yield* Effect.forEach(tests, (test) =>
		Effect.tap(
			Effect.map(runTest(logs, "baseline", test), (ran) => [test, ran.passed] as const),
			([, passed]) =>
				Console.log(`${Str.padEnd(9)(passed ? "passes" : "FAILS")}(no plant)  ${test}`)
		)
	)
	const baseline = new Map(baselines)
	const trialLines = yield* Effect.forEach(trials, (trial) =>
		Effect.tap(trialOf(logs, baseline, trial), (lines) =>
			Effect.forEach(lines, (line) => Console.log(lineOf(line)), { discard: true })
		)
	)
	const judged = Arr.flatten(trialLines)
	const unred = Arr.filter(judged, (line) => line.verdict !== "red")
	yield* Console.log(
		Arr.isReadonlyArrayNonEmpty(unred)
			? `${String(unred.length)} of ${String(judged.length)} plant and test pairs are not red:\n${Arr.join(Arr.map(unred, lineOf), "\n")}\nlogs in ${logs}`
			: `every one of ${String(judged.length)} plant and test pairs is red; logs in ${logs}`
	)
	return Arr.isReadonlyArrayNonEmpty(unred) ? 1 : 0
})

runDevtool(main)
