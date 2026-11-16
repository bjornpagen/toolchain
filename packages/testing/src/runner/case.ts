import type { NodeServices } from "@effect/platform-node/NodeServices"
import {
	Array as Arr,
	Cause,
	Context,
	Deferred,
	Duration,
	Effect,
	Exit,
	Fiber,
	Formatter,
	Option,
	Result,
	type Scope,
	Struct
} from "effect"
import { failureText } from "#failure.ts"
import { keyOf, type Pending, pendingAt, type Reached } from "#features.ts"
import type { Gen } from "#gen.ts"
import { abandon, awaitWithinGrace, liveNanos, liveSleep, watchedCase } from "#live.ts"
import type { Need, NeedContext, Needs, NeedValue, Resources } from "#property.ts"
import { fnv1a32 } from "#random.ts"
import { type Drawn, replayTokenOf } from "#replay.ts"
import type { RunnerServicesFailed } from "#runner/config.ts"
import { Perception } from "#runner/perceive.ts"
import {
	type CaseOrder,
	type CaseOutcome,
	type CaseResult,
	chooserOf,
	type Printed,
	type Trace
} from "#runner/protocol.ts"
import { NeedFailed } from "#runner/services.ts"
import { type Observed, type Recording, recording, simplestChooser } from "#source.ts"

/**
 * What a property sees of the case it runs: it notes the situations it reached; draws more from the case's own tape;
 * and records on the tape what the system under test decided (and learns whether a replay decided the same). A case
 * never gives itself up: a precondition is a property of the space, which constructs only cases that meet it. A note,
 * a draw, an observation or a measure made after the case ended is a misuse, reported as one. `measure` adds an amount
 * to a named count of its property (schedules explored), summed over every case its search ran and printed on its
 * report line.
 */
export type Case<F extends string> = Readonly<{
	note: (feature: F) => void
	noteAll: (features: Iterable<F>) => void
	pair: (first: F, second: F) => void
	draw: <A>(generator: Gen<A>) => A
	observe: (decided: string) => Observed
	measure: (name: string, amount: number) => void
}>

/** A need's resource as one case takes it, in the case's scope. */
type Taker<A> = Effect.Effect<A, NeedFailed, Scope.Scope>

/** The cache a process keeps its opened needs in: what a need's `open` gave, by the need's key. */
type NeedSlot<A> = Deferred.Deferred<Taker<A>, NeedFailed>

/** The slot a need's opening is kept under in a process's cache: one per key, so needs of one key share it. */
const needSlotOf = <A>(need: Need<A>) =>
	Context.Service<NeedSlot<A>>(`@bjornpagen/testing/runner/case/need/${need.key}`)

/**
 * The needs an evaluating process has opened: `take` gives a case a need's resource in the case's scope, opening the
 * need the first time any case of the process takes it (needs of one key share it), in the process's own scope and
 * services, so what a need keeps warm stays warm across cases and properties.
 */
export class NeedCache extends Context.Service<
	NeedCache,
	Readonly<{ take: <A>(need: Need<A>) => Taker<A> }>
>()("@bjornpagen/testing/runner/case/NeedCache") {}

/**
 * The need cache of a process whose needs open in the context `services` gives: its scope, the platform, its worker
 * index and the repository's services, which the process builds the first time a need opens, so a process whose cases
 * take no need never builds them. Services that fail to build fail every need that opens with their failure.
 */
export const needCacheOf = (
	services: Effect.Effect<Context.Context<NeedContext>, RunnerServicesFailed>
): Context.Service.Shape<typeof NeedCache> => {
	let opened: Context.Context<never> = Context.empty()
	return {
		take: <A>(need: Need<A>) =>
			Effect.suspend(() =>
				Option.match(Context.getOption(opened, needSlotOf(need)), {
					onSome: (taker) => Effect.flatten(Deferred.await(taker)),
					onNone: () => {
						const taker = Deferred.makeUnsafe<Taker<A>, NeedFailed>()
						opened = Context.add(opened, needSlotOf(need), taker)
						const open = Effect.flatMap(
							Effect.mapError(services, (failed) =>
								NeedFailed.make({ need: need.key, message: failed.message })
							),
							(context) => Effect.provideContext(need.open, context)
						)
						return Effect.andThen(Deferred.into(open, taker), Effect.flatten(Deferred.await(taker)))
					}
				})
			)
	}
}

/** What an evaluating process provides every case: its opened needs, its perception and the platform. */
export type CaseEnv = NeedCache | Perception | LateUses | Stopped | NodeServices

/** One case's taker of a need, as `Struct.map` maps a property's needs. */
interface Taking extends Struct.Lambda {
	<A>(need: Need<A>): Taker<A>
	readonly "~lambda.out": Taker<NeedValue<this["~lambda.in"]>>
}

/**
 * An effect that runs `effect` the first time it is run and gives every later run the same exit: a case takes each
 * resource once, however often its check yields it.
 */
const once = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Effect.Effect<A, E, Scope.Scope> => {
	const settled = Deferred.makeUnsafe<A, E>()
	let started = false
	return Effect.suspend(() => {
		if (started) {
			return Deferred.await(settled)
		}
		started = true
		return Effect.andThen(Deferred.into(effect, settled), Deferred.await(settled))
	})
}

/**
 * A case's resources, by the name its check reads each under: each an effect that takes the need's resource in the
 * case's scope the first time the check yields it, and gives the same resource every later time.
 */
const resourcesOf = <N extends Needs>(
	needs: N,
	cache: Context.Service.Shape<typeof NeedCache>
): Resources<N> =>
	Struct.map(
		needs,
		Struct.lambda<Taking>((need) => once(cache.take(need)))
	)

/**
 * How a property's cases are drawn and printed, its value type erased into closures: the generator a case's steering
 * selects, the situations its steering names by place, and how a value prints (its show, or its structural form).
 */
export type Drawing<S, F extends string> = Readonly<{
	situations: ReadonlyArray<Reached<F>>
	spaceUnder: (steering: Option.Option<Pending<F>>) => Gen<S>
	print: (value: S) => string
}>

/** The steering a case's generator reads, as its order records it. */
const steeringOf = <F extends string>(
	situations: ReadonlyArray<Reached<F>>,
	drawn: Drawn
): Option.Option<Pending<F>> => {
	switch (drawn.kind) {
		case "unsteered":
			return Option.none()
		case "steered":
			return Option.some(pendingAt(situations, drawn.pending))
	}
}

/** What closing a case's handle leaves: its notes, its measures, and what its property drew. */
type Closed = Readonly<{
	notes: ReadonlyArray<string>
	measures: ReadonlyArray<readonly [string, number]>
	drew: ReadonlyArray<unknown>
}>

/** A case's handle, and its closing. */
type Handle<F extends string> = Readonly<{ c: Case<F>; close: () => Closed }>

/**
 * The handle of a case drawing on `recorded`: open until closed. A use after it closed (a note, a draw, an observation
 * or a measure) touches nothing of the case, whose result may have left the process, and is reported as a late use
 * (`lateUse`, with what the property had drawn), which marks the case misused wherever its result is judged.
 */
const handleOf = <F extends string>(
	recorded: Recording,
	lateUse: (drew: ReadonlyArray<unknown>) => void
): Handle<F> => {
	const notes = new Set<string>()
	const measures = new Map<string, number>()
	const drew: Array<unknown> = []
	let open = true
	const whileOpen = (use: () => void) => {
		if (open) {
			use()
			return
		}
		lateUse(drew)
	}
	const record = (key: string) => whileOpen(() => notes.add(key))
	return {
		c: {
			note: record,
			noteAll: (features) => {
				for (const feature of features) {
					record(feature)
				}
			},
			pair: (first, second) => record(keyOf<F>([first, second])),
			draw: (inner) => {
				if (!open) {
					lateUse(drew)
					return inner(recording(simplestChooser).source)
				}
				const value = inner(recorded.source)
				drew.push(value)
				return value
			},
			observe: (decided) => {
				if (!open) {
					lateUse(drew)
					return "as-recorded"
				}
				return recorded.source.observe(fnv1a32(decided))
			},
			measure: (name, amount) =>
				whileOpen(() => {
					measures.set(name, (measures.get(name) ?? 0) + amount)
				})
		},
		close: () => {
			open = false
			return {
				notes: Arr.fromIterable(notes),
				measures: Arr.fromIterable(measures.entries()),
				drew
			}
		}
	}
}

/**
 * Where a process reports a case its property used after the case ended: the case's order and how it prints. The
 * worker sends it to the parent (a `misused` message), the inline evaluator keeps it, and either marks the case's
 * result misused before its window is judged.
 */
export class LateUses extends Context.Service<
	LateUses,
	Readonly<{ report: (order: CaseOrder, printed: Printed) => void }>
>()("@bjornpagen/testing/runner/case/LateUses") {}

/**
 * Results with every late use reported so far marked: a passing case another fiber used after it ended is misused,
 * printed as it ran; then cut after the first batch in order that holds a result `stop` holds of.
 */
export const withLateUses = (
	results: ReadonlyArray<ReadonlyArray<CaseResult>>,
	lateAt: (batch: number, at: number) => Option.Option<Printed>,
	stop: (result: CaseResult) => boolean
): ReadonlyArray<ReadonlyArray<CaseResult>> => {
	const marked = Arr.map(results, (batch, batchAt) =>
		Arr.map(batch, (result, at): CaseResult =>
			Option.match(lateAt(batchAt, at), {
				onNone: () => result,
				onSome: (printed) =>
					result.outcome.kind === "passed"
						? { ...result, outcome: { kind: "misused", printed } }
						: result
			})
		)
	)
	return Option.match(
		Arr.findFirstIndex(marked, (batch) => Arr.some(batch, stop)),
		{ onNone: () => marked, onSome: (first) => Arr.take(marked, first + 1) }
	)
}

/** A value as the report prints it; a show or a value whose printing throws is stated as unprintable. */
const shownOf = <S>(print: (value: S) => string, value: S): string =>
	Result.getOrElse(
		Result.try(() => print(value)),
		() => "unprintable: printing the case throws"
	)

/** A case as the report prints it: its value and what its property drew. */
const printedOf = <S>(
	print: (value: S) => string,
	value: S,
	drew: ReadonlyArray<unknown>
): Printed => ({
	kind: "drawn",
	value: shownOf(print, value),
	draws: Arr.map(drew, (draw) => Formatter.format(draw))
})

/** How a guarded effect ended: it passed, failed with its cause, or ran past its deadline. */
type Settled =
	| Readonly<{ kind: "passed" }>
	| Readonly<{ kind: "failed"; cause: Cause.Cause<unknown> }>
	| Readonly<{ kind: "hung" }>

const settledOf = <E>(exit: Exit.Exit<Exit.Exit<void, E>>): Settled => {
	if (Exit.isFailure(exit)) {
		return { kind: "failed", cause: exit.cause }
	}
	return Exit.isSuccess(exit.value)
		? { kind: "passed" }
		: { kind: "failed", cause: exit.value.cause }
}

/**
 * The cases a process stopped as hung whose cleanup outran HUNG_CLEANUP_GRACE (live.ts): `keep` holds such a case's
 * fiber, and `drained` waits until every fiber held has ended. A worker drains them before it starts its next unit,
 * and the inline evaluator after each batch, so no stopped case's cleanup runs beside a later case or outlives the
 * evaluation that stopped it.
 */
export class Stopped extends Context.Service<
	Stopped,
	Readonly<{
		keep: (fiber: Fiber.Fiber<unknown, unknown>) => void
		drained: Effect.Effect<void>
	}>
>()("@bjornpagen/testing/runner/case/Stopped") {}

/** A process's stopped cases, none held yet. */
export const stoppedOf = (): Context.Service.Shape<typeof Stopped> => {
	const held = new Set<Fiber.Fiber<unknown, unknown>>()
	return {
		keep: (fiber) => {
			held.add(fiber)
		},
		drained: Effect.suspend(() => {
			const waiting = Arr.fromIterable(held)
			held.clear()
			return Effect.forEach(waiting, (fiber) => Fiber.await(fiber), { discard: true })
		})
	}
}

/**
 * Runs `effect` in a fiber of its own, raced against `deadline` milliseconds on the live clock: an effect that runs to
 * its end synchronously arms no timer. A hung effect is interrupted, and its cleanup awaited for HUNG_CLEANUP_GRACE
 * (live.ts) before the case is reported; a cleanup that runs longer is held among the process's stopped cases
 * (Stopped), which the process drains before its next unit. From the fork until the race, the evaluation is
 * uninterruptible, so an interruption that arrives in between reaches the race and stops the fiber rather than leaving
 * it running detached.
 */
const guarded = <E, R>(
	effect: Effect.Effect<void, E, R>,
	deadline: number
): Effect.Effect<Settled, never, R | Stopped> =>
	Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const stopped = yield* Stopped
			const running = yield* Effect.forkDetach(Effect.exit(effect), { startImmediately: true })
			const ranThrough = running.pollUnsafe()
			if (ranThrough !== undefined) {
				return settledOf(ranThrough)
			}
			const ended = yield* restore(
				Effect.raceFirst(
					Effect.map(Fiber.await(running), settledOf),
					Effect.as(liveSleep(Duration.millis(deadline)), { kind: "hung" } satisfies Settled)
				)
			).pipe(
				Effect.onInterrupt(() =>
					Effect.andThen(
						abandon(running),
						Effect.sync(() => stopped.keep(running))
					)
				)
			)
			if (ended.kind === "hung") {
				yield* abandon(running)
				yield* awaitWithinGrace(running)
				if (running.pollUnsafe() === undefined) {
					stopped.keep(running)
				}
			}
			return ended
		})
	)

/** Milliseconds since a moment of liveNanos. */
const millisSince = (began: bigint) => Effect.map(liveNanos, (now) => Number(now - began) / 1e6)

/** The outcome of a case that drew its value and settled. */
const outcomeOf = (
	settled: Settled,
	order: CaseOrder,
	recorded: Recording,
	printed: Printed
): CaseOutcome => {
	switch (settled.kind) {
		case "passed":
			return {
				kind: "passed",
				kept: order.keep === "tape" ? { kind: "tape", tape: recorded.tape() } : { kind: "nothing" },
				shown: order.print === "always" ? { kind: "shown", printed } : { kind: "unshown" }
			}
		case "failed":
			return { kind: "failed", failure: failureText(settled.cause), tape: recorded.tape(), printed }
		case "hung":
			return { kind: "hung", tape: recorded.tape(), printed }
	}
}

/** What a case's run settles to before its result is measured. */
type Ran = Readonly<{
	sketchDecisions: number
	notes: ReadonlyArray<string>
	measures: ReadonlyArray<readonly [string, number]>
	trace: Trace
	outcome: CaseOutcome
}>

/** A property's check of one case. */
export type CaseCheck<S, F extends string, N extends Needs, E> = (
	resources: Resources<N>,
	c: Case<F>
) => (value: S) => Effect.Effect<void, E, Scope.Scope | NodeServices>

/** A batched property's check of a batch: each case's own effect is its verdict. */
export type BatchCheck<S, F extends string, N extends Needs, E> = (
	resources: Resources<N>
) => (
	cases: Arr.NonEmptyReadonlyArray<readonly [S, Case<F>]>
) => Effect.Effect<ReadonlyArray<Effect.Effect<void, E>>, E, Scope.Scope | NodeServices>

/** One case once drawn: its order, recording, value and handle, its sketch's decisions, and its place among its
 * batch's drawn cases, where a batched check's verdict for it is. */
type DrawnCase<S, F extends string> = Readonly<{
	order: CaseOrder
	recorded: Recording
	value: S
	handle: Handle<F>
	sketchDecisions: number
	at: number
}>

/** A case of an evaluation, drawn, or undrawn because its space threw while drawing it. */
type Slot<S, F extends string> =
	| Readonly<{ kind: "drawn"; drawn: DrawnCase<S, F> }>
	| Readonly<{ kind: "undrawn"; recorded: Recording; ran: Ran }>

/**
 * Draws one case from its order, the `at`-th of its evaluation's drawn cases should it draw; a use of its handle after
 * it ends is reported to `lateUses`.
 */
const slotOf = <S, F extends string>(
	drawing: Drawing<S, F>,
	lateUses: Context.Service.Shape<typeof LateUses>,
	order: CaseOrder,
	at: number
): Slot<S, F> => {
	const recorded = recording(chooserOf(order.chooser))
	const drawn = Result.try(() =>
		drawing.spaceUnder(steeringOf(drawing.situations, order.drawn))(recorded.source)
	)
	if (Result.isFailure(drawn)) {
		return {
			kind: "undrawn",
			recorded,
			ran: {
				sketchDecisions: recorded.decided(),
				notes: [],
				measures: [],
				trace: [],
				outcome: {
					kind: "failed",
					failure: failureText(Cause.die(drawn.failure)),
					tape: recorded.tape(),
					printed: { kind: "undrawn", why: "its space threw while drawing it" }
				}
			}
		}
	}
	return {
		kind: "drawn",
		drawn: {
			order,
			recorded,
			value: drawn.success,
			handle: handleOf<F>(recorded, (drew) =>
				lateUses.report(order, printedOf(drawing.print, drawn.success, drew))
			),
			sketchDecisions: recorded.decided(),
			at
		}
	}
}

/** A drawn case's run once its verdict settled, with what it perceived. */
const ranOf = <S, F extends string>(
	drawing: Drawing<S, F>,
	drawn: DrawnCase<S, F>,
	settled: Settled,
	trace: Trace
): Ran => {
	const closed = drawn.handle.close()
	return {
		sketchDecisions: drawn.sketchDecisions,
		notes: closed.notes,
		measures: closed.measures,
		trace,
		outcome: outcomeOf(
			settled,
			drawn.order,
			drawn.recorded,
			printedOf(drawing.print, drawn.value, closed.drew)
		)
	}
}

/** A case's result from its run and its measured time. */
const resultOf = (recorded: Recording, ran: Ran, millis: number): CaseResult => ({
	decisions: recorded.decided(),
	sketchDecisions: ran.sketchDecisions,
	overrun: recorded.status() === "overrun",
	notes: ran.notes,
	measures: ran.measures,
	trace: ran.trace,
	outcome: ran.outcome,
	millis
})

/** The report a case leaves should it block its process's event loop, which the watchdog prints as it ends it. */
const blockedReport =
	<S, F extends string>(slots: ReadonlyArray<Slot<S, F>>, print: (value: S) => string) =>
	() =>
		Arr.join(
			Arr.map(slots, (slot) => {
				switch (slot.kind) {
					case "undrawn":
						return ""
					case "drawn": {
						const { order, recorded, value } = slot.drawn
						const tape = recorded.tape()
						return Arr.join(
							[
								`${order.property}: a case held its worker's event loop past its deadline of ${Duration.format(Duration.millis(order.deadline))} and the watchdog's grace, so its guard could not stop it: a hang`,
								`case: ${shownOf(print, value)}`,
								`replay: toolchain-test replay '${replayTokenOf(order.property, { drawn: order.drawn, values: Arr.fromIterable(tape.values.subarray(0, tape.length)) })}'`
							],
							"\n"
						)
					}
				}
			}),
			"\n"
		)

/** The deadline an evaluation of these orders runs under: each case's, added up. */
const deadlineOf = (orders: ReadonlyArray<CaseOrder>) =>
	Arr.reduce(orders, 0, (total, order) => total + order.deadline)

/**
 * Evaluates one case of a property: rebuilds its chooser, draws its value from the space its steering selects, and
 * runs its check under the case deadline in the case's own scope, where its needs' resources are taken, perceived as
 * its order's sense asks; the process's watchdog watches it from before its value is drawn. A space that throws while
 * drawing fails the case, undrawn. The tape is copied out only for a case that did not pass and one whose order keeps
 * it.
 */
export const evaluateCase =
	<S, F extends string, N extends Needs, E>(
		drawing: Drawing<S, F>,
		needs: N,
		check: CaseCheck<S, F, N, E>
	) =>
	(order: CaseOrder): Effect.Effect<CaseResult, never, CaseEnv> =>
		Effect.gen(function* () {
			const began = yield* liveNanos
			const lateUses = yield* LateUses
			const slot = slotOf(drawing, lateUses, order, 0)
			const ran = yield* watchedCase(
				{ caseHang: Duration.millis(order.deadline), cut: Option.none() },
				blockedReport([slot], drawing.print),
				Effect.gen(function* () {
					switch (slot.kind) {
						case "undrawn":
							return slot.ran
						case "drawn": {
							const drawn = slot.drawn
							let trace: Trace = []
							const settled = yield* guarded(
								Perception.use((perception) =>
									Effect.map(
										perception.perceive(
											order.sense,
											Effect.scoped(
												NeedCache.use((cache) =>
													check(resourcesOf(needs, cache), drawn.handle.c)(drawn.value)
												)
											)
										),
										([, perceived]) => {
											trace = perceived
										}
									)
								),
								order.deadline
							)
							return ranOf(drawing, drawn, settled, trace)
						}
					}
				})
			)
			const recorded = slot.kind === "drawn" ? slot.drawn.recorded : slot.recorded
			const millis = yield* millisSince(began)
			return resultOf(recorded, ran, millis)
		})

/**
 * Evaluates a batch of a batched property's cases in one check: draws each case (one its space throws on fails alone,
 * undrawn), runs `checkAll` on the drawn cases under the case deadline times their count in the batch's scope, where
 * its needs' resources are taken, then each case's own effect under the case deadline as its verdict. A check that
 * fails or hangs as a whole fails or hangs every case it held; a case it gave no verdict fails. Each case's measured
 * time is the batch's, shared evenly.
 */
export const evaluateBatch =
	<S, F extends string, N extends Needs, E>(
		drawing: Drawing<S, F>,
		needs: N,
		checkAll: BatchCheck<S, F, N, E>
	) =>
	(
		batch: Arr.NonEmptyReadonlyArray<CaseOrder>
	): Effect.Effect<ReadonlyArray<CaseResult>, never, CaseEnv> =>
		Effect.gen(function* () {
			const began = yield* liveNanos
			const lateUses = yield* LateUses
			const [, slots] = Arr.mapAccum(batch, 0, (drawnSoFar, order) => {
				const slot = slotOf(drawing, lateUses, order, drawnSoFar)
				return [slot.kind === "drawn" ? drawnSoFar + 1 : drawnSoFar, slot] as const
			})
			const runs = yield* watchedCase(
				{ caseHang: Duration.millis(deadlineOf(batch)), cut: Option.none() },
				blockedReport(slots, drawing.print),
				runsOf(drawing, needs, checkAll, slots, deadlineOf(batch))
			)
			const millis = (yield* millisSince(began)) / batch.length
			return Arr.zipWith(slots, runs, (slot, ran) =>
				resultOf(slot.kind === "drawn" ? slot.drawn.recorded : slot.recorded, ran, millis)
			)
		})

/** Each case's run, in the batch's order: the batch's check over its drawn cases, then each case's verdict. */
const runsOf = <S, F extends string, N extends Needs, E>(
	drawing: Drawing<S, F>,
	needs: N,
	checkAll: BatchCheck<S, F, N, E>,
	slots: ReadonlyArray<Slot<S, F>>,
	deadline: number
): Effect.Effect<ReadonlyArray<Ran>, never, CaseEnv> =>
	Effect.scoped(
		Effect.gen(function* () {
			const drawnCases = Arr.flatMap(slots, (slot) =>
				slot.kind === "drawn" ? [[slot.drawn.value, slot.drawn.handle.c] as const] : []
			)
			let verdicts: ReadonlyArray<Effect.Effect<void, E>> = []
			const whole: Settled = Arr.isReadonlyArrayNonEmpty(drawnCases)
				? yield* guarded(
						NeedCache.use((cache) =>
							Effect.map(checkAll(resourcesOf(needs, cache))(drawnCases), (given) => {
								verdicts = given
							})
						),
						deadline
					)
				: { kind: "passed" }
			return yield* Effect.forEach(slots, (slot) => {
				switch (slot.kind) {
					case "undrawn":
						return Effect.succeed(slot.ran)
					case "drawn": {
						const drawn = slot.drawn
						if (whole.kind !== "passed") {
							return Effect.succeed(ranOf(drawing, drawn, whole, []))
						}
						return Effect.map(
							Option.match(Arr.get(verdicts, drawn.at), {
								onNone: () =>
									Effect.succeed<Settled>({
										kind: "failed",
										cause: Cause.die(
											`checkAll gave ${verdicts.length} verdicts for ${drawnCases.length} cases`
										)
									}),
								onSome: (verdict) => guarded(verdict, drawn.order.deadline)
							}),
							(settled) => ranOf(drawing, drawn, settled, [])
						)
					}
				}
			})
		})
	)
