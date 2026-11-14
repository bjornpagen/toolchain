import { availableParallelism } from "node:os"

/**
 * How many test workers a run holds: one a core of this machine. Vitest's maxWorkers is this number, and a suite tier
 * that gives each worker a resource of its own (a cloned database, a claimed slot) creates and claims this many, so one
 * constant states the width everywhere. It lives in a module of its own, which loads no Vitest, so a script that sizes
 * such a resource reads it without installing Vitest.
 */
export const testWorkers: number = availableParallelism()
