import { regex } from "arkregex"
import { Array as Arr, Brand, Config, Effect, Option, String as Str } from "effect"

/**
 * What the kernel states of the CPUs a process may keep busy at once: its affinity, the `Cpus_allowed_list` of
 * /proc/self/status (`0-63`, `0-7,16-23`, `5`), and the cpu.max of each cgroup from its own to the hierarchy's root, the
 * path /proc/self/cgroup names (cgroup v2's one line, `0::<path>`), its own first: each `<quota> <period>` in
 * microseconds, or `max <period>` where the cgroup sets no quota, and none where the cgroup has no cpu.max at all (its
 * parent enables no cpu controller for it, as at the hierarchy's root).
 */
export type CpuFacts = Readonly<{ affinity: string; limits: ReadonlyArray<string> }>

/** A run of CPUs in an affinity list: one CPU (`5`) or a range (`0-7`), both ends counted. */
const cpuRun = regex("^([0-9]+)(?:-([0-9]+))?$")

/** How many CPUs an affinity list names: the sum of its runs' sizes. */
const affinityCount = (list: string): number =>
	Arr.reduce(Str.split(Str.trim(list), ","), 0, (sum, part) => {
		const run = cpuRun.exec(part)
		if (run === null) {
			throw new Error(`the affinity list ${list} holds ${part}, which is no CPU or range of them`)
		}
		const [, first, last = first] = run
		return sum + Number(last) - Number(first) + 1
	})

/** A cgroup's cpu.max: `max <period>`, no quota, or `<quota> <period>`, both in microseconds. */
const cpuMax = regex("^(max|[0-9]+) ([0-9]+)$")

/**
 * The whole CPUs a cgroup's cpu.max lets its tasks keep busy at once: its quota over its period, rounded down, and no
 * bound where it sets no quota.
 */
const quotaCpus = (limit: string): number => {
	const read = cpuMax.exec(Str.trim(limit))
	if (read === null) {
		throw new Error(`a cgroup's cpu.max reads ${limit}, which is no quota and period`)
	}
	const [, quota, period] = read
	return quota === "max" ? Number.POSITIVE_INFINITY : Math.floor(Number(quota) / Number(period))
}

/**
 * A width: how many of something a run holds or does at once (CPUs, workers, threads, tasks, places, a member's
 * connections, a message's units), a whole number, one at least. A width of zero is no smaller run but none at all: a
 * gate unit pinned to 8 CPUs read nproc 8, its nproc/16 came to 0, VITEST_MAX_WORKERS=0 ran no test, and Vitest exited 0
 * (edullm's gate, 2026-11-24). So every width the toolchain derives is minted by widthOf, its one floor, and whatever
 * takes a width (a pool's places, Vitest's maxWorkers, a tool's threads) takes this type, never a bare number.
 */
export type Width = number & Brand.Brand<"Width">

const Width = Brand.nominal<Width>()

/**
 * The width a derivation comes to (`size`: a share, a quotient, the fewer of two counts), rounded down, and one at
 * least: the one floor of every width (Width). A size that is no finite number is a broken derivation's (a division by
 * zero, a count never read), and fails the process.
 */
export const widthOf = (size: number): Width => {
	if (!Number.isFinite(size)) {
		throw new Error(`a width derived from ${size}, which is no finite number of anything`)
	}
	return Width(Math.max(1, Math.floor(size)))
}

/**
 * A process's CPU allowance from what the kernel states of it (CpuFacts): the CPUs its affinity names, never more than
 * the whole CPUs any cgroup it runs under lets its tasks keep busy (each cpu.max from its own cgroup to the root, the
 * tightest of them binding), and one at least (widthOf), so a quota of part of a CPU is one. A quota throttles every
 * task of its cgroup and of the cgroups below it, so a process under a slice held to 16 CPUs keeps 16 busy whatever its
 * affinity and its own cgroup say. Node's availableParallelism() is no such reading: on Node 26.13.1 a unit with
 * CPUQuota=400% in a slice held to 16 CPUs reads 16, the slice's quota in place of its own (cassowary, 2026-11-24), so
 * a run under a quota sized itself past it.
 */
export const allowanceOf = (facts: CpuFacts): Width =>
	widthOf(
		Arr.reduce(facts.limits, affinityCount(facts.affinity), (least, limit) =>
			Math.min(least, quotaCpus(limit))
		)
	)

/** What precedes the affinity list in /proc/<pid>/status. */
const affinityLine = regex("^Cpus_allowed_list:\\s*(.*)$", "m")

/** What precedes a process's cgroup path in /proc/<pid>/cgroup: cgroup v2's hierarchy 0, with no controllers. */
const unifiedLine = regex("^0::(.*)$", "m")

/**
 * What the kernel states of this process's CPUs (CpuFacts), read from the files under `root`, a directory every path
 * read is prefixed with (the empty text for the machine's own; a test gives a tree of its own): /proc/self/status's
 * affinity, /proc/self/cgroup's path, and the cpu.max under /sys/fs/cgroup of that cgroup and of each of its
 * ancestors, its own first and the hierarchy's root last, each cgroup that has none passed over.
 */
export const cpuFactsAt = (root: string): CpuFacts => {
	const { existsSync, readFileSync } = process.getBuiltinModule("node:fs")
	const status = readFileSync(`${root}/proc/self/status`, "utf8")
	const affinity = affinityLine.exec(status)?.[1]
	if (affinity === undefined) {
		throw new Error(`${root}/proc/self/status states no Cpus_allowed_list`)
	}
	const membership = readFileSync(`${root}/proc/self/cgroup`, "utf8")
	const path = unifiedLine.exec(membership)?.[1]
	if (path === undefined) {
		throw new Error(`${root}/proc/self/cgroup names no cgroup of the unified hierarchy (0::<path>)`)
	}
	const parts = Arr.filter(Str.split(path, "/"), Str.isNonEmpty)
	const cgroups = Array.from({ length: parts.length + 1 }, (_, up) =>
		Arr.join(
			Arr.map(Arr.take(parts, parts.length - up), (part) => `/${part}`),
			""
		)
	)
	const files = Arr.filter(
		Arr.map(cgroups, (cgroup) => `${root}/sys/fs/cgroup${cgroup}/cpu.max`),
		(file) => existsSync(file)
	)
	return { affinity, limits: Arr.map(files, (file) => readFileSync(file, "utf8")) }
}

/**
 * The variable a process is given its run's CPU allowance in: the allowance the run's first process read of itself
 * (allowanceOf), which every process it starts takes as its own, so one run is one width however its processes are
 * placed, and whenever they start. The runner's pool gives it every worker it forks (runner/pool.ts), and a Vitest
 * config every test process (vitest/config.ts). It is the toolchain's plumbing between its own processes, never a
 * width a person chooses: a process started by no process of a run reads its own.
 */
export const allowanceVariable = "TOOLCHAIN_CPU_ALLOWANCE"

/** An allowance as allowanceVariable carries it: a whole number of CPUs, one at least, in decimal. */
const allowanceText = regex("^[1-9][0-9]*$")

/**
 * This process's CPU allowance: its run's, where the process that started it gave it one (allowanceVariable), else what
 * the kernel states of it now (allowanceOf over cpuFactsAt the machine's root). A variable that is no allowance is a
 * broken parent's, and fails the process.
 */
const allowanceHere = (): Width =>
	Option.match(Effect.runSync(Effect.orDie(Config.option(Config.String(allowanceVariable)))), {
		onNone: () => allowanceOf(cpuFactsAt("")),
		onSome: (given) => {
			if (!allowanceText.test(given)) {
				throw new Error(
					`${allowanceVariable}=${given} is no CPU allowance: a whole number of CPUs it must be`
				)
			}
			return widthOf(Number(given))
		}
	})

/**
 * The logical CPUs this process may keep busy at once, its CPU allowance (allowanceHere), read once as the module loads:
 * what testWorkers and every task's threads derive from, the one source of every width a run takes.
 */
export const processors: Width = allowanceHere()

/**
 * How many test workers a run of `allowance` CPUs holds: half of them, and one at least (Bjorn, 2026-11-20: "they must
 * cut their cpu usage in half"). The machine is shared: many agents' suites run on it at once, now that the database
 * lock that ran one at a time is retired, and a run that took every CPU left each of them a share of a machine at a load
 * of hundreds. Each test file runs in a forked Node process of its own, one JavaScript thread, so a run of this many
 * processes holds half its CPUs at most.
 */
export const workersOf = (allowance: Width): Width => widthOf(allowance / 2)

/**
 * How many test workers a run holds: workersOf this process's CPU allowance (processors). Vitest's maxWorkers is this
 * number, and a suite tier that gives each worker a resource of its own (a cloned database, a claimed slot) creates and
 * claims this many, so one constant states the width everywhere: a mutation's pool, the width a cluster family's
 * members are sized for (pg/family.ts CheckoutFamily's width), a load's processes. It lives in a module of its own,
 * which loads no Vitest, so a script that sizes such a resource reads it without installing Vitest.
 */
export const testWorkers: Width = workersOf(processors)

/**
 * How many workers a run of `properties` properties holds: testWorkers, or fewer when it has fewer properties, one at
 * least, since a run never holds more workers than it has work (main's ruling, 2026-11-20): every worker a run holds
 * leases a slot of each cluster its needs reach for the run's life, so a lane's run of four properties that held
 * testWorkers leased 32 slots of a shared family where it needed 4, and twelve such runs queued two at a time on 5491.
 */
export const runWorkers = (properties: number): Width => widthOf(Math.min(testWorkers, properties))

/**
 * How many threads one task of a run takes when the run executes `tasksAtOnce` tasks at once on `cpus` logical
 * CPUs: the CPUs over the tasks, rounded down, and one at least (GATETHREADS, 2026-11-20: each gate task's oxlint sized
 * its pool to the whole machine, 64 threads a task under a turbo of 32, and one live gate's oxlint ran at about 5,400%
 * CPU). A run of at most `cpus` tasks at once so hands out at most `cpus` threads in all; a run of more
 * hands each task its one.
 */
export const threadsPerTask = (cpus: Width, tasksAtOnce: Width): Width =>
	widthOf(cpus / tasksAtOnce)
