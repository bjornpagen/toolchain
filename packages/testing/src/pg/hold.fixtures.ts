import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import {
	Array as Arr,
	Console,
	Effect,
	Exit,
	FileSystem,
	Option,
	Stream,
	String as Str
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { failureText } from "#failure.ts"
import { element, type Gen } from "#gen.ts"
import { liveSleep } from "#live.ts"
import type { CheckoutDir } from "#mutate/checkout.ts"
import { specAt } from "#pg/config-file.ts"
import {
	type CheckoutFamily,
	checkoutAt,
	familyOf,
	homesHere,
	memberNames,
	sliceOf,
	unitOf
} from "#pg/family.ts"
import { familyHeld, leaseOf } from "#pg/hold.ts"
import { type Shape, specWritten } from "#pg/settle.fixtures.ts"
import { memberBroughtUp, processSettler } from "#pg/settle.ts"
import { HARDENED_FLAGS } from "#runner/config.ts"
import { exitOf } from "#runner/pool.fixtures.ts"

/**
 * What the hold properties (hold.test.ts) run and read: a run of a case cluster's family, a program of its own started
 * as a transient unit, which holds the family and brings up every member of it as a run's workers do, then waits for
 * ever, so a property ends it as a run ends, killed by SIGKILL to its unit or stopped; and what systemd says of each
 * member once its holders have ended, waited on by the exits of processes, never by a clock.
 */

/** The program's path in a checkout of the testing package. */
const runProgram = (checkout: CheckoutDir): string => `${checkout}/src/pg/hold.fixtures.ts`

/** How a run ends: killed by SIGKILL to its unit, as a run's kill does, or stopped, as a run that ends does. */
export type Ending = "killed" | "stopped"

/** Every ending, one each. */
export const endings: Gen<Ending> = (source) => source.draw(element(["killed", "stopped"]))

/** How two runs of one family end, one after the other: the first to end, and the last. */
export type Endings = Readonly<{ first: Ending; last: Ending }>

/** Every pair of endings, one each. */
export const endingPairs: Gen<Endings> = (source) => ({
	first: source.draw(endings),
	last: source.draw(endings)
})

/** Which member of a family a case starts: its first, or its last. */
export const whichMember: Gen<"first" | "last"> = (source) =>
	source.draw(element(["first", "last"]))

/**
 * The program: the family of the cluster `<checkout>/pg.config.ts` states (settle.fixtures.ts specWritten) at the
 * checkout, its states home `states` and the run width `width`, held (hold.ts familyHeld) and every member of it brought
 * up in this process as a run's worker brings up the one it reaches (memberBroughtUp, processSettler); then a line on
 * stdout, `ready ` and this process's id, or, where a step failed, `failed: ` and its failure; then a wait for ever,
 * which a SIGTERM interrupts as it interrupts a run's process (NodeRuntime), its hold let go as its scope closes, and a
 * SIGKILL ends with no finalizer run.
 */
const heldAsProgram = (checkout: string, states: string, width: number) =>
	Effect.scoped(
		Effect.gen(function* () {
			const brought = Effect.gen(function* () {
				const spec = yield* Effect.orDie(specAt(checkout))
				const homes = yield* Effect.orDie(homesHere)
				const family = familyOf(spec, checkoutAt(checkout), { states, data: homes.data }, width)
				const held = yield* familyHeld(family)
				yield* Effect.forEach(
					memberNames(family),
					(_, index) => memberBroughtUp(held, index, processSettler),
					{ discard: true }
				)
			})
			const outcome = yield* Effect.exit(brought)
			yield* Console.log(
				Exit.isSuccess(outcome)
					? `${readyLine}${process.pid}`
					: `failed: ${Arr.join(Str.split("\n")(failureText(outcome.cause)), " ")}`
			)
			return yield* Effect.never
		})
	)

/** A run as a property reads it: its unit, its program's process id and the processes of its holds. */
export type Run = Readonly<{ unit: string; program: number; holds: ReadonlyArray<number> }>

/** What the program's line says before its process's id once its family is held and every member brought up. */
const readyLine = "ready "

/** What precedes a process's cgroup path in /proc/<pid>/cgroup: cgroup v2's hierarchy 0, with no controllers. */
const unifiedPrefix = "0::"

/**
 * The children of process `pid` that run in a hold of `family` (a scope `<family>-hold-*.scope`, hold.ts): its holds'
 * shells, which systemd-run became in their scopes, each the hold's one process.
 */
const holdsOf = (pid: number, family: CheckoutFamily) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const listed = yield* Effect.orElseSucceed(
			fs.readFileString(`/proc/${pid}/task/${pid}/children`),
			() => ""
		)
		const children = Arr.map(Arr.filter(Str.split(" ")(Str.trim(listed)), Str.isNonEmpty), Number)
		return yield* Effect.filter(children, (child) =>
			Effect.map(
				Effect.orElseSucceed(fs.readFileString(`/proc/${child}/cgroup`), () => ""),
				(cgroup) =>
					Arr.some(
						Str.split("\n")(cgroup),
						(line) =>
							Str.startsWith(unifiedPrefix)(line) &&
							Str.includes(`/${family.name}-hold-`)(line) &&
							Str.endsWith(".scope")(line)
					)
			)
		)
	})

/**
 * Run `index` of `family` started from `program` in the testing package's checkout `checkout` as the transient unit
 * `<cluster>-run-<index>.service`, in the family's repository's slice, stopped by name as the enclosing scope closes;
 * its program told the family's checkout, whose pg.config.ts states the case's cluster (specWritten), its states home
 * and width (heldAsProgram), its stdout this process's to read through systemd-run's (`--pipe --wait`, which lasts as
 * long as the unit). Once its first line says it is ready, however long its start takes (no clock decides, and its
 * read spends nothing while it waits, so a program that never says it holds its case, whose guard reports it hung),
 * the run as a property reads it (Run); a program that failed, or ended first, fails the case with what it said.
 */
export const runStarted = (checkout: CheckoutDir, family: CheckoutFamily, index: number) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		yield* specWritten(family)
		const unit = `${family.cluster.unit}-run-${index}.service`
		yield* Effect.addFinalizer(() =>
			Effect.ignore(spawner.exitCode(ChildProcess.make("systemctl", ["--user", "stop", unit])))
		)
		const handle = yield* Effect.orDie(
			spawner.spawn(
				ChildProcess.make(
					"systemd-run",
					[
						"--user",
						"--quiet",
						"--collect",
						"--pipe",
						"--wait",
						`--unit=${unit}`,
						`--slice=${sliceOf(family.cluster)}`,
						"--",
						process.execPath,
						...HARDENED_FLAGS,
						runProgram(checkout),
						family.checkout,
						family.homes.states,
						`${family.width}`
					],
					{ stdin: "ignore", stderr: "ignore" }
				)
			)
		)
		const said = yield* Effect.orDie(
			Stream.runHead(Stream.splitLines(Stream.decodeText(handle.stdout)))
		)
		const line = Option.getOrElse(said, () => "")
		if (!Str.startsWith(readyLine)(line)) {
			return yield* Effect.die(`${unit} was never ready: ${line}`)
		}
		const program = Number(Str.slice(readyLine.length)(line))
		const run: Run = { unit, program, holds: yield* holdsOf(program, family) }
		return run
	})

/**
 * `run` ended as `ending` says (`systemctl --user kill --signal=SIGKILL`, or `systemctl --user stop`, its program's
 * SIGTERM), then the exits of its program and its holds' shells waited on (pool.fixtures.ts exitOf, pidwait on each),
 * each pidfile in `scratch`: a hold's shell ends as its input does, so the wait ends at once where the hold is bound to
 * its process, and its case's guard reports it hung where it is not.
 */
export const runEnded = (run: Run, ending: Ending, scratch: string) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const verb = ending === "killed" ? ["kill", "--signal=SIGKILL", run.unit] : ["stop", run.unit]
		yield* Effect.orDie(spawner.exitCode(ChildProcess.make("systemctl", ["--user", ...verb])))
		yield* Effect.forEach([run.program, ...run.holds], (pid) => exitOf(pid, scratch), {
			discard: true
		})
	})

/**
 * A case's cluster of the hold properties: spread over two members (where its width gives two), over its socket, with
 * a room for its workers (settle.fixtures.ts clusterOf).
 */
export const spreadShape: Shape = { tls: false, spread: true, room: true }

/** What systemd says of a unit now: its active state, its job's id where it has one, and its main process's id. */
type UnitNow = Readonly<{ state: string; job: string; pid: number }>

/** A `systemctl show` line: a property's name, `=`, its value. */
const shown = (lines: string, name: string): string =>
	Option.getOrElse(
		Option.map(Arr.findFirst(Str.split("\n")(lines), Str.startsWith(`${name}=`)), (line) =>
			Str.slice(name.length + 1)(line)
		),
		() => ""
	)

/** `unit` as systemd says it is now (UnitNow), read by `systemctl --user show`. */
const unitNow = (unit: string) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const lines = yield* Effect.orDie(
			spawner.string(
				ChildProcess.make("systemctl", [
					"--user",
					"show",
					"-p",
					"ActiveState",
					"-p",
					"Job",
					"-p",
					"MainPID",
					unit
				])
			)
		)
		const now: UnitNow = {
			state: shown(lines, "ActiveState"),
			job: shown(lines, "Job"),
			pid: Number(shown(lines, "MainPID"))
		}
		return now
	})

/** Whether every member of `family` runs now, held: active, with no job of systemd's pending. */
export const membersHeld = (family: CheckoutFamily) =>
	Effect.map(
		Effect.forEach(memberNames(family), (name) => unitNow(unitOf(name))),
		Arr.map((now) => now.state === "active" && Str.isEmpty(now.job))
	)

/** A member as its last hold's end leaves it: running, with nothing of systemd's to stop it, or stopped. */
export type Afterwards = "left running" | "stopped"

/**
 * Each member of `family` and its lease as the end of its last hold leaves them, read once every hold of it has ended:
 * a member active with no job pending is left running, since systemd stops a lease no hold wants, and its member with
 * it, as the hold's scope ends, before it answers another request; any other is stopping or stopped, its postmaster's
 * exit waited on (exitOf, its pidfile in `scratch`) and its unit read until systemd has done with it. Also whether any
 * lease of the family is still active.
 */
export const leftOnceUnheld = (family: CheckoutFamily, scratch: string) =>
	Effect.gen(function* () {
		const members = yield* Effect.forEach(memberNames(family), (name) =>
			Effect.gen(function* () {
				const now = yield* unitNow(unitOf(name))
				if (now.state === "active" && Str.isEmpty(now.job)) {
					const left: Afterwards = "left running"
					return left
				}
				if (now.pid > 0) {
					yield* exitOf(now.pid, scratch)
				}
				for (;;) {
					const after = yield* unitNow(unitOf(name))
					if ((after.state === "inactive" || after.state === "failed") && Str.isEmpty(after.job)) {
						const left: Afterwards = "stopped"
						return left
					}
					yield* liveSleep("20 millis")
				}
			})
		)
		const leases = yield* Effect.forEach(memberNames(family), (name) => unitNow(leaseOf(name)))
		return { members, leasesActive: Arr.some(leases, (now) => now.state === "active") }
	})

/** Whether member `name`'s data directory was ever made: its link, which its unit's first start makes, is there. */
export const memberMade = (family: CheckoutFamily, name: string) =>
	Effect.flatMap(FileSystem.FileSystem, (fs) =>
		Effect.isSuccess(fs.readLink(`${family.homes.data}/${name}`))
	)

if (import.meta.main) {
	const [checkout, states, width] = process.argv.slice(2)
	if (checkout !== undefined && states !== undefined && width !== undefined) {
		NodeRuntime.runMain(
			heldAsProgram(checkout, states, Number(width)).pipe(Effect.provide(NodeServices.layer))
		)
	}
}
