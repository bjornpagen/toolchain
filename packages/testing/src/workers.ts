import { availableParallelism } from "node:os"

/**
 * How many test workers a run holds: one a logical CPU of this machine. Vitest's maxWorkers is this number, and a suite
 * tier that gives each worker a resource of its own (a cloned database, a claimed slot) creates and claims this many,
 * so one constant states the width everywhere. It lives in a module of its own, which loads no Vitest, so a script that
 * sizes such a resource reads it without installing Vitest.
 *
 * It is what the machine reports, availableParallelism(), the logical CPUs this process may use, read here and never
 * minted as a limit: each test file runs in a forked Node process of its own, one JavaScript thread, so one process a
 * CPU is as many as can run at once. Vitest's own default keeps one CPU back for its main process
 * (availableParallelism() - 1); here the main process transforms no module (no module runner) and only runs the global
 * setup and gathers results, so no CPU is kept back.
 */
export const testWorkers: number = availableParallelism()
