import { Array as Arr, Effect, Formatter, Option, Schema, Struct } from "effect"
import type { Aimed, Gen, Size, Steered, Weight } from "#gen.ts"
import type {
	Case,
	CheckContext,
	ExploreSpec,
	ExploreStated,
	Needs,
	Resources,
	Space
} from "#property.ts"
import { type Source, weightsOf } from "#source.ts"
import { type Swarm, weightOf } from "#swarm.ts"

/** The model accepts a step, and predicts the state the system enters after it. */
export type Accepted<M> = Readonly<{ kind: "accepted"; next: M }>

/** The model refuses a step, by a refusal of its own closed vocabulary, and the system must refuse it the same way. */
export type Refused<V extends string> = Readonly<{ kind: "refused"; refusal: V }>

/**
 * What a model predicts of one step: accepted, with the state after it, or refused, with the refusal the system must
 * answer. A refused step leaves the model's state as it was, and the system's must stay as it was too.
 */
export type Verdict<M, V extends string> = Accepted<M> | Refused<V>

/** The system accepted a step: what a real step answers when it took it. */
export type Took = Readonly<{ kind: "accepted" }>

/** What the real system answered one step: it took it, or refused it with a refusal of the model's vocabulary. */
export type Answer<V extends string> = Took | Refused<V>

/** The model accepts the step and predicts `next`. */
export const accepted = <M>(next: M): Accepted<M> => ({ kind: "accepted", next })

/** The model refuses the step, or the system answered it, by `refusal`. */
export const refused = <V extends string>(refusal: V): Refused<V> => ({ kind: "refused", refusal })

/** The answer of a real step the system took. */
export const took: Took = { kind: "accepted" }

/** The judge of a command its model never refuses: every step accepted, with the state `next` predicts after it. */
export const accepting =
	<M, P>(next: (model: M, parameters: P) => M) =>
	(model: M, parameters: P): Accepted<M> =>
		accepted(next(model, parameters))

/**
 * One command of a state machine, judged by its model alone:
 * - `weight` is how often a program draws it, against the other commands its swarm turns on;
 * - `applies` is the harness's own invariant, whether the step can be written in a model's state at all (a handle it
 *   never made cannot be named), and never what the system is expected to refuse, which `judge` says;
 * - `parameters` draws its parameters in a model's state, valid ones and the named invalid ones alike;
 * - `judge` is the model's verdict on the step: accepted with the state after it, or refused with its refusal.
 *
 * All are pure, so a whole program is generated, printed, enumerated and shrunk without touching the system under
 * test, and a program draws steps the model refuses as readily as steps it accepts: those are the cases to try.
 */
export type Command<M, P, V extends string> = Readonly<{
	weight: Weight
	applies: (model: M) => boolean
	parameters: (model: M) => Gen<P>
	judge: (model: M, parameters: P) => Verdict<M, V>
}>

/**
 * A state machine: the model's initial state and its commands, each named, with the parameters each takes and the
 * vocabulary `V` its refusals are named from (`never` for a machine that refuses nothing). It is an interface, so a
 * machine's type keeps its arguments: a command's verdicts sit under its name in a mapped record, from which no
 * argument can be read back, so property.stateful reads `V` from the machine's type, and its step features
 * (StepFeature) are as closed as `V`.
 */
export interface Machine<M, P, V extends string> {
	readonly initial: M
	readonly commands: { readonly [K in keyof P]: Command<M, P[K], V> }
}

/** A command's name. */
export type CommandName<P> = keyof P & string

type StepOf<P> = { readonly [K in CommandName<P>]: Readonly<{ command: K; parameters: P[K] }> }

/** One step of a program: a command by name and the parameters it was drawn with. */
export type Step<P> = StepOf<P>[CommandName<P>]

/**
 * A program of a state machine: plain data that prints as the literal a kept case writes,
 * `[{ command: "push", parameters: 3 }, { command: "pop", parameters: undefined }]`.
 */
export type Program<P> = ReadonlyArray<Step<P>>

/**
 * How each command runs on the real system: given its parameters, the model's state before it, the state the model
 * claims after it (the verdict's `next` when accepted, the state before it when refused) and the verdict itself, it
 * acts, checks that the system entered the claimed state, and answers what the system did: `took`, or `refused` with
 * the refusal the system's own error names. It is supplied when the program runs, so it can close over the scoped
 * resources the property set up.
 */
export type Real<M, P, V extends string, E, R> = {
	readonly [K in keyof P]: (
		parameters: P[K],
		before: M,
		after: M,
		verdict: Verdict<M, V>
	) => Effect.Effect<Answer<V>, E, R>
}

/** A program's step names a command its model does not allow there: a kept program that drifted from its machine. */
export class StepInapplicable extends Schema.TaggedError<
	StepInapplicable,
	{ readonly brand: unique symbol }
>()("StepInapplicable", { at: Schema.Finite, command: Schema.String, message: Schema.String }) {}

/**
 * The system answered a step otherwise than its model allows: a planned machine's step it took where the model refuses
 * it, refused where the model accepts it, or refused by another refusal; a reactive machine's step whose observation
 * names no outcome the model allows there, or names one whose state cannot hold what the system showed. `allowed` are
 * the features the model allows the step (one, for a planned machine) and `answered` the feature the system answered.
 */
export class VerdictDiverged extends Schema.TaggedError<
	VerdictDiverged,
	{ readonly brand: unique symbol }
>()("VerdictDiverged", {
	at: Schema.Finite,
	command: Schema.String,
	allowed: Schema.Array(Schema.String),
	answered: Schema.String,
	message: Schema.String
}) {}

/** A step as a feature: its command and the verdict it met, `"push accepted"` or `"pop refused empty"`. */
export type StepFeature<P, V extends string> =
	| `${CommandName<P>} accepted`
	| `${CommandName<P>} refused ${V}`

/** The feature of a step that met `answer`. */
export const stepFeature = <P, V extends string>(
	command: CommandName<P>,
	answer: Answer<V>
): StepFeature<P, V> => {
	switch (answer.kind) {
		case "accepted":
			return `${command} accepted`
		case "refused":
			return `${command} refused ${answer.refusal}`
	}
}

/** The answer a verdict predicts: what the system must answer the step. */
const answerOf = <M, V extends string>(verdict: Verdict<M, V>): Answer<V> => {
	switch (verdict.kind) {
		case "accepted":
			return took
		case "refused":
			return verdict
	}
}

/** The model's state after a step it judged: the verdict's next state, or the state before it when refused. */
const claimedAfter = <M, V extends string>(before: M, verdict: Verdict<M, V>): M => {
	switch (verdict.kind) {
		case "accepted":
			return verdict.next
		case "refused":
			return before
	}
}

/** The greatest common divisor of two whole numbers. */
/**
 * One of weighted commands, drawn in proportion to their weights, in the order given: one weighted decision
 * (Source.weigh), which an enumeration meets once a command, so no two of its values name the same command. One
 * command with weight is no choice and draws nothing.
 */
const pickOf = <K>(
	source: Source,
	weighted: Arr.NonEmptyReadonlyArray<readonly [name: K, weight: number]>
): K =>
	Arr.getUnsafe(weighted, source.weigh(weightsOf(Arr.map(weighted, ([, weight]) => weight))))[0]

/**
 * Programs of between `size.min` and `size.max` steps over the commands `drawn` turns on, each as often as its weight
 * times its presence in the swarm: the caller draws the swarm (`swarm` over the commands' names), so each program
 * explores its own lopsided mix, or passes `fullSwarm` for every command at its weight. Each step picks a command
 * among those on, in the order the machine declares them, so one decision names the same command in every state and
 * shrinking can move a step past its neighbour; a pick that does not apply in the model's state picks again among
 * those on that do, by the same weights. The step then draws its parameters in that state and the model judges it,
 * accepted or refused, and the program ends early where no command on applies. Each step is its own span, so
 * shrinking deletes and reorders steps, and the steps after an edit are drawn again in the state it leaves, so a
 * shrunk program is still one whose every step its harness can write.
 */
export const program =
	<M, P, V extends string>(
		machine: Machine<M, P, V>,
		size: Size,
		drawn: Swarm<CommandName<P>>
	): Gen<Program<P>> =>
	(source) => {
		const names: ReadonlyArray<CommandName<P>> = Struct.keys(machine.commands)
		const on = Arr.flatMap(names, (name) => {
			const presence = weightOf(drawn, name)
			return presence > 0 ? [[name, machine.commands[name].weight * presence] as const] : []
		})
		const drawStep = <K extends CommandName<P>>(command: K, model: M): StepOf<P>[K] => ({
			command,
			parameters: source.draw(machine.commands[command].parameters(model))
		})
		source.open("array")
		const length = source.choose(size.min, size.max)
		const steps: Array<Step<P>> = []
		if (Arr.isReadonlyArrayNonEmpty(on)) {
			let model = machine.initial
			for (let index = 0; index < length; index += 1) {
				const applicable = Arr.filter(on, ([name]) => machine.commands[name].applies(model))
				if (!Arr.isReadonlyArrayNonEmpty(applicable)) {
					break
				}
				source.open("element")
				const named = pickOf(source, on)
				const step = drawStep(
					machine.commands[named].applies(model) ? named : pickOf(source, applicable),
					model
				)
				model = claimedAfter(model, judgeStep(machine, model, step.command, step.parameters))
				steps.push(step)
				source.close()
			}
		}
		source.close()
		return steps
	}

/** The model's verdict on a command run with its parameters. */
const judgeStep = <M, P, V extends string, K extends CommandName<P>>(
	machine: Machine<M, P, V>,
	model: M,
	command: K,
	parameters: P[K]
): Verdict<M, V> => machine.commands[command].judge(model, parameters)

/** A program's run: the model's final state, and each step's feature in order, as the system answered it. */
export type Ran<M, P, V extends string> = Readonly<{
	model: M
	verdicts: ReadonlyArray<StepFeature<P, V>>
}>

/**
 * Runs a program on the real system, step by step: each step's command must apply in the model's state, the model
 * judges it, its real run checks the system against the state the verdict claims and answers what the system did,
 * which must be exactly the answer the verdict predicts, and the model advances, a refused step leaving it as it was.
 * It succeeds with the model's final state and every step's feature, for a property to note; it fails with the first
 * step whose run fails, with `VerdictDiverged` for the first step the system answered otherwise than its model, or
 * with `StepInapplicable` for a kept program that names a command its harness no longer allows.
 */
export const runProgram = Effect.fn("testing.commands.run")(function* <
	M,
	P,
	V extends string,
	E,
	R
>(machine: Machine<M, P, V>, real: Real<M, P, V, E, R>, steps: Program<P>) {
	const runStep = <K extends CommandName<P>>(
		command: K,
		parameters: P[K],
		before: M,
		verdict: Verdict<M, V>
	) => real[command](parameters, before, claimedAfter(before, verdict), verdict)
	let model = machine.initial
	const verdicts: Array<StepFeature<P, V>> = []
	for (let at = 0; at < steps.length; at += 1) {
		const { command, parameters } = Arr.getUnsafe(steps, at)
		if (!machine.commands[command].applies(model)) {
			return yield* StepInapplicable.make({
				at,
				command,
				message: `step ${at} runs ${command}, which the model does not allow in its state there`
			})
		}
		const verdict = judgeStep(machine, model, command, parameters)
		const answer = yield* runStep(command, parameters, model, verdict)
		const predicted = stepFeature<P, V>(command, answerOf(verdict))
		const answered = stepFeature<P, V>(command, answer)
		if (predicted !== answered) {
			return yield* VerdictDiverged.make({
				at,
				command,
				allowed: [predicted],
				answered,
				message: `step ${at}: the model predicts ${predicted}, and the system answered ${answered}`
			})
		}
		verdicts.push(answered)
		model = claimedAfter(model, verdict)
	}
	const ran: Ran<M, P, V> = { model, verdicts }
	return ran
})

/**
 * The programs of a machine, of between `size.min` and `size.max` steps, over the commands a swarm drawn from `mix`
 * turns on: `swarm(commands)` gives each case its own lopsided mix, `constant(fullSwarm(commands))` every command at
 * its weight, and any other generator of swarms a mix of its own (one that keeps a command on). The swarm is drawn on
 * the case's tape before its program, so it replays and shrinks with it.
 */
export const programs =
	<M, P, V extends string>(
		machine: Machine<M, P, V>,
		size: Size,
		mix: Gen<Swarm<CommandName<P>>>
	): Space<Program<P>> =>
	(source) =>
		source.draw(program(machine, size, source.draw(mix)))

/**
 * One outcome a reactive machine's model allows a step: the name the system's observation gives it, and the state it
 * leads to from what the system showed, none when what it showed is no state this outcome allows (a value it never
 * held, an identity it never drew).
 */
export type Branch<M, O extends string, X> = Readonly<{
	outcome: O
	next: (shown: X) => Option.Option<M>
}>

/** An outcome whose state is `next` whatever the system showed. */
export const branch = <M, O extends string>(outcome: O, next: M): Branch<M, O, unknown> => ({
	outcome,
	next: () => Option.some(next)
})

/** What the system answered a step of a reactive machine: the outcome its observation names, and what it showed. */
export type Observation<O extends string, X> = Readonly<{ outcome: O; shown: X }>

/**
 * One rule of a reactive machine, judged by its model alone, as a planned machine's Command is:
 * - `weight`, `applies` and `parameters` are a Command's, read in the state the run actually reached;
 * - `judge` is every outcome the model allows the step (Branch), at least one: the system's observation chooses among
 *   them, as nature does, so a model states what may happen, never what will.
 */
export interface Rule<M, P, O extends string, X> {
	readonly weight: Weight
	readonly applies: (model: M) => boolean
	readonly parameters: (model: M) => Gen<P>
	readonly judge: (model: M, parameters: P) => Arr.NonEmptyReadonlyArray<Branch<M, O, X>>
}

/**
 * A reactive state machine, Hypothesis's rule-based state machine: its rules, each named, with the parameters each
 * takes, the closed vocabulary `O` of the outcomes its observations name and what the system shows `X`. Its steps are
 * drawn as the run goes, each in the state the system's observations led the model to, so a model whose outcomes
 * branch is checked as readily as one that predicts; the state it starts in is its real's (ReactiveReal `start`),
 * since the system a case builds (an installation, a staged reality) decides it. An interface, so its type keeps its
 * arguments.
 */
export interface ReactiveMachine<M, P, O extends string, X> {
	readonly rules: { readonly [K in keyof P]: Rule<M, P[K], O, X> }
}

/**
 * How a reactive machine's rules run on the real system a case built: `start` is the model's state the system starts
 * in; each step, given its parameters, the model's state before it and the outcomes the model allows, acts and answers
 * what the system observed; `holds` checks the system is in a state of the model's, the start before any step and,
 * after each, the state the outcome its observation chose leads to. Supplied when a case runs, so it closes over the
 * case's resources and draws.
 */
export type ReactiveReal<M, P, O extends string, X, E, R> = Readonly<{
	start: M
	steps: {
		readonly [K in keyof P]: (
			parameters: P[K],
			before: M,
			allowed: Arr.NonEmptyReadonlyArray<Branch<M, O, X>>
		) => Effect.Effect<Observation<O, X>, E, R>
	}
	holds: (after: M) => Effect.Effect<void, E, R>
}>

/** A reactive machine's step as a feature: its rule and the outcome the system's observation named, `"send dropped"`. */
export type OutcomeFeature<P, O extends string> = `${CommandName<P>} ${O}`

/** A reactive run: the model's final state, and each step's feature in order. */
export type Reacted<M, P, O extends string> = Readonly<{
	model: M
	outcomes: ReadonlyArray<OutcomeFeature<P, O>>
}>

/**
 * The next step of a reactive run, drawn in the state `model` the run reached, as one span, so shrinking deletes a
 * step and simplifies its draws, and the steps after it are drawn again in the state the edit leaves: none where the
 * run ends. A run takes `size.min` steps, then before each further step draws whether it goes on (stopping is the
 * simplest value, so a shrink ends a run sooner) until `size.max`; it also ends where no rule the swarm turns on
 * applies. A rule is picked among those on by weight and presence, again among those that apply when it does not, as
 * `program` picks a command.
 */
const reactiveStep =
	<M, P, O extends string, X>(
		machine: ReactiveMachine<M, P, O, X>,
		size: Size,
		drawn: Swarm<CommandName<P>>,
		model: M,
		at: number
	): Gen<Option.Option<Step<P>>> =>
	(source) => {
		const names: ReadonlyArray<CommandName<P>> = Struct.keys(machine.rules)
		const on = Arr.flatMap(names, (name) => {
			const presence = weightOf(drawn, name)
			return presence > 0 ? [[name, machine.rules[name].weight * presence] as const] : []
		})
		const applicable = Arr.filter(on, ([name]) => machine.rules[name].applies(model))
		if (
			at >= size.max ||
			!Arr.isReadonlyArrayNonEmpty(on) ||
			!Arr.isReadonlyArrayNonEmpty(applicable)
		) {
			return Option.none()
		}
		return source.span("element", () => {
			if (at >= size.min && source.weigh(weightsOf([1, size.max - size.min])) === 0) {
				return Option.none()
			}
			const named = pickOf(source, on)
			const rule = machine.rules[named].applies(model) ? named : pickOf(source, applicable)
			const step: StepOf<P>[typeof rule] = {
				command: rule,
				parameters: source.draw(machine.rules[rule].parameters(model))
			}
			return Option.some(step)
		})
	}

/** The outcomes a rule allows a step, as features, for a divergence's report. */
const allowedOf = <M, P, O extends string, X>(
	rule: CommandName<P>,
	allowed: Arr.NonEmptyReadonlyArray<Branch<M, O, X>>
): ReadonlyArray<OutcomeFeature<P, O>> =>
	Arr.dedupe(Arr.map(allowed, (outcome): OutcomeFeature<P, O> => `${rule} ${outcome.outcome}`))

/**
 * Runs a reactive machine on the real system as its steps are drawn, from the state the system starts in, which `holds`
 * checks first: each step is drawn from the case (`draw`, its own tape) in the state the run reached (reactiveStep),
 * the model judges it, its real run acts and answers an
 * observation, and the outcome the observation names, whose state can hold what the system showed, is taken: the first
 * such of the outcomes the model allows, in the order it allows them; `holds` checks the system is in that outcome's
 * state, and the model advances to it. It succeeds with the model's final state and every step's feature; it fails
 * with the first step whose run fails, or with `VerdictDiverged` for the first step the system answered with no outcome
 * the model allows.
 */
export const runReactive = Effect.fn("testing.commands.react")(function* <
	M,
	P,
	O extends string,
	X,
	E,
	R
>(
	machine: ReactiveMachine<M, P, O, X>,
	real: ReactiveReal<M, P, O, X, E, R>,
	size: Size,
	drawn: Swarm<CommandName<P>>,
	draw: <A>(generator: Gen<A>) => A
) {
	const runStep = <K extends CommandName<P>>(
		rule: K,
		parameters: P[K],
		before: M,
		allowed: Arr.NonEmptyReadonlyArray<Branch<M, O, X>>
	) => real.steps[rule](parameters, before, allowed)
	yield* real.holds(real.start)
	let model = real.start
	const outcomes: Array<OutcomeFeature<P, O>> = []
	for (let at = 0; ; at += 1) {
		const step = draw(reactiveStep(machine, size, drawn, model, at))
		if (Option.isNone(step)) {
			break
		}
		const { command: rule, parameters } = step.value
		const allowed = machine.rules[rule].judge(model, parameters)
		const observed = yield* runStep(rule, parameters, model, allowed)
		const answered: OutcomeFeature<P, O> = `${rule} ${observed.outcome}`
		const taken = Arr.findFirst(allowed, (outcome) =>
			outcome.outcome === observed.outcome ? outcome.next(observed.shown) : Option.none()
		)
		if (Option.isNone(taken)) {
			const features = allowedOf(rule, allowed)
			return yield* VerdictDiverged.make({
				at,
				command: rule,
				allowed: features,
				answered,
				message: Arr.contains(features, answered)
					? `step ${at}: the system answered ${answered}, showing ${Formatter.format(observed.shown)}, which the model's ${answered} there does not allow`
					: `step ${at}: the model allows ${Arr.join(features, " or ")}, and the system answered ${answered}`
			})
		}
		yield* real.holds(taken.value)
		outcomes.push(answered)
		model = taken.value
	}
	const reacted: Reacted<M, P, O> = { model, outcomes }
	return reacted
})

declare const noCommand: unique symbol

/**
 * The parameters of the kind of machine a stateful property does not run: no command name (its one key is a symbol), so
 * that kind's step features are none, and property.stateful's defaults for the kind it is not given.
 */
export type NoCommands = Readonly<{ [noCommand]: never }>

/**
 * What a reactive case draws before its run, from its property's mix: the swarm its steps are drawn over, beside
 * whatever else the property draws there for its real to read (an installation, the aims its steering left pending). A
 * mix is a space, as an explored property's is, plain, aimed or steered, so it is the part of a reactive case that
 * reads the case's steering: the steps are drawn as the run goes, and a real cannot see what is pending.
 */
export type ReactiveMix<K extends string> = Readonly<{ swarm: Swarm<K> }>

/**
 * The features a stateful property's situations name: its machine's step features, of either kind (the other kind's are
 * none), and its real's own notes.
 */
export type StatefulFeature<PP, V extends string, PR, O extends string, F extends string> =
	| StepFeature<PP, V>
	| OutcomeFeature<PR, O>
	| F

/**
 * A stateful property's machine with the real system it runs on, by the kind of machine, its first argument:
 * - `planned`: a Machine, whose programs are drawn whole before they run, over a swarm drawn from `mix`
 *   (`swarm(names)` for each case its own lopsided mix, `constant(fullSwarm(names))` every command at its weight), so
 *   a case is its program, printed and kept as the literal it is; its real (Real) checks the state the model's one
 *   verdict claims;
 * - `reactive`: a ReactiveMachine, whose steps are drawn as the run goes, so a case is its mix (ReactiveMix) and its
 *   steps are its draws, printed beside it. `mix` is a space of the case's mix, plain (`map(swarm(names), (swarm) =>
 *   ({ swarm }))`), aimed or steered, as property.explore's space is and typed as it is, by the features it aims at: a
 *   steered mix reads the required situations still pending, as an explored space does, and resolves what its steps
 *   should aim at into the mix it draws. Its real (ReactiveReal) is handed that mix, so the state the model starts in
 *   carries what the rules read of it, and answers observations, whose outcome the model's branches choose.
 * `real` builds the system on the case's resources, in its scope, and may note situations of its own and draw from the
 * case. The machine, its mix and its real are one value, so a machine is never run on the other kind's mix or real.
 */
export type StatefulMachine<
	M,
	PP,
	V extends string,
	PR,
	O extends string,
	X,
	W extends ReactiveMix<CommandName<PR>>,
	N extends Needs,
	F extends string,
	E
> =
	| Readonly<{
			kind: "planned"
			machine: Machine<M, PP, V>
			mix: Gen<Swarm<NoInfer<CommandName<PP>>>>
			real: (
				resources: Resources<N>,
				c: Case<F>
			) => Effect.Effect<
				Real<NoInfer<M>, NoInfer<PP>, NoInfer<V>, E, CheckContext>,
				E,
				CheckContext
			>
	  }>
	| Readonly<{
			kind: "reactive"
			machine: ReactiveMachine<M, PR, O, X>
			mix: Space<W> | Aimed<W, F> | Steered<W, F>
			real: (
				resources: Resources<N>,
				c: Case<F>
			) => (
				mix: NoInfer<W>
			) => Effect.Effect<
				ReactiveReal<NoInfer<M>, NoInfer<PR>, NoInfer<O>, NoInfer<X>, E, CheckContext>,
				E,
				CheckContext
			>
	  }>

/**
 * What a stateful property states beside its machine: runs of `size` steps, and what every property states, its
 * situations among its machine's step features (StepFeature, or OutcomeFeature) and its real's own notes. A case prints
 * in its structural form.
 */
export type StatefulSpec<
	PP,
	V extends string,
	PR,
	O extends string,
	N extends Needs,
	F extends string
> = Omit<
	ExploreStated<
		never,
		StatefulFeature<NoInfer<PP>, NoInfer<V>, NoInfer<PR>, NoInfer<O>, F>,
		N,
		never
	>,
	"check" | "show"
> &
	Readonly<{ size: Size }>

/**
 * The exploration a stateful property is, handed to `explored` (CORE's constructor), whatever its case type: a planned
 * machine's programs as its space, and a check that runs the case's program (runProgram); or a reactive machine's
 * mix as its space, steered as an explored space is, and a check that hands the case's mix to its real and runs its
 * steps over the mix's swarm as they are drawn (runReactive). Either notes each step's feature.
 */
export const statefulExplore = <
	M,
	PP,
	V extends string,
	PR,
	O extends string,
	X,
	W extends ReactiveMix<CommandName<PR>>,
	N extends Needs,
	F extends string,
	E,
	Built
>(
	machine: StatefulMachine<M, PP, V, PR, O, X, W, N, F, E>,
	spec: StatefulSpec<PP, V, PR, O, N, F>,
	explored: <S>(
		explore: ExploreSpec<
			S,
			StatefulFeature<PP, V, PR, O, F>,
			N,
			E | StepInapplicable | VerdictDiverged
		>
	) => Built
): Built => {
	const { size, ...stated } = spec
	switch (machine.kind) {
		case "planned":
			return explored({
				...stated,
				space: programs(machine.machine, size, machine.mix),
				check: (resources, c) => (steps) =>
					Effect.gen(function* () {
						const system = yield* machine.real(resources, c)
						const ran = yield* runProgram(machine.machine, system, steps)
						c.noteAll(ran.verdicts)
					})
			})
		case "reactive":
			return explored({
				...stated,
				space: machine.mix,
				check: (resources, c) => (mix) =>
					Effect.gen(function* () {
						const system = yield* machine.real(resources, c)(mix)
						const reacted = yield* runReactive(machine.machine, system, size, mix.swarm, c.draw)
						c.noteAll(reacted.outcomes)
					})
			})
	}
}
