#!/usr/bin/env -S node

import { Effect, Option, Stdio } from "effect"
import { runDevtool } from "#shared/run.ts"
import { TOOLS, toolRun } from "#shared/threads.ts"

/**
 * toolchain-typecheck: a package's typecheck, tsrs, Effect-patched by @effect/tsgo, over the tsconfig.json of the
 * directory it runs in, handed its task's threads (shared/threads.ts). The shared base makes it incremental: a
 * re-check reads the package's build info and checks only what changed. Every argument passes through, so the
 * typecheck from scratch is this same command with --incremental false (`turbo run typecheck -- --incremental false`),
 * and a package states its typecheck once. It answers tsrs's exit status.
 */
const main = Effect.flatMap(
	Effect.flatMap(Stdio.Stdio, (stdio) => stdio.args),
	(args) => toolRun(TOOLS.tsrs, args, Option.none())
)

runDevtool(main)
