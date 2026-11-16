import { Array as Arr, Option, Order, Result, Schema, String as Str } from "effect"
import type { ChildrenCpu } from "#runner/protocol.ts"

/**
 * What a run cost in CPU, as `toolchain-test run` reports it after its verdicts: every process's CPU (user and system)
 * as each measured its own (process.cpuUsage), attributed where it was spent. A worker measures each case it runs
 * (the CPU its process took while the case ran), each readying (its property's module imported and needs opened, the
 * module's first property on a worker paying the import), what it took to start, and its CPU so far with each unit it
 * finishes; beside each readying and each unit, the CPU of the children the worker waited for meanwhile (a compiler, a
 * program, git, psql that a case or a need ran), which its own reading leaves out; the parent measures its own
 * (loading, discovery, every search's state machine, scheduling, messaging). So a property's CPU is its cases', its
 * readyings' and their children's, and what is left of a worker's CPU (messaging, collection between cases, its time
 * after its last report) is the workers' own line.
 */

/**
 * @formatConstant Linux's /proc/<pid>/stat: its fields after the command's closing parenthesis, from the third (the
 * state), the children's user time the 16th and their system time the 17th; and USER_HZ, the clock ticks a second
 * every time there is counted in, which Linux fixes at 100 for every program whatever the kernel's own tick.
 */
const PROC_STAT = {
	path: "/proc/self/stat",
	firstField: 3,
	user: 16,
	system: 17,
	ticksPerSecond: 100
} as const

/** Milliseconds in a second. */
const millisPerSecond = 1000

const { readFileSync } = process.getBuiltinModule("node:fs")

/**
 * The CPU (ms) the children of this process took that it has waited for, user and system, as Linux states it in
 * /proc/self/stat; none on a system that has no such file.
 */
export const childrenCpuNow = (): Option.Option<number> =>
	Option.flatMap(
		Result.getSuccess(Result.try(() => readFileSync(PROC_STAT.path, "utf8"))),
		(stat) =>
			Option.flatMap(Str.lastIndexOf(")")(stat), (closing) => {
				const fields = Str.split(" ")(Str.trim(Str.slice(closing + 1)(stat)))
				const ticks = (field: number) => Number(fields[field - PROC_STAT.firstField])
				const total = ticks(PROC_STAT.user) + ticks(PROC_STAT.system)
				return Number.isFinite(total)
					? Option.some((total * millisPerSecond) / PROC_STAT.ticksPerSecond)
					: Option.none()
			})
	)

/** The CPU the children took between two readings, as a message states it. */
export const childrenSince = (before: Option.Option<number>): ChildrenCpu =>
	Option.match(
		Option.zipWith(childrenCpuNow(), before, (now, then) => now - then),
		{
			onNone: () => ({ kind: "unstated" }),
			onSome: (millis) => ({ kind: "stated", millis })
		}
	)

/**
 * One property's run as the report counts it: its label, its cases, their CPU, its readyings' CPU, and the CPU of the
 * children its cases and readyings ran (ms).
 */
export type PropertyUsage = Readonly<{
	label: string
	cases: number
	casesCpu: number
	readyingCpu: number
	childrenCpu: number
}>

/** One worker process: the CPU it took to start (ms), and its CPU when it last reported (ms). */
export type WorkerUsage = Readonly<{ started: number; reported: number }>

/**
 * Whether the workers' systems stated their children's CPU: every reading did, or one did not (a system with no
 * /proc), and the children's CPU the report states is then a part of it at most.
 */
export type ChildrenStated = "stated" | "unstated"

/**
 * What a pool's workers measured: each property's run, each worker process the pool forked, and whether every reading
 * of their children's CPU was stated.
 */
export type PoolUsage = Readonly<{
	properties: ReadonlyArray<PropertyUsage>
	workers: ReadonlyArray<WorkerUsage>
	children: ChildrenStated
}>

/** What a run measured: the parent's CPU (ms), and every pool's. */
export type RunUsage = Readonly<{ parent: number } & PoolUsage>

/**
 * One line of the report: a property's label, cases and CPU (ms; its cases', its readyings' and their children's), its
 * CPU per case, its share of the run's CPU and the share of every line before it too.
 */
const UsageRow = Schema.Struct({
	label: Schema.String,
	cases: Schema.Finite,
	cpu: Schema.Finite,
	casesCpu: Schema.Finite,
	readyingCpu: Schema.Finite,
	childrenCpu: Schema.Finite,
	perCase: Schema.Finite,
	share: Schema.Finite,
	cumulative: Schema.Finite
})

/**
 * The report a run's usage gives: its CPU in all (ms), by where it was spent (the parent; the workers', in starting,
 * readying, cases and the rest; the children the workers waited for, and whether every reading of them was stated),
 * and each property's row, costliest first.
 */
const UsageReport = Schema.Struct({
	total: Schema.Finite,
	parent: Schema.Finite,
	workers: Schema.Finite,
	workersStarted: Schema.Finite,
	readying: Schema.Finite,
	cases: Schema.Finite,
	workersOther: Schema.Finite,
	children: Schema.Finite,
	childrenStated: Schema.Literals(["stated", "unstated"]),
	rows: Schema.Array(UsageRow)
})

export type UsageReport = typeof UsageReport.Type

/** A run's report as its JSON file holds it: the package root, the run's seed and its wall time (ms) beside it. */
const UsageRecord = Schema.Struct({
	root: Schema.String,
	seed: Schema.Finite,
	millis: Schema.Finite,
	report: UsageReport
})

/** A run's report as JSON text. */
export const usageJson = Schema.encodeEffect(Schema.fromJsonString(UsageRecord))

/** The rows of properties of one label (a property on one stack) summed, as pools report each its own. */
const merged = (properties: ReadonlyArray<PropertyUsage>): ReadonlyArray<PropertyUsage> => {
	const byLabel = new Map<string, PropertyUsage>()
	for (const one of properties) {
		const before = byLabel.get(one.label)
		byLabel.set(
			one.label,
			before === undefined
				? one
				: {
						label: one.label,
						cases: before.cases + one.cases,
						casesCpu: before.casesCpu + one.casesCpu,
						readyingCpu: before.readyingCpu + one.readyingCpu,
						childrenCpu: before.childrenCpu + one.childrenCpu
					}
		)
	}
	return Arr.fromIterable(byLabel.values())
}

/** A property's CPU beside its label, as the report sorts them. */
type Costed = Readonly<{ label: string; cpu: number }>

/** By CPU, costliest first, then by label. */
const costliestFirst = Order.combine(
	Order.mapInput(Order.flip(Order.Number), (row: Costed) => row.cpu),
	Order.mapInput(Order.String, (row: Costed) => row.label)
)

/** A run's usage as its report states it. */
export const reportOf = (usage: RunUsage): UsageReport => {
	const properties = merged(usage.properties)
	const workers = Arr.reduce(usage.workers, 0, (sum, worker) => sum + worker.reported)
	const workersStarted = Arr.reduce(usage.workers, 0, (sum, worker) => sum + worker.started)
	const cases = Arr.reduce(properties, 0, (sum, one) => sum + one.casesCpu)
	const readying = Arr.reduce(properties, 0, (sum, one) => sum + one.readyingCpu)
	const children = Arr.reduce(properties, 0, (sum, one) => sum + one.childrenCpu)
	const total = usage.parent + workers + children
	const sorted = Arr.sort(
		Arr.map(properties, (one) => ({
			...one,
			cpu: one.casesCpu + one.readyingCpu + one.childrenCpu
		})),
		costliestFirst
	)
	const [, rows] = Arr.mapAccum(sorted, 0, (before, one) => {
		const share = total > 0 ? one.cpu / total : 0
		return [
			before + share,
			{
				label: one.label,
				cases: one.cases,
				cpu: one.cpu,
				casesCpu: one.casesCpu,
				readyingCpu: one.readyingCpu,
				childrenCpu: one.childrenCpu,
				perCase: one.cases > 0 ? one.casesCpu / one.cases : 0,
				share,
				cumulative: before + share
			}
		] as const
	})
	return {
		total,
		parent: usage.parent,
		workersStarted,
		readying,
		cases,
		workersOther: workers - workersStarted - readying - cases,
		workers,
		children,
		childrenStated: usage.children,
		rows
	}
}

/** Seconds from milliseconds, as the report prints them. */
const seconds = (millis: number) => `${(millis / 1000).toFixed(1)} s`

/** A share as a percentage. */
const percent = (share: number) => `${(share * 100).toFixed(1)}%`

/** What the report says of the workers' children: their CPU, or that their systems did not state it all. */
const childrenText = (report: UsageReport): string => {
	switch (report.childrenStated) {
		case "stated":
			return `their children ${seconds(report.children)}`
		case "unstated":
			return `their children ${seconds(report.children)} where stated (this system does not state every child's CPU)`
	}
}

/**
 * The report's lines: the run's CPU and where it went, then one line a property, costliest first, with its share of
 * the run's CPU and the share of every property above it too, its cases, its CPU per case, its readyings' CPU and its
 * children's.
 */
export const usageLines = (report: UsageReport): ReadonlyArray<string> => [
	`CPU ${seconds(report.total)}: parent ${seconds(report.parent)}, workers ${seconds(report.workers)} (starting ${seconds(report.workersStarted)}, readying ${seconds(report.readying)}, cases ${seconds(report.cases)}, the rest ${seconds(report.workersOther)}), ${childrenText(report)}`,
	...Arr.map(
		report.rows,
		(row) =>
			`  ${percent(row.share)} (${percent(row.cumulative)}) ${seconds(row.cpu)}: ${row.cases} cases at ${row.perCase.toFixed(2)} ms, readying ${seconds(row.readyingCpu)}, children ${seconds(row.childrenCpu)}; ${row.label}`
	)
]
