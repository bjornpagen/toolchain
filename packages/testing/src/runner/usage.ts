import { Array as Arr, Option, Order, Result, Schema, String as Str } from "effect"
import type { ChildrenCpu } from "#runner/protocol.ts"

/**
 * What a run cost, as `toolchain-test run` reports it after its verdicts: in CPU and in wall time.
 *
 * CPU: every process's (user and system) as each measured its own (process.cpuUsage), attributed where it was spent. A
 * worker measures each case it runs (the CPU its process took while the case ran), each readying (its property's module
 * imported and needs opened, the module's first property on a worker paying the import), what it took to start, and
 * its CPU so far with each unit it finishes; beside each readying and each unit, the CPU of the children the worker
 * waited for meanwhile (a compiler, a program, git, psql that a case or a need ran), which its own reading leaves out;
 * the parent measures its own (loading, discovery, every search's state machine, scheduling, messaging). So a
 * property's CPU is its cases', its readyings' and their children's, and what is left of a worker's CPU (messaging,
 * collection between cases, its time after its last report) is the workers' own line.
 *
 * Wall time: what a property held the workers, and when its verdict landed. A case that waits (on a database, a child,
 * a lock) spends wall time its CPU does not show: grizzle's database tier at 5374a0575 ran 343 minutes while its
 * workers' CPU, all of them together, came to 380 minutes, so CPU alone hid which properties the run waited for
 * (~/.cache/trunk-cache/grizzle/xdg/toolchain-test/runs/2219874524-2251814.json). A property's wall time on the
 * workers is its units' (each from the moment its worker started it, given it or done with the unit before, to its
 * answer, or to its worker's end for a unit the worker died in, its readyings in that span taken out, on the parent's
 * clock, the measure the scheduling weighs a unit's work by) and its readyings' (as its workers measured them); its
 * time to its verdict is its search's, from its start to its verdict, and since every search of a run starts at once,
 * it is also when the verdict landed in the run.
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
 * One property's run on a pool as the report counts it: its label, its cases, their CPU, its readyings' CPU, the CPU of
 * the children its cases and readyings ran, and the wall time its units and its readyings held the pool's workers (ms).
 */
export type PropertyUsage = Readonly<{
	label: string
	cases: number
	casesCpu: number
	readyingCpu: number
	childrenCpu: number
	casesWall: number
	readyingWall: number
}>

/** A property's usage of no case, no readying and no time, which every cost it spent adds to. */
export const unused = (label: string): PropertyUsage => ({
	label,
	cases: 0,
	casesCpu: 0,
	readyingCpu: 0,
	childrenCpu: 0,
	casesWall: 0,
	readyingWall: 0
})

/** Two usages of one property, summed. */
export const summed = (before: PropertyUsage, cost: PropertyUsage): PropertyUsage => ({
	label: before.label,
	cases: before.cases + cost.cases,
	casesCpu: before.casesCpu + cost.casesCpu,
	readyingCpu: before.readyingCpu + cost.readyingCpu,
	childrenCpu: before.childrenCpu + cost.childrenCpu,
	casesWall: before.casesWall + cost.casesWall,
	readyingWall: before.readyingWall + cost.readyingWall
})

/**
 * A property's run as the report reads it beside its usage: its label (`<id>`, or `<id>@small-stack`) and its search's
 * wall time, from its start to its verdict (ms).
 */
type Landed = Readonly<{ label: string; millis: number }>

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
 * One line of the report, every time in ms: a property's label and cases; its CPU (its cases', its readyings' and
 * their children's) and its cases' CPU per case; its wall time on the workers (its units' and its readyings'), its
 * units' wall time per case, its share of every property's wall time on the workers and the share of every line before
 * it too; and its search's wall time, from its start to its verdict.
 */
const UsageRow = Schema.Struct({
	label: Schema.String,
	cases: Schema.Finite,
	cpu: Schema.Finite,
	casesCpu: Schema.Finite,
	readyingCpu: Schema.Finite,
	childrenCpu: Schema.Finite,
	cpuPerCase: Schema.Finite,
	wall: Schema.Finite,
	casesWall: Schema.Finite,
	readyingWall: Schema.Finite,
	wallPerCase: Schema.Finite,
	wallShare: Schema.Finite,
	wallCumulative: Schema.Finite,
	toVerdict: Schema.Finite
})

/**
 * The report a run's usage gives: its CPU in all (ms), by where it was spent (the parent; the workers', in starting,
 * readying, cases and the rest; the children the workers waited for, and whether every reading of them was stated);
 * every property's wall time on the workers, summed (ms); and each property's row, the longest on the workers first.
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
	wall: Schema.Finite,
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

/**
 * Each property run's usage: what every pool spent on its label (a property on one stack) summed, as pools report each
 * its own, none for a run of no case.
 */
const usageOf = (
	landed: ReadonlyArray<Landed>,
	pooled: ReadonlyArray<PropertyUsage>
): ReadonlyArray<PropertyUsage & Landed> => {
	const byLabel = new Map<string, PropertyUsage>()
	for (const one of pooled) {
		byLabel.set(one.label, summed(byLabel.get(one.label) ?? unused(one.label), one))
	}
	return Arr.map(landed, (ran) => ({
		...(byLabel.get(ran.label) ?? unused(ran.label)),
		millis: ran.millis
	}))
}

/** A property's wall time on the workers beside its label, as the report sorts them. */
type Held = Readonly<{ label: string; wall: number }>

/** By wall time on the workers, longest first, then by label. */
const longestFirst = Order.combine(
	Order.mapInput(Order.flip(Order.Number), (row: Held) => row.wall),
	Order.mapInput(Order.String, (row: Held) => row.label)
)

/** A part of a whole, none of none. */
const per = (part: number, whole: number) => (whole > 0 ? part / whole : 0)

/** A run's usage as its report states it, a row for every property run that `landed`. */
export const reportOf = (usage: RunUsage, landed: ReadonlyArray<Landed>): UsageReport => {
	const properties = usageOf(landed, usage.properties)
	const workers = Arr.reduce(usage.workers, 0, (sum, worker) => sum + worker.reported)
	const workersStarted = Arr.reduce(usage.workers, 0, (sum, worker) => sum + worker.started)
	const cases = Arr.reduce(properties, 0, (sum, one) => sum + one.casesCpu)
	const readying = Arr.reduce(properties, 0, (sum, one) => sum + one.readyingCpu)
	const children = Arr.reduce(properties, 0, (sum, one) => sum + one.childrenCpu)
	const wall = Arr.reduce(properties, 0, (sum, one) => sum + one.casesWall + one.readyingWall)
	const sorted = Arr.sort(
		Arr.map(properties, (one) => ({ ...one, wall: one.casesWall + one.readyingWall })),
		longestFirst
	)
	const [, rows] = Arr.mapAccum(sorted, 0, (before, one) => {
		const share = per(one.wall, wall)
		return [
			before + share,
			{
				label: one.label,
				cases: one.cases,
				cpu: one.casesCpu + one.readyingCpu + one.childrenCpu,
				casesCpu: one.casesCpu,
				readyingCpu: one.readyingCpu,
				childrenCpu: one.childrenCpu,
				cpuPerCase: per(one.casesCpu, one.cases),
				wall: one.wall,
				casesWall: one.casesWall,
				readyingWall: one.readyingWall,
				wallPerCase: per(one.casesWall, one.cases),
				wallShare: share,
				wallCumulative: before + share,
				toVerdict: one.millis
			}
		] as const
	})
	return {
		total: usage.parent + workers + children,
		parent: usage.parent,
		workersStarted,
		readying,
		cases,
		workersOther: workers - workersStarted - readying - cases,
		workers,
		children,
		childrenStated: usage.children,
		wall,
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
 * How many properties the report prints, the longest on the workers first: a run's tail is a few properties, and the
 * run's JSON holds every one.
 */
const PRINTED_LONGEST = 20

/**
 * The report's lines: the run's CPU and where it went; every property's wall time on the workers; then the longest
 * properties on the workers, one line each, with its share of every property's wall time and the share of every line
 * above it too, its cases and its units' wall time per case, its CPU and its time to its verdict.
 */
export const usageLines = (report: UsageReport): ReadonlyArray<string> => [
	`CPU ${seconds(report.total)}: parent ${seconds(report.parent)}, workers ${seconds(report.workers)} (starting ${seconds(report.workersStarted)}, readying ${seconds(report.readying)}, cases ${seconds(report.cases)}, the rest ${seconds(report.workersOther)}), ${childrenText(report)}`,
	`wall time on the workers ${seconds(report.wall)}, the ${Math.min(PRINTED_LONGEST, report.rows.length)} longest of ${report.rows.length} properties:`,
	...Arr.map(
		Arr.take(report.rows, PRINTED_LONGEST),
		(row) =>
			`  ${percent(row.wallShare)} (${percent(row.wallCumulative)}) ${seconds(row.wall)}: ${row.cases} cases at ${row.wallPerCase.toFixed(1)} ms, readying ${seconds(row.readyingWall)}; CPU ${seconds(row.cpu)}; its verdict after ${seconds(row.toVerdict)}; ${row.label}`
	)
]

/**
 * What a property's verdict line adds as it lands: its search's wall time to its verdict, and its wall time on the
 * workers so far (ms).
 */
export const landedText = (toVerdict: number, wall: number): string =>
	`its verdict after ${seconds(toVerdict)}, ${seconds(wall)} on the workers`
