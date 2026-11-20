#!/usr/bin/env -S node

import { Effect, Option, Stdio } from "effect"
import { runDevtool } from "#shared/run.ts"
import { TOOLS, toolRun } from "#shared/threads.ts"

/**
 * toolchain-oxfmt: oxfmt with every argument it is given, handed its task's threads (shared/threads.ts): a root's
 * `format` (`toolchain-oxfmt --check .`) and the commit gate's check of the staged files. It answers oxfmt's exit
 * status.
 */
const main = Effect.flatMap(
	Effect.flatMap(Stdio.Stdio, (stdio) => stdio.args),
	(args) => toolRun(TOOLS.oxfmt, args, Option.none())
)

runDevtool(main)
