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

/** The logical CPUs this process may use, availableParallelism(), which testWorkers and every task's threads derive from. */
export const processors: number = availableParallelism()

/**
 * How many workers a run of `properties` properties holds: testWorkers, or fewer when it has fewer properties, one at
 * least, since a run never holds more workers than it has work (main's ruling, 2026-11-20): every worker a run holds
 * leases a slot of each cluster its needs reach for the run's life, so a lane's run of four properties that held
 * testWorkers leased 32 slots of a shared family where it needed 4, and twelve such runs queued two at a time on 5491.
 */
export const runWorkers = (properties: number): number =>
	Math.max(1, Math.min(testWorkers, properties))

/**
 * How many threads one task of a run takes when the run executes `tasksAtOnce` tasks at once on `cpus` logical
 * CPUs: the CPUs over the tasks, rounded down, and one at least (GATETHREADS, 2026-11-20: each gate task's oxlint sized
 * its pool to the whole machine, 64 threads a task under a turbo of 32, and one live gate's oxlint ran at about 5,400%
 * CPU). A run of at most `cpus` tasks at once so hands out at most `cpus` threads in all; a run of more
 * hands each task its one.
 */
export const threadsPerTask = (cpus: number, tasksAtOnce: number): number =>
	Math.max(1, Math.floor(cpus / tasksAtOnce))
