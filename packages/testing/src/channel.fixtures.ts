import { Array as Arr, Effect, Option } from "effect"
import { deepStrictEqual } from "#assert.ts"
import {
	branch,
	type Observation,
	type OutcomeFeature,
	type ReactiveMachine,
	type ReactiveReal
} from "#commands.ts"
import { constant, type Gen, int } from "#gen.ts"

/** The messages a lossy channel's model holds in flight, oldest first. */
export type InFlight = ReadonlyArray<number>

export type ChannelParameters = Readonly<{ send: number; receive: undefined; peek: number }>

export type ChannelRule = keyof ChannelParameters

/**
 * What a channel's observation names: a send delivered or dropped, a receive that got a message or found none, a
 * message seen in place.
 */
export type ChannelOutcome = "delivered" | "dropped" | "received" | "empty" | "seen"

/** What a channel shows of a step: the message it received or saw, none for a send or an empty receive. */
export type Shown = Option.Option<number>

export const RULES: Arr.NonEmptyReadonlyArray<ChannelRule> = ["send", "receive", "peek"]

/** Every step feature of the channel's model. */
export const CHANNEL_FEATURES: Arr.NonEmptyReadonlyArray<
	OutcomeFeature<ChannelParameters, ChannelOutcome>
> = ["send delivered", "send dropped", "receive received", "receive empty", "peek seen"]

/** An outcome whose state follows only when the system showed `expected`. */
const showing = (outcome: ChannelOutcome, expected: number, next: InFlight) => ({
	outcome,
	next: (shown: Shown) => (Option.contains(shown, expected) ? Option.some(next) : Option.none())
})

/**
 * A lossy FIFO channel as its model judges it: a send is delivered or dropped, which the model cannot tell (the
 * channel's capacity is the system's own), so it allows both; a receive gets the oldest message in flight, or finds
 * none; a peek names a position in flight, the harness's own invariant, and sees the message there.
 */
export const CHANNEL: ReactiveMachine<InFlight, ChannelParameters, ChannelOutcome, Shown> = {
	rules: {
		send: {
			weight: 2,
			applies: () => true,
			parameters: () => int(0, 9),
			judge: (inFlight, message) => [
				branch("delivered", Arr.append(inFlight, message)),
				branch("dropped", inFlight)
			]
		},
		receive: {
			weight: 2,
			applies: () => true,
			parameters: () => constant(undefined),
			judge: (inFlight) =>
				Arr.match(inFlight, {
					onEmpty: () => [branch("empty", inFlight)],
					onNonEmpty: ([oldest, ...rest]) => [showing("received", oldest, rest)]
				})
		},
		peek: {
			weight: 1,
			applies: (inFlight) => inFlight.length > 0,
			parameters: (inFlight) => int(0, inFlight.length - 1),
			judge: (inFlight, at) => [showing("seen", Arr.getUnsafe(inFlight, at), inFlight)]
		}
	}
}

/**
 * How a channel is built: how many messages it holds before it drops a send; whether it serves the newest message
 * rather than the oldest; and whether it keeps a dropped message where no receive serves it but its size counts it.
 */
export type ChannelBuild = Readonly<{ capacity: number; reorders: boolean; leaksDropped: boolean }>

/** Every way to build a channel of capacity 1 or 2. */
export const channelBuilds: Gen<ChannelBuild> = (source) => ({
	capacity: source.draw(int(1, 2)),
	reorders: source.draw(int(0, 1)) === 1,
	leaksDropped: source.draw(int(0, 1)) === 1
})

/**
 * Whether a channel behaves as a lossy FIFO channel: it keeps no dropped message, and it serves the oldest message, or
 * holds one message at most, so the newest is the oldest.
 */
export const isRightChannel = (build: ChannelBuild): boolean =>
	!build.leaksDropped && (!build.reorders || build.capacity === 1)

/** A channel, the system under test, built as `build` says, of a capacity the model never reads. */
export const channelOf = (build: ChannelBuild) => {
	const held: Array<number> = []
	let leaked = 0
	return {
		send: (message: number): boolean => {
			if (held.length < build.capacity) {
				held.push(message)
				return true
			}
			leaked += build.leaksDropped ? 1 : 0
			return false
		},
		receive: (): Option.Option<number> =>
			Option.fromUndefinedOr(build.reorders ? held.pop() : held.shift()),
		peek: (at: number): Option.Option<number> =>
			Arr.get(held, build.reorders ? held.length - 1 - at : at),
		held: (): ReadonlyArray<number> => held,
		size: (): number => held.length + leaked
	}
}

/** An observation of a step that showed nothing. */
const nothing = (outcome: ChannelOutcome): Observation<ChannelOutcome, Shown> => ({
	outcome,
	shown: Option.none()
})

/**
 * Each rule run on a channel, which starts empty: it acts and answers what the channel did; `holds` checks the channel
 * holds exactly the messages the model has in flight, by its size as well, so a message it keeps where nothing serves
 * it is seen.
 */
export const channelReal = (
	channel: ReturnType<typeof channelOf>
): ReactiveReal<InFlight, ChannelParameters, ChannelOutcome, Shown, never, never> => ({
	start: [],
	steps: {
		send: (message) => Effect.sync(() => nothing(channel.send(message) ? "delivered" : "dropped")),
		receive: () =>
			Effect.sync(() =>
				Option.match(channel.receive(), {
					onNone: () => nothing("empty"),
					onSome: (message) => ({ outcome: "received", shown: Option.some(message) })
				})
			),
		peek: (at) => Effect.sync(() => ({ outcome: "seen", shown: channel.peek(at) }))
	},
	holds: (after) =>
		Effect.sync(() => {
			deepStrictEqual(
				{ held: channel.held(), size: channel.size() },
				{ held: after, size: after.length }
			)
		})
})
