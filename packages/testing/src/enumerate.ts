import { Effect, Option, Scheduler } from "effect"
import type { Gen } from "#gen.ts"
import {
	type Generated,
	generate,
	prefixChooser,
	type Recorder,
	recorder,
	simplestChooser
} from "#source.ts"
import type { Tape } from "#tape.ts"

/** A point in enumeration order: the first `length` decisions fixed to `values`, every later one at its simplest. */
export type Branch = Readonly<{ values: Float64Array; length: number }>

/** The first branch of every enumeration: no decision fixed yet. */
export const firstBranch: Branch = { values: new Float64Array(0), length: 0 }

/**
 * The branch after a case in enumeration order: the last decision that can still grow takes its next value, and every
 * decision after it starts again from its simplest. The first decision is outermost and each decision counts up from
 * its simplest, so cases come smallest first and every case of a bounded generator comes exactly once.
 */
export const nextBranch = (tape: Tape): Option.Option<Branch> => {
	for (let at = tape.length - 1; at >= 0; at -= 1) {
		const value = tape.values[at] ?? 0
		if (value >= (tape.hi[at] ?? 0)) {
			continue
		}
		const values = tape.values.slice(0, at + 1)
		values[at] = value + 1
		return Option.some({ values, length: at + 1 })
	}
	return Option.none()
}

/** One step of an enumeration: the case at a branch, and the branch after it, if there is one. */
export type Enumerated<A> = Readonly<{ generated: Generated<A>; next: Option.Option<Branch> }>

/**
 * The case at `branch`, every decision past it at its simplest, and the branch that follows, recorded on `recorded`'s
 * buffers.
 */
export const enumerated = <A>(
	recorded: Recorder,
	generator: Gen<A>,
	branch: Branch
): Enumerated<A> => {
	const generated = generate(
		recorded,
		generator,
		prefixChooser(branch.values, branch.length, simplestChooser)
	)
	return { generated, next: nextBranch(generated.tape) }
}

/** Milliseconds of a reading of a thread's CPU, user and system. */
const cpuMillisOf = (spent: NodeJS.CpuUsage): number => (spent.user + spent.system) / 1000

/**
 * How many cases a generator's space holds, counted as sizeOf counts it, unless the count itself takes more than
 * `cpuMillis` of CPU: none then, for a space too large to count, and so to exhaust. The count is bounded by the CPU it
 * spends, its thread's alone (no collector or other thread of the process), read around each run of cases it counts
 * between two yields, never by the time that passes, so a busy machine,
 * or a busy process whose other fibers run between those runs, never makes a countable space uncountable.
 */
export const countWithin = (
	generator: Gen<unknown>,
	cpuMillis: number
): Effect.Effect<Option.Option<number>> =>
	Effect.gen(function* () {
		const yieldEvery = yield* Scheduler.MaxOpsBeforeYield
		const recorded = recorder()
		let cases = 0
		let spent = 0
		let branch: Option.Option<Branch> = Option.some(firstBranch)
		while (Option.isSome(branch)) {
			const began = process.threadCpuUsage()
			for (let run = 0; run < yieldEvery && Option.isSome(branch); run += 1) {
				branch = enumerated(recorded, generator, branch.value).next
				cases += 1
			}
			spent += cpuMillisOf(process.threadCpuUsage(began))
			if (spent > cpuMillis) {
				return Option.none()
			}
			yield* Effect.yieldNow
		}
		return Option.some(cases)
	})

/**
 * How many cases a generator's space holds, counted by generating alone before any property runs, every case on one
 * recorder's buffers. The count yields to the event loop as often as the runtime yields a fiber, once every
 * MaxOpsBeforeYield of its cases, so the deadline of the test it runs in can end the count of a space too large to
 * finish, which fails the test: an exhaustive check is a proof over its whole space or nothing, and no cap ends it
 * early.
 */
export const sizeOf = (generator: Gen<unknown>): Effect.Effect<number> =>
	Effect.gen(function* () {
		const yieldEvery = yield* Scheduler.MaxOpsBeforeYield
		const recorded = recorder()
		let cases = 0
		let branch: Option.Option<Branch> = Option.some(firstBranch)
		while (Option.isSome(branch)) {
			branch = enumerated(recorded, generator, branch.value).next
			cases += 1
			if (cases % yieldEvery === 0) {
				yield* Effect.yieldNow
			}
		}
		return cases
	})
