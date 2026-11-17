import { handedFrom, resolveKnown } from "#runner/resolutions.ts"

/**
 * The worker (runner/worker.ts), which a pool's worker's entry runs (runner/pool.ts forks this module) once it holds
 * the resolutions its parent wrote to its standard input, installed before anything else loads (runner/resolutions.ts):
 * its own modules, the runner config's and each test module's resolve from its parent's answers where the parent
 * resolved them. It reads exactly the payload its parent wrote, and its parent then closes the stream, so a process it
 * starts on its standard input reads its end, as on /dev/null.
 *
 *   node runner/worker-entry.ts <package root> <index> <workers> <notes | blocks>
 */
const worker = (): Promise<unknown> => import("#runner/worker.ts")

handedFrom(0)
resolveKnown()
await worker()
