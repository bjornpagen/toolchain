import { Array as Arr, Effect, FileSystem, Option, Schema, String as Str } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { array, boolean, element, type Gen, int, option, weighted } from "#gen.ts"
import type { CheckoutDir } from "#mutate/checkout.ts"

/**
 * What the allowance properties (workers.test.ts) draw and make: a process's CPUs as the kernel states them, written as
 * the kernel's files in a tree of the case's own; and a unit of systemd's of the case's own limits, which reads its own
 * allowance as every process does.
 */

/**
 * What one cgroup of a process's ancestry states in its cpu.max: nothing, the file absent (its parent enables no cpu
 * controller for it); no quota, `max <period>`; or a quota of `quota` microseconds a `period`.
 */
export type Limit =
	| Readonly<{ kind: "none" }>
	| Readonly<{ kind: "unbounded"; period: number }>
	| Readonly<{ kind: "quota"; quota: number; period: number }>

/**
 * A process's CPUs as a case draws them: its affinity, runs of CPUs ascending and apart (each its first CPU and how many
 * it holds); the cpu.max of each cgroup of its ancestry, its own first and the hierarchy's root last, so its cgroup lies
 * `levels.length - 1` deep; and whether its /proc/self/cgroup names a cgroup v1 hierarchy before the unified one.
 */
export type Tree = Readonly<{
	runs: Arr.NonEmptyReadonlyArray<readonly [first: number, count: number]>
	levels: Arr.NonEmptyReadonlyArray<Limit>
	legacy: boolean
}>

/** The periods a cpu.max states: systemd's 100 ms, and a shorter and a longer one. */
const periods = [100_000, 50_000, 1_000_000] as const

/**
 * The least quota the kernel takes a period, in microseconds (cgroup-v2.rst, cpu.max: its quota is at least 1 ms).
 *
 * @formatConstant the kernel's least CFS bandwidth quota, 1 ms
 */
const leastQuota = 1000

/** A quota of `period`: whole CPUs past the machine's and a remainder of any part of one, at least the kernel's least. */
const quotaOf =
	(period: number): Gen<Limit> =>
	(source) => {
		const cpus = source.draw(int(0, 80))
		const part = source.draw(element([0, leastQuota, period / 2, period - 1]))
		return { kind: "quota", quota: Math.max(leastQuota, cpus * period + part), period }
	}

/** One cgroup's cpu.max: none, no quota, or a quota, mostly a quota. */
const limit: Gen<Limit> = (source) => {
	const period = source.draw(element(periods))
	return source.draw(
		weighted<Limit>([
			[2, () => ({ kind: "none" })],
			[1, () => ({ kind: "unbounded", period })],
			[4, quotaOf(period)]
		])
	)
}

/** Every tree a case draws: one to three runs of CPUs, an ancestry of one to four cgroups, and a legacy line or none. */
export const trees: Gen<Tree> = (source) => {
	const drawn = source.draw(
		array((inner) => [inner.draw(int(0, 8)), inner.draw(int(1, 40))] as const, { min: 1, max: 3 })
	)
	const runs = Arr.map(drawn, ([gap, count], at) => {
		const before = Arr.reduce(Arr.take(drawn, at), 0, (end, [g, c]) => end + g + c + 1)
		return [before + gap, count] as const
	})
	const levels = source.draw(array(limit, { min: 1, max: 4 }))
	return {
		runs: Arr.isReadonlyArrayNonEmpty(runs) ? runs : [[0, 1]],
		levels: Arr.isReadonlyArrayNonEmpty(levels) ? levels : [{ kind: "none" }],
		legacy: source.draw(boolean)
	}
}

/** The whole CPUs a cgroup's limit lets its tasks keep busy, or none where it sets no quota. */
export const cpusOf = (level: Limit): Option.Option<number> =>
	level.kind === "quota" ? Option.some(Math.floor(level.quota / level.period)) : Option.none()

/** How many CPUs a tree's affinity names. */
export const affinityOf = (tree: Tree): number =>
	Arr.reduce(tree.runs, 0, (sum, [, count]) => sum + count)

/** A tree's affinity as the kernel lists it: `<first>` or `<first>-<last>` a run, joined by commas. */
const affinityList = (tree: Tree): string =>
	Arr.join(
		Arr.map(tree.runs, ([first, count]) =>
			count === 1 ? `${first}` : `${first}-${first + count - 1}`
		),
		","
	)

/** The cgroup at level `up` of a tree's ancestry (0 its own), as /proc/self/cgroup's path names it: `/` its root. */
const cgroupAt = (tree: Tree, up: number): string => {
	const depth = tree.levels.length - 1
	return Arr.join(
		Array.from({ length: depth - up }, (_, at) => `/level-${at + 1}.slice`),
		""
	)
}

/**
 * `tree` written as the kernel's files in a scratch directory made for the enclosing scope, which is returned: its
 * proc/self/status (its affinity among the lines beside it, the mask before the list), its proc/self/cgroup (the
 * unified line, a legacy one before it where it draws one), and the cpu.max of each cgroup of its ancestry that has
 * one under sys/fs/cgroup.
 */
export const treeWritten = (tree: Tree) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const root = yield* Effect.orDie(fs.makeTempDirectoryScoped({ prefix: "toolchain-cpus-" }))
		const written = (file: string, text: string) =>
			Effect.orDie(
				Effect.andThen(
					fs.makeDirectory(process.getBuiltinModule("node:path").dirname(file), {
						recursive: true
					}),
					fs.writeFileString(file, text)
				)
			)
		yield* written(
			`${root}/proc/self/status`,
			`Name:\tnode\nCpus_allowed:\tffffffff,ffffffff\nCpus_allowed_list:\t${affinityList(tree)}\nMems_allowed_list:\t0\n`
		)
		const own = cgroupAt(tree, 0)
		yield* written(
			`${root}/proc/self/cgroup`,
			`${tree.legacy ? "1:name=systemd:/legacy.slice\n" : ""}0::${Str.isEmpty(own) ? "/" : own}\n`
		)
		yield* Effect.forEach(
			tree.levels,
			(level, up) =>
				level.kind === "none"
					? Effect.void
					: written(
							`${root}/sys/fs/cgroup${cgroupAt(tree, up)}/cpu.max`,
							level.kind === "quota" ? `${level.quota} ${level.period}\n` : `max ${level.period}\n`
						),
			{ discard: true }
		)
		return root
	})

/**
 * A unit's own limits in a live case: its quota as systemd's CPUQuota states it, a percent of one CPU, and the CPUs of
 * its affinity (CPUAffinity, from CPU 0), each where it states one.
 */
export type UnitLimits = Readonly<{ quota: Option.Option<number>; affinity: Option.Option<number> }>

/**
 * Every live case: a quota of half a CPU, one or two, or none, and an affinity of one or two CPUs or none, each a bound
 * well below any machine's that runs the toolchain's tests, so its affinity is smaller than the machine's CPUs.
 */
export const unitLimits: Gen<UnitLimits> = (source) => ({
	quota: source.draw(option(element([50, 100, 200]))),
	affinity: source.draw(option(int(1, 2)))
})

/**
 * The widths a process derives of itself (workers.ts), as a unit prints them, as JSON: its CPU allowance, its test
 * workers, the workers of a run of no property, and the threads of one task among more tasks than it has CPUs.
 */
const UnitWidthsJson = Schema.fromJsonString(
	Schema.Struct({
		processors: Schema.Finite,
		testWorkers: Schema.Finite,
		runOfNone: Schema.Finite,
		threadsAmongMore: Schema.Finite
	})
)

/**
 * The widths a transient unit of systemd's with `limits` derives of itself (UnitWidthsJson): workers.ts of the testing
 * package at `checkout` (Checkout.dir, so a kill's mutant on disk is what it loads) loaded in a Node process the unit
 * runs (`systemd-run --user --wait --pipe`), which no process of a run started, so no allowance is given it and it
 * reads its own (its affinity and every cpu.max of its ancestry), printed and read back here.
 */
export const unitWidths = (checkout: CheckoutDir, limits: UnitLimits) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const workers = process
			.getBuiltinModule("node:url")
			.pathToFileURL(`${checkout}/src/workers.ts`).href
		const properties = [
			...Option.match(limits.quota, {
				onNone: () => [],
				onSome: (percent) => ["-p", `CPUQuota=${percent}%`]
			}),
			...Option.match(limits.affinity, {
				onNone: () => [],
				onSome: (cpus) => ["-p", `CPUAffinity=0-${cpus - 1}`]
			})
		]
		const printed = yield* Effect.orDie(
			spawner.string(
				ChildProcess.make("systemd-run", [
					"--user",
					"--quiet",
					"--wait",
					"--pipe",
					"--collect",
					...properties,
					"--",
					process.execPath,
					"--disable-warning=ExperimentalWarning",
					"--input-type=module",
					"--eval",
					`import { processors, runWorkers, testWorkers, threadsPerTask, widthOf } from "${workers}"\nconsole.log(JSON.stringify({ processors, testWorkers, runOfNone: runWorkers(0), threadsAmongMore: threadsPerTask(processors, widthOf(processors + 1)) }))`
				])
			)
		)
		return yield* Effect.orDie(Schema.decodeEffect(UnitWidthsJson)(Str.trim(printed)))
	})

/**
 * A count a run's widths are derived beside: the properties a run holds, the tasks a turbo run executes at once, the
 * trials of a mutation run, and the weights (properties) of a run's kinds of workers, none of them bounded below.
 */
type Counts = Readonly<{
	properties: number
	tasks: number
	trials: number
	weights: Arr.NonEmptyReadonlyArray<number>
}>

/** Every count a case draws beside its tree: each from none to past any allowance the trees state. */
export const widthCounts: Gen<Counts> = (source) => {
	const weights = source.draw(array(int(0, 12), { min: 1, max: 4 }))
	return {
		properties: source.draw(int(0, 40)),
		tasks: source.draw(int(0, 400)),
		trials: source.draw(int(0, 40)),
		weights: Arr.isReadonlyArrayNonEmpty(weights) ? weights : [0]
	}
}
