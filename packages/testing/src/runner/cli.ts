import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { regex } from "arkregex"
import {
	Array as Arr,
	Cause,
	Config,
	Console,
	Effect,
	FileSystem,
	Formatter,
	Inspectable,
	Option,
	Predicate,
	Random,
	Record as Rec,
	Result,
	Schema
} from "effect"
import { replayOf, replayTokenOf } from "#replay.ts"
import { compileCached } from "#runner/compile-cache.ts"
import { HARDENED_FLAGS } from "#runner/config.ts"
import { fuzz } from "#runner/fuzz.ts"
import { configOf, keptValuesAt } from "#runner/load.ts"
import { failureLines, lineOf } from "#runner/report.ts"
import { loadPackage, replayToken, runPackage } from "#runner/run.ts"
import { reportOf, type UsageReport, usageJson, usageLines } from "#runner/usage.ts"

/**
 * `toolchain-test`, the runner's command, run from a package's root (its test.config.ts):
 *
 *   toolchain-test run [paths | property ids]   every property (or those named), at full width, and the kills of each
 *                                               that passed, every verdict cached; exit 1 on any failure or survivor
 *   toolchain-test replay <token>               the one case a failure printed, as it ran
 *   toolchain-test kills [paths | property ids] each property's kills turn its witnesses red; exit 1 on any survivor
 *                                               or stale kill (mutate/commands.ts)
 *   toolchain-test mutate <file>... [options]  operator mutation of the files, a measurement (mutate/commands.ts)
 *   toolchain-test affected <ref>               the push gate: every property with no cached pass, and its kills
 *   toolchain-test fuzz <fuzztime> [paths | ids] the scheduled fuzz budget: fresh seeds round after round
 *   toolchain-test keep <id> <value file>       kept values as replay tokens, to paste into the property's kept
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

/**
 * Writes a run's CPU report as JSON under toolchain-test's cache, beside every repository's verdicts:
 * `${XDG_CACHE_HOME:-~/.cache}/toolchain-test/runs/<seed>-<pid>.json`, and the same as `runs/last.json`, with the
 * package root, the run's seed and its wall time; and gives the run's path.
 */
const usageWritten = (packageRoot: string, seed: number, millis: number, usage: UsageReport) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const home = yield* Config.String("HOME")
		const cacheHome = yield* Config.withDefault(Config.String("XDG_CACHE_HOME"), `${home}/.cache`)
		const runs = `${cacheHome}/toolchain-test/runs`
		const file = `${runs}/${seed}-${process.pid}.json`
		const json = yield* usageJson({ root: packageRoot, seed, millis, report: usage })
		yield* fs.makeDirectory(runs, { recursive: true })
		yield* fs.writeFileString(file, `${json}\n`)
		yield* fs.writeFileString(`${runs}/last.json`, `${json}\n`)
		return file
	})

/**
 * `run [paths | ids]`, the full run per production version: every property named, reading no cached pass; then the
 * kills of each whose searches passed, and every verdict recorded in the verdict cache (affected.ts recordedRun); each
 * run's line, every judged kill, then every failure; 1 when any search failed or any kill did not turn its property red.
 */
const run = (selected: ReadonlyArray<string>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const { seed, drawn } = yield* seedOf
			yield* Console.log(
				`TEST_SEED=${seed}${drawn ? " (drawn by this run; set it to reproduce the run)" : ""}`
			)
			const outcome = yield* runPackage({ root, seed, reach: "full", selected })
			const loaded = yield* Effect.result(affectedModule)
			const { judged, passing } = yield* Result.match(loaded, {
				onSuccess: (module) =>
					Effect.map(module.recordedRun(root, selected, outcome), (settled) => ({
						judged: settled.lines,
						passing: settled.passing
					})),
				onFailure: (failure) =>
					Effect.as(Console.log(`kills not judged and verdicts not recorded: ${failure.message}`), {
						judged: [],
						passing: new Set(
							Arr.filter(
								Arr.map(outcome.properties, (ran) => ran.id),
								(id) =>
									!Arr.some(
										outcome.properties,
										(ran) => ran.id === id && ran.verdict.kind === "failed"
									)
							)
						)
					})
			})
			const usage = reportOf(outcome.usage)
			const written = yield* usageWritten(root, seed, outcome.millis, usage)
			const failed = Arr.filter(outcome.properties, (ran) => ran.verdict.kind === "failed")
			const failing = Arr.filter(
				Arr.dedupe(Arr.map(outcome.properties, (ran) => ran.id)),
				(id) => !passing.has(id)
			).length
			yield* Console.log(
				Arr.join(
					[
						...Arr.map(outcome.properties, (ran) => lineOf(ran.label, ran.oracle, ran.verdict)),
						...judged,
						...Arr.flatMap(failed, (ran) => ["", `${ran.label}:`, ...failureLines(ran.verdict)]),
						"",
						...usageLines(usage),
						`its CPU, as JSON: ${written}`,
						"",
						`${outcome.properties.length} properties, ${failing} failed, in ${Math.round(outcome.millis)} ms on ${outcome.workers.length} workers`
					],
					"\n"
				)
			)
			return failing > 0 ? 1 : 0
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
type Command = (
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
		Effect.fail(
			CommandFailed.make({
				message: Option.match(Cause.findErrorOption(cause), {
					onNone: () => Cause.pretty(cause),
					onSome: (error) =>
						Schema.is(CommandFailed)(error) ? error.message : Inspectable.toStringUnknown(error)
				})
			})
		)
	)

/**
 * The modules that load TypeScript's native compiler, an optional peer of the library: the verdict cache's
 * (affected.ts, with closure.ts) and the mutator's (mutate/commands.ts, with mutants.ts). Only the commands that use
 * them load them, so `run`, `replay`, `fuzz` and `keep` start without TypeScript installed.
 */
const affectedModule = Effect.tryPromise({
	try: () => import("#runner/affected.ts"),
	catch: (cause) =>
		CommandFailed.make({
			message: `the closure hasher did not load (TypeScript 7, an optional peer, must be installed): ${Predicate.isError(cause) ? cause.message : Inspectable.toStringUnknown(cause)}`
		})
})

const mutateModule = Effect.tryPromise({
	try: () => import("#mutate/commands.ts"),
	catch: (cause) =>
		CommandFailed.make({
			message: `the mutator did not load (TypeScript 7, an optional peer, must be installed): ${Predicate.isError(cause) ? cause.message : Inspectable.toStringUnknown(cause)}`
		})
})

/**
 * `keep <id> <value file>`: each value the file keeps (its default export, an array of { value, reason, since }) as the
 * replay token of the case the property's space draws it from (keep.ts), printed as a kept entry to paste into the
 * property's `kept`; a value no tape draws is reported with why. 1 when any value has no token.
 */
const keep = (args: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const [id, file] = args
		if (id === undefined || file === undefined) {
			return yield* CommandFailed.make({
				message: "keep takes a property and a value file: toolchain-test keep <id> <value file>"
			})
		}
		const { discovered } = yield* loadPackage(root, [id])
		const found = yield* Effect.mapError(
			Effect.fromOption(Arr.findFirst(discovered, (one) => one.id === id)),
			() => CommandFailed.make({ message: `${id} names no property of this package` })
		)
		const values = yield* keptValuesAt(root, file)
		const tokens = Arr.map(values, (value) => ({
			kept: value,
			keeping: found.property.keep(value.value)
		}))
		yield* Console.log(
			Arr.join(
				Arr.map(tokens, ({ kept, keeping }) => {
					switch (keeping.kind) {
						case "found":
							return `{ token: ReplayToken(${Formatter.format(replayTokenOf(id, keeping.replayed))}), reason: ${Formatter.format(kept.reason)}, since: ${Formatter.format(kept.since)} },`
						case "unfound":
							return `UNFOUND ${Formatter.format(kept.reason)}: ${keeping.why}`
					}
				}),
				"\n"
			)
		)
		return Arr.some(tokens, ({ keeping }) => keeping.kind === "unfound") ? 1 : 0
	})

/**
 * The commands, by name. A lane's command is an entry here (affected, kills, mutate, fuzz), reading the package as
 * loadPackage and runPackage (run.ts) give it.
 */
const commands: Readonly<Record<string, Command>> = {
	run: (args) => failing(run(args)),
	replay: (args) => failing(replay(args)),
	kills: (args) =>
		failing(Effect.flatMap(mutateModule, (module) => module.killsCommand(root, args))),
	mutate: (args) =>
		failing(Effect.flatMap(mutateModule, (module) => module.mutateCommand(root, args))),
	affected: (args) =>
		failing(Effect.flatMap(affectedModule, (module) => module.affected(root, args))),
	fuzz: (args) => failing(fuzz(root, args)),
	keep: (args) => failing(keep(args))
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
	yield* compileCached
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
