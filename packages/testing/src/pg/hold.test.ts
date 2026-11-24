/**
 * A family's members run exactly as long as some process that needs them does (pg/hold.ts): a run that holds its family
 * and brings up every member of it leaves none running once it ends, killed by SIGKILL to its unit or stopped; of two
 * runs holding one family, the first to end leaves every member running for the other, and the last stops them; and a
 * member's start where no process holds its family is refused, the member never made. Each run is a
 * program of its own started as a transient unit (hold.fixtures.ts), each case's cluster a unit name of its own, its
 * family at a checkout of the case's own, its units stopped and its data, claims and state removed when the case ends.
 * Every wait is on a process's exit or on a stop systemd has already begun, never a clock. Oracle: the specification,
 * stated in the checks.
 */
import { Array as Arr, Effect } from "effect"
import { assert } from "#assert.ts"
import { finite } from "#gen.ts"
import { Checkout } from "#mutate/checkout.ts"
import { memberNames } from "#pg/family.ts"
import {
	endingPairs,
	endings,
	type Afterwards,
	leftOnceUnheld,
	memberMade,
	membersHeld,
	runEnded,
	runStarted,
	spreadShape,
	whichMember
} from "#pg/hold.fixtures.ts"
import { leaseStarted } from "#pg/hold.ts"
import { clusterOf, failedOf, familyIn, removedAtEnd } from "#pg/settle.fixtures.ts"
import { familySettled } from "#pg/settle.ts"
import { property } from "#property.ts"
import { Scratch } from "#resources/scratch.ts"
import { testWorkers } from "#workers.ts"

export const aRunsEndLeavesNoMemberRunning = property.exhaust(finite(endings), {
	box: "a family spread over its members, held and brought up whole by one run, a program started as a transient unit, which is then killed by SIGKILL to its unit or stopped",
	needs: { checkout: Checkout.dir, directory: Scratch.dir },
	situations: [],
	check:
		({ checkout, directory }) =>
		(ending) =>
			Effect.scoped(
				Effect.gen(function* () {
					const dir = yield* checkout
					const scratch = yield* directory
					const cluster = yield* clusterOf(spreadShape)
					yield* removedAtEnd(cluster)
					const family = yield* familyIn(cluster, testWorkers)
					const run = yield* runStarted(dir, family, 0)
					const held = yield* membersHeld(family)
					yield* runEnded(run, ending, scratch)
					const left = yield* leftOnceUnheld(family, scratch)
					assert.deepEqual(
						{ held, holds: run.holds.length, left },
						{
							held: Arr.map(memberNames(family), () => true),
							holds: 1,
							left: {
								members: Arr.map(memberNames(family), (): Afterwards => "stopped"),
								leasesActive: false
							}
						}
					)
				})
			),
	oracle: {
		kind: "specification",
		name: "every member a run brought up runs while the run lives, and once the run ends, killed by SIGKILL to its unit with no finalizer of its run, or stopped, its hold ends with it and systemd stops every member and its lease: none is left running"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/pg/hold.ts",
			original:
				'\treturn Effect.andThen(leaseMade(family, name, at), whileLeased(family, name, "start", at))\n',
			replacement:
				'\treturn Effect.asVoid(succeeded(at, ChildProcess.make("systemctl", ["--user", "start", unitOf(name)])))\n',
			why: "A member is started as a unit of its own, as toolchain-pg started postgres@<family>-<i> before leases, so a run that ends, fails or is killed leaves it running (2026-11-24: 379 members of grizzle's families idle in /dev/shm, 88 GB of its 124, metis's idle 3 to 40 hours after their runs); this property fails, the member left running."
		},
		{
			file: "packages/testing/src/pg/hold.ts",
			original: `\t\t\t\t\`PropagatesStopTo=\${unitOf(name)}\`\n`,
			replacement: `\t\t\t\t\`Description=\${unitOf(name)}\`\n`,
			why: "A lease's stop leaves its member running: systemd stops the lease once no hold wants it, but nothing carries the stop to the member; this property fails, the member left running."
		},
		{
			file: "packages/testing/src/pg/hold.ts",
			original: 'const HOLDER = "echo held; while read -r _; do :; done"\n',
			replacement: 'const HOLDER = "echo held; exec sleep infinity"\n',
			why: "A hold outlives the process that made it, bound to nothing that ends with it, so a run killed with no finalizer run leaves its members held for ever; this property fails, its hold's shell never ending, the case held past its guard."
		}
	]
})

export const aMemberStopsWithItsLastHolder = property.exhaust(finite(endingPairs), {
	box: "a family spread over its members held by two runs, each a program started as a transient unit, ended one after the other, each killed by SIGKILL to its unit or stopped",
	needs: { checkout: Checkout.dir, directory: Scratch.dir },
	situations: [],
	check:
		({ checkout, directory }) =>
		({ first, last }) =>
			Effect.scoped(
				Effect.gen(function* () {
					const dir = yield* checkout
					const scratch = yield* directory
					const cluster = yield* clusterOf(spreadShape)
					yield* removedAtEnd(cluster)
					const family = yield* familyIn(cluster, testWorkers)
					const before = yield* runStarted(dir, family, 0)
					const after = yield* runStarted(dir, family, 1)
					yield* runEnded(before, first, scratch)
					const heldByTheOther = yield* membersHeld(family)
					yield* runEnded(after, last, scratch)
					const left = yield* leftOnceUnheld(family, scratch)
					assert.deepEqual(
						{ heldByTheOther, left },
						{
							heldByTheOther: Arr.map(memberNames(family), () => true),
							left: {
								members: Arr.map(memberNames(family), (): Afterwards => "stopped"),
								leasesActive: false
							}
						}
					)
				})
			),
	oracle: {
		kind: "specification",
		name: "two runs of one checkout share its family's members: the first to end, killed or stopped, leaves every member running for the other, its hold one of two, and the last to end stops every member and its lease"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/pg/hold.ts",
			original: '\t\t\t\t"StopWhenUnneeded=yes",\n',
			replacement: '\t\t\t\t"StopWhenUnneeded=no",\n',
			why: "A lease stays once no hold wants it, and its member with it, so the last run's end leaves the family running as a unit of its own did; this property fails, every member left running."
		},
		{
			file: "packages/testing/src/pg/hold.ts",
			original: `\t\tconst unit = \`\${family.name}-hold-\${process.getBuiltinModule("node:crypto").randomBytes(4).toString("hex")}.scope\`\n`,
			replacement: `\t\tconst unit = \`\${family.name}-hold.scope\`\n`,
			why: "A family has one hold of one name, so a second process that needs it is refused its own hold while the first's lasts (systemd makes one unit of a name), and two runs of one checkout cannot both hold its members; this property fails, the second run unready."
		}
	]
})

export const aLeaseNoHoldWantsLeavesNoMember = property.exhaust(finite(whichMember), {
	box: "a member of a settled family spread over its members, its first or its last, started by its lease where no process holds the family, as a settle whose asker has ended starts it",
	needs: { directory: Scratch.dir },
	situations: [],
	check:
		({ directory }) =>
		(which) =>
			Effect.scoped(
				Effect.gen(function* () {
					const scratch = yield* directory
					const cluster = yield* clusterOf(spreadShape)
					yield* removedAtEnd(cluster)
					const family = yield* familyIn(cluster, testWorkers)
					yield* familySettled(family)
					const names = memberNames(family)
					const name = which === "first" ? Arr.headNonEmpty(names) : Arr.lastNonEmpty(names)
					const refused = yield* failedOf(
						leaseStarted(family, name, { cluster: family.name, doing: "the property" })
					)
					const made = yield* memberMade(family, name)
					const left = yield* leftOnceUnheld(family, scratch)
					assert.deepEqual(
						{ refused, made, left },
						{
							refused: true,
							made: false,
							left: { members: Arr.map(names, (): Afterwards => "stopped"), leasesActive: false }
						}
					)
				})
			),
	oracle: {
		kind: "specification",
		name: "a member's start where no process holds its family is refused: systemd stops its lease at once, no hold wanting it, and refuses the start, which requires the lease active, so the member is never made and nothing is left running"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/pg/hold.ts",
			original: '\t\t\t\t"StopWhenUnneeded=yes",\n',
			replacement: '\t\t\t\t"StopWhenUnneeded=no",\n',
			why: "A lease no hold wants stays, and its member with it, so a settle whose asker has ended leaves its member running for good; this property fails, the member left running."
		},
		{
			file: "packages/testing/src/pg/hold.ts",
			original: `\t\t\t\t\`Requisite=\${lease}\`,\n`,
			replacement: `\t\t\t\t\`Wants=\${lease}\`,\n`,
			why: "A member's start pulls its lease in rather than requiring it active, so a settle whose asker has ended starts the member, which systemd stops once the start is done: a member made for no process; this property fails, the member made."
		}
	]
})
