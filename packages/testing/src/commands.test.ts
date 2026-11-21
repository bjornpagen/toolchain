/**
 * Command programs against a model (commands.ts) and property.stateful, over a bounded queue its fixtures plant and a
 * ring buffer built right or wrong (commands.fixtures.ts), against what they promise. Oracles are stated per property.
 */
import { Array as Arr, Effect, Exit, Formatter, Option, Order, Schema, Struct } from "effect"
import {
	ACCOUNT,
	ACCOUNT_FEATURES,
	type AccountFeature,
	type AccountMix,
	accountBuilds,
	accountMixes,
	accountOf,
	accountReal,
	isRightAccount,
	plainMixes,
	rightAccount
} from "#account.fixtures.ts"
import { assert } from "#assert.ts"
import { everyCase, everyValue, type Fraction, fraction, plus, shareOf } from "#chance.fixtures.ts"
import {
	CHANNEL,
	CHANNEL_FEATURES,
	channelBuilds,
	channelMixes,
	channelOf,
	channelReal,
	isRightChannel
} from "#channel.fixtures.ts"
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
import { element, finite, int, type Space, type Steered, subarray } from "#gen.ts"
import { property } from "#property.ts"
import { fnv1a32 } from "#random.ts"
import { inlineRun, replayInline, searchInline } from "#runner/inline.ts"
import { falsifiedOf, shownOf, unreachedOf } from "#runner/search.fixtures.ts"
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
				assert.deepEqual(drawn.size, writable(machine, box.values, machine.initial, box.steps))
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
				assert.ok(Option.isSome(failed), "a lie fails the run")
				const step = Arr.getUnsafe(steps, firstLie.value)
				const verdict = Arr.getUnsafe(folded.verdicts, firstLie.value)
				assert.deepEqual(
					Option.map(failed, (error) =>
						error._tag === "VerdictDiverged"
							? [error.at, error.command, error.allowed, error.answered]
							: [error._tag]
					),
					Option.some([
						firstLie.value,
						step.command,
						[stepFeature<QueueParameters, QueueRefusal>(step.command, answerOf(verdict))],
						stepFeature<QueueParameters, QueueRefusal>(step.command, lieAbout(verdict))
					])
				)
				return
			}
			c.note("agrees")
			assert.deepEqual(
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
export const ringBufferMeetsQueue = property.stateful(
	{
		kind: "planned",
		machine: QUEUE,
		mix: swarm(COMMANDS),
		real: () => Effect.sync(() => realOf(ringBuffer(rightly)))
	},
	{
		size: { min: 0, max: 12 },
		needs: {},
		situations: STEP_FEATURES,
		oracle: {
			kind: "second-implementation",
			name: "the bounded queue model's verdicts and states"
		},
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
	}
)

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
					assert.deepEqual(
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
				original: "source.weigh(weightsOf(Arr.map(weighted, ([, weight]) => weight / common)))",
				replacement: "source.weigh(weightsOf(Arr.map(weighted, () => 1)))",
				why: "Every command is drawn equally often whatever its weight, so commands are drawn off their weights."
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
				property.stateful(
					{
						kind: "planned",
						machine: QUEUE,
						mix: swarm(COMMANDS),
						real: () => Effect.sync(() => realOf(ringBuffer(build)))
					},
					{
						size: { min: 0, max: 12 },
						needs: {},
						situations: [],
						oracle: { kind: "specification", name: "a ring buffer built as the case says" },
						kept: [],
						kills: []
					}
				),
				inlineRun(id, fnv1a32(id))
			)
			if (isRight(build)) {
				assert.equal(verdict.kind, "explored")
				c.note("a right buffer passes")
				return
			}
			const shrunk = yield* shrunkOf(verdict, space)
			assert.deepEqual(shortestFailing(build, shrunk.length), Option.some(shrunk.length))
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
			assert.deepEqual(
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

/**
 * A lossy channel built right meets its model, whose sends may be delivered or dropped: property.stateful's reactive
 * form, each step drawn in the state the channel's observations led the model to, the channel's capacity, which the
 * model never reads, drawn from the case.
 */
export const channelMeetsModel = property.stateful(
	{
		kind: "reactive",
		machine: CHANNEL,
		mix: channelMixes,
		real: (_resources, c) => () =>
			Effect.sync(() =>
				channelReal(
					channelOf({ capacity: c.draw(int(1, 3)), reorders: false, leaksDropped: false })
				)
			)
	},
	{
		size: { min: 0, max: 16 },
		needs: {},
		situations: CHANNEL_FEATURES,
		oracle: {
			kind: "second-implementation",
			name: "the lossy FIFO channel's model, its outcomes chosen by the channel's observations"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/commands.ts",
				original:
					"\t\t\toutcome.outcome === observed.outcome ? outcome.next(observed.shown) : Option.none()",
				replacement: "\t\t\toutcome.next(observed.shown)",
				why: "A step takes the first outcome whose state holds what the system showed, whatever outcome its observation names, so a dropped send is taken as delivered."
			},
			{
				file: "packages/testing/src/commands.ts",
				original: "\t\tconst step = draw(reactiveStep(machine, size, drawn, model, at))",
				replacement: "\t\tconst step = draw(reactiveStep(machine, size, drawn, real.start, at))",
				why: "Each step is drawn in the state the system started in, not the state the run reached, so no peek is ever drawn."
			},
			{
				file: "packages/testing/src/commands.ts",
				original: "\t\t\t\t\t\tc.noteAll(reacted.outcomes)\n",
				replacement: "",
				why: "property.stateful's reactive form notes no step's feature, so no required outcome is reached."
			}
		]
	}
)

/**
 * A search over a channel built wrong, serving the newest of the messages it holds or keeping a dropped one where only
 * its size shows it, is falsified, and one that behaves as the model's channel passes (one holding a message at most
 * serves the newest as the oldest): every way to build one, each searched inline (runner/inline.ts) as
 * property.stateful's reactive form.
 */
export const wrongChannelsCaught = property.exhaust(finite(channelBuilds), {
	box: "every channel of capacity 1 or 2, serving the oldest message or the newest, keeping a dropped message or not",
	needs: {},
	situations: ["a right channel passes", "a wrong channel is falsified"],
	check: (_resources, c) => (build) =>
		Effect.gen(function* () {
			const id = `commands.test.ts#wrongChannelsCaught/${Formatter.format(build)}`
			const verdict = yield* searchInline(
				property.stateful(
					{
						kind: "reactive",
						machine: CHANNEL,
						mix: channelMixes,
						real: () => () => Effect.sync(() => channelReal(channelOf(build)))
					},
					{
						size: { min: 0, max: 16 },
						needs: {},
						situations: [],
						oracle: { kind: "specification", name: "a channel built as the case says" },
						kept: [],
						kills: []
					}
				),
				inlineRun(id, fnv1a32(id))
			)
			if (isRightChannel(build)) {
				assert.equal(verdict.kind, "explored")
				c.note("a right channel passes")
				return
			}
			assert.equal(verdict.kind === "failed" ? verdict.finding.kind : verdict.kind, "falsified")
			c.note("a wrong channel is falsified")
		}),
	oracle: {
		kind: "specification",
		name: "a channel that reorders or keeps a dropped message is not the lossy FIFO channel its model allows"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/commands.ts",
			original: "\t\tyield* real.holds(taken.value)\n",
			replacement: "",
			why: "No step checks the system holds the state its outcome leads to, so a channel that keeps a dropped message where nothing serves it passes."
		}
	]
})

/**
 * An account built right meets its model, whose withdrawal of exactly the balance empties it: property.stateful's
 * reactive form over a steered mix (account.fixtures.ts accountMixes). A withdrawal drawn plainly names the balance
 * about once in 2^32 draws, so an emptied withdrawal is reached only by a case whose turn aims at it while it is
 * pending, the steering an explored space reads, which its mix resolves into withdrawals drawn at the balance.
 */
export const steeredMixReachesRare = property.stateful(
	{
		kind: "reactive",
		machine: ACCOUNT,
		mix: accountMixes,
		real: () => (mix) => Effect.sync(() => accountReal(accountOf(rightAccount), mix))
	},
	{
		size: { min: 0, max: 16 },
		needs: {},
		situations: ACCOUNT_FEATURES,
		oracle: {
			kind: "second-implementation",
			name: "the account's model: a deposit adds, a withdrawal of no more than the balance is paid and empties it at exactly the balance, one of more is refused"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/property.ts",
				original: "\t\t\t\treturn space.under(steering)",
				replacement: "\t\t\t\treturn space.under(Option.none())",
				why: "A steered space is drawn as if nothing were pending (property.ts spaceUnderOf), so no reactive case's mix aims its withdrawals at the balance, no withdrawal empties the account, and the required emptied withdrawal is unreached."
			},
			{
				file: "packages/testing/src/features.ts",
				original: "\t\taimed: (situation) => Option.contains(aim, keyOf(situation))",
				replacement: "\t\taimed: () => false",
				why: "No pending situation is any case's aim (features.ts pendingAt), so no reactive case's mix aims its withdrawals at the balance and the required emptied withdrawal is unreached."
			}
		]
	}
)

/**
 * An account that refuses a withdrawal of exactly its balance (an overdraft check off by one) is falsified under the
 * steered mix and its failing case replays from its token as it ran, steering and all; an account built right passes;
 * and at the same seed a search over the plain mix (the steered mix as no steering draws it) misses the emptied
 * withdrawal, so it falsifies neither: each build searched inline (runner/inline.ts) as property.stateful's reactive
 * form, once under each mix.
 */
export const steeredMixCatchesExact = property.exhaust(finite(accountBuilds), {
	box: "every account: paying a withdrawal of exactly its balance, or refusing it",
	needs: {},
	situations: [
		"a right account passes",
		"a wrong account is falsified and replays",
		"the plain mix misses the emptied withdrawal at the same seed"
	],
	check: (_resources, c) => (build) =>
		Effect.gen(function* () {
			const searched = (mix: Space<AccountMix> | Steered<AccountMix, AccountFeature>) =>
				property.stateful(
					{
						kind: "reactive",
						machine: ACCOUNT,
						mix,
						real: () => (drawn) => Effect.sync(() => accountReal(accountOf(build), drawn))
					},
					{
						size: { min: 0, max: 16 },
						needs: {},
						situations: ACCOUNT_FEATURES,
						oracle: { kind: "specification", name: "an account built as the case says" },
						kept: [],
						kills: []
					}
				)
			const id = `commands.test.ts#steeredMixCatchesExact/${Formatter.format(build)}`
			const run = inlineRun(id, fnv1a32(id))
			const plain = yield* searchInline(searched(plainMixes), run)
			if (Option.exists(unreachedOf(plain), Arr.contains("withdraw emptied"))) {
				c.note("the plain mix misses the emptied withdrawal at the same seed")
			}
			const verdict = yield* searchInline(searched(accountMixes), run)
			if (isRightAccount(build)) {
				assert.equal(verdict.kind, "explored")
				c.note("a right account passes")
				return
			}
			const falsified = yield* Option.match(falsifiedOf(verdict), {
				onNone: () => Effect.die(`a wrong account was not falsified: ${Formatter.format(verdict)}`),
				onSome: Effect.succeed
			})
			const replayed = yield* replayInline(searched(accountMixes), run, falsified.token)
			assert.deepEqual(
				shownOf(replayed),
				Option.some({ phase: "replayed", printed: falsified.printed })
			)
			c.note("a wrong account is falsified and replays")
		}),
	oracle: {
		kind: "specification",
		name: "an account that refuses a withdrawal of exactly its balance is not the account its model allows, and a plain draw of 2^32 amounts almost never names the balance"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/commands.ts",
			original: "\t\t\t\tspace: machine.mix,",
			replacement:
				'\t\t\t\tspace: typeof machine.mix === "function" ? machine.mix : machine.mix.kind === "steered" ? machine.mix.under(Option.none()) : machine.mix.space,',
			why: "The reactive kind draws its mix as no steering draws it, so no case aims its withdrawals at the balance and the account refusing exactly its balance passes the steered search."
		}
	]
})
