#!/usr/bin/env -S node

import { Effect, Option, Stdio } from "effect"
import { Repository } from "#shared/repository.ts"
import { runDevtool } from "#shared/run.ts"
import { TOOLS, toolRun } from "#shared/threads.ts"
import { rootIncludeOf } from "#workspace/root-files.ts"

/**
 * toolchain-oxlint-root: the root's lint, oxlint over exactly the paths the root tsconfig.json's include names, the
 * root's own files, which the root's typecheck reads as its program. One list says what the root's two checks read, so
 * a file the root typechecks is a file it lints (the workspace gate's root-files rule holds every root file to that
 * list and the root's oxlint script to this command). Every argument comes after the include's paths, so
 * `turbo run oxlint -- --fix` fixes them. Its oxlint is toolchain-oxlint's, handed its task's threads
 * (shared/threads.ts), run in the root. It answers oxlint's exit status.
 */
const main = Effect.gen(function* () {
	const { root } = yield* Repository
	const { include } = yield* rootIncludeOf(root)
	const stdio = yield* Stdio.Stdio
	const args = yield* stdio.args
	return yield* toolRun(TOOLS.oxlint, [...include, ...args], Option.some(root))
})

runDevtool(main)
