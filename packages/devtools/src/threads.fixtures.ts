import { element, finite } from "@bjornpagen/testing/gen"
import { allowanceOf, allowanceVariable, cpuFactsAt } from "@bjornpagen/testing/workers"
import { Array as Arr, Effect, FileSystem, Option, String as Str } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/**
 * What the threads property (threads.test.ts) draws and runs: each wrapper of the gate's tools as a task of a turbo run
 * that toolchain-turbo starts, the run a shape of tasks at a concurrency, turbo a stub on the PATH that answers its
 * configuration and its dry run as a real turbo of that shape would and runs the wrapper as its task, and the wrapper's
 * tool a stub that writes down what it was handed: the value of RAYON_NUM_THREADS and its arguments.
 */

/**
 * A task of the run: a wrapper of the gate's tools, its entry in the dev tools' source, the program it runs, the flag
 * it reads its count by (`--threads=N`, `--threads N`, tsrs's `--checkers N`) and the count that flag states for a
 * task's share: the share itself for a pool's threads, and one for tsrs's checkers, a program checked by one checker
 * (shared/threads.ts ONE_CHECKER); or a test task, a process that sizes its test pool and its V8 pool from the testing
 * library's workers.ts, as toolchain-test and Vitest do.
 */
export type Wrapped =
	| Readonly<{
			kind: "tool"
			entry: string
			program: string
			flag: "equals" | "apart" | "checkers"
			flagged: (share: number) => number
	  }>
	| Readonly<{ kind: "test" }>

/** A pool's threads: the task's share. */
const theShare = (share: number): number => share

/** A program's checkers: one, whatever the share. */
const oneChecker = (): number => 1

/** Each wrapper, by how its tool takes its count and what the count is, and a test task. */
const WRAPPED: Arr.NonEmptyReadonlyArray<Wrapped> = [
	{ kind: "tool", entry: "tool-oxlint.ts", program: "oxlint", flag: "equals", flagged: theShare },
	{ kind: "tool", entry: "tool-oxfmt.ts", program: "oxfmt", flag: "equals", flagged: theShare },
	{ kind: "tool", entry: "tool-fallow.ts", program: "fallow", flag: "apart", flagged: theShare },
	{
		kind: "tool",
		entry: "tool-typecheck.ts",
		program: "effect-tsgo",
		flag: "checkers",
		flagged: oneChecker
	},
	{ kind: "test" }
]

/**
 * The CPU allowance a case's run reads of itself: the kernel's statement of this process's CPUs (workers.ts allowanceOf),
 * which the case's toolchain-turbo, started with no allowance of a run's (extendEnv false), reads as its own, the
 * machine its tasks share.
 */
const allowance = allowanceOf(cpuFactsAt(""))

/**
 * A turbo run: turbo's configured concurrency, the tasks its dry run plans that run a script, and those it plans for
 * packages without the script, which run nothing.
 */
export type Shape = Readonly<{ concurrency: string; tasks: number; scriptless: number }>

/**
 * A narrow run, six tasks at a concurrency of every processor, two more planned for packages without the script; a wide
 * run, more tasks than this machine has processors at that concurrency; and a run at a quarter of the processors.
 */
const SHAPES: Arr.NonEmptyReadonlyArray<Shape> = [
	{ concurrency: "100%", tasks: 6, scriptless: 2 },
	{ concurrency: "100%", tasks: 4 * allowance, scriptless: 0 },
	{ concurrency: "25%", tasks: 4 * allowance, scriptless: 0 }
]

/**
 * A case: a task, the turbo run it is a task of, and the CPU allowance the run's starter holds: the kernel's, or 4 given
 * it (TOOLCHAIN_CPU_ALLOWANCE), as a gate unit gives its run, which real turbo strips from its tasks' environment.
 */
export type Threaded = Readonly<{ wrapped: Wrapped; shape: Shape; given: Option.Option<number> }>

/** Every task in every shape of run, under the kernel's allowance and under 4 given. */
export const threadings = finite((source): Threaded => ({
	wrapped: source.draw(element(WRAPPED)),
	shape: source.draw(element(SHAPES)),
	given: source.draw(element([Option.none(), Option.some(4)] as const))
}))

/** The allowance a case's run holds: the one given its starter, else the kernel's. */
export const allowanceOfRun = (threaded: Threaded): number =>
	Option.getOrElse(threaded.given, () => allowance)

/**
 * The tasks a run of `shape` executes at once on this machine: the fewer of its concurrency, as turbo's documentation
 * states it (a whole number of tasks, or a share of the processors rounded down, one at least), and the tasks it has.
 */
export const tasksOf = (shape: Shape, cpus: number): number =>
	Math.min(
		Str.endsWith("%")(shape.concurrency)
			? Math.max(1, Math.floor((cpus * Number(Str.slice(0, -1)(shape.concurrency))) / 100))
			: Number(shape.concurrency),
		shape.tasks
	)

/** The variable a stub tool writes what it was handed to the file it names. */
const SEEN = "TOOLCHAIN_THREADS_SEEN"

/** A stub tool: it writes RAYON_NUM_THREADS and each argument it was handed, a line each, to the file SEEN names. */
const STUB_TOOL = `#!/bin/sh\nprintf '%s\\n' "$RAYON_NUM_THREADS" "$@" > "$${SEEN}"\n`

/**
 * A test task, given the testing library's workers.ts in the checkout: it writes its share (processors), its test
 * pool's workers (testWorkers), the V8 pool flag of the processes it starts (nodePoolFlag), its load's processes
 * (loadWorkers), and each argument it was handed, a line each, to the file SEEN names.
 */
const testTask = (workers: string): string =>
	Arr.join(
		[
			`import { loadWorkers, nodePoolFlag, processors, testWorkers } from "${workers}"`,
			`process.getBuiltinModule("node:fs").writeFileSync(process.env.${SEEN}, [processors, testWorkers, nodePoolFlag, loadWorkers, ...process.argv.slice(2)].join("\\n"))`,
			""
		],
		"\n"
	)

/**
 * A stub turbo of `shape`: its configuration names the shape's concurrency, its dry run plans its tasks and its
 * scriptless ones, and a run runs `wrapper` with the caller's environment but its CPU allowance, as turbo runs a task
 * in its strict environment mode, which passes every TURBO_ variable and strips every other.
 */
const stubTurbo = (shape: Shape, wrapper: string): string => {
	const planned = Arr.join(
		Arr.map(
			[
				...Array.from({ length: shape.tasks }, () => "node script.ts"),
				...Array.from({ length: shape.scriptless }, () => "<NONEXISTENT>")
			],
			(command) => `{"command":"${command}"}`
		),
		","
	)
	return Arr.join(
		[
			"#!/bin/sh",
			'case " $* " in',
			`*" --dry=json "*) printf '%s\\n' '{"tasks":[${planned}]}' ;;`,
			`" config ") printf '%s\\n' '{"concurrency":"${shape.concurrency}"}' ;;`,
			`*) exec env -u ${allowanceVariable} '${process.execPath}' '${wrapper}' --an-argument ;;`,
			"esac",
			""
		],
		"\n"
	)
}

/**
 * What a task was handed: a tool, the threads RAYON_NUM_THREADS said and those its flag said; a test task, its share,
 * its test pool's workers, its V8 pool's size and its load's processes.
 */
type Handed =
	| Readonly<{ kind: "tool"; variable: number; flag: Option.Option<number> }>
	| Readonly<{ kind: "test"; share: number; workers: number; pool: number; load: number }>

/** The count a tool's arguments hand it by its flag: its last, which the tool takes. */
const flagOf = (
	args: ReadonlyArray<string>,
	flag: "equals" | "apart" | "checkers"
): Option.Option<number> => {
	const apart = (name: string) =>
		Option.flatMap(
			Arr.findLastIndex(args, (arg) => arg === name),
			(at) => Option.map(Arr.get(args, at + 1), Number)
		)
	switch (flag) {
		case "equals":
			return Option.map(Arr.findLast(args, Str.startsWith("--threads=")), (arg) =>
				Number(Str.slice("--threads=".length)(arg))
			)
		case "apart":
			return apart("--threads")
		case "checkers":
			return apart("--checkers")
	}
}

/**
 * Runs `toolchain-turbo run task` from the dev tools' directory in the checkout, `packageRoot` (Checkout.dir, so a
 * mutant of the dev tools or the testing library in a worker tree is what the case runs), turbo a stub of the case's
 * shape on the PATH in `directory` that runs the case's task, a wrapper whose tool is a stub too or a test task, and
 * reads what the task was handed. The run's environment is the case's alone (extendEnv false): a run started as a task
 * of a turbo run inherits its TURBO_CONCURRENCY, which toolchain-turbo reads as turbo's concurrency, so the case would
 * measure the host's run, not its shape (trunk@toolchain at 7c9d754: a tool handed 32 threads, the machine over the
 * outer run's two tasks, where the case's six tasks at every processor hand it 10).
 */
export const handedTo = (packageRoot: string, directory: string, threaded: Threaded) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const task =
			threaded.wrapped.kind === "tool"
				? `${packageRoot}/src/${threaded.wrapped.entry}`
				: `${directory}/test-task.ts`
		const stubs: ReadonlyArray<readonly [string, string]> = [
			...(threaded.wrapped.kind === "tool"
				? [[threaded.wrapped.program, STUB_TOOL] as const]
				: [["test-task.ts", testTask(`${packageRoot}/../testing/src/workers.ts`)] as const]),
			["turbo", stubTurbo(threaded.shape, task)]
		]
		yield* Effect.forEach(
			stubs,
			([name, text]) =>
				Effect.andThen(
					fs.writeFileString(`${directory}/${name}`, text),
					fs.chmod(`${directory}/${name}`, 0o755)
				),
			{ discard: true }
		)
		const seen = `${directory}/seen.txt`
		const status = yield* spawner.exitCode(
			ChildProcess.make(process.execPath, [`${packageRoot}/src/turbo.ts`, "run", "task"], {
				env: {
					PATH: `${directory}:/usr/bin:/bin`,
					HOME: directory,
					XDG_CACHE_HOME: `${directory}/cache`,
					[SEEN]: seen,
					...Option.match(threaded.given, {
						onNone: () => ({}),
						onSome: (given) => ({ [allowanceVariable]: `${given}` })
					})
				},
				extendEnv: false,
				stdin: "ignore",
				stdout: "ignore",
				stderr: "inherit"
			})
		)
		const written = yield* fs.readFileString(seen)
		const lines = Str.split("\n")(Str.trimEnd(written))
		const handed: Handed =
			threaded.wrapped.kind === "tool"
				? {
						kind: "tool",
						variable: Number(Arr.getUnsafe(lines, 0)),
						flag: flagOf(Arr.drop(lines, 1), threaded.wrapped.flag)
					}
				: {
						kind: "test",
						share: Number(Arr.getUnsafe(lines, 0)),
						workers: Number(Arr.getUnsafe(lines, 1)),
						pool: Number(Str.slice("--v8-pool-size=".length)(Arr.getUnsafe(lines, 2))),
						load: Number(Arr.getUnsafe(lines, 3))
					}
		return {
			status: Number(status),
			handed,
			passed: Arr.contains(lines, "--an-argument")
		}
	})
