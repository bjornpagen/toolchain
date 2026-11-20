import { Array as Arr } from "effect"
import { between, biased, caseSeed, type Stream, type Words, wordsOf } from "#random.ts"
import type { Status, Tape } from "#tape.ts"

/** Whether what the system decided matches the tape being replayed: always, on a fresh tape. */
export type Observed = "as-recorded" | "diverged"

/**
 * What a generator draws its decisions from. `choose` makes one bounded decision about a magnitude, which a random
 * search leans toward the ends of a wide range (`biased`); `pick` makes one bounded decision among options, which a
 * random search draws uniformly however wide, so a choice's stated distribution is its distribution; `weigh` makes one
 * decision among options in proportion to their weights (Weights), which a random search draws as often as each one's
 * weight and every other search sees as one value an option, so an enumeration meets each option once, never once a
 * unit of its weight, and a shrink moves toward the first; `recall` makes
 * one decision of 0 to `count` that every search takes at 0 and only a replay takes past it, the arm of a recorded
 * space (gen.ts recorded), which only a token reaches; `draw` runs
 * another generator on the same decisions, so a struct, a tuple or a dependent value is a plain function body; `span`
 * labels the decisions a generator makes while it runs, so a tape keeps its structure (`open` and `close` do the same
 * without allocating, for a combinator's loop, and must pair); `observe` records a value the system under test decided, not the test, as a decision with one
 * possible value, and says whether a replay recorded the same one there; an observation a replay lacks is new, never
 * an overrun. A generator never sees where the values come from: a random stream, a replay, an enumeration or a shrink
 * candidate are all the same to it.
 */
export type Source = Readonly<{
	choose: (lo: number, hi: number) => number
	pick: (lo: number, hi: number) => number
	weigh: (weights: Weights) => number
	recall: (count: number) => number
	draw: <A>(generator: (source: Source) => A) => A
	span: <A>(label: string, generate: () => A) => A
	open: (label: string) => void
	close: () => void
	observe: (value: number) => Observed
}>

/**
 * Options' weights as a weighted decision (Source.weigh) takes them: each a whole number from one, an option's in its
 * place, and their sum (weightsOf).
 */
export type Weights = Readonly<{
	kind: "weighted"
	weights: Arr.NonEmptyReadonlyArray<number>
	total: number
}>

/** Options' whole-number weights, each at least one, as a weighted decision takes them. */
export const weightsOf = (weights: Arr.NonEmptyReadonlyArray<number>): Weights => ({
	kind: "weighted",
	weights,
	total: Arr.reduce(weights, 0, (sum, weight) => sum + weight)
})

/** The option a unit of weight below the total falls in: each option owns the next `weight` units, in order. */
export const optionAt = (weights: Weights, unit: number): number => {
	let rest = unit
	for (const [option, weight] of weights.weights.entries()) {
		if (rest < weight) {
			return option
		}
		rest -= weight
	}
	return weights.weights.length - 1
}

/**
 * How a random search spreads a decision over its range: a magnitude leans toward the ends of a wide range, where code
 * branches; an option is drawn uniformly, so no option is favoured by where it sits; a weighted option is drawn as often
 * as its weight (a unit of the total, uniformly, read as the option that owns it: optionAt); and a recalled decision is
 * taken at its least, so no drawn case reaches a value a regression recorded. Only a random search spreads by it, and a
 * recording bounds a recalled decision's tape by the value it took (recorder); a replay, an enumeration and a shrink see
 * the same decision with the same bounds, a weighted one's an option a value.
 */
export type Spread =
	| Readonly<{ kind: "leaning" }>
	| Readonly<{ kind: "uniform" }>
	| Readonly<{ kind: "recalled" }>
	| Weights

const LEANING: Spread = { kind: "leaning" }
const UNIFORM: Spread = { kind: "uniform" }
const RECALLED: Spread = { kind: "recalled" }

/**
 * Where a recording's values come from: `draw` answers the decision at position `at`, spread as `spread` says, and
 * `exhausted` says a replay has no value for it, so the recording finishes on simplest values.
 */
export type Chooser = Readonly<{
	exhausted: (at: number) => boolean
	draw: (lo: number, hi: number, at: number, spread: Spread) => number
}>

/** Fresh decisions from a seeded word source: a magnitude leaning toward the ends of a wide range, an option uniform. */
export const randomChooser = (words: Words): Chooser => ({
	exhausted: () => false,
	draw: (lo, hi, _at, spread) => {
		switch (spread.kind) {
			case "leaning":
				return biased(words, lo, hi)
			case "uniform":
				return between(words, lo, hi)
			case "weighted":
				return lo + optionAt(spread, between(words, 0, spread.total - 1))
			case "recalled":
				return lo
		}
	}
})

/** The simplest value of every decision: what an enumeration takes past its prefix. */
export const simplestChooser: Chooser = {
	exhausted: () => false,
	draw: (lo) => lo
}

/** Exactly the first `length` of these values, and nothing after them: a replay, or a shrink candidate. */
export const forcedChooser = (values: Float64Array, length: number): Chooser => ({
	exhausted: (at) => at >= length,
	draw: (_lo, _hi, at) => values[at] ?? 0
})

/** The first `length` of these values, then whatever `then` chooses: a mutation's prefix, or an enumeration's branch. */
export const prefixChooser = (values: Float64Array, length: number, then: Chooser): Chooser => ({
	exhausted: (at) => at >= length && then.exhausted(at),
	draw: (lo, hi, at, spread) => (at < length ? (values[at] ?? 0) : then.draw(lo, hi, at, spread))
})

/** A generated value and the tape that determines it. */
export type Generated<A> = Readonly<{ value: A; tape: Tape }>

/**
 * A live recording: the source a case draws from, how many decisions it has made, and a snapshot of its tape so far. A property keeps drawing from the
 * same source after its value is generated, so those draws replay and shrink with the case.
 */
export type Recording = Readonly<{
	source: Source
	status: () => Status
	decided: () => number
	tape: () => Tape
}>

/**
 * A recording that can start over: `reset` begins a new case against a new chooser on the same buffers, so a search
 * that runs case after case allocates its buffers once.
 */
export type Recorder = Recording & Readonly<{ reset: (chooser: Chooser) => void }>

/** A buffer `factor` times the size, holding the old one's contents. */
const grownFloat = (buffer: Float64Array, factor: number) => {
	const grown = new Float64Array(buffer.length * factor)
	grown.set(buffer)
	return grown
}

const grownInt = (buffer: Int32Array, factor: number) => {
	const grown = new Int32Array(buffer.length * factor)
	grown.set(buffer)
	return grown
}

/**
 * Records every decision and span made against its chooser. Decisions are packed three numbers apiece (value, lowest,
 * highest) into one buffer, and spans three apiece (start, end, depth) into another, each starting at one and doubling
 * when full, so the buffers grow to the longest case the search draws, and a decision costs a few stores and a
 * recording two allocations. A tape is copied out only when someone asks for it,
 * which a passing case never does. A span still open when its tape is copied out, its case stopped inside a draw, ends
 * where the tape ends, so every span of every tape lies within its decisions. A value the chooser cannot give, because
 * a replay ran out or its value no longer fits the decision, becomes the decision's simplest value and marks the
 * recording `overrun`: it still completes, deterministically, and shrinking may still accept it. A decision with one
 * possible value is no decision: it gives that value and records nothing, so a choice among one option never lengthens
 * a tape, and a kept case whose property passes through one still draws nothing. A recalled decision is recorded between
 * 0 and the value it took, the only values a search may move it to: an enumeration never moves it off 0, a mutation
 * and a shrink move it toward 0 alone, and only a replay's value takes it past.
 */
export const recorder = (): Recorder => {
	let chooser: Chooser = simplestChooser
	let decisions = new Float64Array(3)
	let length = 0
	let spans = new Int32Array(3)
	const spanLabel: Array<string> = []
	let open = new Int32Array(1)
	let depth = 0
	let status: Status = "complete"
	const append = (value: number, lo: number, hi: number) => {
		const at = length * 3
		if (at === decisions.length) {
			decisions = grownFloat(decisions, 2)
		}
		decisions[at] = value
		decisions[at + 1] = lo
		decisions[at + 2] = hi
		length += 1
		return value
	}
	const decide = (lo: number, hi: number, spread: Spread) => {
		if (lo === hi) {
			return lo
		}
		const offered = chooser.exhausted(length) ? lo - 1 : chooser.draw(lo, hi, length, spread)
		const fits = offered >= lo && offered <= hi
		if (!fits && status === "complete") {
			status = "overrun"
		}
		const value = fits ? offered : lo
		return append(value, lo, spread.kind === "recalled" ? value : hi)
	}
	const source: Source = {
		draw: (inner) => inner(source),
		choose: (lo, hi) => decide(lo, hi, LEANING),
		pick: (lo, hi) => decide(lo, hi, UNIFORM),
		weigh: (weights) => decide(0, weights.weights.length - 1, weights),
		recall: (count) => decide(0, count, RECALLED),
		open: (label) => {
			const index = spanLabel.length
			spanLabel.push(label)
			if (index * 3 === spans.length) {
				spans = grownInt(spans, 2)
			}
			spans[index * 3] = length
			spans[index * 3 + 2] = depth
			if (depth === open.length) {
				open = grownInt(open, 2)
			}
			open[depth] = index
			depth += 1
		},
		close: () => {
			depth -= 1
			spans[(open[depth] ?? 0) * 3 + 1] = length
		},
		span: (label, run) => {
			source.open(label)
			const value = run()
			source.close()
			return value
		},
		observe: (value) => {
			const offered = chooser.exhausted(length)
				? value
				: chooser.draw(value, value, length, UNIFORM)
			append(value, value, value)
			return offered === value ? "as-recorded" : "diverged"
		}
	}
	return {
		source,
		reset: (next) => {
			chooser = next
			length = 0
			spanLabel.length = 0
			depth = 0
			status = "complete"
		},
		status: () => status,
		decided: () => length,
		tape: () => {
			const values = new Float64Array(length)
			const lo = new Float64Array(length)
			const hi = new Float64Array(length)
			for (let at = 0; at < length; at += 1) {
				values[at] = decisions[at * 3] ?? 0
				lo[at] = decisions[at * 3 + 1] ?? 0
				hi[at] = decisions[at * 3 + 2] ?? 0
			}
			const count = spanLabel.length
			const spanStart = new Int32Array(count)
			const spanEnd = new Int32Array(count)
			const spanDepth = new Int32Array(count)
			for (let at = 0; at < count; at += 1) {
				spanStart[at] = spans[at * 3] ?? 0
				spanEnd[at] = spans[at * 3 + 1] ?? 0
				spanDepth[at] = spans[at * 3 + 2] ?? 0
			}
			for (let level = 0; level < depth; level += 1) {
				spanEnd[open[level] ?? 0] = length
			}
			return {
				length,
				values,
				lo,
				hi,
				spanStart,
				spanEnd,
				spanDepth,
				spanLabel: Arr.copy(spanLabel),
				status
			}
		}
	}
}

/** A fresh recording against one chooser. */
export const recording = (chooser: Chooser): Recording => {
	const started = recorder()
	started.reset(chooser)
	return started
}

/**
 * Runs a generator against a chooser on a recorder's buffers, which it starts over first: the value, and the tape that
 * determines it, copied out of the buffers. A loop that generates case after case (an enumeration, a shrink, a sample)
 * holds one recorder for all of them, so it allocates its buffers once, as an exploration's pool does.
 */
export const generate = <A>(
	recorded: Recorder,
	generator: (source: Source) => A,
	chooser: Chooser
): Generated<A> => {
	recorded.reset(chooser)
	const value = generator(recorded.source)
	return { value, tape: recorded.tape() }
}

/**
 * The first `count` cases of a stream, by value. A pure function of the generator and the stream, so another process
 * given the same stream draws the same cases: a type batch or an agreement suite can generate its inputs ahead of
 * time. A stream is minted only by random.ts, from a suite's label or from the run's seed, never written as a literal.
 */
export const sample = <A>(
	generator: (source: Source) => A,
	stream: Stream,
	count: number
): ReadonlyArray<A> => {
	const recorded = recorder()
	const cases: Array<A> = []
	for (let index = 0; index < count; index += 1) {
		cases.push(generate(recorded, generator, randomChooser(wordsOf(caseSeed(stream, index)))).value)
	}
	return cases
}
