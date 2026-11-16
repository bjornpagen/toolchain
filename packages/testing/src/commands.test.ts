/**
 * Command programs against a model (commands.ts) and property.stateful, over a bounded queue its fixtures plant and a
 * ring buffer built right or wrong (commands.fixtures.ts), against what they promise. Oracles are stated per property.
 */
import { Array as Arr, Effect, Exit, Formatter, Option, Order, Schema, Struct } from "effect"
import { assertTrue, deepStrictEqual, strictEqual } from "#assert.ts"
import { everyCase, everyValue, type Fraction, fraction, plus, shareOf } from "#chance.fixtures.ts"
import {
	anyProgram,
	answerOf,
	builds,
	COMMANDS,
	EVEN,
	foldOf,
	heldBefore,
	isRight,
	lieAbout,
	presenceOf,
	QUEUE,
	type QueueCommand,
	type QueueParameters,
	type QueueRefusal,
	queueOf,
	realOf,
	ringBuffer,
	rightly,
	shortestFailing,
	shrunkOf,
	STEP_FEATURES,
	swarmedPrograms,
	WEIGHTS,
	writable
} from "#commands.fixtures.ts"
import {
	type Answer,
	program,
	programs,
	type Real,
	runProgram,
	StepInapplicable,
	stepFeature
} from "#commands.ts"
import { element, finite, int, subarray } from "#gen.ts"
import { property } from "#property.ts"
import { fnv1a32 } from "#random.ts"
import { inlineRun, searchInline } from "#runner/inline.ts"
import { fullSwarm, swarm } from "#swarm.ts"

/**
 * The programs a machine draws are every program its harness can write, each step one the model accepts or refuses:
 * in a box of up to 3 steps over pushes of one value or two.
 */
export const writablePrograms = property.exhaust(
	finite((source) => ({ values: source.draw(int(1, 2)), steps: source.draw(int(0, 3)) })),
	{
		box: "every program of up to 3 steps, pushes of one value or two",
		needs: {},
		situations: [],
		check: () => (box) =>
			Effect.sync(() => {
				const machine = queueOf(EVEN, int(0, box.values - 1))
				const drawn = new Set(
					Arr.map(
						everyValue(program(machine, { min: 0, max: box.steps }, fullSwarm(COMMANDS))),
						(steps) => Formatter.format(steps)
					)
				)
				deepStrictEqual(drawn.size, writable(machine, box.values, machine.initial, box.steps))
			}),
		oracle: {
			kind: "second-implementation",
			name: "the programs a naive recursion over the queue model writes"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/commands.ts",
				original: "\t\t\tfor (let index = 0; index < length; index += 1) {",
				replacement: "\t\t\tfor (let index = 0; index < length - 1; index += 1) {",
				why: "A program draws one step short of the length it chose, so no program holds the box's 3 steps."
			}
		]
	}
)

/**
 * A run answers every step as the system did, and fails at the first step the system answers otherwise than its
 * model, by the step's feature as predicted and as answered.
 */
export const verdicts = property.explore(swarmedPrograms(QUEUE, { min: 0, max: 8 }), {
	needs: {},
	situations: ["agrees", "diverges"],
	check: (_resources, c) => (steps) =>
		Effect.gen(function* () {
			const lies: ReadonlySet<number> = new Set(c.draw(subarray(Arr.fromIterable(steps.keys()))))
			const folded = foldOf(QUEUE, steps)
			const answers = Arr.map(folded.verdicts, (verdict, at) =>
				lies.has(at) ? lieAbout(verdict) : answerOf(verdict)
			)
			let at = 0
			const answer = (): Effect.Effect<Answer<QueueRefusal>> =>
				Effect.sync(() => {
					const given = Arr.getUnsafe(answers, at)
					at += 1
					return given
				})
			const liar: Real<readonly number[], QueueParameters, QueueRefusal, never, never> = {
				push: answer,
				pop: answer,
				size: answer,
				peek: answer
			}
			const exit = yield* Effect.exit(runProgram(QUEUE, liar, steps))
			const firstLie = Arr.head(Arr.sort(Arr.fromIterable(lies), Order.Number))
			if (Option.isSome(firstLie)) {
				c.note("diverges")
				const failed = Exit.findErrorOption(exit)
				assertTrue(Option.isSome(failed), "a lie fails the run")
				const step = Arr.getUnsafe(steps, firstLie.value)
				const verdict = Arr.getUnsafe(folded.verdicts, firstLie.value)
				deepStrictEqual(
					Option.map(failed, (error) =>
						error._tag === "VerdictDiverged"
							? [error.at, error.command, error.predicted, error.answered]
							: [error._tag]
					),
					Option.some([
						firstLie.value,
						step.command,
						stepFeature<QueueParameters, QueueRefusal>(step.command, answerOf(verdict)),
						stepFeature<QueueParameters, QueueRefusal>(step.command, lieAbout(verdict))
					])
				)
				return
			}
			c.note("agrees")
			deepStrictEqual(
				exit,
				Exit.succeed({
					model: folded.model,
					verdicts: Arr.map(steps, (step, index) =>
						stepFeature<QueueParameters, QueueRefusal>(
							step.command,
							answerOf(Arr.getUnsafe(folded.verdicts, index))
						)
					)
				})
			)
		}),
	oracle: {
		kind: "second-implementation",
		name: "the machine's own judge folded over the program"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/commands.ts",
			original: "\t\tif (predicted !== answered) {",
			replacement: '\t\tif (predicted.split(" ")[0] !== answered.split(" ")[0]) {',
			why: "A step's answer is held against its prediction by its command alone, so a system that answers otherwise than its model passes."
		}
	]
})

/**
 * A ring buffer built right meets its queue model on every program, its refusals included: a property of
 * property.stateful, whose every step's feature is noted.
 */
export const ringBufferMeetsQueue = property.stateful(QUEUE, {
	size: { min: 0, max: 12 },
	mix: swarm(COMMANDS),
	needs: {},
	real: () => Effect.sync(() => realOf(ringBuffer(rightly))),
	situations: STEP_FEATURES,
	oracle: { kind: "second-implementation", name: "the bounded queue model's verdicts and states" },
	kept: [],
	kills: [
		{
			file: "packages/testing/src/commands.ts",
			original: '\t\tcase "refused":\n\t\t\treturn verdict',
			replacement: '\t\tcase "refused":\n\t\t\treturn took',
			why: "A step the model refuses is predicted to be taken, so a correct system's refusal diverges."
		},
		{
			file: "packages/testing/src/commands.ts",
			original: "\t\t\t\tc.noteAll(ran.verdicts)\n",
			replacement: "",
			why: "property.stateful notes no step's feature, so no required verdict is reached."
		}
	]
})

/**
 * Each command is drawn as often as its weight times its presence, a pick it cannot write drawn again among those it
 * can, by exact enumeration of one-step programs.
 */
export const commandWeights = property.explore(
	(source) => ({
		weights: {
			push: source.draw(element(WEIGHTS)),
			pop: source.draw(element(WEIGHTS)),
			size: source.draw(element(WEIGHTS)),
			peek: source.draw(element(WEIGHTS))
		},
		mix: source.draw(swarm(COMMANDS))
	}),
	{
		needs: {},
		situations: [],
		check:
			() =>
			({ weights, mix }) =>
				Effect.sync(() => {
					const machine = queueOf(weights, int(0, 1))
					const cases = everyCase(program(machine, { min: 1, max: 1 }, mix))
					const effective = (command: QueueCommand) =>
						BigInt(weights[command] * presenceOf(mix, command))
					const total = Arr.reduce(COMMANDS, 0n, (sum, command) => sum + effective(command))
					const writableTotal = Arr.reduce(
						Arr.filter(COMMANDS, (command) => command !== "peek"),
						0n,
						(sum, command) => sum + effective(command)
					)
					const expected = (command: QueueCommand): Fraction =>
						command === "peek" || writableTotal === 0n
							? fraction(0n, 1n)
							: plus(
									fraction(effective(command), total),
									fraction(effective("peek") * effective(command), total * writableTotal)
								)
					deepStrictEqual(
						Arr.map(Struct.keys(EVEN), (command) =>
							shareOf(cases, (steps) => Arr.some(steps, (step) => step.command === command))
						),
						Arr.map(Struct.keys(EVEN), expected)
					)
				}),
		oracle: {
			kind: "specification",
			name: "each command's weight times its presence over the total, by exact enumeration"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/commands.ts",
				original: "\t\tif (rest < weight / divisor) {",
				replacement: "\t\tif (rest <= weight / divisor) {",
				why: "Each command's pick owns one value past its share, so commands are drawn off their weights."
			}
		]
	}
)

/**
 * A search over a ring buffer built wrong finds a failing program and shrinks it to no more steps than the shortest
 * failing program of pushes of 0 or 1 has, and a search over one built right passes: every way to build one, each
 * searched inline (runner/inline.ts) as property.stateful.
 */
export const shrinksToShortest = property.exhaust(finite(builds), {
	box: "every ring buffer of capacity 3, its reads wrapping at 1, 2 or 3, overwriting when full or not",
	needs: {},
	situations: ["a right buffer passes", "a wrong buffer's failure shrinks to a shortest one"],
	check: (_resources, c) => (build) =>
		Effect.gen(function* () {
			const space = programs(QUEUE, { min: 0, max: 12 }, swarm(COMMANDS))
			const id = `commands.test.ts#shrinksToShortest/${Formatter.format(build)}`
			const verdict = yield* searchInline(
				property.stateful(QUEUE, {
					size: { min: 0, max: 12 },
					mix: swarm(COMMANDS),
					needs: {},
					real: () => Effect.sync(() => realOf(ringBuffer(build))),
					situations: [],
					oracle: { kind: "specification", name: "a ring buffer built as the case says" },
					kept: [],
					kills: []
				}),
				inlineRun(id, fnv1a32(id))
			)
			if (isRight(build)) {
				strictEqual(verdict.kind, "explored")
				c.note("a right buffer passes")
				return
			}
			const shrunk = yield* shrunkOf(verdict, space)
			deepStrictEqual(shortestFailing(build, shrunk.length), Option.some(shrunk.length))
			c.note("a wrong buffer's failure shrinks to a shortest one")
		}),
	oracle: {
		kind: "second-implementation",
		name: "every program of pushes of 0 or 1 enumerated by length, the shortest that fails"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/shrink.ts",
			original: '\tcursor: { pass: "delete-items", cursor: best.items.length - 1 },',
			replacement: '\tcursor: { pass: "simplify-spans", span: best.tape.spanLabel.length - 1 },',
			why: "A shrink round deletes no item and no span, so a failing program keeps steps it does not need."
		}
	]
})

/** A kept program runs to its end, or is refused at its first step the model does not allow there. */
export const inapplicableRefused = property.explore(anyProgram, {
	needs: {},
	situations: ["refused at the first step", "refused later", "ran to its end"],
	check: (_resources, c) => (steps) =>
		Effect.gen(function* () {
			const firstInapplicable = Arr.findFirst(
				Arr.map(steps, (step, at) => ({ step, at, held: heldBefore(steps, at) })),
				({ step, held }) => step.command === "peek" && held === 0
			)
			c.note(
				Option.match(firstInapplicable, {
					onNone: () => "ran to its end",
					onSome: ({ at }) => (at === 0 ? "refused at the first step" : "refused later")
				})
			)
			const ran = yield* Effect.exit(runProgram(QUEUE, realOf(ringBuffer(rightly)), steps))
			deepStrictEqual(
				{
					ranToItsEnd: Exit.isSuccess(ran),
					refusedAt: Option.map(Exit.findErrorOption(ran), (failure) =>
						Schema.is(StepInapplicable)(failure) ? [failure.at, failure.command] : []
					)
				},
				{
					ranToItsEnd: Option.isNone(firstInapplicable),
					refusedAt: Option.map(firstInapplicable, ({ at, step }) => [at, step.command])
				}
			)
		}),
	oracle: {
		kind: "second-implementation",
		name: "a bounded queue walked by hand: a peek applies only to a queue that holds something"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/commands.ts",
			original: `\t\tif (!machine.commands[command].applies(model)) {\n\t\t\treturn yield* StepInapplicable.make({\n\t\t\t\tat,\n\t\t\t\tcommand,\n\t\t\t\tmessage: \`step \${at} runs \${command}, which the model does not allow in its state there\`\n\t\t\t})\n\t\t}\n`,
			replacement: "",
			why: "A step its model does not allow there runs instead of refusing the program at it."
		}
	]
})
