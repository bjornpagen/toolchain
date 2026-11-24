/**
 * A process's CPU allowance (workers.ts), the one source of every width a run takes: read from the kernel's files, it
 * is the CPUs the process's affinity names, never more than the whole CPUs the tightest cpu.max of any cgroup from its
 * own to the hierarchy's root lets its tasks keep busy, and one at least, whatever cgroups between them state no quota
 * or no cpu.max at all, a quota of part of a CPU among them, and whatever legacy hierarchy /proc/self/cgroup names
 * beside the unified one; and a unit of systemd's, which no process of a run started, reads no more than its own quota
 * and affinity let it keep busy. Oracle: the specification, stated in the checks (the allowance computed from the
 * drawn numbers, never from the files' text), and the unit's own limits as systemd was given them.
 */
import { Array as Arr, Effect, Option } from "effect"
import { assert } from "#assert.ts"
import { finite } from "#gen.ts"
import { Checkout } from "#mutate/checkout.ts"
import { property } from "#property.ts"
import {
	affinityOf,
	cpusOf,
	treeWritten,
	trees,
	unitAllowance,
	unitLimits
} from "#workers.fixtures.ts"
import { allowanceOf, cpuFactsAt } from "#workers.ts"

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
				assert.deepEqual(allowanceOf(cpuFactsAt(root)), Math.max(1, bound))
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
	box: "a transient unit of systemd's with a CPU quota of one or two CPUs or none, and an affinity of one or two CPUs or none",
	needs: { checkout: Checkout.dir },
	situations: [],
	check:
		({ checkout }) =>
		(limits) =>
			Effect.gen(function* () {
				const dir = yield* checkout
				const allowance = yield* unitAllowance(dir, limits)
				const bound = Arr.reduce(
					Arr.getSomes([limits.quota, limits.affinity]),
					Number.POSITIVE_INFINITY,
					(least, cpus) => Math.min(least, cpus)
				)
				assert.deepEqual(
					{ atLeastOne: allowance >= 1, withinItsLimits: allowance <= bound },
					{ atLeastOne: true, withinItsLimits: true }
				)
			}),
	oracle: {
		kind: "specification",
		name: "a unit that no process of a run started reads an allowance of one CPU at least and never more than its own quota (CPUQuota, in whole CPUs) or its affinity's CPUs allow"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/workers.ts",
			original: "\t\tArr.reduce(facts.limits, affinityCount(facts.affinity), (least, limit) =>\n",
			replacement:
				"\t\tArr.reduce(Arr.empty<string>(), affinityCount(facts.affinity), (least, limit) =>\n",
			why: "The allowance ignores every cpu.max, so a unit held to 2 CPUs by its quota reads the machine's whole affinity; the property fails."
		}
	]
})
