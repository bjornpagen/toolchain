/**
 * A process's CPU allowance (workers.ts), the one source of every width a run takes: read from the kernel's files, it
 * is the CPUs the process's affinity names, never more than the whole CPUs the tightest cpu.max of any cgroup from its
 * own to the hierarchy's root lets its tasks keep busy, and one at least, whatever cgroups between them state no quota
 * or no cpu.max at all, a quota of part of a CPU among them, and whatever legacy hierarchy /proc/self/cgroup names
 * beside the unified one; a unit of systemd's, which no process of a run started, reads no more than its own quota
 * and affinity let it keep busy, half a CPU's quota among them; and every width derived from any allowance and any
 * count beside it (no property, no task, no trial) is a whole number, one at least (widthOf), in a unit as in a drawn
 * tree. Oracle: the specification, stated in the checks (the allowance computed from the drawn numbers, never from the
 * files' text), and the unit's own limits as systemd was given them.
 */
import { Array as Arr, Effect, Option } from "effect"
import { assert } from "#assert.ts"
import { finite } from "#gen.ts"
import { Checkout } from "#mutate/checkout.ts"
import { shareOf } from "#mutate/schedule.ts"
import { property } from "#property.ts"
import { placesShared } from "#runner/pool.ts"
import {
	affinityOf,
	cpusOf,
	treeWritten,
	trees,
	unitLimits,
	unitWidths,
	widthCounts
} from "#workers.fixtures.ts"
import {
	allowanceOf,
	cpuFactsAt,
	runWorkers,
	threadsPerTask,
	widthOf,
	workersOf
} from "#workers.ts"

export const anAllowanceIsTheTightestBoundAboveIt = property.explore(trees, {
	needs: {},
	situations: [
		"a quota binds below the affinity",
		"a cgroup's own quota binds below an ancestor's",
		"an ancestor's quota binds below one under it",
		"a cgroup with no cpu.max between two that have one",
		"a quota of less than one CPU",
		"an affinity of several runs"
	],
	check: (_resources, c) => (tree) =>
		Effect.scoped(
			Effect.gen(function* () {
				const quotas = Arr.map(tree.levels, cpusOf)
				const bound = Arr.reduce(Arr.getSomes(quotas), affinityOf(tree), (least, cpus) =>
					Math.min(least, cpus)
				)
				if (bound < affinityOf(tree)) {
					c.note("a quota binds below the affinity")
				}
				const binding = Arr.findFirstIndex(quotas, (cpus) => Option.contains(cpus, bound))
				if (
					Option.exists(binding, (at) =>
						Arr.some(Arr.drop(quotas, at + 1), (cpus) =>
							Option.exists(cpus, (above) => above > bound)
						)
					)
				) {
					c.note("a cgroup's own quota binds below an ancestor's")
				}
				if (
					Option.exists(binding, (at) =>
						Arr.some(Arr.take(quotas, at), (cpus) => Option.exists(cpus, (below) => below > bound))
					)
				) {
					c.note("an ancestor's quota binds below one under it")
				}
				const stated = Arr.map(tree.levels, (level) => level.kind !== "none")
				if (
					Arr.some(
						tree.levels,
						(level, at) =>
							level.kind === "none" &&
							Arr.some(Arr.take(stated, at), Boolean) &&
							Arr.some(Arr.drop(stated, at + 1), Boolean)
					)
				) {
					c.note("a cgroup with no cpu.max between two that have one")
				}
				if (
					Arr.some(tree.levels, (level) => level.kind === "quota" && level.quota < level.period)
				) {
					c.note("a quota of less than one CPU")
				}
				if (tree.runs.length > 1) {
					c.note("an affinity of several runs")
				}
				const root = yield* treeWritten(tree)
				assert.deepEqual<number>(allowanceOf(cpuFactsAt(root)), Math.max(1, bound))
			})
		),
	oracle: {
		kind: "specification",
		name: "the allowance is the CPUs the affinity names, never more than the whole CPUs (quota over period, rounded down) of any cpu.max from the process's own cgroup to the hierarchy's root, and one at least; a cgroup with no cpu.max, or one stating no quota, bounds nothing"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/workers.ts",
			original: "\t\tArr.reduce(facts.limits, affinityCount(facts.affinity), (least, limit) =>\n",
			replacement:
				"\t\tArr.reduce(Arr.empty<string>(), affinityCount(facts.affinity), (least, limit) =>\n",
			why: "The allowance ignores every cpu.max, its affinity alone, so a run under a slice held to 16 CPUs on a machine of 64 sizes itself for 32 workers and is throttled, its clusters' connections and its tests' databases exhausted (grizzle's DECIDE5 broad gate under grizzle.slice's quota, 2026-11-24: 5 infrastructure reds); the property fails."
		},
		{
			file: "packages/testing/src/workers.ts",
			original: "\tconst cgroups = Array.from({ length: parts.length + 1 }, (_, up) =>\n",
			replacement: "\tconst cgroups = Array.from({ length: 1 }, (_, up) =>\n",
			why: "The allowance reads its own cgroup's cpu.max alone, never its ancestors', so a unit in a slice held to 16 CPUs, which states no quota of its own, sizes itself for the whole machine; the property fails."
		}
	]
})

export const aUnitsOwnLimitsBoundItsAllowance = property.exhaust(finite(unitLimits), {
	box: "a transient unit of systemd's with a CPU quota of half a CPU, one or two, or none, and an affinity of one or two CPUs or none",
	needs: { checkout: Checkout.dir },
	situations: [],
	check:
		({ checkout }) =>
		(limits) =>
			Effect.gen(function* () {
				const dir = yield* checkout
				const widths = yield* unitWidths(dir, limits)
				const bound = Math.max(
					1,
					Arr.reduce(
						Arr.getSomes([
							Option.map(limits.quota, (percent) => Math.floor(percent / 100)),
							limits.affinity
						]),
						Number.POSITIVE_INFINITY,
						(least, cpus) => Math.min(least, cpus)
					)
				)
				assert.deepEqual(
					{
						withinItsLimits: widths.processors <= bound,
						zeroWidths: Arr.filter(
							[
								["processors", widths.processors],
								["testWorkers", widths.testWorkers],
								["runWorkers(0)", widths.runOfNone],
								["threadsPerTask(processors, processors + 1)", widths.threadsAmongMore]
							] as const,
							([, width]) => !(Number.isInteger(width) && width >= 1)
						)
					},
					{ withinItsLimits: true, zeroWidths: [] }
				)
			}),
	oracle: {
		kind: "specification",
		name: "a unit that no process of a run started reads an allowance never more than its own quota (CPUQuota, in whole CPUs) or its affinity's CPUs allow, one at least, and derives every width of it, its test workers, a run's workers and a task's threads, a whole number, one at least"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/workers.ts",
			original: "\t\tArr.reduce(facts.limits, affinityCount(facts.affinity), (least, limit) =>\n",
			replacement:
				"\t\tArr.reduce(Arr.empty<string>(), affinityCount(facts.affinity), (least, limit) =>\n",
			why: "The allowance ignores every cpu.max, so a unit held to 2 CPUs by its quota reads the machine's whole affinity; the property fails."
		},
		{
			file: "packages/testing/src/workers.ts",
			original: "\treturn Width(Math.max(1, Math.floor(size)))\n",
			replacement: "\treturn Width(Math.floor(size))\n",
			why: "A width is not floored at one, so a unit whose quota is half a CPU reads an allowance of 0 and derives 0 test workers, the VITEST_MAX_WORKERS=0 of edullm's gate, which ran no test and passed; the property fails."
		}
	]
})

export const everyWidthIsOneAtLeast = property.explore(
	(source) => ({ tree: source.draw(trees), counts: source.draw(widthCounts) }),
	{
		needs: {},
		situations: [
			"a quota of less than one CPU",
			"an affinity of one CPU",
			"a run of no property",
			"no task at once",
			"more tasks at once than CPUs",
			"more kinds of workers than workers"
		],
		check:
			(_resources, c) =>
			({ tree, counts }) =>
				Effect.scoped(
					Effect.gen(function* () {
						if (
							Arr.some(tree.levels, (level) => level.kind === "quota" && level.quota < level.period)
						) {
							c.note("a quota of less than one CPU")
						}
						if (affinityOf(tree) === 1) {
							c.note("an affinity of one CPU")
						}
						if (counts.properties === 0) {
							c.note("a run of no property")
						}
						const root = yield* treeWritten(tree)
						const allowance = allowanceOf(cpuFactsAt(root))
						const workers = workersOf(allowance)
						if (counts.tasks === 0) {
							c.note("no task at once")
						}
						if (counts.tasks > allowance) {
							c.note("more tasks at once than CPUs")
						}
						if (counts.weights.length > workers) {
							c.note("more kinds of workers than workers")
						}
						const places = placesShared(workers, counts.weights)
						const widths = [
							["the allowance", allowance],
							["its test workers", workers],
							["a run's workers", runWorkers(counts.properties)],
							["a task's threads", threadsPerTask(allowance, widthOf(counts.tasks))],
							["a trial's share", shareOf(workers, counts.trials)],
							...Arr.map(places, (one, kind) => [`kind ${kind}'s places`, one.at.length] as const),
							...Arr.map(places, (one, kind) => [`kind ${kind}'s width`, one.of] as const)
						] as const
						assert.deepEqual(
							Arr.filter(widths, ([, width]) => !(Number.isInteger(width) && width >= 1)),
							[]
						)
					})
				),
		oracle: {
			kind: "specification",
			name: "every width derived from any CPU allowance (any affinity, any cpu.max of any cgroup of the ancestry, a quota of part of a CPU among them) and any count beside it (no property, no task, no trial among them) is a whole number, one at least"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/workers.ts",
				original: "\treturn Width(Math.max(1, Math.floor(size)))\n",
				replacement: "\treturn Width(Math.floor(size))\n",
				why: "A width is not floored at one, so a quota of part of a CPU is an allowance of 0, a run of no property holds 0 workers and a task among more tasks than CPUs takes 0 threads; the property fails."
			}
		]
	}
)
