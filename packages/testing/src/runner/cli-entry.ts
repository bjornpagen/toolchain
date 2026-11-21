import { resolveKnown } from "#runner/resolutions.ts"

/**
 * The command line (runner/cli.ts), which toolchain-test's entry runs (scripts/toolchain-test.sh starts this module)
 * once it answers this process's resolutions from what it resolved before (runner/resolutions.ts), installed before
 * anything else loads: a pool of this process then hands its workers every resolution of the runner's modules, the
 * runner config's and the test modules'. Before the command line loads, it enables the package root's compile cache
 * (runner/compile-cache.ts), so the runner's own modules past Effect's are compiled once for every run of the root.
 */
const commandLine = (): Promise<unknown> => import("#runner/cli.ts")

resolveKnown()
const [{ Effect }, { compileCached }] = await Promise.all([
	import("effect"),
	import("#runner/compile-cache.ts")
])
Effect.runSync(compileCached(process.cwd()))
await commandLine()
