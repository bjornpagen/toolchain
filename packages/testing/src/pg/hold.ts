import { Array as Arr, Brand, Effect, type Scope, String as Str } from "effect"
import { ChildProcess, type ChildProcessSpawner } from "effect/process"
import { type CheckoutFamily, memberNames, sliceOf, unitOf } from "#pg/family.ts"
import { type ClusterFailed, failed, type Step, succeeded } from "#pg/server.ts"

/**
 * A family's members run exactly as long as some process that needs them does: a run's worker that reaches the family,
 * a member's settle while it settles, a person's psql. No member is started as a unit of its own, which a run that ended,
 * failed or was killed left running for days (2026-11-24: 379 members of grizzle's families idle in /dev/shm, 88 GB of
 * its 124, and runs refused at CREATE DATABASE for want of space). Each link is an invariant of systemd's or the
 * kernel's, kept with no clock and no reaper:
 *
 * - A member is stopped by its lease (leaseOf), `<member>-lease.service`, a transient unit beside the member's
 *   postgres@ unit, which runs nothing (a oneshot of /bin/true that remains after it exits): PropagatesStopTo= the
 *   member, so its stop stops the member; and StopWhenUnneeded=, so systemd stops it, and with it the member, once no
 *   active unit wants it. The workbench's postgres@ unit, which every repository's members are instances of, takes no
 *   dependency at run time (`systemctl set-property` refuses BindsTo= on a loaded unit), so the dependency lives in the
 *   lease.
 * - A member is started and restarted only while its lease is active (whileLeased: leaseStarted, leaseRestarted), by a
 *   transient oneshot that runs the `systemctl` and requires the lease (Requisite=): systemd refuses it where the lease
 *   is stopped, and keeps the lease while it runs, so no start or restart is ever under way as a lease stops, which
 *   would leave the member's stop refused. The lease depends on the member in no way, so a member's restart is one
 *   restart, never a stop and a start that a member in memory loses its data by.
 * - What wants a lease is a hold (familyHeld), `<family>-hold-<random>.scope`, a transient scope that wants every
 *   member's lease, made by each process that needs the family for as long as it needs it, its one process a shell
 *   reading a pipe that only the holding process writes (HOLDER). The kernel closes a process's end of every pipe as
 *   the process ends, however it ends, a SIGKILL's and its unit's stop included, where no finalizer of its runs; the
 *   shell reads the end of its input and exits, and the scope, empty, ends. A hold binds to the process, never to a
 *   unit it runs in: a terminal's scope lives for days, and a unit's service may run many runs.
 *
 * So a member is started only while its lease is active, stopped as its lease stops, its lease active only while some
 * hold wants it, and a hold only while its process lives; systemd counts the holds, so a run's workers, and two runs of
 * one checkout, share members, and the last hold's end stops them, a member in memory taking its data with its stop
 * (family.ts).
 */

/** A member's lease, the transient unit that alone starts it: `<member>-lease.service`. */
export const leaseOf = (name: string): string => `${name}-lease.service`

/**
 * A family that this process holds for the enclosing scope (familyHeld), so every member of it it brings up stays up
 * while the scope is open: what a worker's first need takes (settle.ts memberBroughtUp), whose read after a settle finds
 * the member the settle started only while some process holds it.
 */
export type HeldFamily = CheckoutFamily & Brand.Brand<"HeldFamily">

const heldOf = Brand.nominal<HeldFamily>()

/** Node's child processes: a hold's shell is started with a pipe the holding process alone writes. */
const childProcesses = process.getBuiltinModule("node:child_process")

/**
 * What a hold's scope runs: a line that says the scope is made, written once systemd-run has made it and runs the
 * shell in it, then its standard input read to its end, which comes when the process that holds the pipe's other end
 * closes it or ends however it ends.
 */
const HOLDER = "echo held; while read -r _; do :; done"

/** systemd-run started with `args`, a pipe to each of its standard streams, in a session of its own. */
const spawned = (args: ReadonlyArray<string>) =>
	childProcesses.spawn("systemd-run", args, { detached: true, stdio: ["pipe", "pipe", "pipe"] })

/** A hold's process as Node holds it, and its scope's name. */
type Holder = Readonly<{ unit: string; child: ReturnType<typeof spawned> }>

/**
 * `family`'s hold made: systemd-run makes the scope `<family>-hold-<8 random hex digits>.scope` in the family's
 * repository's slice, wanting every member's lease, then runs HOLDER in it, whose first line says so. Its shell leads a
 * session of its own, so a signal to this process's group (the pool ending a worker's group) never ends it first: it
 * ends as its input does.
 */
const holderMade = (family: CheckoutFamily): Effect.Effect<Holder, ClusterFailed> =>
	Effect.callback<Holder, ClusterFailed>((resume) => {
		const unit = `${family.name}-hold-${process.getBuiltinModule("node:crypto").randomBytes(4).toString("hex")}.scope`
		const step: Step = { cluster: family.name, doing: `holding it as ${unit}` }
		const child = spawned([
			"--user",
			"--scope",
			"--quiet",
			"--collect",
			`--unit=${unit}`,
			`--slice=${sliceOf(family.cluster)}`,
			...Arr.flatMap(memberNames(family), (name) => ["-p", `Wants=${leaseOf(name)}`]),
			"--",
			"/bin/sh",
			"-c",
			HOLDER
		])
		let said = ""
		let complained = ""
		const unmade = (code: number | null, signal: string | null) =>
			resume(
				Effect.fail(
					failed(
						step,
						`systemd-run exited ${code ?? signal}: ${Str.trim(`${complained}\n${said}`)}`
					)
				)
			)
		child.stderr.setEncoding("utf8").on("data", (text: string) => {
			complained += text
		})
		child.stdout.setEncoding("utf8").on("data", (text: string) => {
			said += text
			if (!Str.includes("\n")(said)) {
				return
			}
			child.stdout.removeAllListeners("data")
			child.removeListener("close", unmade)
			resume(Effect.succeed({ unit, child }))
		})
		child.once("error", (error) => resume(Effect.fail(failed(step, error.message))))
		child.once("close", unmade)
	})

/** A hold let go: its shell's input ended, and its exit, with which its scope ends, waited on. */
const holderEnded = (holder: Holder): Effect.Effect<void> =>
	Effect.callback<void>((resume) => {
		const { child } = holder
		if (child.exitCode !== null || child.signalCode !== null) {
			resume(Effect.void)
			return
		}
		child.once("exit", () => resume(Effect.void))
		child.stdin.end()
	})

/**
 * `family` held by this process for the enclosing scope: a hold of its own (holderMade), wanting every member's lease,
 * which ends as the scope closes or as this process ends, however it ends. While it lasts, every member of the family
 * that a lease started stays up; once the last hold of the family ends, systemd stops every lease no hold wants, and
 * each lease its member.
 */
export const familyHeld = (
	family: CheckoutFamily
): Effect.Effect<HeldFamily, ClusterFailed, Scope.Scope> =>
	Effect.as(Effect.acquireRelease(holderMade(family), holderEnded), heldOf(family))

/**
 * What systemd-run is given to make member `name`'s lease (leaseOf) of `family` and start it: a transient unit in the
 * family's repository's slice that runs /bin/true and remains (Type=oneshot, RemainAfterExit=), stopped by systemd once
 * no active unit wants it (StopWhenUnneeded=) and stopping the member as it stops (PropagatesStopTo=); collected once
 * stopped and wanted by no hold. It starts nothing: a hold made while it is loaded and stopped starts it alone.
 */
const leaseArgv = (family: CheckoutFamily, name: string): ReadonlyArray<string> =>
	Arr.flatten([
		[
			"--user",
			"--quiet",
			"--collect",
			`--unit=${leaseOf(name)}`,
			`--slice=${sliceOf(family.cluster)}`
		],
		Arr.flatMap(
			[
				"Type=oneshot",
				"RemainAfterExit=yes",
				"StopWhenUnneeded=yes",
				`PropagatesStopTo=${unitOf(name)}`
			],
			(property) => ["-p", property]
		),
		["--", "/bin/true"]
	])

/**
 * Member `name`'s lease of `family` made and started (leaseArgv), or, where it is loaded already (a hold made it start,
 * or another settle made it), started (`systemctl --user start`), for `step`. Started where no hold wants it, systemd
 * stops it at once.
 */
const leaseMade = (family: CheckoutFamily, name: string, step: Step) => {
	const lease = leaseOf(name)
	return Effect.catch(
		succeeded(step, ChildProcess.make("systemd-run", leaseArgv(family, name))),
		(unmade) =>
			Effect.mapError(
				succeeded(step, ChildProcess.make("systemctl", ["--user", "start", lease])),
				(unstarted) => failed(step, `${unmade.message}; started as loaded: ${unstarted.message}`)
			)
	)
}

/**
 * `systemctl --user <verb>` of member `name`'s unit run while its lease is active and kept so, for `step`, to its end:
 * the command of a transient oneshot `<member>-<verb>-<8 random hex digits>` in the family's repository's slice that
 * requires its lease active and runs after it (Requisite=, After=), so systemd refuses it, and the member is never
 * started or restarted, where the lease is stopped, its last hold ended; and while it runs the lease stays (its
 * requisite is needed), so a hold that ends meanwhile stops the member only once the command is done, never under a
 * start or a restart that systemd would refuse to stop. Its exit status and what it printed are systemd-run's
 * (`--wait --pipe`).
 */
const whileLeased = (
	family: CheckoutFamily,
	name: string,
	verb: "start" | "try-restart",
	step: Step
) => {
	const lease = leaseOf(name)
	const unit = `${name}-${verb}-${process.getBuiltinModule("node:crypto").randomBytes(4).toString("hex")}.service`
	return Effect.asVoid(
		succeeded(
			{ ...step, doing: `${step.doing}: systemctl --user ${verb} ${unitOf(name)} as ${unit}` },
			ChildProcess.make("systemd-run", [
				"--user",
				"--quiet",
				"--collect",
				"--wait",
				"--pipe",
				`--unit=${unit}`,
				`--slice=${sliceOf(family.cluster)}`,
				"-p",
				"Type=oneshot",
				"-p",
				`Requisite=${lease}`,
				"-p",
				`After=${lease}`,
				"--",
				"systemctl",
				"--user",
				verb,
				unitOf(name)
			])
		)
	)
}

/**
 * Member `name` of `family` started by its lease for `step`, to its start, its server ready: its lease made or started
 * (leaseMade), then the member started while the lease is active and kept so (whileLeased). A start where no hold wants
 * the lease is refused, the lease stopped at once: a settle whose asker has ended starts nothing.
 */
export const leaseStarted = (
	family: CheckoutFamily,
	name: string,
	step: Step
): Effect.Effect<void, ClusterFailed, ChildProcessSpawner.ChildProcessSpawner> => {
	const at: Step = { ...step, doing: `${step.doing}: starting it by its lease ${leaseOf(name)}` }
	return Effect.andThen(leaseMade(family, name, at), whileLeased(family, name, "start", at))
}

/**
 * Member `name` of `family` restarted where it runs, for `step`, while its lease is active and kept so (whileLeased,
 * `try-restart`): systemd starts it again once it is ready (Type=notify), as one restart, so a member in memory keeps
 * its data; a member stopped meanwhile stays stopped.
 */
export const leaseRestarted = (
	family: CheckoutFamily,
	name: string,
	step: Step
): Effect.Effect<void, ClusterFailed, ChildProcessSpawner.ChildProcessSpawner> =>
	whileLeased(family, name, "try-restart", step)
