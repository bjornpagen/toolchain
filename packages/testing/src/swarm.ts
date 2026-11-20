import { Array as Arr } from "effect"
import type { Gen } from "#gen.ts"
import { type Weights, weightsOf } from "#source.ts"

/** A feature's weight in one case: off, or present at a third, two thirds or every place it could appear. */
export type SwarmWeight = 0 | 1 | 2 | 3

/** The weight of a feature a swarm turns on. */
export type Presence = Exclude<SwarmWeight, 0>

/**
 * One case's swarm: the features it turns on, each at its weight, every feature it does not name being off. A drawn
 * swarm always turns at least one on (`swarm`'s forced feature); `fullSwarm` turns every one on. Swarm
 * testing randomizes the generator's own settings per case, so each case explores a lopsided corner where features
 * that crowd others out are absent and the rest combine. A swarm is its own literal: a kept case writes
 * `{ join: 3, where: 1 }`, and a feature added to or removed from the generator's list is a type error there.
 */
export type Swarm<F extends string> = Readonly<Partial<Record<F, Presence>>>

/**
 * How many of the features other than its forced one a case omits, drawn per case, the most omitting first, so a
 * failing case shrinks toward fewer features. Drawing it per case makes cases with few features on as common as cases
 * with most of them on, which one fixed rate never does.
 */
export const OMISSIONS = ["five-sixths", "half", "one-sixth"] as const

export type Omission = (typeof OMISSIONS)[number]

/**
 * A feature's gate is one weighted decision (Source.weigh) over eighteen parts: off for `OFF[omission]` of them, and
 * weights 1, 2 and 3 in equal thirds of the rest. Eighteen divides by six and by three, so every rate and every third is
 * exact; an enumeration meets each of the four once, and a gate shrinks toward the first, the feature being off.
 */
const GATES = 18

const OFF: Readonly<Record<Omission, number>> = { "five-sixths": 15, half: 9, "one-sixth": 3 }

const PRESENCES = [1, 2, 3] as const

/** A gate's weights under an omission that turns a feature off for `off` of GATES parts: off, then each presence. */
const gateOf = (off: number): Weights => {
	const third = (GATES - off) / 3
	return weightsOf([off, third, third, third])
}

/** Each omission's gate (gateOf). */
const GATE_WEIGHTS: Readonly<Record<Omission, Weights>> = {
	"five-sixths": gateOf(OFF["five-sixths"]),
	half: gateOf(OFF.half),
	"one-sixth": gateOf(OFF["one-sixth"])
}

/**
 * Draws a swarm over a generator's features: first the one feature every case has, then an omission, then one decision
 * per feature in the order given, a gate for every other feature and a presence for the one every case has. That
 * feature is the forced move that keeps a swarm from turning every feature off, which would leave a case none of the
 * generator's features to combine; it is drawn uniformly, shrinks toward the first feature and its presence toward 1,
 * so a failing case still shrinks toward the fewest features at the lowest weight.
 */
export const swarm =
	<F extends string>(features: Arr.NonEmptyReadonlyArray<F>): Gen<Swarm<F>> =>
	(source) => {
		source.open("swarm")
		const forced = source.pick(0, features.length - 1)
		const gate = GATE_WEIGHTS[Arr.getUnsafe(OMISSIONS, source.pick(0, OMISSIONS.length - 1))]
		const on: Partial<Record<F, Presence>> = {}
		for (const [index, feature] of features.entries()) {
			if (index === forced) {
				on[feature] = Arr.getUnsafe(PRESENCES, source.pick(0, PRESENCES.length - 1))
				continue
			}
			const presence = source.weigh(gate)
			if (presence > 0) {
				on[feature] = Arr.getUnsafe(PRESENCES, presence - 1)
			}
		}
		source.close()
		return on
	}

/** The swarm that turns every feature on at full weight: a generator's behaviour without swarm testing. */
export const fullSwarm = <F extends string>(features: ReadonlyArray<F>): Swarm<F> => {
	const on: Partial<Record<F, Presence>> = {}
	for (const feature of features) {
		on[feature] = 3
	}
	return on
}

/** A feature's weight in a swarm. */
export const weightOf = <F extends string>(drawn: Swarm<F>, feature: F): SwarmWeight =>
	drawn[feature] ?? 0

/**
 * Whether a feature appears at the next place it could: always at weight 3, never when off, and otherwise by one more
 * decision on the case's tape, which shrinks toward leaving it out.
 */
export const keep =
	<F extends string>(drawn: Swarm<F>, feature: F): Gen<boolean> =>
	(source) => {
		const weight = weightOf(drawn, feature)
		return weight === 3 || (weight > 0 && source.weigh(weightsOf([3 - weight, weight])) === 1)
	}

/**
 * One of several features, each as often as its weight, shrinking toward the first that is on. When every one is off
 * the choice takes the first, the floor, which the caller names first because it is the simplest valid form: a
 * filter's input, a union's first arm. So no draw is a dead end, and the caller never needs a fallback of its own. When
 * exactly one is on, that one is no choice and draws nothing. It returns the options' own type, so a choice among some
 * of the features keeps that subset.
 */
export const swarmChoice =
	<F extends string, O extends F>(drawn: Swarm<F>, options: Arr.NonEmptyReadonlyArray<O>): Gen<O> =>
	(source) => {
		const on = Arr.filter(options, (option) => weightOf(drawn, option) > 0)
		if (!Arr.isReadonlyArrayNonEmpty(on)) {
			return Arr.headNonEmpty(options)
		}
		if (on.length === 1) {
			return Arr.headNonEmpty(on)
		}
		return Arr.getUnsafe(
			on,
			source.weigh(weightsOf(Arr.map(on, (option) => weightOf(drawn, option))))
		)
	}
