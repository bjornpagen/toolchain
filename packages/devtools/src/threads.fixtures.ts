import { element, finite } from "@bjornpagen/testing/gen"
import { processors } from "@bjornpagen/testing/workers"
import { Array as Arr, Effect, FileSystem, Option, String as Str } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/**
 * What the threads property (threads.test.ts) draws and runs: each wrapper of the gate's tools as a task of a turbo run
 * that toolchain-turbo starts, the run a shape of tasks at a concurrency, turbo a stub on the PATH that answers its
 * configuration and its dry run as a real turbo of that shape would and runs the wrapper as its task, and the wrapper's
 * tool a stub that writes down what it was handed: the value of RAYON_NUM_THREADS and its arguments.
 */

/** A wrapper of the gate's tools, its entry in the dev tools' source, and the program it runs. */
export type Wrapped = Readonly<{
	entry: string
	program: string
	flag: "equals" | "apart" | "none"
}>

/** Each wrapper, by how its tool takes a count of threads: `--threads=N`, `--threads N`, or none but the variable. */
const WRAPPED: Arr.NonEmptyReadonlyArray<Wrapped> = [
	{ entry: "tool-oxlint.ts", program: "oxlint", flag: "equals" },
	{ entry: "tool-oxfmt.ts", program: "oxfmt", flag: "equals" },
	{ entry: "tool-fallow.ts", program: "fallow", flag: "apart" },
	{ entry: "tool-typecheck.ts", program: "effect-tsgo", flag: "none" }
]

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
	{ concurrency: "100%", tasks: 4 * processors, scriptless: 0 },
	{ concurrency: "25%", tasks: 4 * processors, scriptless: 0 }
]

/** A case: a wrapper, and the turbo run it is a task of. */
export type Threaded = Readonly<{ wrapped: Wrapped; shape: Shape }>

/** Every wrapper in every shape of run. */
export const threadings = finite((source): Threaded => ({
	wrapped: source.draw(element(WRAPPED)),
	shape: source.draw(element(SHAPES))
}))

/**
 * The tasks a run of `shape` executes at once on this machine: the fewer of its concurrency, as turbo's documentation
 * states it (a whole number of tasks, or a share of the processors rounded down, one at least), and the tasks it has.
 */
export const tasksOf = (shape: Shape): number =>
	Math.min(
		Str.endsWith("%")(shape.concurrency)
			? Math.max(1, Math.floor((processors * Number(Str.slice(0, -1)(shape.concurrency))) / 100))
			: Number(shape.concurrency),
		shape.tasks
	)

/** The variable a stub tool writes what it was handed to the file it names. */
const SEEN = "TOOLCHAIN_THREADS_SEEN"

/** A stub tool: it writes RAYON_NUM_THREADS and each argument it was handed, a line each, to the file SEEN names. */
const STUB_TOOL = `#!/bin/sh\nprintf '%s\\n' "$RAYON_NUM_THREADS" "$@" > "$${SEEN}"\n`

/**
 * A stub turbo of `shape`: its configuration names the shape's concurrency, its dry run plans its tasks and its
 * scriptless ones, and a run runs `wrapper` with the caller's environment, as turbo runs a task.
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
			`*) exec '${process.execPath}' '${wrapper}' --an-argument ;;`,
			"esac",
			""
		],
		"\n"
	)
}

/** What a stub tool was handed: the threads the variable said, and those its flag said, none for no flag. */
type Handed = Readonly<{ variable: number; flag: Option.Option<number> }>

/** The threads a tool's arguments hand it by its flag. */
const flagOf = (args: ReadonlyArray<string>, flag: Wrapped["flag"]): Option.Option<number> => {
	switch (flag) {
		case "equals":
			return Option.map(Arr.findFirst(args, Str.startsWith("--threads=")), (arg) =>
				Number(Str.slice("--threads=".length)(arg))
			)
		case "apart":
			return Option.flatMap(
				Arr.findFirstIndex(args, (arg) => arg === "--threads"),
				(at) => Option.map(Arr.get(args, at + 1), Number)
			)
		case "none":
			return Option.none()
	}
}

/**
 * Runs `toolchain-turbo run task` from the dev tools' directory in the checkout, `packageRoot` (Checkout.dir, so a
 * mutant of the dev tools in a worker tree is what the case runs), turbo a stub of the case's shape on the PATH in
 * `directory` that runs the case's wrapper as its task, its tool a stub too, and reads what the stub tool was handed.
 * The run's environment is the case's alone (extendEnv false): a run started as a task of a turbo run inherits its
 * TURBO_CONCURRENCY, which toolchain-turbo reads as turbo's concurrency, so the case would measure the host's run, not
 * its shape (trunk@toolchain at 7c9d754: a tool handed 32 threads, the machine over the outer run's two tasks, where
 * the case's six tasks at every processor hand it 10).
 */
export const handedTo = (packageRoot: string, directory: string, threaded: Threaded) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const stubs: ReadonlyArray<readonly [string, string]> = [
			[threaded.wrapped.program, STUB_TOOL],
			["turbo", stubTurbo(threaded.shape, `${packageRoot}/src/${threaded.wrapped.entry}`)]
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
					[SEEN]: seen
				},
				extendEnv: false,
				stdin: "ignore",
				stdout: "ignore",
				stderr: "inherit"
			})
		)
		const written = yield* fs.readFileString(seen)
		const [variable, ...args] = Str.split("\n")(Str.trimEnd(written))
		return {
			status: Number(status),
			handed: {
				variable: Number(variable),
				flag: flagOf(args, threaded.wrapped.flag)
			} satisfies Handed,
			passed: Arr.contains(args, "--an-argument")
		}
	})
