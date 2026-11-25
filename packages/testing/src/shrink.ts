import { Array as Arr, Effect, Option } from "effect"
import type { Gen } from "#gen.ts"
import { type Generated, forcedChooser, generate, recorder } from "#source.ts"
import { digestOf, shortlex, type Tape } from "#tape.ts"

/**
 * How much shrinking may cost, counted in candidates run, never in wall time, so the same failure shrinks to the
 * same case on every machine.
 */
export type ShrinkBudget =
	| Readonly<{ kind: "complete" }>
	| Readonly<{ kind: "bounded"; candidates: number }>

/** Shrink until no pass makes progress. */
export const completeShrink: ShrinkBudget = { kind: "complete" }

/** Shrink at most `candidates` candidates. */
export const boundedShrink = (candidates: number): ShrinkBudget => ({ kind: "bounded", candidates })

/** A failing case: the tape it drew, and what the caller reports of its failure. */
export type Failing<X> = Readonly<{ tape: Tape; failure: X }>

/**
 * One run of a candidate, with the tape it really drew: it still fails, with what the caller reports of the failure,
 * or it holds.
 */
export type Attempt<X> =
	| Readonly<{ kind: "fails"; tape: Tape; failure: X }>
	| Readonly<{ kind: "holds"; tape: Tape }>

/** Why shrinking ended: no pass made progress, or its budget of candidates ran out. */
export type ShrinkEnd = "minimal" | "budget"

/** The smallest failing case shrinking reached, how many candidates it ran to their end, and why it ended. */
export type Shrunk<X> = Readonly<{ best: Failing<X>; candidates: number; ended: ShrinkEnd }>

/** Values with the decisions `[start, end)` removed. */
const without = (values: Float64Array, start: number, end: number) => {
	const kept = new Float64Array(values.length - (end - start))
	kept.set(values.subarray(0, start))
	kept.set(values.subarray(end), start)
	return kept
}

/** Values with the value at `at` replaced. */
const replaced = (values: Float64Array, at: number, value: number) => {
	const copy = values.slice()
	copy[at] = value
	return copy
}

/** Values with the decisions `[start, end)` at their simplest. */
const simplified = (tape: Tape, start: number, end: number) => {
	const copy = tape.values.slice()
	copy.set(tape.lo.subarray(start, end), start)
	return copy
}

/** The `element` span that follows an `element` span in the same collection: the next one at its depth that starts
 * where it ends. */
const nextItemOf = (tape: Tape, element: number): Option.Option<number> => {
	const depth = tape.spanDepth[element] ?? 0
	const end = tape.spanEnd[element] ?? 0
	for (let span = element + 1; span < tape.spanLabel.length; span += 1) {
		const spanDepth = tape.spanDepth[span] ?? 0
		if (spanDepth < depth) {
			return Option.none()
		}
		if (spanDepth === depth && tape.spanLabel[span] === "element") {
			return (tape.spanStart[span] ?? 0) === end ? Option.some(span) : Option.none()
		}
	}
	return Option.none()
}

/**
 * One collection of a tape: the tape's decisions, the decisions `[start, bounds[0])` that count its items, and its
 * items, item `i` the decisions `[bounds[i], bounds[i + 1])`. Its items are `element` spans at one depth, each starting
 * where the one before it ends with no shallower span between them. The `array` span that holds them counts them by its
 * decisions before its first item: its length, or none when its size admits one length; a run of items no `array` span
 * holds has no count. Its bounds never decrease and end within the decisions it carries, so deleting or exchanging its
 * items is an edit of those decisions alone.
 */
type Collection = Readonly<{ values: Float64Array; start: number; bounds: ReadonlyArray<number> }>

/** One item of a tape: the collection it is an item of, and which of its items it is. */
type Item = Readonly<{ collection: Collection; at: number }>

/**
 * Where the decisions that count a collection begin: at the start of the span its first item is directly inside, the
 * nearest one before it a level out, when that span is an `array`, and otherwise at its first item, counting nothing.
 */
const countStartOf = (tape: Tape, first: number): number => {
	const depth = (tape.spanDepth[first] ?? 0) - 1
	for (let span = first - 1; span >= 0; span -= 1) {
		if ((tape.spanDepth[span] ?? 0) === depth) {
			return tape.spanLabel[span] === "array"
				? (tape.spanStart[span] ?? 0)
				: (tape.spanStart[first] ?? 0)
		}
	}
	return tape.spanStart[first] ?? 0
}

/**
 * Every `element` span of a tape as an item of its collection, in the order the spans opened. A collection begins at an
 * `element` span no earlier one is followed by, and holds every item that follows it.
 */
const itemsOf = (tape: Tape): ReadonlyArray<Item> => {
	const found = new Map<number, Item>()
	for (let span = 0; span < tape.spanLabel.length; span += 1) {
		if (tape.spanLabel[span] !== "element" || found.has(span)) {
			continue
		}
		const members = [span]
		for (
			let next = nextItemOf(tape, span);
			Option.isSome(next);
			next = nextItemOf(tape, next.value)
		) {
			members.push(next.value)
		}
		const collection: Collection = {
			values: tape.values,
			start: countStartOf(tape, span),
			bounds: [
				tape.spanStart[span] ?? 0,
				...Arr.map(members, (member) => tape.spanEnd[member] ?? 0)
			]
		}
		for (const [at, member] of members.entries()) {
			found.set(member, { collection, at })
		}
	}
	return Arr.getSomes(
		Arr.map(Arr.fromIterable(tape.spanLabel.keys()), (span) =>
			Option.fromUndefinedOr(found.get(span))
		)
	)
}

/** An item's collection's decisions with the item removed and every decision that counts its items one lower. */
const withoutItem = ({ collection, at }: Item) => {
	const { values, start, bounds } = collection
	const shorter = without(values, bounds[at] ?? 0, bounds[at + 1] ?? 0)
	for (let count = start; count < (bounds[0] ?? 0); count += 1) {
		shorter[count] = (shorter[count] ?? 0) - 1
	}
	return shorter
}

/**
 * An item's collection's decisions with the item and the one `later` items after it exchanged, the items between them
 * kept, while that later item is one of its collection's.
 */
const exchanged = ({ collection, at }: Item, later: number): Option.Option<Float64Array> =>
	Option.map(Arr.get(collection.bounds, at + later + 1), (end) => {
		const { values, bounds } = collection
		const start = bounds[at] ?? 0
		const firstEnd = bounds[at + 1] ?? 0
		const second = bounds[at + later] ?? 0
		const copy = values.slice()
		copy.set(values.subarray(second, end), start)
		copy.set(values.subarray(firstEnd, second), start + end - second)
		copy.set(values.subarray(start, firstEnd), end - (firstEnd - start))
		return copy
	})

/**
 * A failing case with its tape's items, parsed when it becomes the best, so a pass reads the items of the tape it
 * edits.
 */
type Parsed<X> = Failing<X> & Readonly<{ items: ReadonlyArray<Item> }>

const parsedOf = <X>(failing: Failing<X>): Parsed<X> => ({
	...failing,
	items: itemsOf(failing.tape)
})

/**
 * Shrinks a failing attempt by editing its tape. Every pass proposes smaller values; `attempt` runs them and reports
 * the tape it really drew, which counts only when it is strictly smaller in shortlex order and still fails, so
 * shrinking always ends and only ever moves toward simpler cases. The best case carries its tape's items, parsed when it becomes the best, and every
 * candidate of an item is built from its own collection's decisions. The passes, in order of how much each removes:
 * - delete one item of a collection (its decisions, and one off each decision that counts the collection);
 * - delete any span outright;
 * - set every decision of a span to its simplest;
 * - swap two items of a collection, so a sequence whose failure needs its items in some order reaches the simplest
 *   order, which deleting and lowering alone cannot reorder into;
 * - lower each decision by binary search toward its simplest.
 * Once its budget is spent, no pass builds another candidate. The candidates already tried
 * are remembered for this shrink alone, and forgotten when it ends: a digest finds them, and their values are compared
 * before one is skipped, so a collision never passes over a distinct candidate. Every candidate is smaller than the
 * best, so each accepted shrink forgets those it is not smaller than: none of them could be proposed again.
 */
export const shrinkAttempt = <X, R>(
	failing: Failing<X>,
	attempt: (values: Float64Array) => Effect.Effect<Attempt<X>, never, R>,
	budget: ShrinkBudget
): Effect.Effect<Shrunk<X>, never, R> =>
	Effect.gen(function* () {
		let best = parsedOf(failing)
		let candidates = 0
		const tried = new Map<number, Array<Float64Array>>()
		const triedBefore = (digest: number, values: Float64Array) =>
			Arr.some(
				tried.get(digest) ?? [],
				(seen) => shortlex(seen, seen.length, values, values.length) === 0
			)
		const budgetSpent = () => budget.kind === "bounded" && candidates >= budget.candidates
		const endOf = (): ShrinkEnd => (budgetSpent() ? "budget" : "minimal")
		const belowBest = (values: Float64Array) =>
			shortlex(values, values.length, best.tape.values, best.tape.length) === -1
		const forgetAboveBest = () => {
			for (const [digest, seen] of tried) {
				const below = Arr.filter(seen, belowBest)
				if (Arr.isReadonlyArrayNonEmpty(below)) {
					tried.set(digest, below)
				} else {
					tried.delete(digest)
				}
			}
		}

		const propose = Effect.fnUntraced(function* (values: Float64Array) {
			if (budgetSpent()) {
				return false
			}
			const digest = digestOf(values, values.length)
			if (triedBefore(digest, values) || !belowBest(values)) {
				return false
			}
			tried.set(digest, [...(tried.get(digest) ?? []), values])
			const result = yield* attempt(values)
			candidates += 1
			switch (result.kind) {
				case "holds":
					return false
				case "fails":
					if (
						shortlex(result.tape.values, result.tape.length, best.tape.values, best.tape.length) !==
						-1
					) {
						return false
					}
					best = parsedOf({ tape: result.tape, failure: result.failure })
					forgetAboveBest()
					return true
			}
		})

		const deleteItems = Effect.fnUntraced(function* () {
			let progressed = false
			for (
				let cursor = best.items.length - 1;
				cursor >= 0 && !budgetSpent();
				cursor = Math.min(cursor, best.items.length) - 1
			) {
				progressed = (yield* propose(withoutItem(Arr.getUnsafe(best.items, cursor)))) || progressed
			}
			return progressed
		})

		const deleteSpans = Effect.fnUntraced(function* () {
			let progressed = false
			for (let span = best.tape.spanLabel.length - 1; span >= 0 && !budgetSpent(); span -= 1) {
				const start = best.tape.spanStart[span] ?? 0
				const end = best.tape.spanEnd[span] ?? 0
				if (end > start) {
					progressed = (yield* propose(without(best.tape.values, start, end))) || progressed
				}
			}
			return progressed
		})

		const simplifySpans = Effect.fnUntraced(function* () {
			let progressed = false
			for (let span = best.tape.spanLabel.length - 1; span >= 0 && !budgetSpent(); span -= 1) {
				const start = best.tape.spanStart[span] ?? 0
				const end = best.tape.spanEnd[span] ?? 0
				if (end > start) {
					progressed = (yield* propose(simplified(best.tape, start, end))) || progressed
				}
			}
			return progressed
		})

		const exchangeAt = (cursor: number, later: number) =>
			Option.flatMap(Arr.get(best.items, cursor), (item) => exchanged(item, later))

		const reorderItems = Effect.fnUntraced(function* () {
			let progressed = false
			for (let cursor = 0; cursor < best.items.length && !budgetSpent(); cursor += 1) {
				let later = 1
				let exchange = exchangeAt(cursor, later)
				while (Option.isSome(exchange) && !budgetSpent()) {
					progressed = (yield* propose(exchange.value)) || progressed
					later += 1
					exchange = exchangeAt(cursor, later)
				}
			}
			return progressed
		})

		const lowerChoices = Effect.fnUntraced(function* () {
			let progressed = false
			for (let at = 0; at < best.tape.length && !budgetSpent(); at += 1) {
				const lo = best.tape.lo[at] ?? 0
				const value = best.tape.values[at] ?? 0
				if (value === lo) {
					continue
				}
				if (yield* propose(replaced(best.tape.values, at, lo))) {
					progressed = true
					continue
				}
				let low = lo
				let high = value
				while (low + 1 < high && !budgetSpent()) {
					const middle = low + Math.floor((high - low) / 2)
					if (yield* propose(replaced(best.tape.values, at, middle))) {
						high = middle
						progressed = true
					} else {
						low = middle
					}
				}
			}
			return progressed
		})

		let progressed = true
		while (progressed && !budgetSpent()) {
			const deleted = yield* deleteItems()
			const dropped = yield* deleteSpans()
			const simplifiedAny = yield* simplifySpans()
			const reordered = yield* reorderItems()
			const lowered = yield* lowerChoices()
			progressed = deleted || dropped || simplifiedAny || reordered || lowered
		}
		return { best: { tape: best.tape, failure: best.failure }, candidates, ended: endOf() }
	})

/**
 * Shrinks a failing case of a plain generator against a predicate that says whether a value still fails, every
 * candidate generated on one recorder's buffers.
 */
export const shrink = <A, R>(
	generator: Gen<A>,
	failing: Generated<A>,
	stillFails: (value: A) => Effect.Effect<boolean, never, R>,
	budget: ShrinkBudget
): Effect.Effect<Shrunk<A>, never, R> =>
	Effect.suspend(() => {
		const recorded = recorder()
		return shrinkAttempt(
			{ tape: failing.tape, failure: failing.value },
			(values): Effect.Effect<Attempt<A>, never, R> => {
				const candidate = generate(recorded, generator, forcedChooser(values, values.length))
				return Effect.map(stillFails(candidate.value), (fails): Attempt<A> =>
					fails
						? { kind: "fails", tape: candidate.tape, failure: candidate.value }
						: { kind: "holds", tape: candidate.tape }
				)
			},
			budget
		)
	})

/**
 * A candidate's verdict as a shrink in candidate order reads it: it still fails, with the tape it drew; it holds; or it
 * was never judged (`unjudged`, with why: what judging it needed could not be had), which says nothing of the failure,
 * and no later candidate, judged by the same means, would say more.
 */
export type Judged<X, U> =
	| Readonly<{ kind: "fails"; tape: Tape; failure: X }>
	| Readonly<{ kind: "holds" }>
	| Readonly<{ kind: "unjudged"; why: U }>

/** Why a shrink in candidate order ended with every candidate it ran judged: no pass made progress, or its budget of
 * candidates ran out. */
export type OrderedEnd = "minimal" | "budget"

/**
 * The smallest failing case a shrink in candidate order reached and the candidates it judged: it ended as OrderedEnd
 * says, or at the first candidate in candidate order it could not judge (`unjudged`, with why), every candidate before
 * it judged and none after it run.
 */
export type Ordered<X, U> =
	| Readonly<{ best: Failing<X>; candidates: number; ended: OrderedEnd }>
	| Readonly<{ best: Failing<X>; candidates: number; ended: "unjudged"; why: U }>

/**
 * Where a shrink is among its passes (shrinkAttempt's, in its order): deleting the item at `cursor`, deleting or
 * simplifying the span at `span`, exchanging the item at `cursor` with the one `later` after it, or lowering the
 * decision at `at` to its simplest (`lowest`) or by bisection between `low` and `high`.
 */
type Cursor =
	| Readonly<{ pass: "delete-items"; cursor: number }>
	| Readonly<{ pass: "delete-spans"; span: number }>
	| Readonly<{ pass: "simplify-spans"; span: number }>
	| Readonly<{ pass: "reorder-items"; cursor: number; later: number }>
	| Readonly<{ pass: "lower-choices"; at: number; search: Lowering }>

/** How a decision is being lowered: straight to its simplest, then by bisection. */
type Lowering =
	| Readonly<{ kind: "lowest" }>
	| Readonly<{ kind: "bisect"; low: number; high: number }>

/** Where a shrink is, and whether its round has accepted a candidate yet. */
type Walk = Readonly<{ cursor: Cursor; progressed: boolean }>

/**
 * The next thing a walk does from where it is, against the best case so far: propose a candidate, whose verdict
 * (`after`, given whether it was accepted and the best case then) says where the walk goes next; move on without one
 * (a span with no decisions, a decision already at its simplest); or end its round.
 */
type Step =
	| Readonly<{
			kind: "propose"
			values: Float64Array
			after: (accepted: boolean, best: Parsed<unknown>) => Walk
	  }>
	| Readonly<{ kind: "move"; walk: Walk }>
	| Readonly<{ kind: "round-end"; progressed: boolean }>

/** A round's first walk: deleting the best case's last item. */
const roundOf = (best: Parsed<unknown>): Walk => ({
	cursor: { pass: "delete-items", cursor: best.items.length - 1 },
	progressed: false
})

/** A walk at `cursor` that keeps its round's progress, and adds an accepted candidate's. */
const walkTo = (walk: Walk, cursor: Cursor, accepted: boolean): Walk => ({
	cursor,
	progressed: walk.progressed || accepted
})

/** What a walk does next from where it is (Step), exactly as shrinkAttempt's passes would. */
const stepOf = (walk: Walk, best: Parsed<unknown>): Step => {
	const cursor = walk.cursor
	const move = (next: Cursor): Step => ({ kind: "move", walk: walkTo(walk, next, false) })
	const spanBounds = (span: number) =>
		[best.tape.spanStart[span] ?? 0, best.tape.spanEnd[span] ?? 0] as const
	switch (cursor.pass) {
		case "delete-items": {
			if (cursor.cursor < 0) {
				return move({ pass: "delete-spans", span: best.tape.spanLabel.length - 1 })
			}
			return {
				kind: "propose",
				values: withoutItem(Arr.getUnsafe(best.items, cursor.cursor)),
				after: (accepted, now) =>
					walkTo(
						walk,
						{ pass: "delete-items", cursor: Math.min(cursor.cursor, now.items.length) - 1 },
						accepted
					)
			}
		}
		case "delete-spans":
		case "simplify-spans": {
			if (cursor.span < 0) {
				return move(
					cursor.pass === "delete-spans"
						? { pass: "simplify-spans", span: best.tape.spanLabel.length - 1 }
						: { pass: "reorder-items", cursor: 0, later: 1 }
				)
			}
			const [start, end] = spanBounds(cursor.span)
			const next: Cursor = { pass: cursor.pass, span: cursor.span - 1 }
			if (end <= start) {
				return move(next)
			}
			return {
				kind: "propose",
				values:
					cursor.pass === "delete-spans"
						? without(best.tape.values, start, end)
						: simplified(best.tape, start, end),
				after: (accepted) => walkTo(walk, next, accepted)
			}
		}
		case "reorder-items": {
			if (cursor.cursor >= best.items.length) {
				return move({ pass: "lower-choices", at: 0, search: { kind: "lowest" } })
			}
			return Option.match(
				Option.flatMap(Arr.get(best.items, cursor.cursor), (item) => exchanged(item, cursor.later)),
				{
					onNone: () => move({ pass: "reorder-items", cursor: cursor.cursor + 1, later: 1 }),
					onSome: (values): Step => ({
						kind: "propose",
						values,
						after: (accepted) =>
							walkTo(
								walk,
								{ pass: "reorder-items", cursor: cursor.cursor, later: cursor.later + 1 },
								accepted
							)
					})
				}
			)
		}
		case "lower-choices": {
			const at = cursor.at
			const nextDecision: Cursor = { pass: "lower-choices", at: at + 1, search: { kind: "lowest" } }
			if (at >= best.tape.length) {
				return { kind: "round-end", progressed: walk.progressed }
			}
			const search = cursor.search
			switch (search.kind) {
				case "lowest": {
					const lo = best.tape.lo[at] ?? 0
					const value = best.tape.values[at] ?? 0
					if (value === lo) {
						return move(nextDecision)
					}
					return {
						kind: "propose",
						values: replaced(best.tape.values, at, lo),
						after: (accepted) =>
							walkTo(
								walk,
								accepted
									? nextDecision
									: { pass: "lower-choices", at, search: { kind: "bisect", low: lo, high: value } },
								accepted
							)
					}
				}
				case "bisect": {
					if (search.low + 1 >= search.high) {
						return move(nextDecision)
					}
					const middle = search.low + Math.floor((search.high - search.low) / 2)
					return {
						kind: "propose",
						values: replaced(best.tape.values, at, middle),
						after: (accepted) =>
							walkTo(
								walk,
								{
									pass: "lower-choices",
									at,
									search: accepted
										? { kind: "bisect", low: search.low, high: middle }
										: { kind: "bisect", low: middle, high: search.high }
								},
								accepted
							)
					}
				}
			}
		}
	}
}

/** A candidate a walk proposed, and where the walk goes once it is judged. */
type Proposed = Readonly<{
	values: Float64Array
	after: (accepted: boolean, best: Parsed<unknown>) => Walk
}>

/** What a walk proposes ahead of its verdicts: the candidates it would propose were none accepted, or its round's end. */
type Ahead =
	| Readonly<{ kind: "proposed"; proposed: Arr.NonEmptyReadonlyArray<Proposed> }>
	| Readonly<{ kind: "round-end"; progressed: boolean }>

/**
 * The next `wide` candidates a walk proposes from where it is, were none of them accepted, passing over what `skipped`
 * holds of (a candidate already judged, or not smaller than the best) and over a repeat among them; or its round's end,
 * when it reaches it before proposing any.
 */
const speculated = (
	walk: Walk,
	best: Parsed<unknown>,
	wide: number,
	skipped: (values: Float64Array) => boolean
): Ahead => {
	const proposed: Array<Proposed> = []
	const seen = new Map<number, Array<Float64Array>>()
	let ahead = walk
	for (;;) {
		const step = stepOf(ahead, best)
		switch (step.kind) {
			case "round-end":
				return Arr.isReadonlyArrayNonEmpty(proposed)
					? { kind: "proposed", proposed }
					: { kind: "round-end", progressed: step.progressed }
			case "move":
				ahead = step.walk
				break
			case "propose": {
				const digest = digestOf(step.values, step.values.length)
				const repeated = Arr.some(
					seen.get(digest) ?? [],
					(known) => shortlex(known, known.length, step.values, step.values.length) === 0
				)
				if (!repeated && !skipped(step.values)) {
					seen.set(digest, [...(seen.get(digest) ?? []), step.values])
					proposed.push({ values: step.values, after: step.after })
				}
				if (Arr.isReadonlyArrayNonEmpty(proposed) && proposed.length >= wide) {
					return { kind: "proposed", proposed }
				}
				ahead = step.after(false, best)
				break
			}
		}
	}
}

/**
 * Shrinks a failing case by editing its tape, proposing exactly the candidates shrinkAttempt's passes propose, in their
 * order, and accepting exactly the ones it accepts, while judging many at once: from where it is, it proposes the
 * candidates its walk would propose were none of them accepted, up to `width` of them (read before each round of
 * judging), and `judge` judges them together, in parallel, giving back their verdicts in candidate order up to one
 * that fails (it may stop there). The first candidate in candidate order that fails with a tape smaller than the best
 * is accepted once every candidate before it has been judged, and the walk goes on from it; the candidates judged after
 * it are let go. So the case it reaches, and how many candidates it counts, depend on the failing case alone, never on
 * the width. A candidate already judged in this shrink, or not smaller than the best, is passed over unjudged and
 * uncounted. It ends when a round of every pass accepts nothing (`minimal`) or `budget` candidates have been judged, or
 * at the first candidate in candidate order that `judge` could not judge (`unjudged`), uncounted, with the best so far.
 */
export const shrinkInOrder = <X, U, R>(
	failing: Failing<X>,
	judge: (
		candidates: Arr.NonEmptyReadonlyArray<Float64Array>
	) => Effect.Effect<ReadonlyArray<Judged<X, U>>, never, R>,
	width: Effect.Effect<number, never, R>,
	budget: ShrinkBudget
): Effect.Effect<Ordered<X, U>, never, R> =>
	Effect.gen(function* () {
		let best: Parsed<X> = parsedOf(failing)
		let walk = roundOf(best)
		let candidates = 0
		const tried = new Map<number, Array<Float64Array>>()
		const seenIn = (seen: ReadonlyMap<number, ReadonlyArray<Float64Array>>, values: Float64Array) =>
			Arr.some(
				seen.get(digestOf(values, values.length)) ?? [],
				(known) => shortlex(known, known.length, values, values.length) === 0
			)
		const remember = (seen: Map<number, Array<Float64Array>>, values: Float64Array) => {
			const digest = digestOf(values, values.length)
			seen.set(digest, [...(seen.get(digest) ?? []), values])
		}
		const belowBest = (values: Float64Array) =>
			shortlex(values, values.length, best.tape.values, best.tape.length) === -1
		const room = () =>
			budget.kind === "bounded" ? budget.candidates - candidates : Number.POSITIVE_INFINITY
		for (;;) {
			if (room() <= 0) {
				return { best: { tape: best.tape, failure: best.failure }, candidates, ended: "budget" }
			}
			const free = yield* width
			const ahead = speculated(
				walk,
				best,
				Math.max(1, Math.min(free, room())),
				(values) => seenIn(tried, values) || !belowBest(values)
			)
			if (ahead.kind === "round-end") {
				if (ahead.progressed) {
					walk = roundOf(best)
					continue
				}
				return { best: { tape: best.tape, failure: best.failure }, candidates, ended: "minimal" }
			}
			const proposed = ahead.proposed
			const verdicts = yield* judge(Arr.map(proposed, (candidate) => candidate.values))
			for (const [at, candidate] of proposed.entries()) {
				const verdict = Arr.get(verdicts, at)
				if (Option.isNone(verdict)) {
					break
				}
				const judged = verdict.value
				if (judged.kind === "unjudged") {
					return {
						best: { tape: best.tape, failure: best.failure },
						candidates,
						ended: "unjudged",
						why: judged.why
					}
				}
				candidates += 1
				remember(tried, candidate.values)
				const accepted =
					judged.kind === "fails" &&
					shortlex(judged.tape.values, judged.tape.length, best.tape.values, best.tape.length) ===
						-1
				if (accepted) {
					best = parsedOf({ tape: judged.tape, failure: judged.failure })
					for (const [digest, seen] of tried) {
						const below = Arr.filter(seen, belowBest)
						if (Arr.isReadonlyArrayNonEmpty(below)) {
							tried.set(digest, below)
						} else {
							tried.delete(digest)
						}
					}
					walk = candidate.after(true, best)
					break
				}
				walk = candidate.after(false, best)
			}
		}
	})
