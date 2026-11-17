import { resolveKnown } from "#runner/resolutions.ts"

/**
 * The command line (runner/cli.ts), which toolchain-test's entry runs (scripts/toolchain-test.sh starts this module)
 * once it answers this process's resolutions from what it resolved before (runner/resolutions.ts), installed before
 * anything else loads: a pool of this process then hands its workers every resolution of the runner's modules, the
 * runner config's and the test modules'.
 */
const commandLine = (): Promise<unknown> => import("#runner/cli.ts")

resolveKnown()
await commandLine()
