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
	Record as Rec,
	Result,
	Schema,
	Scope,
	Struct
} from "effect"
import { countWithin } from "#enumerate.ts"
import { failureText } from "#failure.ts"
import { keyOf, type Pending, pendingAt, type Reached } from "#features.ts"
import type { Gen } from "#gen.ts"
import {
	abandon,
	awaitWithinGrace,
	liveMillis,
	liveNanos,
	liveSleep,
	liveSleepUntil,
	watchedCase
} from "#live.ts"
import type { Need, NeedContext, Needs, NeedValue, Resources } from "#property.ts"
import { fnv1a32 } from "#random.ts"
import { type Drawn, replayTokenOf } from "#replay.ts"
import type { RunnerServicesFailed } from "#runner/config.ts"
import { Perception } from "#runner/perceive.ts"
import {
	type CaseOrder,
	type CaseOutcome,
	type CaseResult,
	judgedLate,
	chooserOf,
	type CountAnswer,
	type CountOrder,
	type Done,
	doneWith,
	type Printed,
	type SeriesOrder,
	type SeriesRan,
	type Trace,
	unopenedResult,
	type Work
} from "#runner/protocol.ts"
import { seriesRun } from "#runner/series.ts"
import { NeedFailed } from "#runner/services.ts"
import { type Began, beganAt, ownCpu, type Reading, standingOf, treeCpuAt } from "#runner/work.ts"
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

/** The identifier of the slot a need's opening is kept under, by its key. */
const slotIdOf = (key: string) => `@bjornpagen/testing/runner/case/need/${key}`

/** The slot a need's opening is kept under in a process's cache: one per key, so needs of one key share it. */
const needSlotOf = <A>(need: Need<A>) => Context.Service<NeedSlot<A>>(slotIdOf(need.key))

/**
 * The needs an evaluating process has opened. `opened` opens a need the first time the process asks for it (needs of
 * one key share it), in a scope of its own under the process's and with the process's services, on a fiber of its own,
 * within `bound` milliseconds on the live clock; every later ask gets what that open gave: the need's taker, or the
 * NeedFailed it failed with (its open past the bound among them, and an open that died, its defect's text the
 * failure's message, so a defect opening a need refuses its property on that process, every case unopened, never
 * ending the process with nothing said), which no later ask retries. What a need keeps warm
 * stays warm across cases and properties until `release` closes its scope (what it holds: clones, sessions, lease
 * permits, released) and forgets it, so a later ask opens it again.
 */
export class NeedCache extends Context.Service<
	NeedCache,
	Readonly<{
		opened: <A>(need: Need<A>, bound: number) => Effect.Effect<Taker<A>, NeedFailed>
		release: (keys: ReadonlyArray<string>) => Effect.Effect<void>
	}>
>()("@bjornpagen/testing/runner/case/NeedCache") {}

/**
 * The need cache of a process whose needs open in the context `services` gives: its scope, the platform, its worker
 * index and the repository's services, which the process builds the first time a need opens, so a process whose cases
 * take no need never builds them. Services that fail to build fail every need that opens with their failure.
 */
export const needCacheOf = (
	services: Effect.Effect<Context.Context<NeedContext>, RunnerServicesFailed>
): Context.Service.Shape<typeof NeedCache> => {
	let slots: Context.Context<never> = Context.empty()
	const scopes = new Map<string, Scope.Closeable>()
	return {
		opened: <A>(need: Need<A>, bound: number) =>
			Effect.suspend(() =>
				Option.match(Context.getOption(slots, needSlotOf(need)), {
					onSome: (slot) => Deferred.await(slot),
					onNone: () => {
						const slot = Deferred.makeUnsafe<Taker<A>, NeedFailed>()
						slots = Context.add(slots, needSlotOf(need), slot)
						const open = Effect.catchCauseIf(
							Effect.raceFirst(
								Effect.flatMap(
									Effect.mapError(services, (failed) =>
										NeedFailed.make({ need: need.key, message: failed.message })
									),
									(context) =>
										Effect.flatMap(Scope.fork(Context.get(context, Scope.Scope)), (scope) => {
											scopes.set(need.key, scope)
											return Effect.provideContext(
												need.open,
												Context.add(context, Scope.Scope, scope)
											)
										})
								),
								Effect.andThen(
									liveSleep(Duration.millis(bound)),
									Effect.fail(
										NeedFailed.make({
											need: need.key,
											message: `its open ran past the open bound of ${Duration.format(Duration.millis(bound))} (needOpenMillis)`
										})
									)
								)
							),
							(cause) => !Cause.hasInterruptsOnly(cause),
							(cause) =>
								Effect.fail(
									Option.getOrElse(Cause.findErrorOption(cause), () =>
										NeedFailed.make({ need: need.key, message: failureText(cause) })
									)
								)
						)
						return Effect.andThen(
							Effect.forkDetach(Deferred.into(open, slot)),
							Deferred.await(slot)
						)
					}
				})
			),
		release: (keys) =>
			Effect.forEach(
				keys,
				(key) =>
					Effect.suspend(() => {
						const scope = Option.fromUndefinedOr(scopes.get(key))
						scopes.delete(key)
						slots = Context.omit(Context.Service<NeedSlot<unknown>>(slotIdOf(key)))(slots)
						return Option.match(scope, {
							onNone: () => Effect.void,
							onSome: (open) => Scope.close(open, Exit.void)
						})
					}),
				{ discard: true }
			)
	}
}

/**
 * Which needs a process holds open for which of its properties: a property readied there uses the keys of its needs;
 * once every property that used a key has retired (its search ended, so no case of it comes again), the key is no
 * longer used and is released, so a worker holds a held need (a seat's clone and session, a lease's permit) only while
 * a property that needs it may still run there.
 */
export type Holdings = Readonly<{
	/** A property readied here uses these need keys. */
	readied: (property: string, keys: ReadonlyArray<string>) => void
	/** A property retired: the keys no property readied here and not retired uses any more, to release. */
	retired: (property: string) => ReadonlyArray<string>
}>

/** A process's holdings, holding nothing. */
export const holdingsOf = (): Holdings => {
	const users = new Map<string, Set<string>>()
	const keysOf = new Map<string, ReadonlyArray<string>>()
	return {
		readied: (property, keys) => {
			keysOf.set(property, keys)
			for (const key of keys) {
				users.set(key, (users.get(key) ?? new Set()).add(property))
			}
		},
		retired: (property) => {
			const keys = keysOf.get(property) ?? []
			keysOf.delete(property)
			return Arr.filter(keys, (key) => {
				const using = users.get(key) ?? new Set<string>()
				using.delete(property)
				if (using.size > 0) {
					return false
				}
				users.delete(key)
				return true
			})
		}
	}
}

/** The keys of a property's needs, each once. */
export const needKeysOf = (needs: Needs): ReadonlyArray<string> =>
	Arr.dedupe(Arr.map(Rec.values(needs), (need) => need.key))

/**
 * What an evaluating process provides every case of a property it readied: its opened needs, its perception and the
 * platform, and where it reports a late use and holds a stopped case.
 */
export type CaseEnv = NeedCache | Perception | LateUses | Stopped | NodeServices

/**
 * A property's needs opened on this process, all at once, each within `bound` milliseconds (NeedCache.opened), before
 * any case of the property and outside every case's deadline: the first that does not open is why the property's
 * cases cannot run here.
 */
const openAll = (needs: Needs, bound: number): Effect.Effect<void, NeedFailed, NeedCache> =>
	NeedCache.use((cache) =>
		Effect.forEach(Rec.values(needs), (need) => cache.opened(need, bound), {
			concurrency: "unbounded",
			discard: true
		})
	)

/** One case's taker of a need its process opened, as `Struct.map` maps a property's needs. */
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
 * One case's resources, by the name its check reads each under: each an effect that takes the need's resource, the
 * need opened on this process before the case (openAll, within `bound`), in the case's scope the first time the check
 * yields it, and gives the same resource every later time.
 */
const resourcesOf = <N extends Needs>(
	needs: N,
	cache: Context.Service.Shape<typeof NeedCache>,
	bound: number
): Resources<N> =>
	Struct.map(
		needs,
		Struct.lambda<Taking>((need) => once(Effect.flatten(cache.opened(need, bound))))
	)

/**
 * A property's evaluations on a process where its needs are open: of a batch of its cases (the results, one an order,
 * in the batch's order); of a series of them, which the process draws itself, an exhaustion's sketches over the
 * property's space or a stream's cases from their seeds, and runs as the search's window (runner/series.ts); and the
 * count of its unsteered space, every case of which an exhaustion runs.
 */
export type Evaluation = Readonly<{
	cases: (
		batch: Arr.NonEmptyReadonlyArray<CaseOrder>
	) => Effect.Effect<ReadonlyArray<CaseResult>, never, CaseEnv>
	series: (series: SeriesOrder) => Effect.Effect<SeriesRan, never, CaseEnv>
	count: (order: CountOrder) => Effect.Effect<CountAnswer>
}>

/**
 * A property's evaluations from its evaluation of a batch: a series' cases drawn over the unsteered space, each
 * evaluated as a batch's, a late use of one reported to the series itself, which marks the case misused; and the count
 * of that space, which the series of its sketches walk.
 */
const evaluationOf = <S, F extends string>(
	drawing: Drawing<S, F>,
	cases: Evaluation["cases"]
): Evaluation => ({
	cases,
	count: (order) =>
		Effect.map(
			countWithin(drawing.spaceUnder(Option.none()), order.cpu, order.every),
			Option.match({
				onNone: (): CountAnswer => ({ kind: "uncountable" }),
				onSome: (counted): CountAnswer => ({
					kind: "counted",
					cases: counted.cases,
					starts: counted.starts
				})
			})
		),
	series: (series) =>
		Effect.suspend(() => {
			const late = new Map<CaseOrder, Printed>()
			return seriesRun(
				drawing.spaceUnder(Option.none()),
				(batch) =>
					cases(batch).pipe(
						Effect.provideService(LateUses, {
							report: (order, printed) => {
								late.set(order, printed)
							}
						})
					),
				(order) => Option.fromUndefinedOr(late.get(order)),
				series
			)
		})
})

/**
 * How a process readies a property for its cases: it opens the property's needs within `bound` milliseconds, before
 * any case and outside every case's deadline, and gives the evaluation of its batches with them open; or why a need did
 * not open, which no case of the property can run without.
 */
export type Readying = (bound: number) => Effect.Effect<Evaluation, NeedFailed, NeedCache>

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
		Arr.map(batch, (result, at) => judgedLate(result, lateAt(batchAt, at)))
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

/**
 * How a guarded effect ended: it passed, failed with its cause, ran past its deadline, or could not have a need's
 * resource (`unopened`: a NeedFailed in its error channel, a need's take that failed or a need the check opened itself),
 * which is no fact of its case's value, so no shrink ever sees it.
 */
type Settled =
	| Readonly<{ kind: "passed" }>
	| Readonly<{ kind: "failed"; cause: Cause.Cause<unknown> }>
	| Readonly<{ kind: "hung" }>
	| Readonly<{ kind: "unopened"; unopened: NeedFailed }>

/**
 * A guarded effect's failure as it settles: unopened by the first need that failed in its error channel, whatever else
 * failed beside it, since a case without its resources says nothing of its value; failed with its cause otherwise.
 */
const failedOf = (cause: Cause.Cause<unknown>): Settled =>
	Option.match(
		Arr.findFirst(cause.reasons, (reason) =>
			Cause.isFailReason(reason) && Schema.is(NeedFailed)(reason.error)
				? Option.some(reason.error)
				: Option.none()
		),
		{
			onNone: (): Settled => ({ kind: "failed", cause }),
			onSome: (unopened): Settled => ({ kind: "unopened", unopened })
		}
	)

const settledOf = <E>(exit: Exit.Exit<Exit.Exit<void, E>>): Settled => {
	if (Exit.isFailure(exit)) {
		return failedOf(exit.cause)
	}
	return Exit.isSuccess(exit.value) ? { kind: "passed" } : failedOf(exit.value.cause)
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
 * Ends `{ kind: "hung" }` once the work begun at `began` has spent `deadline` milliseconds of its process tree's CPU, or
 * its CPU has not moved over a whole `deadline` of wall time (runner/work.ts standingOf). It reads the tree only when its
 * live-clock timer fires, at a window's end or when the CPU left could run out sooner, so a case that ends in time pays
 * one timer and no reading of its tree.
 */
const overrun = (began: Began, deadline: number): Effect.Effect<Settled> => {
	const watch = (window: Reading, readAt: number): Effect.Effect<Settled> =>
		Effect.flatMap(Effect.andThen(liveSleepUntil(readAt), liveMillis), (wall) => {
			const standing = standingOf({ began, window, now: { wall, cpu: treeCpuAt(began) }, deadline })
			return standing.kind === "working"
				? watch(standing.window, standing.readAgainAt)
				: Effect.succeed<Settled>({ kind: "hung" })
		})
	return watch(began, began.wall + deadline)
}

/**
 * Runs `effect` in a fiber of its own, raced against `deadline` milliseconds of its work (overrun): an effect that runs
 * to its end synchronously arms no timer and reads no file. A hung effect is interrupted, and its cleanup awaited for
 * HUNG_CLEANUP_GRACE (live.ts) before the case is reported; a cleanup that runs longer is held among the process's
 * stopped cases (Stopped), which the process drains before its next unit. From the fork until the race, the evaluation
 * is uninterruptible, so an interruption that arrives in between reaches the race and stops the fiber rather than
 * leaving it running detached.
 */
const guarded = <E, R>(
	effect: Effect.Effect<void, E, R>,
	deadline: number
): Effect.Effect<Settled, never, R | Stopped> =>
	Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const stopped = yield* Stopped
			const wall = yield* liveMillis
			const own = ownCpu()
			const running = yield* Effect.forkDetach(Effect.exit(effect), { startImmediately: true })
			const ranThrough = running.pollUnsafe()
			if (ranThrough !== undefined) {
				return settledOf(ranThrough)
			}
			const ended = yield* restore(
				Effect.raceFirst(
					Effect.map(Fiber.await(running), settledOf),
					overrun(beganAt(wall, own), deadline)
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

/** This process's CPU so far, user and system: what a case's CPU is measured from. */
const cpuNow = Effect.sync(() => process.cpuUsage())

/** Milliseconds of this process's CPU, user and system, since a reading of cpuNow. */
const cpuSince = (began: NodeJS.CpuUsage) =>
	Effect.sync(() => {
		const spent = process.cpuUsage(began)
		return (spent.user + spent.system) / 1000
	})

/**
 * The outcome of a case that drew its value and settled, printed (`printed`, which formats its value) only when the
 * outcome shows it: a failing or hung case, or a passing one its order asks to show. A case that could not have a need's
 * resource is unopened, as a property whose need did not open on its process is: the need and why, no tape and no
 * printed value, which a search reports once and never shrinks.
 */
const outcomeOf = (
	settled: Settled,
	order: CaseOrder,
	recorded: Recording,
	printed: () => Printed
): CaseOutcome => {
	switch (settled.kind) {
		case "passed":
			return {
				kind: "passed",
				kept: order.keep === "tape" ? { kind: "tape", tape: recorded.tape() } : { kind: "nothing" },
				shown:
					order.print === "always" ? { kind: "shown", printed: printed() } : { kind: "unshown" }
			}
		case "failed":
			return {
				kind: "failed",
				failure: failureText(settled.cause),
				tape: recorded.tape(),
				printed: printed()
			}
		case "hung":
			return { kind: "hung", tape: recorded.tape(), printed: printed() }
		case "unopened":
			return {
				kind: "unopened",
				need: settled.unopened.need,
				message: settled.unopened.message
			}
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

/**
 * A property as a process readied it: its needs open, with the evaluation of its batches; or refused, with the one
 * result every case of it gets on that process (unopened when a need did not open; lost when a worker could not load
 * its module).
 */
export type Readied =
	| Readonly<{ kind: "ready"; evaluate: Evaluation }>
	| Readonly<{ kind: "refused"; result: CaseResult }>

/** A property readied on this process, its needs opened within `bound`: ready, or refused as unopened. */
export const readiedOf = (
	ready: Readying,
	bound: number
): Effect.Effect<Readied, never, NeedCache> =>
	Effect.match(ready(bound), {
		onFailure: (unopened): Readied => ({
			kind: "refused",
			result: unopenedResult(unopened.need, unopened.message)
		}),
		onSuccess: (evaluate): Readied => ({ kind: "ready", evaluate })
	})

/**
 * A unit's work done on a process: its batch evaluated, or its series, when its property is ready; the refusal for each
 * of its cases otherwise.
 */
export const doneOf = (readied: Readied, work: Work): Effect.Effect<Done, never, CaseEnv> => {
	switch (readied.kind) {
		case "ready":
			switch (work.kind) {
				case "cases":
					return Effect.map(readied.evaluate.cases(work.batch), (results) => ({
						kind: "cases",
						results
					}))
				case "series":
					return Effect.map(readied.evaluate.series(work.series), (ran) => ({
						kind: "series",
						ran
					}))
				case "count":
					return Effect.suspend(() => {
						const began = process.threadCpuUsage()
						return Effect.map(readied.evaluate.count(work.count), (answer): Done => {
							const spent = process.threadCpuUsage(began)
							return { kind: "count", answer, cpu: (spent.user + spent.system) / 1000 }
						})
					})
			}
		case "refused":
			return Effect.succeed(doneWith(work, readied.result))
	}
}

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
		outcome: outcomeOf(settled, drawn.order, drawn.recorded, () =>
			printedOf(drawing.print, drawn.value, closed.drew)
		)
	}
}

/** A case's result from its run, its measured time and its process's CPU meanwhile. */
const resultOf = (recorded: Recording, ran: Ran, millis: number, cpu: number): CaseResult => ({
	decisions: recorded.decided(),
	sketchDecisions: ran.sketchDecisions,
	overrun: recorded.status() === "overrun",
	notes: ran.notes,
	measures: ran.measures,
	trace: ran.trace,
	outcome: ran.outcome,
	millis,
	cpu
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
 * Evaluates one case of a property whose needs are open: rebuilds its chooser, draws its value from the space its
 * steering selects, and runs its check under the case deadline in the case's own scope, where it takes its needs'
 * resources from its needs, opened on this process before it, perceived as its order's sense asks; the process's watchdog watches it from before its value is drawn. A space that throws while
 * drawing fails the case, undrawn. The tape is copied out only for a case that did not pass and one whose order keeps
 * it.
 */
const evaluateCase =
	<S, F extends string, N extends Needs, E>(
		drawing: Drawing<S, F>,
		needs: N,
		check: CaseCheck<S, F, N, E>
	) =>
	(order: CaseOrder): Effect.Effect<CaseResult, never, CaseEnv> =>
		Effect.gen(function* () {
			const began = yield* liveNanos
			const cpuBegan = yield* cpuNow
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
													check(resourcesOf(needs, cache, order.open), drawn.handle.c)(drawn.value)
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
			const cpu = yield* cpuSince(cpuBegan)
			return resultOf(recorded, ran, millis, cpu)
		})

/**
 * How a property checked one case at a time is readied on a process: its needs opened within the bound, then each
 * case of a batch evaluated in turn (evaluateCase).
 */
export const casesReadied =
	<S, F extends string, N extends Needs, E>(
		drawing: Drawing<S, F>,
		needs: N,
		check: CaseCheck<S, F, N, E>
	): Readying =>
	(bound) =>
		Effect.as(
			openAll(needs, bound),
			evaluationOf(drawing, (batch) => Effect.forEach(batch, evaluateCase(drawing, needs, check)))
		)

/**
 * Evaluates a batch of a batched property's cases in one check, its needs open: draws each case (one its space throws
 * on fails alone, undrawn), runs `checkAll` on the drawn cases under the case deadline times their count in the batch's
 * scope, where it takes its needs' resources (opened on this process before it), then each case's own effect under the case deadline as its verdict. A check that
 * fails or hangs as a whole fails or hangs every case it held; a case it gave no verdict fails. Each case's measured
 * time and CPU are the batch's, shared evenly.
 */
const evaluateBatch =
	<S, F extends string, N extends Needs, E>(
		drawing: Drawing<S, F>,
		needs: N,
		checkAll: BatchCheck<S, F, N, E>
	): Evaluation["cases"] =>
	(batch) =>
		Effect.gen(function* () {
			const began = yield* liveNanos
			const cpuBegan = yield* cpuNow
			const lateUses = yield* LateUses
			const [, slots] = Arr.mapAccum(batch, 0, (drawnSoFar, order) => {
				const slot = slotOf(drawing, lateUses, order, drawnSoFar)
				return [slot.kind === "drawn" ? drawnSoFar + 1 : drawnSoFar, slot] as const
			})
			const runs = yield* watchedCase(
				{ caseHang: Duration.millis(deadlineOf(batch)), cut: Option.none() },
				blockedReport(slots, drawing.print),
				runsOf(drawing, needs, checkAll, Arr.headNonEmpty(batch).open, slots, deadlineOf(batch))
			)
			const millis = (yield* millisSince(began)) / batch.length
			const cpu = (yield* cpuSince(cpuBegan)) / batch.length
			return Arr.zipWith(slots, runs, (slot, ran) =>
				resultOf(slot.kind === "drawn" ? slot.drawn.recorded : slot.recorded, ran, millis, cpu)
			)
		})

/** How a batched property is readied on a process: its needs opened within the bound, then each batch evaluated in
 * one check (evaluateBatch). */
export const batchesReadied =
	<S, F extends string, N extends Needs, E>(
		drawing: Drawing<S, F>,
		needs: N,
		checkAll: BatchCheck<S, F, N, E>
	): Readying =>
	(bound) =>
		Effect.as(openAll(needs, bound), evaluationOf(drawing, evaluateBatch(drawing, needs, checkAll)))

/** Each case's run, in the batch's order: the batch's check over its drawn cases, then each case's verdict. */
const runsOf = <S, F extends string, N extends Needs, E>(
	drawing: Drawing<S, F>,
	needs: N,
	checkAll: BatchCheck<S, F, N, E>,
	bound: number,
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
							Effect.map(checkAll(resourcesOf(needs, cache, bound))(drawnCases), (given) => {
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
