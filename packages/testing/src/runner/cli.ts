import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { regex } from "arkregex"
import {
	Array as Arr,
	Config,
	Console,
	Effect,
	Option,
	Random,
	Schema,
	String as Str
} from "effect"
import { replayOf } from "#replay.ts"
import { HARDENED_FLAGS } from "#runner/config.ts"
import { configOf } from "#runner/load.ts"
import { failureLines, lineOf } from "#runner/report.ts"
import { replayToken, runPackage } from "#runner/run.ts"

/**
 * `toolchain-test`, the runner's command, run from a package's root (its test.config.ts):
 *
 *   toolchain-test run [paths | property ids]   every property (or those named), at full width; exit 1 on any failure
 *   toolchain-test replay <token>               the one case a failure printed, as it ran
 *
 * A run prints its seed first (TEST_SEED reproduces the run), then one line per property, then each failure: the case
 * as it ran, its failure and its replay token. Every process of the run, this one and its workers, runs under the
 * hardened flags and the config's export conditions: when this process was started without them it starts itself
 * again with them. A command is an entry of `commands`; a lane adds its own (affected, kills, mutate, fuzz) there,
 * reading runPackage's results.
 */

/** A 32-bit run seed as a person writes it: decimal, or hexadecimal after `0x`. */
const SeedText = Schema.String.check(Schema.isPattern(regex("^(0x[0-9a-fA-F]{1,8}|[0-9]{1,10})$")))

/** The run's seed: TEST_SEED's, or one drawn fresh. */
const seedOf = Effect.gen(function* () {
	const given = yield* Config.option(Config.String("TEST_SEED"))
	if (Option.isSome(given)) {
		const text = yield* Schema.decodeEffect(SeedText)(given.value)
		return { seed: Number(text), drawn: false }
	}
	const seed = yield* Random.nextIntBetween(0, 0xffff_ffff)
	return { seed, drawn: true }
})

/** The package root a command runs in: the directory it was started from. */
const root = process.cwd()

/** `run [paths | ids]`: every property named, its line, then every failure; 1 when any failed. */
const run = (selected: ReadonlyArray<string>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const { seed, drawn } = yield* seedOf
			yield* Console.log(
				`TEST_SEED=${seed}${drawn ? " (drawn by this run; set it to reproduce the run)" : ""}`
			)
			const outcome = yield* runPackage({ root, seed, reach: "full", selected })
			const failed = Arr.filter(outcome.properties, (ran) => ran.verdict.kind === "failed")
			yield* Console.log(
				Arr.join(
					[
						...Arr.map(outcome.properties, (ran) => lineOf(ran.id, ran.oracle, ran.verdict)),
						...Arr.flatMap(failed, (ran) => ["", `${ran.id}:`, ...failureLines(ran.verdict)]),
						"",
						`${outcome.properties.length} properties, ${failed.length} failed, in ${Math.round(outcome.millis)} ms on ${outcome.workers.length} workers`
					],
					"\n"
				)
			)
			return Arr.isReadonlyArrayNonEmpty(failed) ? 1 : 0
		})
	)

/** `replay <token>`: the one case the token names, printed as it ran; 1 unless it passed as its token says. */
const replay = (args: ReadonlyArray<string>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const token = yield* Effect.mapError(
				Effect.fromOption(Arr.head(args)),
				() => "replay takes the token a failure printed: toolchain-test replay '<token>'"
			)
			const named = yield* Effect.mapError(replayOf(token), (unreadable) => unreadable.message)
			const replayed = yield* replayToken(root, named.suite, token)
			yield* Console.log(
				Arr.join(
					[
						lineOf(replayed.id, replayed.oracle, replayed.verdict),
						...failureLines(replayed.verdict)
					],
					"\n"
				)
			)
			return replayed.verdict.kind === "replayed" ? 0 : 1
		})
	)

/** The commands, by name: each takes its arguments and answers its exit status. */
const commands = {
	run,
	replay
} as const

/** The flags this process must run under: the hardened flags and the config's export conditions. */
const requiredFlags = Effect.map(configOf(root), (config) => [
	...HARDENED_FLAGS,
	...Arr.map(config.conditions, (condition) => `--conditions=${condition}`)
])

/**
 * Runs a command under the flags it needs: in this process when it already has them, otherwise in a new process of
 * this script with them added, whose exit status this one answers.
 */
const main = Effect.gen(function* () {
	const [name, ...args] = Arr.drop(process.argv, 2)
	const required = yield* requiredFlags
	const missing = Arr.filter(required, (flag) => !Arr.contains(process.execArgv, flag))
	if (Arr.isReadonlyArrayNonEmpty(missing)) {
		const child = process
			.getBuiltinModule("node:child_process")
			.spawnSync(
				process.execPath,
				[...process.execArgv, ...missing, ...Arr.drop(process.argv, 1)],
				{ stdio: "inherit" }
			)
		return child.status ?? 1
	}
	const command = Option.fromUndefinedOr(
		name === "run" ? commands.run : name === "replay" ? commands.replay : undefined
	)
	return yield* Option.match(command, {
		onNone: () =>
			Effect.as(
				Console.error(
					`toolchain-test ${Str.isNonEmpty(name ?? "") ? name : ""}: the commands are run [paths | ids] and replay <token>`
				),
				2
			),
		onSome: (chosen) => chosen(args)
	})
})

NodeRuntime.runMain(
	main.pipe(
		Effect.catchCause((cause) => Effect.as(Console.error(String(cause)), 2)),
		Effect.flatMap((status) =>
			Effect.sync(() => {
				process.exitCode = status
			})
		),
		Effect.provide(NodeServices.layer)
	)
)
