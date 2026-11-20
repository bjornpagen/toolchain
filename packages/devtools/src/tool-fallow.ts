#!/usr/bin/env -S node

import { Effect, Option, Stdio } from "effect"
import { runDevtool } from "#shared/run.ts"
import { TOOLS, toolRun } from "#shared/threads.ts"

/**
 * toolchain-fallow: fallow with every argument it is given, handed its task's threads (shared/threads.ts): a root's
 * `dead-code` (`toolchain-fallow dead-code`) and `architecture` (`toolchain-fallow architecture`). It answers fallow's
 * exit status.
 */
const main = Effect.flatMap(
	Effect.flatMap(Stdio.Stdio, (stdio) => stdio.args),
	(args) => toolRun(TOOLS.fallow, args, Option.none())
)

runDevtool(main)
