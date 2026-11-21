#!/usr/bin/env -S node

import { compileCacheOf } from "@bjornpagen/testing/compile-cache"
import { Effect, Schema, Stdio } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { failureFrom } from "#shared/devtool.ts"
import { runDevtool } from "#shared/run.ts"
import { runWidth } from "#shared/threads.ts"

/**
 * toolchain-turbo: `turbo run` with every argument it is given, at the width it executes at (shared/threads.ts
 * runWidth: the fewer of turbo's concurrency and the tasks its dry run plans), which it sets as TURBO_CONCURRENCY:
 * turbo runs at it and passes it to every task, whose tool's wrapper hands its tool the machine's logical CPUs over it.
 * So a check of six tasks at a concurrency of every processor hands each tool a sixth of the machine, where the
 * concurrency alone would have handed it one thread, and a run of more tasks than processors hands each one. It sets
 * NODE_COMPILE_CACHE to the repository root's compile cache (testing's runner/compile-cache.ts: its own directory in
 * toolchain-test's store, which no other checkout writes), which turbo passes to every task (turbo.json's
 * globalPassThroughEnv, which the workspace gate holds a repository to: workspace/compile-cache.ts): a tool a task runs
 * that enables Node's compile cache naming no directory (vite's, rolldown's, jiti's and alchemy's commands) keeps it
 * there, where Node would keep it under os.tmpdir(), a tmpfs of bounded inodes on a machine like cassowary (main,
 * 2026-11-20: /tmp at 1,048,460 of its 1,048,576 inodes, 435,000 of them node-compile-cache entries, every lane's shell
 * failing with ENOSPC). A repository's scripts run their turbo through it. It answers turbo's exit status.
 */

/** Its arguments: `run` and turbo run's. */
const Arguments = Schema.TupleWithRest(Schema.Tuple([Schema.Literal("run")]), [Schema.String])

const main = Effect.gen(function* () {
	const stdio = yield* Stdio.Stdio
	const given = yield* stdio.args
	const args = yield* Schema.decodeUnknownEffect(Arguments)(given).pipe(
		Effect.mapError(failureFrom("usage: toolchain-turbo run <turbo run's arguments>"))
	)
	const width = yield* runWidth(args)
	const compiled = yield* compileCacheOf(process.cwd()).pipe(
		Effect.mapError(failureFrom("the compile cache's directory could not be read"))
	)
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	return yield* spawner
		.exitCode(
			ChildProcess.make("turbo", args, {
				env: { TURBO_CONCURRENCY: `${width}`, NODE_COMPILE_CACHE: compiled },
				extendEnv: true,
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit"
			})
		)
		.pipe(Effect.mapError(failureFrom("turbo could not be run")))
})

runDevtool(main)
