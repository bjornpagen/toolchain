import { Array as Arr, Effect, Exit, Option, Schema } from "effect"
import { assert } from "#assert.ts"
import {
	type Answer,
	accepted,
	type Machine,
	type Program,
	program,
	programs,
	type Real,
	refused,
	runProgram,
	type StepFeature,
	took,
	type Verdict
} from "#commands.ts"
import { type Branch, enumerated, firstBranch } from "#enumerate.ts"
import { constant, element, type Gen, int, type Weight } from "#gen.ts"
import { replayOf } from "#replay.ts"
import type { Verdict as SearchVerdict } from "#runner/protocol.ts"
import { forcedChooser, generate, recorder } from "#source.ts"
import { fullSwarm, type Presence, type Swarm, swarm } from "#swarm.ts"

export type Queue = ReadonlyArray<number>

export type QueueParameters = Readonly<{
	push: number
	pop: undefined
	size: undefined
	peek: number
}>

export type QueueCommand = keyof QueueParameters

/** What a bounded queue refuses: a push when it is full, a pop when it is empty. */
export type QueueRefusal = "full" | "empty"

const CAPACITY = 3

export const COMMANDS: Arr.NonEmptyReadonlyArray<QueueCommand> = ["push", "pop", "size", "peek"]

/**
 * A bounded FIFO queue as its model judges it, every command at the weights given: a push to a full queue and a pop
 * of an empty one are refused, named, and drawn like any other step; a peek names a position the queue holds, which is
 * the harness's own invariant, since no position past the end can be written down.
 */
export const queueOf = (
	weights: Readonly<Record<QueueCommand, Weight>>,
	values: Gen<number>
): Machine<Queue, QueueParameters, QueueRefusal> => ({
	initial: [],
	commands: {
		push: {
			weight: weights.push,
			applies: () => true,
			parameters: () => values,
			judge: (queue, value) =>
				queue.length < CAPACITY ? accepted(Arr.append(queue, value)) : refused("full")
		},
		pop: {
			weight: weights.pop,
			applies: () => true,
			parameters: () => constant(undefined),
			judge: (queue) => (queue.length > 0 ? accepted(Arr.drop(queue, 1)) : refused("empty"))
		},
		size: {
			weight: weights.size,
			applies: () => true,
			parameters: () => constant(undefined),
			judge: (queue) => accepted(queue)
		},
		peek: {
			weight: weights.peek,
			applies: (queue) => queue.length > 0,
			parameters: (queue) => int(0, queue.length - 1),
			judge: (queue) => accepted(queue)
		}
	}
})

export const EVEN: Readonly<Record<QueueCommand, Weight>> = { push: 1, pop: 1, size: 1, peek: 1 }

/** The weights a command's weight is drawn from in the weights property: small, so their totals stay small. */
export const WEIGHTS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const

export const QUEUE = queueOf(EVEN, int(0, 9))

/**
 * How a ring buffer is built: where its reads wrap (its capacity when right, short of it when wrong) and whether it
 * overwrites its oldest value when full rather than refusing the push.
 */
export type Build = Readonly<{ wrap: number; overwrites: boolean }>

/** A ring buffer built right. */
export const rightly: Build = { wrap: CAPACITY, overwrites: false }

/** Every way to build a ring buffer: its reads wrapping anywhere up to its capacity, overwriting or not. */
export const builds: Gen<Build> = (source) => ({
	wrap: source.draw(int(1, CAPACITY)),
	overwrites: source.draw(int(0, 1)) === 1
})

/** Whether a ring buffer is built right. */
export const isRight = (build: Build): boolean => build.wrap === CAPACITY && !build.overwrites

/** A ring buffer, the system under test, built as `build` says. */
export const ringBuffer = (build: Build) => {
	const slots = new Float64Array(CAPACITY)
	let head = 0
	let tail = 0
	let size = 0
	return {
		push: (value: number): boolean => {
			if (size === CAPACITY && !build.overwrites) {
				return false
			}
			slots[tail] = value
			tail = (tail + 1) % CAPACITY
			size = Math.min(CAPACITY, size + 1)
			return true
		},
		pop: (): Option.Option<number> => {
			if (size === 0) {
				return Option.none()
			}
			const value = slots[head] ?? 0
			head = (head + 1) % build.wrap
			size -= 1
			return Option.some(value)
		},
		peek: (at: number): number => slots[(head + at) % CAPACITY] ?? 0,
		size: () => size
	}
}

/** The queue's state the verdict claims after a step from `before`. */
const claimed = (before: Queue, verdict: Verdict<Queue, QueueRefusal>): Queue =>
	verdict.kind === "accepted" ? verdict.next : before

/** Each command run on a ring buffer: it answers what the buffer did, and checks it against the queue claimed. */
export const realOf = (
	buffer: ReturnType<typeof ringBuffer>
): Real<Queue, QueueParameters, QueueRefusal, never, never> => ({
	push: (value, _before, after) =>
		Effect.sync((): Answer<QueueRefusal> => {
			const tookIt = buffer.push(value)
			assert.equal(buffer.size(), after.length)
			return tookIt ? took : refused("full")
		}),
	pop: (_parameters, before) =>
		Effect.sync((): Answer<QueueRefusal> => {
			const popped = buffer.pop()
			if (Option.isNone(popped)) {
				return refused("empty")
			}
			assert.deepEqual<Option.Option<number>>(popped, Arr.head(before))
			return took
		}),
	size: (_parameters, before) =>
		Effect.sync((): Answer<QueueRefusal> => {
			assert.equal(buffer.size(), before.length)
			return took
		}),
	peek: (at, before) =>
		Effect.sync((): Answer<QueueRefusal> => {
			assert.deepEqual(Option.some(buffer.peek(at)), Arr.get(before, at))
			return took
		})
})

/** Programs of a queue machine over a swarm of its commands drawn with each. */
export const swarmedPrograms = (
	machine: Machine<Queue, QueueParameters, QueueRefusal>,
	size: Readonly<{ min: number; max: number }>
): Gen<Program<QueueParameters>> => programs(machine, size, swarm(COMMANDS))

/**
 * The verdicts of a program, judged by folding its machine's own judge over its steps: the second implementation
 * `runProgram`'s answers and final state are checked against.
 */
export const foldOf = (
	machine: Machine<Queue, QueueParameters, QueueRefusal>,
	steps: Program<QueueParameters>
): Folded =>
	Arr.reduce(
		steps,
		{ model: machine.initial, verdicts: [] },
		({ model, verdicts }: Folded, step): Folded => {
			const verdict = verdictOf(machine, model, step)
			return { model: claimed(model, verdict), verdicts: Arr.append(verdicts, verdict) }
		}
	)

/** A program's final state and its steps' verdicts, by the fold. */
export type Folded = Readonly<{
	model: Queue
	verdicts: ReadonlyArray<Verdict<Queue, QueueRefusal>>
}>

const verdictOf = (
	machine: Machine<Queue, QueueParameters, QueueRefusal>,
	model: Queue,
	step: Program<QueueParameters>[number]
): Verdict<Queue, QueueRefusal> => {
	switch (step.command) {
		case "push":
			return machine.commands.push.judge(model, step.parameters)
		case "pop":
			return machine.commands.pop.judge(model, step.parameters)
		case "size":
			return machine.commands.size.judge(model, step.parameters)
		case "peek":
			return machine.commands.peek.judge(model, step.parameters)
	}
}

/** The answer a verdict predicts, and the other answer a lying system gives instead. */
export const answerOf = (verdict: Verdict<Queue, QueueRefusal>): Answer<QueueRefusal> =>
	verdict.kind === "accepted" ? took : verdict

export const lieAbout = (verdict: Verdict<Queue, QueueRefusal>): Answer<QueueRefusal> =>
	verdict.kind === "accepted" ? refused("full") : took

/** How many programs of at most `steps` steps the harness can write from `model`: each step one it can name there. */
export const writable = (
	machine: Machine<Queue, QueueParameters, QueueRefusal>,
	values: number,
	model: Queue,
	steps: number
): number => {
	if (steps === 0) {
		return 1
	}
	const pushes = Arr.map(
		Array.from({ length: values }, (_, i) => i),
		(value): Program<QueueParameters>[number] => ({
			command: "push",
			parameters: value
		})
	)
	const peeks = Arr.map(Arr.fromIterable(model.keys()), (at): Program<QueueParameters>[number] => ({
		command: "peek",
		parameters: at
	}))
	const next: ReadonlyArray<Program<QueueParameters>[number]> = [
		...pushes,
		{ command: "pop", parameters: undefined },
		{ command: "size", parameters: undefined },
		...peeks
	]
	return (
		1 +
		Arr.reduce(
			next,
			0,
			(sum, step) =>
				sum + writable(machine, values, claimed(model, verdictOf(machine, model, step)), steps - 1)
		)
	)
}

export const STEP_FEATURES: Arr.NonEmptyReadonlyArray<StepFeature<QueueParameters, QueueRefusal>> =
	[
		"push accepted",
		"push refused full",
		"pop accepted",
		"pop refused empty",
		"size accepted",
		"peek accepted"
	]

/** How many items the queue holds before step `at` of `steps`, walked by hand: a push adds one below capacity, a pop takes one when there is one. */
export const heldBefore = (steps: Program<QueueParameters>, at: number): number =>
	Arr.reduce(Arr.take(steps, at), 0, (held, step) => {
		switch (step.command) {
			case "push":
				return held < CAPACITY ? held + 1 : held
			case "pop":
				return held > 0 ? held - 1 : held
			case "size":
			case "peek":
				return held
		}
	})

/**
 * A program of any of the queue's commands at any step, applicable or not, as a kept program may have drifted: a peek
 * names a position the queue holds there when it holds one, and position 0 of an empty queue otherwise, the one step
 * the model does not allow.
 */
export const anyProgram: Gen<Program<QueueParameters>> = (source) => {
	const length = source.draw(int(0, 8))
	const steps: Array<Program<QueueParameters>[number]> = []
	for (let at = 0; at < length; at += 1) {
		const held = heldBefore(steps, at)
		const command = source.draw(element(COMMANDS))
		switch (command) {
			case "push":
				steps.push({ command, parameters: source.draw(int(0, 9)) })
				break
			case "pop":
			case "size":
				steps.push({ command, parameters: undefined })
				break
			case "peek":
				steps.push({ command, parameters: source.draw(int(0, Math.max(0, held - 1))) })
		}
	}
	return steps
}

/** A command's presence in a swarm, 0 when off. */
export const presenceOf = (mix: Swarm<QueueCommand>, command: QueueCommand): 0 | Presence =>
	mix[command] ?? 0

/** Whether a program fails on a ring buffer built as `build`: a step answered otherwise than the queue, or a check. */
const failsOn = (build: Build, steps: Program<QueueParameters>): boolean =>
	Exit.isFailure(Effect.runSyncExit(runProgram(QUEUE, realOf(ringBuffer(build)), steps)))

/** The queue machine over pushes of 0 or 1: two values are all a ring buffer's wrong read needs to show. */
const TWO_VALUED = queueOf(EVEN, int(0, 1))

/** Whether some case of a bounded generator holds: its cases enumerated in order until one does. */
const someCase = <A>(generator: Gen<A>, holds: (value: A) => boolean): boolean => {
	const recorded = recorder()
	let branch: Option.Option<Branch> = Option.some(firstBranch)
	while (Option.isSome(branch)) {
		const step = enumerated(recorded, generator, branch.value)
		if (holds(step.generated.value)) {
			return true
		}
		branch = step.next
	}
	return false
}

/**
 * The fewest steps of a program of pushes of 0 or 1 that fails on `build`, found by enumerating every such program of
 * one step, then two, up to `most`: the bound a shrink of a failing program must reach. None when none fails.
 */
export const shortestFailing = (build: Build, most: number): Option.Option<number> =>
	Arr.findFirst(
		Array.from({ length: most }, (_, at) => at + 1),
		(length) =>
			someCase(program(TWO_VALUED, { min: length, max: length }, fullSwarm(COMMANDS)), (steps) =>
				failsOn(build, steps)
			)
	)

/** A search a property expected to falsify its case did not: it ended as `verdict` says. */
class NotFalsified extends Schema.TaggedError<NotFalsified, { readonly brand: unique symbol }>()(
	"NotFalsified",
	{ verdict: Schema.String }
) {}

/**
 * The program a search's falsified finding shrank to, read back from its replay token's values through the space it
 * was drawn from; NotFalsified for a verdict that is not a falsification.
 */
export const shrunkOf = (verdict: SearchVerdict, space: Gen<Program<QueueParameters>>) =>
	verdict.kind === "failed" && verdict.finding.kind === "falsified"
		? Effect.map(
				replayOf(verdict.finding.token),
				({ replayed }) =>
					generate(
						recorder(),
						space,
						forcedChooser(Float64Array.from(replayed.values), replayed.values.length)
					).value
			)
		: Effect.fail(NotFalsified.make({ verdict: verdict.kind }))
