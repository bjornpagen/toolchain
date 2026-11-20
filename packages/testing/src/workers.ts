import { availableParallelism } from "node:os"

/**
 * How many test workers a run holds: half the logical CPUs this process may use, and one at least (Bjorn, 2026-11-20:
 * "they must cut their cpu usage in half"). The machine is shared: many agents' suites run on it at once, now that the
 * database lock that ran one at a time is retired, and a run that took every CPU left each of them a share of a machine
 * at a load of hundreds. Vitest's maxWorkers is this number, and a suite tier that gives each worker a resource of its
 * own (a cloned database, a claimed slot) creates and claims this many, so one constant states the width everywhere: a
 * mutation's pool, a cluster family's members and their sizing, a load's processes. It lives in a module of its own,
 * which loads no Vitest, so a script that sizes such a resource reads it without installing Vitest.
 *
 * It is derived from what the machine reports, availableParallelism(), read here and never written down as a number:
 * each test file runs in a forked Node process of its own, one JavaScript thread, so a run of this many processes holds
 * half the machine's CPUs at most.
 */
export const testWorkers: number = Math.max(1, Math.floor(availableParallelism() / 2))
