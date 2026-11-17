#!/usr/bin/env -S node

import { Array as Arr, Effect } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { failureFrom } from "#shared/devtool.ts"
import { Repository } from "#shared/repository.ts"
import { runDevtool } from "#shared/run.ts"
import { rootIncludeOf } from "#workspace/root-files.ts"

/**
 * toolchain-oxlint-root: the root's lint, oxlint over exactly the paths the root tsconfig.json's include names, the
 * root's own files, which the root's typecheck reads as its program. One list says what the root's two checks read, so
 * a file the root typechecks is a file it lints (the workspace gate's root-files rule holds every root file to that
 * list and the root's oxlint script to this command). Every argument comes after the include's paths, so
 * `turbo run oxlint -- --fix` fixes them. It answers oxlint's exit status.
 */
const main = Effect.gen(function* () {
	const { root } = yield* Repository
	const { include } = yield* rootIncludeOf(root)
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	return yield* spawner
		.exitCode(
			ChildProcess.make("oxlint", [...include, ...Arr.drop(process.argv, 2)], {
				cwd: root,
				stdout: "inherit",
				stderr: "inherit"
			})
		)
		.pipe(Effect.mapError(failureFrom("oxlint could not be run over the root tsconfig's include")))
})

runDevtool(main)
