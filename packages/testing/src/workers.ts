import { availableParallelism } from "node:os"
import { Config, Effect, Schema } from "effect"

/**
 * How many test workers a run holds: TOOLCHAIN_TEST_WORKERS when the environment sets it, a whole number above zero,
 * else one a core of this machine. A machine that many runs share (cassowary's 64 cores, where several repositories'
 * suites, linters and type checks run at once) caps every run there; a run on its own takes every core. A value that is
 * not a whole number above zero fails the config that reads it, never falls back. Vitest's maxWorkers is this number,
 * and a suite tier that gives each worker a resource of its own (a cloned database, a claimed slot) creates and claims
 * this many, so one constant states the width everywhere. It lives in a module of its own, which loads no Vitest, so a
 * script that sizes such a resource reads it without installing Vitest.
 */
export const testWorkers: number = Effect.runSync(
	Config.schema(Schema.Int.check(Schema.isGreaterThan(0)), "TOOLCHAIN_TEST_WORKERS").pipe(
		Config.withDefault(availableParallelism())
	)
)
