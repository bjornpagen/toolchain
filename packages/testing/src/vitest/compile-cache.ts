import { enableCompileCache, flushCompileCache } from "node:module"
import { afterAll } from "vitest"

/**
 * Where every test process of a project whose coverage is never read keeps the V8 code of what it loads, Node's compile
 * cache: under the package's node_modules (the test processes run from the package root). A process reads the code of
 * the modules it shares with the run's other processes and with earlier runs instead of compiling them again, and each
 * of a run's processes loads the code under test whole, which is most of what a short test file spends. Node checks
 * each entry against its module's source, so an edited module is compiled afresh. The cache is written once the file's
 * tests are done, as Vitest may end the process with a signal before its exit could write it. A project whose coverage
 * is read never runs this setup (`defineTestConfig`): Node reads coverage less precisely in code that came from it,
 * and so neither do the processes such a project starts.
 */
const compileCacheDirectory = `${process.cwd()}/node_modules/.cache/node-compile-cache`

/**
 * The cache as this process enabled it, which Node's environment variable hands to every process this one starts (a
 * command line under test, a compiler): `enableCompileCache` reaches this process's own loads alone, and a child reads
 * NODE_COMPILE_CACHE as it starts. The directory is the one Node keeps its versioned entries under, so a child shares
 * this process's entries. A cache Node could not enable names no directory, and its children start without one.
 */
const enabled = enableCompileCache(compileCacheDirectory)

if (enabled.directory !== undefined) {
	Object.assign(process.env, { NODE_COMPILE_CACHE: enabled.directory })
}

afterAll(() => {
	flushCompileCache()
})
