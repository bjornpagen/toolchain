import { Effect, Option, Schema, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { element, finite } from "#gen.ts"
import { type Reservation, reservationFiles } from "#pg/lease.ts"

/**
 * What the contended-lease property (contended.test.ts) draws, and the run it sets beside the run it watches: a run of
 * its own, a process apart that takes a family's one slot through the toolchain's holder of kernel locks
 * (scripts/hold.pl), as another lane's suite holds a shared family's slots, and holds it for HOLD_MILLIS, its process
 * tree either working all the while or stopped, before it lets go.
 */

/** How the run that holds the slot spends its hold: its tree's CPU moving, or spending nothing. */
export type Holder = "a holder that works" | "a holder that stops"

/** Both holders, one case each. */
export const holders = finite((source): Holder =>
	source.draw(element(["a holder that works", "a holder that stops"] as const))
)

/** The open bound of the waiting worker's need, in milliseconds: a second, so its guard reads it every second. */
export const OPEN_MILLIS = 1000

/**
 * How long the holder holds the slot, in milliseconds: two of the waiting worker's pool's whole windows (the need's open
 * bound and the pool's silence grace, runner/pool.ts) and more, so the pool reads the wait twice while it lasts, as
 * runner/pool.fixtures.ts DECLARED_WAIT is to a declared wait.
 */
const HOLD_MILLIS = 40_000

/** How much CPU a working holder spends at each of its ticks, in milliseconds: past what shows progress in any window. */
const BURST_MILLIS = 20

/** How long a holder sleeps between its ticks, in milliseconds. */
const TICK_MILLIS = 250

/** The holder of kernel locks, beside this package's other programs. */
const HOLDER = `${import.meta.dirname}/../../scripts/hold.pl`

/** A holder's arguments as the JSON array its program spawns it with. */
const argumentsText = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))

/**
 * The program of the run that holds: it starts the holder of kernel locks with the arguments `holderArguments` states
 * (argumentsText), says `held` once the holder does, and exits HOLD_MILLIS later, which ends the holder's standard
 * input and lets the slot go; meanwhile, when it `works`, it spends BURST_MILLIS of its own CPU at each tick, and when it
 * does not, it does nothing at all: no tick wakes it, so neither it nor its holder runs, waits to run or does storage
 * work until it exits, which is a holder stopped.
 */
const holderProgram = (holderArguments: string, works: boolean): string =>
	`const { spawn } = process.getBuiltinModule("node:child_process")
const holder = spawn("perl", ${holderArguments}, { stdio: ["pipe", "pipe", "inherit"] })
const cpu = () => { const used = process.cpuUsage(); return (used.user + used.system) / 1000 }
const tick = () => {
	const until = cpu() + ${String(BURST_MILLIS)}
	while (cpu() < until) {}
	setTimeout(tick, ${String(TICK_MILLIS)})
}
let said = ""
holder.stdout.on("data", (chunk) => {
	said += chunk.toString("utf8")
	if (said !== "held\\n") { return }
	process.stdout.write("held\\n")
	setTimeout(() => process.exit(0), ${String(HOLD_MILLIS)})
	if (${String(works)}) { tick() }
})`

/**
 * `reservation`'s gate and every slot it reserves, held by a run of its own that `holder` says how it spends its hold,
 * for the enclosing scope, which ends it: once this returns, the run holds them.
 */
export const heldApart = (reservation: Reservation, holder: Holder) =>
	Effect.gen(function* () {
		const [gate, ...slots] = reservationFiles(reservation)
		const holderArguments = yield* Effect.orDie(
			argumentsText([HOLDER, "gate", gate, "wait", "exclusive", String(slots.length), ...slots])
		)
		const handle = yield* ChildProcess.make(
			process.execPath,
			["-e", holderProgram(holderArguments, holder === "a holder that works")],
			{ stdin: "ignore", stderr: "inherit" }
		)
		const said = yield* Stream.runHead(Stream.splitLines(Stream.decodeText(handle.stdout)))
		if (!Option.contains(said, "held")) {
			return yield* Effect.die("the run that holds ended before it held the slot")
		}
	})

/** What the waiting worker's case comes to behind each holder: it passes behind one that works, and its need fails to
 * open, stalled at its open bound, behind one that stops. */
export const outcomeBehind = (holder: Holder): "passed" | "unopened" =>
	holder === "a holder that works" ? "passed" : "unopened"
