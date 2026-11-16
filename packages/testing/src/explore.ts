import {
	Array as Arr,
	Cause,
	Console,
	Context,
	Deferred,
	Duration,
	Effect,
	Exit,
	Fiber,
	Formatter,
	Option,
	type Scope,
	Schema,
	String as Str
} from "effect"
import {
	type Branch,
	type Enumerated,
	enumerated,
	firstBranch,
	nextBranch,
	sizeOf
} from "#enumerate.ts"
import { failureText } from "#failure.ts"
import {
	type Coverage,
	keyOf,
	type Pending,
	type Phase,
	pendingAt,
	pendingOf,
	type Rate,
	ratesOf,
	type Reached,
	type Residual,
	residualOf,
	type SpaceCoverage,
	type SteeringPhase,
	situationsOf,
	type Tally,
	type TallyBuilder,
	type Turns,
	tallyOf,
	turnsOf,
	unreachedOf
} from "#features.ts"
import type { Corpus, Fuzz, FuzzBudget } from "#fuzz.ts"
import type { Gen } from "#gen.ts"
import {
	abandon,
	awaitWithinGrace,
	liveMillis,
	liveSleepUntil,
	WATCHDOG_GRACE_MILLIS,
	watchedCase
} from "#live.ts"
import { mutate } from "#mutate.ts"
import {
	between,
	caseSeed,
	floorSeed,
	fnv1a32,
	fuzzSeed,
	type LabelStream,
	rotatingSeed,
	type RunStream,
	steeredSeed,
	wordsOf
} from "#random.ts"
import { type Drawn, type Replay, ReplayCase, replayTokenOf } from "#replay.ts"
import { searchStarted } from "#searches.ts"
import { seedsOf } from "#seeds.ts"
import { notesOnly, type Sense } from "#sense.ts"
import {
	type Attempt,
	boundedShrink,
	type ShrinkBudget,
	shrinkAttempt,
	type Shrunk
} from "#shrink.ts"
import {
	type Chooser,
	forcedChooser,
	type Observed,
	prefixChooser,
	randomChooser,
	type Recorder,
	type Recording,
	recorder,
	recording,
	simplestChooser
} from "#source.ts"
import { type Tape, tokenOf, valuesFromToken } from "#tape.ts"

/**
 * How long before its test's deadline a search stops its work and reports (explore.ts's cut): the time from the moment
 * it is due to stop to the moment its test's function has failed with the report, which then beats the test's own
 * timeout. In it the search logs its report, then awaits the cleanup of every case it stopped.
 *
 * @limitKind provisional
 * @owner the choice-stream testing library (explore.ts, a search's cut before its test's deadline)
 * @unit milliseconds
 * @scope every search under a bounded deadline (Run.deadline), in each test process alone
 * @guards a search would work up to its test's own timeout, which fails the test as a bare timeout: the smallest
 *   failing case a cut shrink reached, or the case a search had in flight, would go unreported; and a margin shorter
 *   than a stopped case's cleanup loses the typed failure to the timeout
 * @measure re-run the old record's two measurements on cassowary: about 240 cut searches with reports of 1.6 KB and 68
 *   KB and grizzle's write-oracle literal, four test files at once and while the library's whole suite runs, timing
 *   each from its cut to its failure leaving the test's logging; and grizzle's release of a stopped case's schema
 *   (DROP OWNED BY, DROP ROLE, DROP SCHEMA CASCADE) at the largest size a test held and at ten times it, ten runs
 *   each, on grizzle's PostgreSQL cluster. The margin is the slowest report and literal plus the longer of the slowest
 *   large release and three slowest test-sized ones, with its headroom stated
 * @origin a measured record of 2026-11-04 to 2026-11-07 on a macOS (Darwin 27.0.0) arm64 VM on 10 cores, Node 26.13.0,
 *   Vitest 5.1.0, effect 4.1.2 and PostgreSQL 19rc1, load average 27 to 85 (packages/testing/out/print-margin/ in
 *   superstarter's and grizzle's checkouts there): reports at most 30 ms, the literal at most 87 ms, releases at most
 *   2,186 ms large and 801 ms test-sized, about 2,520 ms in all, with 480 ms left for late timers. The machine
 *   changed, which its revalidation names, and its run output stayed with the VM, so the record no longer stands
 * @recorded 2026-11-16
 */
const reportMarginMillis = 3000

/**
 * How often a fuzz run prints its progress (explore.ts), in milliseconds of wall time. The fuzz run is `go test -fuzz`'s
 * in this library (its -fuzztime grammar, its corpus), so it reports as often as Go's fuzzing coordinator does: often
 * enough that a person watching sees it move, and seldom enough that the status lines cost the run nothing.
 *
 * @limitKind published
 * @owner Go 1.27.4's fuzzing coordinator (go test -fuzz), whose status interval the library's fuzz run takes
 * @unit milliseconds
 * @scope the wait between two status lines of one fuzz run
 * @constraint compile-time constant
 * @source https://github.com/golang/go/blob/go1.27.4/src/internal/fuzz/fuzz.go#L205
 * @quote statTicker := time.NewTicker(3 * time.Second)
 * @verified 2026-11-16
 */
const fuzzStatusEveryMillis = 3 * 1000

/** How a run came by its seed: given in the environment to replay a run, or freshly drawn. */
export type SeedSource = "environment" | "fresh"

/**
 * The run every test process of one run shares. Global setup chooses it once, so every suite of a run shares one seed
 * and one failure names the whole run: rerunning with that seed reproduces it. A replay names the one suite whose
 * streams give way to one case, drawn under the steering its token records. A fuzz run names the one suite it fuzzes;
 * every other suite runs as under test.
 */
export type ProcessRun = Readonly<{
	seed: number
	source: SeedSource
	replay: Option.Option<Replay>
	fuzz: Option.Option<Fuzz>
}>

/**
 * When the test a search runs in fails on its own timeout: never, when its timeout is unbounded, or at `millis` on the
 * live clock, in milliseconds since the epoch. A search ends its work PRINT_MARGIN_MILLIS before its deadline, so it
 * reports what it found before its test fails as a bare timeout: a shrink the deadline cuts short reports the smallest
 * failing case it reached, and a search cut short before any case failed reports the case it had in flight.
 */
export type Deadline = Readonly<{ kind: "unbounded" }> | Readonly<{ kind: "at"; millis: number }>

/** The deadline of a search whose test's timeout is unbounded. */
export const noDeadline: Deadline = { kind: "unbounded" }

/**
 * How long before its test's deadline a search stops its work and reports: the time from the moment it is due to stop
 * to the moment its test's function has failed with the report, which then beats the test's own timeout. In it the
 * search logs its report, then awaits the cleanup of every case it stopped (withCaseLives), so a report outlives a
 * cleanup slower than the margin, and only the typed failure is lost to the test's own timeout. It is
 * reportMarginMillis, provisional since its measured record's machine was retired.
 */
export const PRINT_MARGIN_MILLIS = reportMarginMillis

/** The run an exploration draws from, as the test it runs in sees it: the process's run, and its test's deadline. */
export class Run extends Context.Service<Run, ProcessRun & Readonly<{ deadline: Deadline }>>()(
	"@bjornpagen/testing/explore/Run"
) {}

/** The moment on the live clock a search must stop its work for its deadline: PRINT_MARGIN_MILLIS before it, and none
 * for an unbounded deadline. */
const cutOf = (deadline: Deadline): Option.Option<number> => {
	switch (deadline.kind) {
		case "unbounded":
			return Option.none()
		case "at":
			return Option.some(deadline.millis - PRINT_MARGIN_MILLIS)
	}
}

/**
 * A search's cut as its cases read it: none for an unbounded deadline; otherwise its moment, and `reached`, which ends
 * once the live clock reads it. One timer per search keeps it, armed in the search's scope, so a case that runs to its
 * end synchronously arms none, and a case that yields awaits the search's cut beside its own hang guard.
 */
type Cutting =
	| Readonly<{ kind: "unbounded" }>
	| Readonly<{ kind: "at"; moment: number; reached: Effect.Effect<void> }>

/** The cut of a search under `deadline`, its one timer forked into the search's scope. */
const cuttingOf = (deadline: Deadline): Effect.Effect<Cutting, never, Scope.Scope> =>
	Option.match(cutOf(deadline), {
		onNone: () => Effect.succeed<Cutting>({ kind: "unbounded" }),
		onSome: (moment) =>
			Effect.gen(function* () {
				const reached = yield* Deferred.make<void>()
				yield* Effect.forkScoped(
					Effect.andThen(liveSleepUntil(moment), Deferred.succeed(reached, undefined))
				)
				const cutting: Cutting = { kind: "at", moment, reached: Deferred.await(reached) }
				return cutting
			})
	})

/** The moment a search's cut comes, none when it never does. */
const cutMoment = (cutting: Cutting): Option.Option<number> =>
	cutting.kind === "at" ? Option.some(cutting.moment) : Option.none()

/**
 * What a search's cases live within: its cut, and `stop`, which interrupts a case's fiber without waiting and keeps it
 * among the fibers the search awaits before it returns, so no case's cleanup outlives the search that started it.
 */
type Life = Readonly<{
	cutting: Cutting
	stop: (fiber: Fiber.Fiber<unknown, unknown>) => Effect.Effect<void>
}>

/**
 * A search whose cases live no longer than it does: `body` runs with the search's run and life, and every case fiber
 * it stops is awaited before the search returns, however it ends, its cut, its hang and its interruption included.
 * Should a stopped case still be cleaning up when the search fails, the failure's report is printed first, so a
 * deadline that arrives during the wait cannot lose it. A cleanup that never ends holds the search, and its test's own
 * timeout names the leak. Its start is counted as a search's (searchStarted), so the test that runs it is a search.
 */
const withCaseLives = <A, R>(
	body: (run: Context.Service.Shape<typeof Run>, life: Life) => Effect.Effect<A, SearchFailure, R>
): Effect.Effect<A, SearchFailure, Run | Exclude<R, Scope.Scope>> =>
	Effect.suspend(() => {
		const stopped = new Set<Fiber.Fiber<unknown, unknown>>()
		const cleaning = () =>
			Arr.some(Arr.fromIterable(stopped), (fiber) => fiber.pollUnsafe() === undefined)
		return Effect.scoped(
			Effect.gen(function* () {
				yield* searchStarted
				const run = yield* Run
				yield* Effect.addFinalizer(() =>
					Effect.forEach(stopped, (fiber) => Fiber.await(fiber), { discard: true })
				)
				const cutting = yield* cuttingOf(run.deadline)
				const life: Life = {
					cutting,
					stop: (fiber) =>
						Effect.andThen(
							Effect.sync(() => stopped.add(fiber)),
							abandon(fiber)
						)
				}
				return yield* body(run, life)
			}).pipe(
				Effect.tapError((failure) => (cleaning() ? liveReport(failure.message) : Effect.void))
			)
		)
	})

/**
 * What a property sees of the case it runs: it notes the situations it reached; draws more from the case's own tape;
 * and records on the tape what the system under test decided (and learns whether a replay decided the same). A case
 * never gives itself up: a precondition is a property of the generator, which constructs only cases that meet it. A
 * note, a draw or an observation made after the case ended is a misuse, reported as one. A property never reads what
 * its case is steered at: the generator does (Steered), so the case a steered witness runs is its sketch, the one value
 * the search prints, shrinks, keeps and replays.
 */
export type Case<F extends string> = Readonly<{
	note: (feature: F) => void
	noteAll: (features: Iterable<F>) => void
	pair: (first: F, second: F) => void
	draw: <A>(generator: Gen<A>) => A
	observe: (decided: string) => Observed
}>

/**
 * A suite's generator under the steering its case is drawn under: the required situations no witness had reached when
 * the case's window began, the one its turn aims at among them (Pending), or none. Steering is offered to the witnesses
 * (the floor stream and the steered phase) and to a fuzz run, so the generator may draw a case aimed at what is
 * pending; it is none wherever a case must be a plain draw: the rotating stream, whose cases alone estimate the
 * residual. A replay draws under exactly the steering its token records, and a kept case is its sketch, drawn by
 * nothing, so the case an aim drew is the one that ran, was printed and is kept.
 */
export type Steered<S, F extends string> = (steering: Option.Option<Pending<F>>) => Gen<S>

/**
 * What a suite generates and what its property sees: the sketch is what is generated under the case's steering,
 * printed and shrunk, and `resolve` turns it into the value the property takes. A resolve that throws fails the case
 * like the property would.
 */
export type Draw<S, T, F extends string> = Readonly<{
	generator: Steered<S, F>
	resolve: (sketch: S) => T
}>

/** The property takes the generated value itself, drawn alike under any steering. */
export const drawn = <T>(generator: Gen<T>): Draw<T, T, never> => ({
	generator: () => generator,
	resolve: (value) => value
})

/** The property takes what `resolve` makes of the generated sketch, drawn alike under any steering. */
export const sketched = <S, T>(
	generator: Gen<S>,
	resolve: (sketch: S) => T
): Draw<S, T, never> => ({
	generator: () => generator,
	resolve
})

/**
 * The property takes the generated value, drawn by `generator` unless the case's turn aims at a situation `aims` names
 * (Pending `aimed`), which the generator beside it draws instead: a case constructed to reach it, so the cases of one
 * window aim at distinct requirements.
 */
export const aimed = <T, const F extends string>(
	generator: Gen<T>,
	aims: ReadonlyArray<readonly [Reached<F>, Gen<T>]>
): Draw<T, T, F> => ({
	generator: (steering) =>
		Option.match(
			Option.flatMap(steering, (pending) =>
				Arr.findFirst(aims, ([situation]) => pending.aimed(situation))
			),
			{ onNone: () => generator, onSome: ([, aim]) => aim }
		),
	resolve: (value) => value
})

/** The property takes what `resolve` makes of the sketch `generator` draws under the case's steering. */
export const steered = <S, T, F extends string>(
	generator: Steered<S, F>,
	resolve: (sketch: S) => T
): Draw<S, T, F> => ({ generator, resolve })

/**
 * A counterexample kept by value: it replays before any stream, unsteered, is never shrunk, and must still reach every
 * situation it names, so a kept case that drifted away from what it once caught fails loudly. Its sketch is a value;
 * what the property drew from the case's tape is `draws`, the tape token of exactly those decisions ("" when it drew
 * none), so a kept race replays the very schedule that failed. A kept case passes only when it ran exactly its draws:
 * draws that no longer fit what the property draws, running out, out of a decision's range or left over, fail as
 * `KeptStale`, and a kept case never fills in what it lacks. A failure or a
 * hang it meets is reported as one, stale or not. What the system decided is observed, not drawn: an observation the
 * draws lack is recorded, never stale.
 */
export type Kept<S, F extends string> = Readonly<{
	note: string
	sketch: S
	draws: string
	reaches: Arr.NonEmptyReadonlyArray<F>
}>

/**
 * What a search's property is checked against, which its report prints beside what it measured: a second
 * implementation (a naive model, a reference evaluator), the specification turned into a checker, a universal oracle (a
 * round trip, an idempotence, a law any correct answer obeys), or PostgreSQL as the judge of a law, with `name` saying
 * which one, as "a Set<number> against the bitset algebra" or "decode ∘ encode = id"; or `unstated`, a suite that has
 * not yet said, which every report prints and counts as such.
 */
export type Oracle =
	| Readonly<{
			kind: "second-implementation" | "specification" | "universal" | "postgresql"
			name: string
	  }>
	| Readonly<{ kind: "unstated" }>

/**
 * A property search over one draw. Every field but `concurrency` is stated by the suite, so its budget is on the page:
 * - `literal` prints a sketch as source the suite can paste into its kept cases, and must read back as the same sketch;
 * - `coverage` is what the search must reach, and the steered phase that reaches what the floor stream misses: the
 *   floor's and the steered phase's cases alone decide it, so it passes on every run seed or on none;
 * - `runs` is the rotating stream's cases, the run's fresh sample, and the floor stream runs a quarter as many: the
 *   suite's budget for finding failures under test, never a dial for coverage, where a longer search is a fuzz run
 *   with a budget of its own;
 * - `concurrency` is how many cases run at once, one at a time where the suite leaves it out (oneAtATime), as cases
 *   that share state the property does not isolate must run;
 * - `steerEvery` is how many cases pass between the snapshots a steered generator reads (Steered), a constant of the suite, so the
 *   same seed draws the same cases however many run at once;
 * - `caseHang` is how long one case may run before it is stopped and reported;
 * - `oracle` is what the property is checked against, which the report prints, `unstated` while the suite has not
 *   said.
 */
export type Exploration<S, T, F extends string> = Readonly<{
	suite: string
	draw: Draw<S, T, F>
	literal: (sketch: S) => string
	coverage: Coverage<F>
	kept: ReadonlyArray<Kept<S, F>>
	runs: number
	shrink: ShrinkBudget
	concurrency?: number
	steerEvery: number
	caseHang: Duration.Input
	oracle: Oracle
}>

/** Where a falsified case was drawn: a phase of its search, a kept case, or the one case a replay token names. */
export type CasePhase = Phase | "kept" | "replayed"

const CasePhase = Schema.Literals([
	"kept",
	"floor",
	"steered",
	"exhaustive",
	"independent",
	"fuzzed",
	"replayed"
])

/**
 * Whether a falsified case's phase is a witness, one the suite's label fixes: a failure found there is found on every
 * run seed, so a verdict that requires a failure (a mutant's kill) counts it, and no other.
 */
export const isWitness = (phase: CasePhase): boolean => {
	switch (phase) {
		case "floor":
		case "steered":
		case "exhaustive":
			return true
		case "kept":
		case "independent":
		case "fuzzed":
		case "replayed":
			return false
	}
}

/** How far a falsified case was shrunk, as its shrink ended (ShrinkEnd), or `unshrunk`: a kept case and a replayed case
 * are reported as they ran. */
const Shrinking = Schema.Literals(["minimal", "budget", "deadline", "unshrunk"])

/**
 * A property failed on a case; the report names the run, the stream, the shrunk case and how to replay it. `phase` is
 * where the case was drawn and `shrink` how far it was shrunk, as data, so a caller judges a failure by where it came
 * from and whether it is the smallest its shrink could reach, never by its prose. `replay` is the case a replay token
 * names, none for a kept case, which replays by value.
 */
export class PropertyFalsified extends Schema.TaggedError<
	PropertyFalsified,
	{ readonly brand: unique symbol }
>()("PropertyFalsified", {
	suite: Schema.String,
	phase: CasePhase,
	shrink: Shrinking,
	replay: Schema.Option(ReplayCase),
	message: Schema.String
}) {}

/** A case ran past its hang limit; it is reported as drawn, unshrunk, and the suite stops. */
export class CaseHung extends Schema.TaggedError<CaseHung, { readonly brand: unique symbol }>()(
	"CaseHung",
	{ suite: Schema.String, replay: Schema.Option(ReplayCase), message: Schema.String }
) {}

/**
 * The deadline of the test a search runs in arrived before any case failed: the search stopped PRINT_MARGIN_MILLIS
 * before it, and reports where it stopped and the case it had in flight, so its test fails with this report rather than
 * as a bare timeout. `replay` is the case in flight, none for a kept case, which replays by value.
 */
export class DeadlineReached extends Schema.TaggedError<
	DeadlineReached,
	{ readonly brand: unique symbol }
>()("DeadlineReached", {
	suite: Schema.String,
	replay: Schema.Option(ReplayCase),
	message: Schema.String
}) {}

/** The witnesses a coverage verdict was judged on: an exploration's floor and steered cases, or an exhaustion's every
 * case. */
const Witnessed = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("streams"), floor: Schema.Int, steered: Schema.Int }),
	Schema.Struct({ kind: Schema.Literal("space"), cases: Schema.Int })
])

export type Witnessed = typeof Witnessed.Type

/**
 * No witness reached a required situation: the generator draws it too rarely for the floor and the steered budget, or
 * no longer draws it at all. Every witness is fixed by the suite's label, so every run seed fails alike. A kept case
 * and a rotating case never count, so a situation only they reach needs a generator arm, a property that aims its
 * draws at what is pending, or a larger steered budget.
 */
export class FeaturesUnreached extends Schema.TaggedError<
	FeaturesUnreached,
	{ readonly brand: unique symbol }
>()("FeaturesUnreached", {
	suite: Schema.String,
	missing: Schema.Array(Schema.String),
	witnessed: Witnessed,
	message: Schema.String
}) {}

/** A kept case no longer runs as kept: its draws no longer fit what its property draws (they ran out, fell outside a
 * decision's range, or were left over). */
export class KeptStale extends Schema.TaggedError<KeptStale, { readonly brand: unique symbol }>()(
	"KeptStale",
	{ suite: Schema.String, note: Schema.String, message: Schema.String }
) {}

/** A replay token's case no longer runs as its token says: it steers by a requirement the suite no longer declares,
 * or its draws no longer fit what its property draws. */
export class ReplayStale extends Schema.TaggedError<
	ReplayStale,
	{ readonly brand: unique symbol }
>()("ReplayStale", { suite: Schema.String, message: Schema.String }) {}

/** A kept case no longer reaches a situation it names. */
export class KeptUnreached extends Schema.TaggedError<
	KeptUnreached,
	{ readonly brand: unique symbol }
>()("KeptUnreached", {
	suite: Schema.String,
	note: Schema.String,
	missing: Schema.Array(Schema.String),
	message: Schema.String
}) {}

/** A property used its case after the case ended: it noted a situation, drew or observed. */
export class CaseMisused extends Schema.TaggedError<
	CaseMisused,
	{ readonly brand: unique symbol }
>()("CaseMisused", { suite: Schema.String, message: Schema.String }) {}

/** Every way an exploration or an exhaustion can fail. */
export type SearchFailure =
	| PropertyFalsified
	| CaseHung
	| DeadlineReached
	| FeaturesUnreached
	| KeptUnreached
	| KeptStale
	| ReplayStale
	| CaseMisused

/**
 * What a case did. A case is cut when its search's deadline arrived before it ended. A failed, hung or cut case carries
 * its tape, the property's own draws included, to shrink or replay.
 */
type Outcome =
	| Readonly<{ kind: "passed" }>
	| Readonly<{ kind: "failed"; cause: Cause.Cause<unknown>; tape: Tape }>
	| Readonly<{ kind: "hung"; tape: Tape }>
	| Readonly<{ kind: "cut"; tape: Tape }>

/**
 * A case's outcome as its search judges it: what it did, or misused, when a case that passed was used after it ended. A failure, a hang or a cut is judged as itself, whatever was done with the case after.
 */
type Judged = Outcome | Readonly<{ kind: "misused" }>

/**
 * What one path does with each judged outcome: a handler for every kind, so a kind added to Judged is a compile error
 * on every path that reads one.
 */
type Judgment<A> = {
	readonly [K in Judged["kind"]]: (judged: Extract<Judged, { readonly kind: K }>) => A
}

/** One case's run: its sketch, what the property drew, its notes, its sense's trace (empty unless it passed), whether it
 * was used after it ended (read when it is judged, so a use after the case ended counts), its outcome, and what its
 * caller kept of its recording. */
type CaseRun<S, K> = Readonly<{
	sketch: S
	sketchDecisions: number
	decisions: number
	overrun: boolean
	drew: ReadonlyArray<unknown>
	notes: ReadonlySet<string>
	trace: Uint8Array
	misused: () => boolean
	outcome: Outcome
	kept: K
}>

/** The one place a case's outcome is read: every path that runs a case judges it here, by its own Judgment. */
const judge = <A>(caseRun: CaseRun<unknown, unknown>, judgment: Judgment<A>): A => {
	const judged = judgedOf(caseRun)
	switch (judged.kind) {
		case "passed":
			return judgment.passed(judged)
		case "failed":
			return judgment.failed(judged)
		case "hung":
			return judgment.hung(judged)
		case "cut":
			return judgment.cut(judged)
		case "misused":
			return judgment.misused(judged)
	}
}

const judgedOf = (caseRun: CaseRun<unknown, unknown>): Judged => {
	switch (caseRun.outcome.kind) {
		case "passed":
			return caseRun.misused() ? { kind: "misused" } : caseRun.outcome
		case "failed":
		case "hung":
		case "cut":
			return caseRun.outcome
	}
}

/** A failing case's run and its cause, what a shrink carries from candidate to candidate. */
type Failure<S> = Readonly<{ run: CaseRun<S, unknown>; cause: Cause.Cause<unknown> }>

/** A shrink candidate's judgment: it is a smaller case of the failure only when its property failed; a pass, a hang or
 * a misuse is not the failure being shrunk, and a cut candidate ends the shrink. */
const candidateJudgment = <S>(candidate: CaseRun<S, Tape>): Judgment<Attempt<Failure<S>>> => {
	const holds = (): Attempt<Failure<S>> => ({ kind: "holds", tape: candidate.kept })
	return {
		passed: holds,
		hung: holds,
		misused: holds,
		cut: () => ({ kind: "cut" }),
		failed: (failed) => ({
			kind: "fails",
			tape: candidate.kept,
			failure: { run: candidate, cause: failed.cause }
		})
	}
}

/** What a case is drawn under, as its replay token records it, and the steering its property sees of that. */
type Under<F extends string> = Readonly<{ drawn: Drawn; steering: Option.Option<Pending<F>> }>

const underOf = <F extends string>(situations: ReadonlyArray<Reached<F>>, how: Drawn): Under<F> => {
	switch (how.kind) {
		case "unsteered":
			return { drawn: how, steering: Option.none() }
		case "steered":
			return { drawn: how, steering: Option.some(pendingAt(situations, how.pending)) }
	}
}

/**
 * What each case of a window of `cases` cases is drawn under, by its offset in the window: the requirements no case of
 * these steering tallies reached, the case aimed at its turn among them in its stream's `turns`.
 */
const steeredBy = <F extends string>(
	situations: ReadonlyArray<Reached<F>>,
	steering: ReadonlyArray<Tally<SteeringPhase>>,
	turns: Turns,
	cases: number
): ((offset: number) => Under<F>) => {
	const turnAt = turns.window(pendingOf(situations, steering), cases)
	return (offset) => underOf(situations, { kind: "steered", pending: turnAt(offset) })
}

/** How a case's property ended, before its recording is read. */
type Settled =
	| Readonly<{ kind: "passed"; trace: Uint8Array }>
	| Readonly<{ kind: "failed"; cause: Cause.Cause<unknown> }>
	| Readonly<{ kind: "hung" }>
	| Readonly<{ kind: "cut" }>

/** A case's outcome: as its property settled, a failed, hung or cut case with its tape. */
const outcomeOf = (recorded: Recording, settled: Settled): Outcome => {
	switch (settled.kind) {
		case "passed":
			return { kind: "passed" }
		case "failed":
			return { kind: "failed", cause: settled.cause, tape: recorded.tape() }
		case "hung":
			return { kind: "hung", tape: recorded.tape() }
		case "cut":
			return { kind: "cut", tape: recorded.tape() }
	}
}

/**
 * How many cases a search runs at once where its spec states no `concurrency`: one at a time, a sequential run, which
 * is a window's identity (windowOf forks nothing for it) and Effect's own default, so no limit and no bound.
 */
const oneAtATime = 1

/** Keeps nothing of a case's recording: a search reads only a failing case's tape, which its outcome carries. */
const keepNothing = (): void => undefined

/** Keeps a case's whole tape: an enumeration steps from it, and a shrink compares it. */
const keepTape = (recorded: Recording): Tape => recorded.tape()

/**
 * A window's runs, `concurrency` at once, in index order, each handed its index and its offset in the window. A run
 * starts inline, so its property's synchronous work runs on the fiber that starts it; a concurrent window forks each
 * run's fiber and only then holds it among the fibers an interruption of the search reaches, so each concurrent run
 * starts on a turn of its own, once its fiber is held, and an interruption its own work causes reaches it. A window of
 * one run at a time forks nothing and starts each inline.
 */
const windowOf = <B, R>(
	indices: ReadonlyArray<number>,
	runOne: (index: number, offset: number) => Effect.Effect<B, never, R>,
	concurrency: number
): Effect.Effect<Array<B>, never, R> =>
	concurrency === oneAtATime
		? Effect.forEach(indices, runOne)
		: Effect.forEach(
				indices,
				(index, offset) => Effect.andThen(Effect.yieldNow, runOne(index, offset)),
				{ concurrency }
			)

/**
 * Runs a window's cases (windowOf) and returns each case that ran with its offset in the window, in the order its
 * search settles them: case order, but every case its deadline cut after the rest, so a case that failed before the
 * deadline arrived is reported, shrunk as far as the deadline allows, rather than lost behind a lower case still in
 * flight. No case starts once a lower case of its window has failed or hung: the search settles that case before any
 * case above it and ends there, so no case above it can change what the search finds, and a failing window ends when
 * the cases already running end instead of running every case it has left.
 */
const casesOf = <S, K, R>(
	indices: ReadonlyArray<number>,
	runOne: (index: number, offset: number) => Effect.Effect<CaseRun<S, K>, never, R>,
	concurrency: number
): Effect.Effect<ReadonlyArray<readonly [number, CaseRun<S, K>]>, never, R> =>
	Effect.suspend(() => {
		let failedAt = indices.length
		const started = (index: number, offset: number) =>
			Effect.suspend(() =>
				offset > failedAt
					? Effect.succeedNone
					: Effect.map(runOne(index, offset), (caseRun) => {
							if (caseRun.outcome.kind === "failed" || caseRun.outcome.kind === "hung") {
								failedAt = Math.min(failedAt, offset)
							}
							return Option.some([offset, caseRun] as const)
						})
			)
		return Effect.map(windowOf(indices, started, concurrency), (results) => {
			const settled = Arr.getSomes(results)
			const wasCut = ([, caseRun]: readonly [number, CaseRun<S, K>]) =>
				caseRun.outcome.kind === "cut"
			return [...Arr.filter(settled, (entry) => !wasCut(entry)), ...Arr.filter(settled, wasCut)]
		})
	})

/** How a case's fiber ended, as its run settles it: its own settlement, or a failure of the fiber itself. */
const settledOf = (exit: Exit.Exit<Settled>): Settled =>
	Exit.isSuccess(exit) ? exit.value : { kind: "failed", cause: exit.cause }

/** What the watchdog prints of a case that blocked its process: given the case's sketch, when it was drawn, and its tape. */
type Blocked<S> = (sketch: Option.Option<S>, tape: Tape) => string

/**
 * Runs one case on a recorder from the pool: generates its sketch from the chooser, resolves it, and runs the property
 * in its own scope and fiber, raced against the hang guard and the search's deadline. A case stopped any way, hung, cut
 * or interrupted with the search, is kept among its search's stopped cases (`life`, withCaseLives), whose cleanups the
 * search awaits before it returns, so a case's finalizers always run and none outlives its search. The case's fiber
 * starts inline, so a property that runs to its end synchronously arms no guard and never waits on the event loop;
 * from its start until the race that guards it, the search is uninterruptible, so an interruption of the search that
 * arrives in between, from the case's own synchronous work included, reaches the race and stops the case rather than
 * leaving it running detached. A hung case's cleanup is awaited for HUNG_CLEANUP_GRACE (live.ts) before the search goes
 * on, the rest of it when the search ends; a case the deadline cuts is stopped without waiting on its cleanup until the
 * search ends, so the search reports first; and a case begun once the search is due to stop is cut before its property
 * runs. The property's own draws continue the same tape, so they replay and shrink with
 * the case, and it steers as `under` says. The tape is copied out only for a failed, hung or cut case and for what
 * `keep` asks; the recorder goes back to the pool when the case ends, so a use of the case after that is marked a
 * misuse and never reaches the recorder, which another case may be drawing on. The process's watchdog watches the case
 * from before its sketch is drawn (live.ts watchedCase): a case that holds the main thread without yielding, which the
 * hang guard's timer cannot interrupt, ends the process once it is past its hang limit or its search's cut, whichever
 * comes first, by the watchdog's grace, with `blocked`'s report.
 */
const runCase = <S, T, F extends string, E, R, K>(
	generator: Steered<S, F>,
	resolve: (sketch: S) => T,
	property: (value: T, c: Case<F>) => Effect.Effect<void, E, R>,
	chooser: Chooser,
	pool: Array<Recorder>,
	under: Under<F>,
	caseHang: Duration.Input,
	life: Life,
	keep: (recorded: Recording) => K,
	sense: Sense,
	blocked: Blocked<S>
): Effect.Effect<CaseRun<S, K>, never, Exclude<R, Scope.Scope>> =>
	Effect.suspend(() => {
		const recorded = pool.pop() ?? recorder()
		recorded.reset(chooser)
		let drawnSketch: Option.Option<S> = Option.none()
		return watchedCase(
			{ caseHang, cut: cutMoment(life.cutting) },
			() => blocked(drawnSketch, recorded.tape()),
			runRecorded(
				generator,
				resolve,
				property,
				recorded,
				pool,
				under,
				caseHang,
				life,
				keep,
				sense,
				(sketch) => {
					drawnSketch = Option.some(sketch)
				}
			)
		)
	})

/** One case's run on its recorder, once runCase has it watched: `onDrawn` hears of the sketch as soon as it is drawn. */
const runRecorded = <S, T, F extends string, E, R, K>(
	generator: Steered<S, F>,
	resolve: (sketch: S) => T,
	property: (value: T, c: Case<F>) => Effect.Effect<void, E, R>,
	recorded: Recorder,
	pool: Array<Recorder>,
	under: Under<F>,
	caseHang: Duration.Input,
	life: Life,
	keep: (recorded: Recording) => K,
	sense: Sense,
	onDrawn: (sketch: S) => void
): Effect.Effect<CaseRun<S, K>, never, Exclude<R, Scope.Scope>> =>
	Effect.suspend(() => {
		const sketch = generator(under.steering)(recorded.source)
		onDrawn(sketch)
		const sketchDecisions = recorded.decided()
		const notes = new Set<string>()
		const drew: Array<unknown> = []
		let open = true
		let misused = false
		const record = (key: string) => {
			if (open) {
				notes.add(key)
			} else {
				misused = true
			}
		}
		const c: Case<F> = {
			note: record,
			noteAll: (features) => {
				for (const feature of features) {
					record(feature)
				}
			},
			pair: (first, second) => record(keyOf<F>([first, second])),
			draw: (inner) => {
				if (!open) {
					misused = true
					return inner(recording(simplestChooser).source)
				}
				const value = inner(recorded.source)
				drew.push(value)
				return value
			},
			observe: (decided) => {
				if (!open) {
					misused = true
					return "as-recorded"
				}
				return recorded.source.observe(fnv1a32(decided))
			}
		}
		const finish = (settled: Settled): CaseRun<S, K> => {
			open = false
			const run = {
				sketch,
				sketchDecisions,
				decisions: recorded.decided(),
				overrun: recorded.status() === "overrun",
				drew,
				notes,
				trace: settled.kind === "passed" ? settled.trace : new Uint8Array(0),
				misused: () => misused,
				outcome: outcomeOf(recorded, settled),
				kept: keep(recorded)
			}
			pool.push(recorded)
			return run
		}
		const settled = sense
			.perceive(Effect.scoped(Effect.suspend(() => property(resolve(sketch), c))))
			.pipe(
				Effect.exit,
				Effect.map((exit): Settled =>
					Exit.isSuccess(exit)
						? { kind: "passed", trace: exit.value[1] }
						: { kind: "failed", cause: exit.cause }
				)
			)
		return Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				const began = yield* liveMillis
				const cutting = life.cutting
				if (cutting.kind === "at" && began >= cutting.moment) {
					return finish({ kind: "cut" })
				}
				const running = yield* Effect.forkDetach(settled, { startImmediately: true })
				const ranThrough = running.pollUnsafe()
				if (ranThrough !== undefined) {
					const settledNow = settledOf(ranThrough)
					return finish(settledNow)
				}
				const guards: ReadonlyArray<Effect.Effect<Settled>> = [
					Effect.map(Fiber.await(running), settledOf),
					Effect.as(liveSleepUntil(began + Duration.toMillis(Duration.fromInputUnsafe(caseHang))), {
						kind: "hung"
					} as const),
					...(cutting.kind === "at" ? [Effect.as(cutting.reached, { kind: "cut" } as const)] : [])
				]
				const ended = yield* restore(Effect.raceAllFirst(guards)).pipe(
					Effect.onInterrupt(() => life.stop(running))
				)
				switch (ended.kind) {
					case "hung":
						yield* life.stop(running)
						yield* awaitWithinGrace(running)
						break
					case "cut":
						yield* life.stop(running)
						break
					case "passed":
					case "failed":
						break
				}
				return finish(ended)
			})
		)
	})

const hex = (seed: number) => `0x${Str.padStart(8, "0")((seed >>> 0).toString(16))}`

/** The line a search's failure report opens with: the run's seed, which reproduces it, and where it was drawn. */
const seedLine = (run: Context.Service.Shape<typeof Run>, suite: string, where: string) =>
	`TEST_SEED=${run.seed}${run.source === "fresh" ? " (drawn by this run)" : ""}: ${suite}, ${where}`

/**
 * The report of a case that held its process's main thread without yielding past its hang limit and its watchdog
 * grace, which the watchdog prints as it ends the process: the run's seed, the suite, the case as far as it was drawn, and, when the
 * case has a token (`how` it was drawn; none for a kept case, which replays by value), how to replay it alone.
 */
const blockedIn =
	<S>(
		run: Context.Service.Shape<typeof Run>,
		suite: string,
		literal: (sketch: S) => string,
		caseHang: Duration.Input,
		how: Option.Option<Drawn>
	): Blocked<S> =>
	(sketch, tape) =>
		Arr.join(
			[
				seedLine(run, suite, "a case that blocked its process"),
				`it held the process's main thread without yielding past its hang limit of ${hangOf(caseHang)}, or its search's deadline if that came first, and ${Duration.format(Duration.millis(WATCHDOG_GRACE_MILLIS))} more, so its hang guard could not stop it, and the watchdog ended the process: a hang`,
				`counterexample: ${Option.match(sketch, { onNone: () => "none yet: it hung while its generator drew it", onSome: literal })}`,
				...Option.match(how, {
					onNone: () => [],
					onSome: (drawnUnder) => [
						`replay it alone: TEST_REPLAY='${replayTokenOf(suite, replayCaseOf(drawnUnder, tape))}'`
					]
				})
			],
			"\n"
		)

/** The token of what a case's property drew: its tape's decisions after its sketch's, which a kept case replays. */
const drawsOf = (caseRun: CaseRun<unknown, unknown>, tape: Tape) =>
	tokenOf(
		tape.values.subarray(caseRun.sketchDecisions),
		Math.max(0, tape.length - caseRun.sketchDecisions)
	)

/** The case a replay token names: what it was drawn under, and its tape's values. */
const replayCaseOf = (how: Drawn, tape: Tape): ReplayCase => ({
	drawn: how,
	values: Arr.fromIterable(tape.values.subarray(0, tape.length))
})

/** Whether a case replayed from given draws ran exactly them: none ran out or fell outside its decision's range, and
 * none was left over. What the system decided is observed, so a case may record more decisions than it was given. */
const ranExactly = (caseRun: CaseRun<unknown, unknown>, given: number): boolean =>
	!caseRun.overrun && caseRun.decisions >= given

/** How a stale case's draws differ from what its property now draws. */
const drewInstead = (caseRun: CaseRun<unknown, unknown>, given: number): string =>
	`it gives ${given} decisions, and its property now draws ${caseRun.overrun ? "others than those" : `${caseRun.decisions}`}`

/** The first requirement a token's steering names that a suite of `declared` requirements does not have. */
const undeclaredIn = (how: Drawn, declared: number): Option.Option<number> => {
	switch (how.kind) {
		case "unsteered":
			return Option.none()
		case "steered":
			return Arr.findFirst(how.pending, (place) => place >= declared)
	}
}

/** What a failure report says about one case. */
type Reported = Readonly<{
	literal: string
	draws: string
	drew: ReadonlyArray<unknown>
	notes: ReadonlySet<string>
	cause: Cause.Cause<unknown>
}>

/** The report of a falsified case: the run, where the case came from, the case and its cause, how shrinking went, how
 * to replay it alone, and a kept-case literal ready to paste. */
const falsifiedReport = (
	run: Context.Service.Shape<typeof Run>,
	suite: string,
	where: string,
	reported: Reported,
	shrinking: string,
	replay: Option.Option<ReplayCase>
) =>
	Arr.join(
		[
			seedLine(run, suite, where),
			`counterexample: ${reported.literal}`,
			...(Arr.isReadonlyArrayNonEmpty(reported.drew)
				? [`the property drew: ${Formatter.format(reported.drew)}`]
				: []),
			failureText(reported.cause),
			shrinking,
			...Option.match(replay, {
				onNone: () => [],
				onSome: (replayed) => [`replay it alone: TEST_REPLAY='${replayTokenOf(suite, replayed)}'`]
			}),
			`keep it: { note: "…", sketch: ${reported.literal}, draws: ${Formatter.format(reported.draws)}, reaches: ${Formatter.format(Arr.fromIterable(reported.notes))} }`
		],
		"\n"
	)

/** How a shrink went, as a failure report prints it. */
const shrinkingOf = (shrunk: Shrunk<unknown>): string => {
	switch (shrunk.ended) {
		case "minimal":
			return `shrunk in ${shrunk.candidates} candidates`
		case "budget":
			return `shrunk in ${shrunk.candidates} candidates, cut short by its budget`
		case "deadline":
			return `shrunk in ${shrunk.candidates} candidates, cut short by its test's deadline: the smallest failing case it reached, ${PRINT_MARGIN_MILLIS} ms before the deadline; give the test a longer timeout to shrink it further`
	}
}

/**
 * The failure of a search its test's deadline cut short before any case failed: where it stopped, the case in flight,
 * and how to replay that case alone, when it has a token.
 */
const deadlineReachedIn = (
	run: Context.Service.Shape<typeof Run>,
	suite: string,
	where: string,
	inFlight: string,
	replay: Option.Option<ReplayCase>
) =>
	Effect.fail(
		DeadlineReached.make({
			suite,
			replay,
			message: Arr.join(
				[
					seedLine(run, suite, where),
					`its test's deadline cut the search short here, before any case failed: it stopped ${PRINT_MARGIN_MILLIS} ms before the deadline to report`,
					`the case in flight: ${inFlight}`,
					...Option.match(replay, {
						onNone: () => [],
						onSome: (replayed) => [
							`replay it alone: TEST_REPLAY='${replayTokenOf(suite, replayed)}'`
						]
					}),
					"give the test a longer timeout, or its search fewer cases"
				],
				"\n"
			)
		})
	)

/** How long a case may run, as a failure report prints it. */
const hangOf = (caseHang: Duration.Input): string =>
	Duration.format(Duration.fromInputUnsafe(caseHang))

/** The failure of a case its property used after the case ended. */
const misusedIn = (suite: string, where: string) =>
	Effect.fail(
		CaseMisused.make({
			suite,
			message: `${suite}: ${where} used its case after the case ended`
		})
	)

/** What a failure report says of a case's run, its cause and its draws. */
const reportedOf = <S>(
	literal: (sketch: S) => string,
	caseRun: CaseRun<S, unknown>,
	cause: Cause.Cause<unknown>,
	draws: string
): Reported => ({
	literal: literal(caseRun.sketch),
	draws,
	drew: caseRun.drew,
	notes: caseRun.notes,
	cause
})

/** What the replay of one case needs of its search: how its cases are drawn and printed, and what it requires. */
type Replaying<S, T, F extends string> = Readonly<{
	suite: string
	generator: Steered<S, F>
	resolve: (sketch: S) => T
	literal: (sketch: S) => string
	situations: ReadonlyArray<Reached<F>>
	caseHang: Duration.Input
}>

/**
 * Runs the one case a replay token names, under the steering the token records, in place of every stream: a failure
 * is reported as given, unshrunk, with its token again; a pass that ran exactly its draws is `passed`; a case that no
 * longer runs as its token says, or steers by a requirement the suite no longer declares, is ReplayStale.
 */
const replayOne = <S, T, F extends string, E, R, A>(
	search: Replaying<S, T, F>,
	run: Context.Service.Shape<typeof Run>,
	life: Life,
	property: (value: T, c: Case<F>) => Effect.Effect<void, E, R>,
	replayed: ReplayCase,
	passed: () => A
): Effect.Effect<A, SearchFailure, Exclude<R, Scope.Scope>> =>
	Effect.gen(function* () {
		const undeclared = undeclaredIn(replayed.drawn, search.situations.length)
		if (Option.isSome(undeclared)) {
			return yield* ReplayStale.make({
				suite: search.suite,
				message: `${search.suite}: the token steers by requirement ${undeclared.value}, and the suite declares ${search.situations.length}; replay it from a fresh failure`
			})
		}
		const values = Float64Array.from(replayed.values)
		const caseRun = yield* runCase(
			search.generator,
			search.resolve,
			property,
			forcedChooser(values, values.length),
			[],
			underOf(search.situations, replayed.drawn),
			search.caseHang,
			life,
			keepNothing,
			notesOnly,
			blockedIn(run, search.suite, search.literal, search.caseHang, Option.some(replayed.drawn))
		)
		const where = "the replayed case"
		return yield* judge<Effect.Effect<A, SearchFailure>>(caseRun, {
			passed: () =>
				ranExactly(caseRun, values.length)
					? Effect.sync(passed)
					: Effect.fail(
							ReplayStale.make({
								suite: search.suite,
								message: `${search.suite}: ${where} passed, but not as its token says: ${drewInstead(caseRun, values.length)}; replay it from a fresh failure`
							})
						),
			misused: () => misusedIn(search.suite, where),
			hung: (hung) =>
				Effect.fail(
					CaseHung.make({
						suite: search.suite,
						replay: Option.some(replayCaseOf(replayed.drawn, hung.tape)),
						message: `${search.suite}: ${where} ran past ${hangOf(search.caseHang)}: ${search.literal(caseRun.sketch)}`
					})
				),
			cut: (cut) =>
				deadlineReachedIn(
					run,
					search.suite,
					where,
					search.literal(caseRun.sketch),
					Option.some(replayCaseOf(replayed.drawn, cut.tape))
				),
			failed: (failed) => {
				const again = Option.some(replayCaseOf(replayed.drawn, failed.tape))
				return Effect.fail(
					PropertyFalsified.make({
						suite: search.suite,
						phase: "replayed",
						shrink: "unshrunk",
						replay: again,
						message: falsifiedReport(
							run,
							search.suite,
							where,
							reportedOf(search.literal, caseRun, failed.cause, drawsOf(caseRun, failed.tape)),
							"replayed as given, not shrunk",
							again
						)
					})
				)
			}
		})
	})

/**
 * What a passing exploration found: its cases, how many cases its steered phase ran, the residual
 * estimate of its independent cases, how many of them reached each feature its coverage rates (features.ts rating),
 * and the oracle it states. A replay's has its one case: it runs no stream.
 */
export type Explored = Readonly<{
	kind: "explored"
	suite: string
	cases: number
	steered: number
	residual: Residual
	rates: ReadonlyArray<Rate>
	oracle: Oracle
}>

/** A line on the process's own console, whatever console the case runs under: a fuzz run reports to the person
 * running it, as `go test -fuzz` does, past a test's captured console. */
const liveLog = (line: string) =>
	Console.log(line).pipe(Effect.provideService(Console.Console, Console.Console.defaultValue()))

/** A report on the process's own error console, whatever console the search runs under. */
const liveReport = (report: string) =>
	Console.error(report).pipe(Effect.provideService(Console.Console, Console.Console.defaultValue()))

/** How often a fuzz run reports its progress, in milliseconds of wall time: fuzzStatusEveryMillis. */
const STATUS_EVERY = fuzzStatusEveryMillis

/** Whether a fuzz run has spent its budget, after `cases` cases and `elapsed` milliseconds. */
const spent = (budget: FuzzBudget, cases: number, elapsed: number): boolean => {
	switch (budget.kind) {
		case "until-failure":
			return false
		case "cases":
			return cases >= budget.cases
		case "time":
			return elapsed >= Duration.toMillis(budget.duration)
	}
}

const describeBudget = (budget: FuzzBudget): string => {
	switch (budget.kind) {
		case "until-failure":
			return "until a case fails"
		case "cases":
			return `for ${budget.cases} cases`
		case "time":
			return `for ${Duration.format(budget.duration)}`
	}
}

/** One steered case in this many is a fresh draw rather than a mutant of a seed. */
const FRESH_EVERY = 4

/** How a fuzz run's corpus replay went: the cases it replayed, and how many of them it dropped. */
type CorpusReplay = Readonly<{ replayed: number; dropped: number }>

/**
 * Replays a fuzz run's corpus, shortest first, and minimizes it as it goes: `contributes` replays one case and says
 * whether it added a situation or a class of a range nothing before it had, and every case that did not is dropped
 * from the corpus. The loaded tapes are let go once they are replayed; what a fuzz run keeps of them is its seeds.
 */
const replayCorpus = <X, R>(
	corpus: Corpus,
	contributes: (values: Float64Array, index: number) => Effect.Effect<boolean, X, R>
): Effect.Effect<CorpusReplay, X, R> =>
	Effect.gen(function* () {
		const loaded = yield* corpus.load
		let dropped = 0
		for (const [index, values] of loaded.entries()) {
			if (!(yield* contributes(values, index))) {
				dropped += 1
				yield* corpus.drop(values, values.length)
			}
		}
		return { replayed: loaded.length, dropped }
	})

/**
 * A search of mutants grown from kept seeds: the steered phase, a witness on the stream the floor's seed fixes, or a
 * fuzz run, on a stream the run's seed draws. The variant ties the stream's kind to the tally its cases fill, so a
 * witness phase is never drawn from the run's seed.
 */
type Mutated =
	| Readonly<{
			phase: "steered"
			stream: LabelStream
			tally: TallyBuilder<"steered">
			turns: Turns
	  }>
	| Readonly<{ phase: "fuzzed"; stream: RunStream; tally: TallyBuilder<"fuzzed">; turns: Turns }>

/** Where a mutated case came from, as a failure report names it. */
const mutatedLabel = (mutated: Mutated): string => {
	switch (mutated.phase) {
		case "steered":
			return "the steered phase"
		case "fuzzed":
			return "the fuzz run"
	}
}

/** What a fuzz run perceives: the steered phase's sense, or the notes alone for a search that requires nothing. */
const fuzzSenseOf = <F extends string>(coverage: Coverage<F>): Sense => {
	switch (coverage.kind) {
		case "none":
			return notesOnly
		case "required":
			return coverage.steered.sense
	}
}

/**
 * Searches a property: kept cases first; then the witnesses, the floor stream and, for a search that requires
 * situations, the steered phase grown from it, both fixed by the suite's label; then the rotating stream, fresh each
 * run. Cases run in windows of `steerEvery`, up to `concurrency` at once; each window's results are taken in case
 * order, so concurrency changes how fast a search runs and never what it finds. A failing case, the lowest of its
 * window, is shrunk by editing its tape, property draws included, under the steering it was drawn under. The run's
 * deadline bounds every phase and the shrink (Deadline), and a case it cuts is settled after the rest of its window
 * (casesOf). The stall
 * verdict is judged on the floor stream, and the coverage verdict on the witnesses alone, before the rotating stream
 * runs: neither moves with the run's seed, and a coverage failure spends no sample. The residual comes from the
 * rotating stream's independent cases alone. A replay runs its one case instead; a fuzz run searches its run-seeded
 * stream after the floor, in place of the rest.
 */
export const explore = <S, T, F extends string, E, R>(
	spec: Exploration<S, T, F>,
	property: (value: T, c: Case<F>) => Effect.Effect<void, E, R>
): Effect.Effect<Explored, SearchFailure, Run | Exclude<R, Scope.Scope>> =>
	withCaseLives((run, life) =>
		Effect.gen(function* () {
			const situations = situationsOf(spec.coverage)
			const concurrency = spec.concurrency ?? oneAtATime
			const replay = Option.filter(run.replay, (requested) => requested.suite === spec.suite)
			if (Option.isSome(replay)) {
				return yield* replayOne(
					{
						suite: spec.suite,
						generator: spec.draw.generator,
						resolve: spec.draw.resolve,
						literal: spec.literal,
						situations,
						caseHang: spec.caseHang
					},
					run,
					life,
					property,
					replay.value.replayed,
					(): Explored => ({
						kind: "explored",
						suite: spec.suite,
						cases: 1,
						steered: 0,
						residual: residualOf(tallyOf("independent").tally()),
						rates: ratesOf(spec.coverage, tallyOf("independent").tally()),
						oracle: spec.oracle
					})
				)
			}

			const floorTally = tallyOf("floor")
			const steeredTally = tallyOf("steered")
			const independentTally = tallyOf("independent")
			const fuzzedTally = tallyOf("fuzzed")
			const pool: Array<Recorder> = []
			const hang = hangOf(spec.caseHang)
			const unsteered = underOf(situations, { kind: "unsteered" })
			let cases = 0
			const blockedUnder = (under: Under<F>) =>
				blockedIn(run, spec.suite, spec.literal, spec.caseHang, Option.some(under.drawn))
			const caseOf = (chooser: Chooser, under: Under<F>) =>
				runCase(
					spec.draw.generator,
					spec.draw.resolve,
					property,
					chooser,
					pool,
					under,
					spec.caseHang,
					life,
					keepNothing,
					notesOnly,
					blockedUnder(under)
				)
			const seedOf = (chooser: Chooser, under: Under<F>, sense: Sense) =>
				runCase(
					spec.draw.generator,
					spec.draw.resolve,
					property,
					chooser,
					pool,
					under,
					spec.caseHang,
					life,
					keepTape,
					sense,
					blockedUnder(under)
				)
			const candidateOf = (values: Float64Array, under: Under<F>) =>
				runCase(
					spec.draw.generator,
					spec.draw.resolve,
					property,
					forcedChooser(values, values.length),
					pool,
					under,
					spec.caseHang,
					life,
					keepTape,
					notesOnly,
					blockedUnder(under)
				)
			const explored = (): Explored => ({
				kind: "explored",
				suite: spec.suite,
				cases,
				steered: steeredTally.tally().cases,
				residual: residualOf(independentTally.tally()),
				rates: ratesOf(spec.coverage, independentTally.tally()),
				oracle: spec.oracle
			})

			for (const kept of spec.kept) {
				const draws = valuesFromToken(kept.draws)
				const keptRun = yield* runCase(
					() => () => kept.sketch,
					spec.draw.resolve,
					property,
					forcedChooser(draws, draws.length),
					pool,
					unsteered,
					spec.caseHang,
					life,
					keepNothing,
					notesOnly,
					blockedIn(run, spec.suite, spec.literal, spec.caseHang, Option.none())
				)
				const where = `the kept case "${kept.note}"`
				yield* judge<Effect.Effect<void, SearchFailure>>(keptRun, {
					passed: () => {
						if (!ranExactly(keptRun, draws.length)) {
							return Effect.fail(
								KeptStale.make({
									suite: spec.suite,
									note: kept.note,
									message: `${spec.suite}: ${where} no longer runs as kept: ${drewInstead(keptRun, draws.length)}; replay it from a fresh failure and keep that`
								})
							)
						}
						const missing = Arr.filter(kept.reaches, (feature) => !keptRun.notes.has(feature))
						return Arr.isReadonlyArrayNonEmpty(missing)
							? Effect.fail(
									KeptUnreached.make({
										suite: spec.suite,
										note: kept.note,
										missing,
										message: `${spec.suite}: ${where} no longer reaches ${Arr.join(missing, ", ")}`
									})
								)
							: Effect.void
					},
					misused: () => misusedIn(spec.suite, where),
					hung: () =>
						Effect.fail(
							CaseHung.make({
								suite: spec.suite,
								replay: Option.none(),
								message: `${spec.suite}: ${where} ran past ${hang}`
							})
						),
					cut: () =>
						deadlineReachedIn(run, spec.suite, where, spec.literal(kept.sketch), Option.none()),
					failed: (failed) =>
						Effect.fail(
							PropertyFalsified.make({
								suite: spec.suite,
								phase: "kept",
								shrink: "unshrunk",
								replay: Option.none(),
								message: falsifiedReport(
									run,
									spec.suite,
									where,
									reportedOf(spec.literal, keptRun, failed.cause, kept.draws),
									"kept cases are never shrunk",
									Option.none()
								)
							})
						)
				})
			}

			const floor = floorSeed(spec.suite)
			const seeds = seedsOf()

			/** Judges one case of a phase: a pass counts in its phase's tally, a failure is
			 * shrunk under the steering the case was drawn under, as far as the deadline allows, and reported with its phase
			 * and its replay token, and a hang or a cut is reported as drawn. */
			const settle = <K>(
				caseRun: CaseRun<S, K>,
				where: string,
				under: Under<F>,
				tally: TallyBuilder<Phase>
			) =>
				judge<Effect.Effect<void, SearchFailure, Exclude<R, Scope.Scope>>>(caseRun, {
					passed: () =>
						Effect.sync(() => {
							cases += 1
							tally.add(caseRun.notes)
						}),
					misused: () => misusedIn(spec.suite, where),
					hung: (hung) => {
						const replayed = replayCaseOf(under.drawn, hung.tape)
						return Effect.fail(
							CaseHung.make({
								suite: spec.suite,
								replay: Option.some(replayed),
								message: `${spec.suite}: ${where} ran past ${hang}: counterexample ${spec.literal(caseRun.sketch)}, replay it alone: TEST_REPLAY='${replayTokenOf(spec.suite, replayed)}'`
							})
						)
					},
					cut: (cut) =>
						deadlineReachedIn(
							run,
							spec.suite,
							where,
							spec.literal(caseRun.sketch),
							Option.some(replayCaseOf(under.drawn, cut.tape))
						),
					failed: (failed) =>
						Effect.flatMap(
							shrinkAttempt(
								{ tape: failed.tape, failure: { run: caseRun, cause: failed.cause } },
								(values) =>
									Effect.map(candidateOf(values, under), (candidate) =>
										judge(candidate, candidateJudgment(candidate))
									),
								spec.shrink
							),
							(shrunk) => {
								const best = shrunk.best.failure.run
								const replayed = Option.some(replayCaseOf(under.drawn, shrunk.best.tape))
								return Effect.fail(
									PropertyFalsified.make({
										suite: spec.suite,
										phase: tally.phase,
										shrink: shrunk.ended,
										replay: replayed,
										message: falsifiedReport(
											run,
											spec.suite,
											where,
											reportedOf(
												spec.literal,
												best,
												shrunk.best.failure.cause,
												drawsOf(best, shrunk.best.tape)
											),
											shrinkingOf(shrunk),
											replayed
										)
									})
								)
							}
						)
				})

			/** Keeps a passing case as a seed when it noted or perceived something no earlier case had. */
			const keepIfNew = (caseRun: CaseRun<S, Tape>) =>
				seeds.keep(caseRun.kept, caseRun.notes, caseRun.trace)

			/**
			 * One window of mutated cases from the seeds kept so far, each a mutant of a seed, but one in `FRESH_EVERY` a fresh
			 * draw, so a phase whose seeds sit far from what is missing still finds it as often as plain draws would; each
			 * steers by, and picks its seed by, the floor's tally and its own phase's; `found` sees each case that found
			 * something new.
			 */
			const mutatedWindow = <X>(
				mutated: Mutated,
				indices: ReadonlyArray<number>,
				sense: Sense,
				found: (caseRun: CaseRun<S, Tape>) => Effect.Effect<void, X>
			) =>
				Effect.gen(function* () {
					const steering = [floorTally.tally(), mutated.tally.tally()]
					const underAt = steeredBy(situations, steering, mutated.turns, indices.length)
					const pick = seeds.picker(steering)
					const window = yield* casesOf(
						indices,
						(index, offset) => {
							const words = wordsOf(caseSeed(mutated.stream, index))
							const chooser = Option.match(
								between(words, 0, FRESH_EVERY - 1) === 0 ? Option.none() : pick(words),
								{
									onNone: () => randomChooser(words),
									onSome: ([seed, donor]) => {
										const mutant = mutate(seed, Option.some(donor), words)
										return prefixChooser(mutant.values, mutant.length, randomChooser(words))
									}
								}
							)
							return seedOf(chooser, underAt(offset), sense)
						},
						sense.concurrent ? concurrency : oneAtATime
					)
					for (const [offset, caseRun] of window) {
						const where = `${mutatedLabel(mutated)} (seed ${hex(mutated.stream)}), case ${Arr.getUnsafe(indices, offset)}`
						yield* settle(caseRun, where, underAt(offset), mutated.tally)
						if (keepIfNew(caseRun)) {
							yield* found(caseRun)
						}
					}
				})

			const fuzzing = Option.filter(run.fuzz, (fuzz) => fuzz.suite === spec.suite)
			const floorCases = Math.max(1, Math.ceil(spec.runs / 4))

			/** The floor stream, its cases run by `runOne` and each passing case handed to `passed`. */
			const floorStream = <K>(
				runOne: (
					chooser: Chooser,
					under: Under<F>
				) => Effect.Effect<CaseRun<S, K>, never, Exclude<R, Scope.Scope>>,
				passed: (caseRun: CaseRun<S, K>) => void
			) =>
				Effect.gen(function* () {
					const floorTurns = turnsOf()
					for (let windowStart = 0; windowStart < floorCases; windowStart += spec.steerEvery) {
						const indices = Array.from(
							{ length: Math.min(windowStart + spec.steerEvery, floorCases) - windowStart },
							(_, i) => windowStart + i
						)
						const underAt = steeredBy(situations, [floorTally.tally()], floorTurns, indices.length)
						const window = yield* casesOf(
							indices,
							(index, offset) =>
								runOne(randomChooser(wordsOf(caseSeed(floor, index))), underAt(offset)),
							concurrency
						)
						for (const [offset, caseRun] of window) {
							const where = `the floor stream (seed ${hex(floor)}), case ${windowStart + offset}`
							yield* settle(caseRun, where, underAt(offset), floorTally)
							passed(caseRun)
						}
					}
				})

			if (spec.coverage.kind === "required" || Option.isSome(fuzzing)) {
				yield* floorStream((chooser, under) => seedOf(chooser, under, notesOnly), keepIfNew)
			} else {
				yield* floorStream(caseOf, () => undefined)
			}

			if (Option.isSome(fuzzing)) {
				const fuzz = fuzzing.value
				const fuzzed: Mutated = {
					phase: "fuzzed",
					stream: fuzzSeed(rotatingSeed(run.seed, floor)),
					tally: fuzzedTally,
					turns: turnsOf()
				}
				const sense = fuzzSenseOf(spec.coverage)
				const replayed = yield* replayCorpus(fuzz.corpus, (values, index) =>
					Effect.gen(function* () {
						const under = steeredBy(
							situations,
							[floorTally.tally(), fuzzedTally.tally()],
							fuzzed.turns,
							1
						)(0)
						const caseRun = yield* seedOf(
							prefixChooser(
								values,
								values.length,
								randomChooser(wordsOf(caseSeed(fuzzed.stream, -1 - index)))
							),
							under,
							sense
						)
						yield* settle(caseRun, `the corpus's case ${index}`, under, fuzzedTally)
						return keepIfNew(caseRun)
					})
				)
				const started = yield* liveMillis
				let reported = started
				let found = 0
				let fuzzedCases = 0
				const status = (now: number) =>
					liveLog(
						`fuzz: ${spec.suite}: elapsed: ${Math.round((now - started) / 1000)}s, execs: ${fuzzedCases} (${Math.round((fuzzedCases * 1000) / Math.max(1, now - started))}/sec), new interesting: ${found} (total: ${seeds.size()})`
					)
				yield* liveLog(
					`fuzz: ${spec.suite}: ${replayed.replayed} cases of the corpus replayed, ${replayed.dropped} of them dropped as adding nothing, ${seeds.size()} seeds, fuzzing ${describeBudget(fuzz.budget)}`
				)
				const save = (values: Float64Array) => fuzz.corpus.save(values, values.length)
				yield* Effect.gen(function* () {
					for (;;) {
						const now = yield* liveMillis
						if (spent(fuzz.budget, fuzzedCases, now - started)) {
							return yield* status(now)
						}
						if (now - reported >= STATUS_EVERY) {
							reported = now
							yield* status(now)
						}
						const indices = Array.from({ length: spec.steerEvery }, (_, i) => fuzzedCases + i)
						fuzzedCases += indices.length
						yield* mutatedWindow(fuzzed, indices, sense, (caseRun) => {
							found += 1
							return Effect.andThen(
								save(caseRun.kept.values),
								liveLog(
									`fuzz: ${spec.suite}: new interesting case ${fuzzedCases}, ${seeds.size()} seeds`
								)
							)
						})
					}
				}).pipe(
					Effect.tapError((failure) =>
						failure._tag === "PropertyFalsified" || failure._tag === "CaseHung"
							? Option.match(failure.replay, {
									onNone: () => Effect.void,
									onSome: (failing) => save(Float64Array.from(failing.values))
								})
							: Effect.void
					)
				)
				return explored()
			}

			switch (spec.coverage.kind) {
				case "none":
					break
				case "required": {
					const { situations: requiredSituations, steered: steeredPhase } = spec.coverage
					const steering: Mutated = {
						phase: "steered",
						stream: steeredSeed(floor),
						tally: steeredTally,
						turns: turnsOf()
					}
					const witnessed = () => [floorTally.tally(), steeredTally.tally()]
					for (
						let windowStart = 0;
						windowStart < steeredPhase.cases &&
						Arr.isReadonlyArrayNonEmpty(unreachedOf(requiredSituations, witnessed()));
						windowStart += spec.steerEvery
					) {
						yield* mutatedWindow(
							steering,
							Array.from(
								{
									length: Math.min(windowStart + spec.steerEvery, steeredPhase.cases) - windowStart
								},
								(_, i) => windowStart + i
							),
							steeredPhase.sense,
							() => Effect.void
						)
					}
					const missing = unreachedOf(requiredSituations, witnessed())
					if (Arr.isReadonlyArrayNonEmpty(missing)) {
						const floorCount = floorTally.tally().cases
						const steeredCount = steeredTally.tally().cases
						return yield* FeaturesUnreached.make({
							suite: spec.suite,
							missing,
							witnessed: { kind: "streams", floor: floorCount, steered: steeredCount },
							message: `${spec.suite}: no case of its ${floorCount} floor cases or ${steeredCount} steered cases reached ${Arr.join(missing, ", ")}; both streams are fixed by the suite's label, so every run seed fails alike. A kept case and a rotating case never count: give the generator an arm that reaches it, aim the generator at what is pending (aimed, steered), or give the steered phase more cases`
						})
					}
					break
				}
			}

			const rotating = rotatingSeed(run.seed, floor)
			for (let windowStart = 0; windowStart < spec.runs; windowStart += spec.steerEvery) {
				const indices = Array.from(
					{ length: Math.min(windowStart + spec.steerEvery, spec.runs) - windowStart },
					(_, i) => windowStart + i
				)
				const window = yield* casesOf(
					indices,
					(index) => caseOf(randomChooser(wordsOf(caseSeed(rotating, index))), unsteered),
					concurrency
				)
				for (const [offset, caseRun] of window) {
					yield* settle(
						caseRun,
						`the rotating stream (seed ${hex(rotating)}), case ${windowStart + offset}`,
						unsteered,
						independentTally
					)
				}
			}
			return explored()
		})
	)

/**
 * The size of an exhaustion's space, counted before any case runs and raced against its test's deadline: a count the
 * deadline cuts fails the exhaustion, naming the space, since a space too large to count is too large to exhaust.
 */
const spaceCounted = (
	run: Context.Service.Shape<typeof Run>,
	cutting: Cutting,
	suite: string,
	generator: Gen<unknown>
): Effect.Effect<number, DeadlineReached> =>
	cutting.kind === "unbounded"
		? sizeOf(generator)
		: Effect.raceFirst(
				sizeOf(generator),
				Effect.andThen(
					cutting.reached,
					deadlineReachedIn(
						run,
						suite,
						"counting the exhaustive space",
						"none: the space was still being counted, too large to finish before the deadline; exhaust a smaller space the generator constructs, or sample this one with explore",
						Option.none()
					)
				)
			)

/**
 * One sketch of an exhaustion's space: the branch its cases start at, a case of the generator alone, and how many
 * decisions the generator draws there. Every decision past them is its property's, so the cases its property's draws
 * enumerate from the start are its own, and the first branch that changes a decision of the generator's is the next
 * sketch's start.
 */
type Sketch = Readonly<{ start: Branch; decisions: number }>

/** What one sketch's run found: each case that passed, its notes in order, and the first case that did not, if any. */
type SketchRan<A> = Readonly<{
	passed: ReadonlyArray<ReadonlySet<string>>
	stopped: Option.Option<CaseRun<A, Tape>>
}>

/**
 * An exhaustive check: every case of a generator's space, whatever its size, the whole space or a failure. `literal`
 * prints a case as source, as an exploration's does; `coverage` is what the space must reach, judged on every case of it; `box` names the space in
 * words, the bound a pass proves the property within ("every family of size ≤ 4 under every single mutation"); and
 * `oracle` is what the property is checked against. The report prints both. `concurrency` is how many sketches run at
 * once, a sketch being one case of the generator alone with every case its property's draws enumerate from it, one at
 * a time where the suite leaves it out (oneAtATime), as cases that share state the property does not isolate run.
 */
export type Exhaustion<A, F extends string> = Readonly<{
	suite: string
	generator: Gen<A>
	literal: (value: A) => string
	coverage: SpaceCoverage<F>
	caseHang: Duration.Input
	box: Box
	oracle: Oracle
	concurrency?: number
}>

/**
 * The bound an exhaustion's pass proves its property within, in words ("every family of size ≤ 4 under every single
 * mutation"), or `unstated`, an exhaustion that has not yet said, which its report prints as such.
 */
export type Box = string | Readonly<{ kind: "unstated" }>

/**
 * What a passing exhaustion checked: every case of its space, the box it names and the oracle it states. A replay's has its one case.
 */
export type Exhausted = Readonly<{
	kind: "exhausted"
	suite: string
	cases: number
	box: Box
	oracle: Oracle
}>

/**
 * Checks a property on every case of a bounded generator, in enumeration order, and shrinks the first case that fails
 * by editing its tape, property draws included, for at most as many candidates as the space holds cases: enumeration is
 * lexicographic over decisions and shrinking descends shortlex order, so a later case with fewer decisions may be less
 * than the first failure, and the shrink moves toward it, while a space of one shape needs no candidate. Its replay
 * token runs the shrunk case alone. The space is counted before any property runs (sizeOf), and draws the property
 * makes are enumerated too, so a case's successor among them depends on it. The space is run by sketches (Sketch), in
 * windows of up to `concurrency` sketches at once, each sketch's cases one at a time; a window's results are taken in
 * enumeration order, every case its deadline cut after the rest (as an exploration's window settles them), so
 * concurrency changes how fast an exhaustion runs and never what it finds, the first failing case in enumeration
 * order. Nothing caps an exhaustion: its test's deadline is its only end, and a count or a run the deadline cuts fails,
 * naming the space, so a space too large to finish is a failure, never a pass over part of it; a suite whose space
 * cannot finish exhausts a smaller space it constructs, or samples it with explore under a budget it names. Nothing
 * steers an exhaustion: every case of the space runs, the property's draws enumerated with it, so a case aimed at a
 * requirement is one the box holds already. Every case of the space is a witness, fixed by the generator alone, so every
 * requirement must be reached by one of them, and the verdict is the same on every run seed. Passing is a proof inside
 * the box the generator draws.
 */
export const exhaust = <A, F extends string, E, R>(
	spec: Exhaustion<A, F>,
	property: (value: A, c: Case<F>) => Effect.Effect<void, E, R>
): Effect.Effect<Exhausted, SearchFailure, Run | Exclude<R, Scope.Scope>> =>
	withCaseLives((run, life) =>
		Effect.gen(function* () {
			const situations = situationsOf(spec.coverage)
			const concurrency = spec.concurrency ?? oneAtATime
			const generator = () => spec.generator
			const exhaustedOf = (cases: number): Exhausted => ({
				kind: "exhausted",
				suite: spec.suite,
				cases,
				box: spec.box,
				oracle: spec.oracle
			})
			const replay = Option.filter(run.replay, (requested) => requested.suite === spec.suite)
			if (Option.isSome(replay)) {
				return yield* replayOne(
					{
						suite: spec.suite,
						generator,
						resolve: (value: A) => value,
						literal: spec.literal,
						situations,
						caseHang: spec.caseHang
					},
					run,
					life,
					property,
					replay.value.replayed,
					(): Exhausted => exhaustedOf(1)
				)
			}
			const size = yield* spaceCounted(run, life.cutting, spec.suite, spec.generator)
			const exhaustive = tallyOf("exhaustive")
			const unsteered = underOf(situations, { kind: "unsteered" })
			const pool: Array<Recorder> = []
			const hang = hangOf(spec.caseHang)
			const blocked = blockedIn(
				run,
				spec.suite,
				spec.literal,
				spec.caseHang,
				Option.some(unsteered.drawn)
			)
			const caseAt = (at: Branch) =>
				runCase(
					generator,
					(value: A) => value,
					property,
					prefixChooser(at.values, at.length, simplestChooser),
					pool,
					unsteered,
					spec.caseHang,
					life,
					keepTape,
					notesOnly,
					blocked
				)

			const candidateOf = (values: Float64Array) =>
				runCase(
					generator,
					(value: A) => value,
					property,
					forcedChooser(values, values.length),
					pool,
					unsteered,
					spec.caseHang,
					life,
					keepTape,
					notesOnly,
					blocked
				)

			/** A sketch's cases from its start, through its first case that did not pass or its last. */
			const sketchRun = (
				sketch: Sketch
			): Effect.Effect<SketchRan<A>, never, Exclude<R, Scope.Scope>> =>
				Effect.gen(function* () {
					const passed: Array<ReadonlySet<string>> = []
					let branch: Option.Option<Branch> = Option.some(sketch.start)
					while (Option.isSome(branch)) {
						const caseRun = yield* caseAt(branch.value)
						if (judgedOf(caseRun).kind !== "passed") {
							return { passed, stopped: Option.some(caseRun) }
						}
						passed.push(caseRun.notes)
						branch = Option.filter(
							nextBranch(caseRun.kept),
							(after) => after.length > sketch.decisions
						)
					}
					return { passed, stopped: Option.none() }
				})

			const sketches = recorder()
			let next: Option.Option<Branch> = Option.some(firstBranch)
			let cases = 0
			while (Option.isSome(next)) {
				const window: Array<Sketch> = []
				while (Option.isSome(next) && (window.length === 0 || window.length < concurrency)) {
					const step: Enumerated<A> = enumerated(sketches, spec.generator, next.value)
					window.push({ start: next.value, decisions: step.generated.tape.length })
					next = step.next
				}
				const ran = yield* windowOf(
					Arr.map(window, (_, index) => index),
					(index) => sketchRun(Arr.getUnsafe(window, index)),
					concurrency
				)
				const stops: Array<CaseRun<A, Tape>> = []
				for (const sketchRan of ran) {
					for (const notes of sketchRan.passed) {
						cases += 1
						exhaustive.add(notes)
					}
					if (Option.isSome(sketchRan.stopped)) {
						stops.push(sketchRan.stopped.value)
						if (sketchRan.stopped.value.outcome.kind !== "cut") {
							break
						}
					}
				}
				const settling = [
					...Arr.filter(stops, (stop) => stop.outcome.kind !== "cut"),
					...Arr.filter(stops, (stop) => stop.outcome.kind === "cut")
				]
				for (const caseRun of settling) {
					const where = `case ${cases} of the exhaustive space of ${size} cases`
					yield* judge<Effect.Effect<void, SearchFailure, Exclude<R, Scope.Scope>>>(caseRun, {
						passed: () =>
							Effect.sync(() => {
								cases += 1
								exhaustive.add(caseRun.notes)
							}),
						misused: () => misusedIn(spec.suite, where),
						hung: (hung) => {
							const replayed = replayCaseOf(unsteered.drawn, hung.tape)
							return Effect.fail(
								CaseHung.make({
									suite: spec.suite,
									replay: Option.some(replayed),
									message: `${spec.suite}: ${where} ran past ${hang}: counterexample ${spec.literal(caseRun.sketch)}, replay it alone: TEST_REPLAY='${replayTokenOf(spec.suite, replayed)}'`
								})
							)
						},
						cut: (cut) =>
							deadlineReachedIn(
								run,
								spec.suite,
								where,
								spec.literal(caseRun.sketch),
								Option.some(replayCaseOf(unsteered.drawn, cut.tape))
							),
						failed: (failed) =>
							Effect.flatMap(
								shrinkAttempt(
									{ tape: failed.tape, failure: { run: caseRun, cause: failed.cause } },
									(values) =>
										Effect.map(candidateOf(values), (candidate) =>
											judge(candidate, candidateJudgment(candidate))
										),
									boundedShrink(size)
								),
								(shrunk) => {
									const best = shrunk.best.failure.run
									const replayed = Option.some(replayCaseOf(unsteered.drawn, shrunk.best.tape))
									return Effect.fail(
										PropertyFalsified.make({
											suite: spec.suite,
											phase: "exhaustive",
											shrink: shrunk.ended,
											replay: replayed,
											message: falsifiedReport(
												run,
												spec.suite,
												where,
												reportedOf(
													spec.literal,
													best,
													shrunk.best.failure.cause,
													drawsOf(best, shrunk.best.tape)
												),
												shrinkingOf(shrunk),
												replayed
											)
										})
									)
								}
							)
					})
				}
			}
			switch (spec.coverage.kind) {
				case "none":
					return exhaustedOf(cases)
				case "required": {
					const missing = unreachedOf(spec.coverage.situations, [exhaustive.tally()])
					if (Arr.isReadonlyArrayNonEmpty(missing)) {
						return yield* FeaturesUnreached.make({
							suite: spec.suite,
							missing,
							witnessed: { kind: "space", cases },
							message: `${spec.suite}: no case of the space's ${cases} cases reached ${Arr.join(missing, ", ")}`
						})
					}
					return exhaustedOf(cases)
				}
			}
		})
	)
