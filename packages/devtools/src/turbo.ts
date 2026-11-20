#!/usr/bin/env -S node

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
 * concurrency alone would have handed it one thread, and a run of more tasks than processors hands each one. A
 * repository's scripts run their turbo through it. It answers turbo's exit status.
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
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	return yield* spawner
		.exitCode(
			ChildProcess.make("turbo", args, {
				env: { TURBO_CONCURRENCY: `${width}` },
				extendEnv: true,
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit"
			})
		)
		.pipe(Effect.mapError(failureFrom("turbo could not be run")))
})

runDevtool(main)
