import { regex } from "arkregex"
import { Array as Arr, Brand, Config, Effect, Option, Schema, String as Str } from "effect"

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

/** A variable of this process's environment, if it is set. */
const variable = (name: string): Option.Option<string> =>
	Effect.runSync(Effect.orDie(Config.option(Config.String(name))))

/**
 * The tasks turbo executes at once when its configuration names no concurrency: turbo's default.
 *
 * @limitKind published
 * @owner turbo 2.11.13 (the catalog's)
 * @unit tasks at once
 * @scope a turbo run whose turbo.json, environment and command line name no concurrency, as `turbo config` reports it
 *   (`"concurrency": null`)
 * @constraint configurable default
 * @source https://github.com/vercel/turborepo/blob/v2.11.13/docs/site/content/docs/reference/configuration.mdx#concurrency
 * @quote Default: `"10"`
 * @verified 2026-11-20
 */
const TURBO_DEFAULT_CONCURRENCY = 10

/** A count of tasks as turbo reads one: a whole number of at least one, or a share of the processors, `N%`. */
const tasksText = regex("^(?:([1-9][0-9]*)|([0-9]+(?:\\.[0-9]+)?)%)$")

/**
 * How many tasks a run executes at once on `processors` logical CPUs under turbo's concurrency `concurrency`, as turbo
 * reads it (its --concurrency, TURBO_CONCURRENCY or turbo.json's `concurrency`): `N%`, that share of the processors
 * rounded down, one at least; or `N`, a whole number of at least one; none for any other text, which turbo refuses too.
 */
export const tasksAtOnceOf = (concurrency: string, processors: Width): Option.Option<Width> => {
	const read = tasksText.exec(concurrency)
	if (read === null) {
		return Option.none()
	}
	const [, count, share] = read
	return count === undefined
		? Number(share) > 0
			? Option.some(widthOf((processors * Number(share)) / 100))
			: Option.none()
		: Option.some(widthOf(Number(count)))
}

/** What `turbo config` reports that a width reads: the concurrency its configuration resolves to, null for none. */
const TurboConfig = Schema.fromJsonString(
	Schema.Struct({ concurrency: Schema.NullOr(Schema.String) })
)

/**
 * The concurrency turbo's configuration resolves to in this process's directory, as `turbo config` reports it: its
 * text, or turbo's default where it names none.
 */
export const configuredConcurrency = (): string => {
	const reported = process
		.getBuiltinModule("node:child_process")
		.execFileSync("turbo", ["config"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
	return Option.getOrElse(
		Option.fromNullishOr(
			Effect.runSync(Effect.orDie(Schema.decodeEffect(TurboConfig)(reported))).concurrency
		),
		() => `${TURBO_DEFAULT_CONCURRENCY}`
	)
}

/**
 * The tasks a run executes at once under `concurrency` on `allowance` CPUs; a concurrency that is no count is turbo's
 * own refusal, and fails the process.
 */
const tasksUnder = (concurrency: string, allowance: Width): Width =>
	Option.getOrThrowWith(
		tasksAtOnceOf(concurrency, allowance),
		() =>
			new Error(
				`turbo's concurrency ${concurrency} is no count of tasks: a whole number of at least 1 or a share of the processors, N%`
			)
	)

/**
 * How many tasks the run this process is a task of executes at once on `allowance` CPUs, from where it runs: a task of a
 * run whose width toolchain-turbo told it (its TURBO_CONCURRENCY, the fewer of turbo's concurrency and the tasks the
 * run plans, devtools' runWidth); a task of a turbo run started without it (TURBO_HASH alone, which turbo sets for every
 * task), whose width is turbo's configuration's; or a process of no turbo run, a run of one task. Turbo passes every
 * TURBO_ variable to its tasks and strips every other in its strict environment mode, so a task reads these and no
 * allowance its run's starter read.
 */
const tasksAtOnceHere = (allowance: Width): Width => {
	const hash = variable("TURBO_HASH")
	return Option.match(variable("TURBO_CONCURRENCY"), {
		onSome: (concurrency) => tasksUnder(concurrency, allowance),
		onNone: () =>
			Option.isSome(hash) ? tasksUnder(configuredConcurrency(), allowance) : widthOf(1)
	})
}

/**
 * How many threads one task of a run takes when the run executes `tasksAtOnce` tasks at once on `cpus` logical
 * CPUs: the CPUs over the tasks, rounded down, and one at least (GATETHREADS, 2026-11-20: each gate task's oxlint sized
 * its pool to the whole machine, 64 threads a task under a turbo of 32, and one live gate's oxlint ran at about 5,400%
 * CPU). A run of at most `cpus` tasks at once so hands out at most `cpus` threads in all; a run of more
 * hands each task its one.
 */
export const threadsPerTask = (cpus: Width, tasksAtOnce: Width): Width =>
	widthOf(cpus / tasksAtOnce)

/**
 * The variable a process is given its run's CPU share in: the share the run's first process derived of itself
 * (shareHere), which every process it starts takes as its own, so one run is one width however its processes are
 * placed, and whenever they start. The runner's pool gives it every worker it forks (runner/pool.ts), and a Vitest
 * config every test process (vitest/config.ts). It is the toolchain's plumbing between its own processes, never a
 * width a person chooses: a process started by no process of a run derives its own.
 */
export const allowanceVariable = "TOOLCHAIN_CPU_ALLOWANCE"

/**
 * The variable a turbo run's tasks are given the run's CPU allowance in: the allowance of the process that started the
 * run (devtools' toolchain-turbo sets it to its own processors), carried under turbo's prefix, since turbo passes every
 * TURBO_ variable to its tasks and strips every other in its strict environment mode, allowanceVariable among them. A
 * task divides it among the tasks the run executes at once (shareHere), so a run given 4 CPUs hands each of four tasks
 * one, where each task read the kernel's 64 and took 16 (PRINTONCE3's gate at an allowance of 4: 13 to 16 cores).
 */
export const runAllowanceVariable = "TURBO_TOOLCHAIN_CPU_ALLOWANCE"

/** An allowance as allowanceVariable or runAllowanceVariable carries it: a whole number of CPUs, one at least, in decimal. */
const allowanceText = regex("^[1-9][0-9]*$")

/** An allowance a variable carries, or the failure of a broken parent that set one that is none. */
const allowanceGiven = (name: string, given: string): Width => {
	if (!allowanceText.test(given)) {
		throw new Error(`${name}=${given} is no CPU allowance: a whole number of CPUs it must be`)
	}
	return widthOf(Number(given))
}

/**
 * This process's CPU share: its run's, where the process that started it gave it one (allowanceVariable); else its
 * task's share of its run's allowance, the allowance its turbo run's starter handed its tasks (runAllowanceVariable) or
 * what the kernel states of it now (allowanceOf over cpuFactsAt the machine's root), over the tasks its enclosing turbo
 * run executes at once (threadsPerTask, tasksAtOnceHere), so a test task beside three others of a
 * `pnpm check --concurrency=4` at an allowance of 4 holds one CPU, never all four. A variable that is no allowance is a
 * broken parent's, and fails the process.
 */
const shareHere = (): Width =>
	Option.match(variable(allowanceVariable), {
		onNone: () => {
			const allowance = Option.match(variable(runAllowanceVariable), {
				onNone: () => allowanceOf(cpuFactsAt("")),
				onSome: (given) => allowanceGiven(runAllowanceVariable, given)
			})
			return threadsPerTask(allowance, tasksAtOnceHere(allowance))
		},
		onSome: (given) => allowanceGiven(allowanceVariable, given)
	})

/**
 * The logical CPUs this process may keep busy at once, its task's share of its CPU allowance (shareHere), read once as
 * the module loads: the one source of every width a run takes, each tool's threads (devtools' toolRun), each test
 * pool's workers (testWorkers), and the V8 platform pool of each Node process the toolchain starts (nodePoolFlag).
 */
export const processors: Width = shareHere()

/**
 * The flag that holds a Node process's V8 platform pool, its background threads of garbage collection and compilation,
 * to this process's share (processors), where Node sizes it to the machine's CPUs: on each Node process the toolchain
 * starts, on its own command line, since NODE_OPTIONS does nothing in this Node.
 */
export const nodePoolFlag = `--v8-pool-size=${processors}`

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
