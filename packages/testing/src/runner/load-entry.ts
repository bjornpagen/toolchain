import { handedFrom, resolveKnown } from "#runner/resolutions.ts"

/**
 * A load's process (`toolchain-test load`, runner/loads.ts), started as a pool's worker starts (runner/worker-entry.ts):
 * it takes the resolutions its parent wrote to its standard input and installs them before anything else loads
 * (runner/resolutions.ts), so the runner's modules and its test module's closure resolve from what the load's parent
 * and its earlier processes resolved, then loads its one module (runner/load-child.ts).
 *
 *   node runner/load-entry.ts <package root> <module>
 */
const child = (): Promise<unknown> => import("#runner/load-child.ts")

handedFrom(0)
resolveKnown()
await child()
