import { Array as Arr, Effect, FileSystem } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/**
 * What the compile-cache property (compile-cache.test.ts) runs: toolchain-turbo from the checkout, turbo a stub on the
 * PATH that runs as its task a node program enabling Node's compile cache naming no directory, as vite's, rolldown's,
 * jiti's and alchemy's commands do, which writes down the directory Node took.
 */

/** The variable the stub task writes the directory Node took to the file it names. */
const SEEN = "TOOLCHAIN_COMPILE_CACHE_SEEN"

/** The task: Node's compile cache enabled naming no directory, and the directory it took written down. */
const TASK = `const m = require("node:module"); m.enableCompileCache(); require("node:fs").writeFileSync(process.env.${SEEN}, String(m.getCompileCacheDir()))`

/** A stub turbo: its configuration and dry run as a run of one task, and a run that runs TASK with its environment. */
const stubTurbo = Arr.join(
	[
		"#!/bin/sh",
		'case " $* " in',
		`*" --dry=json "*) printf '%s\\n' '{"tasks":[{"command":"node script.ts"}]}' ;;`,
		`" config ") printf '%s\\n' '{"concurrency":"1"}' ;;`,
		`*) exec '${process.execPath}' -e '${TASK}' ;;`,
		"esac",
		""
	],
	"\n"
)

/**
 * Runs `toolchain-turbo run task` from the dev tools' directory in the checkout, `packageRoot` (Checkout.dir, so a
 * mutant of the dev tools is what the case runs), with only PATH (turbo the stub, in `directory`), HOME, TMPDIR and
 * XDG_CACHE_HOME in its environment, the last two under `directory`, and, when `inherited`, a NODE_COMPILE_CACHE under
 * that TMPDIR, as a caller's own may name; and reads the directory the task's compile cache took, beside the two it may
 * lie under.
 */
export const compileCacheOf = (packageRoot: string, directory: string, inherited: boolean) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const tmp = `${directory}/tmp`
		const cache = `${directory}/cache`
		yield* fs.makeDirectory(tmp, { recursive: true })
		yield* fs.writeFileString(`${directory}/turbo`, stubTurbo)
		yield* fs.chmod(`${directory}/turbo`, 0o755)
		const seen = `${directory}/seen.txt`
		const status = yield* spawner.exitCode(
			ChildProcess.make(process.execPath, [`${packageRoot}/src/turbo.ts`, "run", "task"], {
				env: {
					PATH: `${directory}:/usr/bin:/bin`,
					HOME: directory,
					TMPDIR: tmp,
					XDG_CACHE_HOME: cache,
					[SEEN]: seen,
					...(inherited ? { NODE_COMPILE_CACHE: `${tmp}/node-compile-cache` } : {})
				},
				extendEnv: false,
				stdin: "ignore",
				stdout: "ignore",
				stderr: "inherit"
			})
		)
		return { status: Number(status), took: yield* fs.readFileString(seen), tmp, cache }
	})
