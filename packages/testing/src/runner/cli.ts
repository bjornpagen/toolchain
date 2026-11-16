import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { regex } from "arkregex"
import {
	Array as Arr,
	Cause,
	Config,
	Console,
	Effect,
	FileSystem,
	Option,
	Random,
	Record as Rec,
	Schema,
	String as Str
} from "effect"
import { loadingOf } from "#mutate/checkout.ts"
import { imagesOf } from "#mutate/image.ts"
import { type Judged, killsOf } from "#mutate/kills.ts"
import { realPathOf } from "#mutate/mutated.ts"
import { treesOf } from "#mutate/tree.ts"
import { replayOf } from "#replay.ts"
import { affected } from "#runner/affected.ts"
import { HARDENED_FLAGS } from "#runner/config.ts"
import { fuzz } from "#runner/fuzz.ts"
import { mutantPoolOf } from "#runner/lease.ts"
import { runnerLimits } from "#runner/limits.ts"
import { configOf } from "#runner/load.ts"
import { failureLines, lineOf } from "#runner/report.ts"
import { loadPackage, replayToken, runPackage } from "#runner/run.ts"

/**
 * `toolchain-test`, the runner's command, run from a package's root (its test.config.ts):
 *
 *   toolchain-test run [paths | property ids]   every property (or those named), at full width; exit 1 on any failure
 *   toolchain-test replay <token>               the one case a failure printed, as it ran
 *   toolchain-test kills [paths | property ids] each property's kills turn its witnesses red; exit 1 on any survivor
 *   toolchain-test affected <ref>               the push gate: every property with no cached pass, and its kills
 *   toolchain-test fuzz <fuzztime> [paths | ids] the scheduled fuzz budget: fresh seeds round after round
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
						...Arr.map(outcome.properties, (ran) => lineOf(ran.label, ran.oracle, ran.verdict)),
						...Arr.flatMap(failed, (ran) => ["", `${ran.label}:`, ...failureLines(ran.verdict)]),
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
/**
 * A command: its arguments in, its exit status out (0 passed, 1 found something), every failure of its own a
 * CommandFailed, which prints and exits 2. It runs in the package root with the platform's services.
 */
export type Command = (
	args: ReadonlyArray<string>
) => Effect.Effect<number, CommandFailed, NodeServices.NodeServices>

/** A command failed in itself (a config or module that would not load, a pool that would not start): its report. */
export class CommandFailed extends Schema.TaggedError<
	CommandFailed,
	{ readonly brand: unique symbol }
>()("CommandFailed", { message: Schema.String }) {}

/** A command's own failures, of any kind, as CommandFailed with their report. */
const failing = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, CommandFailed, R> =>
	Effect.catchCause(effect, (cause) =>
		Effect.fail(CommandFailed.make({ message: Cause.pretty(cause) }))
	)

/** The repository a package root lies in: the nearest directory at or above it that holds `.git`. */
const repositoryOf = (start: string): Effect.Effect<string, CommandFailed, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		let at = start
		for (;;) {
			const found = yield* Effect.orElseSucceed(fs.exists(`${at}/.git`), () => false)
			if (found) {
				return at
			}
			const parent = Option.map(Str.lastIndexOf("/")(at), (slash) => Str.slice(0, slash)(at))
			if (Option.isNone(parent) || !Str.isNonEmpty(parent.value)) {
				return yield* CommandFailed.make({ message: `${start} lies in no git repository` })
			}
			at = parent.value
		}
	})

/** A judged kill as the gate reports it: killed, or why it fails the gate. */
const judgedLine = (judged: Judged): string => {
	const verdict = judged.verdict
	switch (verdict.kind) {
		case "killed":
			return `${judged.property}: killed: ${judged.kill.why}`
		case "survived":
			return `${judged.property}: SURVIVED${verdict.loaded ? "" : ", its workers never loaded the file"}: ${judged.kill.why} (${judged.kill.file})`
		case "stale":
			return `${judged.property}: STALE: ${verdict.stale.message}`
	}
}

/**
 * `kills [paths | ids]`: every kill of every property named applied in the checkout, each property's witnesses run on
 * workers leased for that kill alone (mutate/kills.ts); 1 when any kill survives or is stale.
 */
const kills = (selected: ReadonlyArray<string>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const repository = yield* repositoryOf(root)
			const checkout = yield* realPathOf(repository)
			const packageRoot = yield* realPathOf(root)
			const { discovered } = yield* loadPackage(root, selected)
			const trees = yield* treesOf(checkout)
			const images = yield* imagesOf(checkout, trees)
			const judged = yield* killsOf(
				mutantPoolOf(checkout, packageRoot),
				{ seed: 0, limits: runnerLimits },
				checkout,
				images,
				Arr.map(discovered, (found) => ({
					id: found.id,
					property: found.property,
					loading: loadingOf(found.property.needs)
				}))
			)
			yield* Console.log(Arr.join(Arr.map(judged, judgedLine), "\n"))
			return Arr.some(judged, (one) => one.verdict.kind !== "killed") ? 1 : 0
		})
	)

/**
 * The commands, by name. A lane's command is an entry here (affected, kills, mutate, fuzz), reading the package as
 * loadPackage and runPackage (run.ts) give it.
 */
const commands: Readonly<Record<string, Command>> = {
	run: (args) => failing(run(args)),
	replay: (args) => failing(replay(args)),
	kills: (args) => failing(kills(args)),
	affected: (args) => failing(affected(root, args)),
	fuzz: (args) => failing(fuzz(root, args))
}

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
	const command = Option.flatMap(Option.fromUndefinedOr(name), (named) =>
		Option.fromUndefinedOr(commands[named])
	)
	return yield* Option.match(command, {
		onNone: () =>
			Effect.as(
				Console.error(
					`toolchain-test: the commands are ${Arr.join(Rec.keys(commands), ", ")}; ${name ?? "none"} is none of them`
				),
				2
			),
		onSome: (chosen) => chosen(args)
	})
})

NodeRuntime.runMain(
	main.pipe(
		Effect.catchCause((cause) => Effect.as(Console.error(Cause.pretty(cause)), 2)),
		Effect.flatMap((status) =>
			Effect.sync(() => {
				process.exitCode = status
			})
		),
		Effect.provide(NodeServices.layer)
	)
)
