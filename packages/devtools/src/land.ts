#!/usr/bin/env -S node

import { Console, Effect, String as Str } from "effect"
import { repositoryToolchain } from "#shared/config.ts"
import { runDevtool } from "#shared/run.ts"

/**
 * toolchain-land's binding (bin/land.sh): the `land` of the toolchain.config.ts of the repository it runs in, printed as
 * the one line of shell assignments land.sh evaluates, `lock='~/…' branch='…'`, each value single-quoted, so no value
 * a config holds is read by the shell as anything but itself. A config that is missing or that binds no landing fails
 * the run, as every tool's does: a landing never runs on a binding it could not read.
 */

/** A value as a shell word that is exactly it: single-quoted, each quote it holds closed, escaped and reopened. */
const quoted = (value: string): string => `'${Str.replaceAll("'", "'\\''")(value)}'`

const main = Effect.gen(function* () {
	const { land } = yield* repositoryToolchain
	yield* Console.log(`lock=${quoted(land.lock)} branch=${quoted(land.branch)}`)
	return 0
})

runDevtool(main)
