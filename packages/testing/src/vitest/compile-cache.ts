import { flushCompileCache } from "node:module"
import { Effect, Option } from "effect"
import { afterAll } from "vitest"
import { compileCached } from "#runner/compile-cache.ts"

/**
 * Where every test process of a project whose coverage is never read keeps the V8 code of what it loads, Node's compile
 * cache: the package root's directory in toolchain-test's store (runner/compile-cache.ts; the test processes run from
 * the package root). A process reads the code of the modules it shares with the run's other processes and with earlier
 * runs instead of compiling them again, and each of a run's processes loads the code under test whole, which is most of
 * what a short test file spends. Node checks each entry against its module's source, so an edited module is compiled
 * afresh. The cache is written once the file's tests are done, as Vitest may end the process with a signal before its
 * exit could write it. A project whose coverage is read never runs this setup (`defineTestConfig`): Node reads coverage
 * less precisely in code that came from it, and so neither do the processes such a project starts.
 *
 * The cache as this process enabled it is what Node's environment variable hands to every process this one starts (a
 * command line under test, a compiler): `enableCompileCache` reaches this process's own loads alone, and a child reads
 * NODE_COMPILE_CACHE as it starts. The account's switch (NODE_DISABLE_COMPILE_CACHE) is no reason to start without
 * one: compileCached takes it out, as the cache has its folder; a cache Node did not enable names no directory, and its
 * children start without one.
 */
const enabled = Effect.runSync(compileCached(process.cwd()))

if (Option.isSome(enabled)) {
	Object.assign(process.env, { NODE_COMPILE_CACHE: enabled.value })
}

afterAll(() => {
	flushCompileCache()
})
