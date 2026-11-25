import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import {
	Array as Arr,
	Cause,
	Console,
	Effect,
	FileSystem,
	Formatter,
	Inspectable,
	Option,
	Predicate,
	Record as Rec,
	Result,
	Schema,
	String as Str
} from "effect"
import { replayOf, replayTokenOf } from "#replay.ts"
import type { RunKeying, Seeding } from "#runner/affected.ts"
import { toolchainTestCache } from "#runner/cache-home.ts"
import { fuzz } from "#runner/fuzz.ts"
import { keptValuesAt, requiredFlagsAt } from "#runner/load.ts"
import { type LoadKeying, loadCommand } from "#runner/loads.ts"
import { failureLines, lineOf } from "#runner/report.ts"
import {
	drawnSeed,
	emptyOutcome,
	givenSeed,
	loadPackage,
	replayToken,
	runPackage,
	translateToken
} from "#runner/run.ts"
import { affectedModule } from "#runner/settle.ts"
import { reportOf, type UsageReport, usageJson, usageLines } from "#runner/usage.ts"

/**
 * `toolchain-test`, the runner's command, run from a package's root (its test.config.ts):
 *
 *   toolchain-test run [paths | property ids]   every property (or those named): a pass its verdict key holds is
 *                                               its answer, every other's search runs at full width and its verdict
 *                                               is kept under its key; exit 1 on any failure. A run judges no kill
 *   toolchain-test replay <token>               the one case a failure printed, as it ran
 *   toolchain-test census [paths | property ids] whether each property caught a bug: a kill or an operator mutant of
 *                                               product source turns it red (mutate/census.ts); exit 1 on any that
 *                                               never did or cannot be judged
 *   toolchain-test kills [paths | property ids] the kill census: every kill of each property turns its witnesses red;
 *                                               exit 1 on any survivor, stale or unjudged kill (mutate/commands.ts)
 *   toolchain-test mutate <file>... [options]  operator mutation of the files, a measurement (mutate/commands.ts)
 *   toolchain-test verified <ref>               the push gate of a repository whose gate runs no property: every
 *                                               property the landing touched carries a green verdict at its closure
 *   toolchain-test fuzz <fuzztime> [paths | ids] the scheduled fuzz budget: fresh seeds round after round
 *   toolchain-test keep <id> <value file>       kept values as replay tokens, to paste into the property's kept
 *   toolchain-test kept migrate [paths | ids]   kept tokens written before a weighted decision recorded its option
 *                                               (71eb30f), rewritten in their modules as they are written now, once
 *
 * A run prints how it seeds first (each property by its verdict key, or TEST_SEED's for all), then each property its
 * cache answers, then one line per property it runs the moment its verdict lands (a failure's case, failure and replay
 * token under it, and what it observed past its key, if anything), then, once every search has ended, each failure
 * again, the run's CPU and its properties' wall time, the longest first, and how many properties were cached and run. A run answers whether the product is right: its searches.
 * Whether each test can still catch the bug it declares is the kill census's (`kills`), a command of its own, so no
 * command does both. Every process of the run, this one
 * and its workers, runs under the hardened flags and the config's export conditions: when this process was started
 * without them it starts itself again with them. A command is an entry of `commands`; a lane adds its own (kills, mutate, fuzz) there,
 * reading runPackage's results.
 */

/** The package root a command runs in: the directory it was started from. */
const root = process.cwd()

/**
 * Writes a run's CPU and wall-time report as JSON under toolchain-test's cache, beside every repository's verdicts:
 * `${XDG_CACHE_HOME:-~/.cache}/toolchain-test/runs/<seed>-<pid>.json`, and the same as `runs/last.json`, with the
 * package root, the run's seed and its wall time; and gives the run's path.
 */
const usageWritten = (packageRoot: string, seed: number, millis: number, usage: UsageReport) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const cache = yield* toolchainTestCache
		const runs = `${cache}/runs`
		const file = `${runs}/${seed}-${process.pid}.json`
		const json = yield* usageJson({ root: packageRoot, seed, millis, report: usage })
		yield* fs.makeDirectory(runs, { recursive: true })
		yield* fs.writeFileString(file, `${json}\n`)
		yield* fs.writeFileString(`${runs}/last.json`, `${json}\n`)
		return file
	})

/**
 * What a run reads of the verdict cache before it runs (affected.ts RunKeying): keyed, with the properties it answers
 * from the cache, the seed of every other and how it keeps their verdicts; unkeyed, saying why, every property run on
 * the run's one seed and nothing kept.
 */
const keyingOf = (selected: ReadonlyArray<string>, seeding: Seeding) =>
	Effect.flatMap(
		Effect.result(affectedModule),
		Result.match({
			onSuccess: (module) => module.runKeyingAt(root, selected, seeding),
			onFailure: (unloaded): Effect.Effect<RunKeying> =>
				Effect.succeed({ kind: "unkeyed", why: unloaded.message })
		})
	)

/**
 * `run [paths | ids]`: every property named, each answered from the verdict cache where its key holds a pass (affected.ts
 * runKeyingAt: its joint closure, the toolchain, its workers' environment, its PostgreSQL where it declares a database
 * template, and its seeds, each its key's unless TEST_SEED names one for all), every other's search run (runPackage) and
 * its verdict kept under its key, a pass only where no worker that ran it had observed past its key
 * (runner/observe.ts); then the run's JSON record, every failure and the run's usage, and each property said cached or
 * run; 1 when any search failed. A package with no verdict key runs every property, saying why. It judges no kill: that
 * is the kill census (`kills`).
 */
const run = (selected: ReadonlyArray<string>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const given = yield* givenSeed
			const seeding: Seeding = Option.match(given, {
				onNone: () => ({ kind: "derived" }),
				onSome: (seed) => ({ kind: "given", seed })
			})
			const keying = yield* keyingOf(selected, seeding)
			const drawn = yield* drawnSeed
			const seedOf =
				keying.kind === "keyed" ? keying.seedOf : () => Option.getOrElse(given, () => drawn)
			yield* Console.log(
				Option.match(given, {
					onSome: (seed) => `TEST_SEED=${seed}`,
					onNone: () =>
						keying.kind === "keyed"
							? "each property's rotating stream seeded by its verdict key (TEST_SEED=<n> seeds every property with n)"
							: `TEST_SEED=${drawn} (drawn by this run; set it to reproduce the run)`
				})
			)
			const cached = keying.kind === "keyed" ? keying.cached : []
			if (keying.kind === "unkeyed") {
				yield* Console.log(`verdicts not read or recorded: ${keying.why}`)
			}
			if (Arr.isReadonlyArrayNonEmpty(cached)) {
				yield* Console.log(
					Arr.join(
						Arr.map(cached, (one) => `${one.id}: CACHED: its verdict key holds a pass`),
						"\n"
					)
				)
			}
			const answered = new Set(Arr.map(cached, (one) => one.id))
			const { discovered } = yield* loadPackage(root, selected)
			const due = Arr.filter(discovered, (found) => !answered.has(found.id))
			const outcome = Arr.isReadonlyArrayNonEmpty(due)
				? yield* runPackage({
						root,
						seedOf,
						conductOf: keying.kind === "keyed" ? keying.conductOf : () => "clean",
						reach: "full",
						selected: Arr.map(due, (found) => found.id)
					})
				: emptyOutcome
			if (keying.kind === "keyed") {
				yield* keying.record(outcome)
			}
			const usage = reportOf(outcome.usage, outcome.properties)
			const written = yield* usageWritten(
				root,
				Option.getOrElse(given, () => drawn),
				outcome.millis,
				usage
			)
			const failed = Arr.filter(outcome.properties, (ran) => ran.verdict.kind === "failed")
			const failing = Arr.dedupe(Arr.map(failed, (ran) => ran.id)).length
			const observed = Arr.dedupe(
				Arr.map(
					Arr.filter(outcome.properties, (ran) => Option.isSome(ran.observed.unclean)),
					(ran) => ran.id
				)
			).length
			const ranCount = Arr.dedupe(Arr.map(outcome.properties, (ran) => ran.id)).length
			yield* Console.log(
				Arr.join(
					[
						...Arr.flatMap(failed, (ran) => ["", `${ran.label}:`, ...failureLines(ran.verdict)]),
						"",
						...usageLines(usage),
						`its CPU and wall time, every property's, as JSON: ${written}`,
						"",
						`${discovered.length} properties: ${cached.length} cached, ${ranCount} run (${observed} observed past their keys, never cached), ${failing} failed, in ${Math.round(outcome.millis)} ms on ${outcome.workers.length} workers`
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

/**
/** A command's own failures, of any kind, as CommandFailed with their report. */
const failing = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
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
 * The mutator's module (mutate/commands.ts, with mutants.ts), which loads TypeScript's native compiler, an optional peer
 * of the library, as the verdict cache's does (settle.ts affectedModule): only the commands that use them load them, so
 * `run`, `replay`, `fuzz` and `keep` start without TypeScript installed.
 */
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

/** What `kept migrate` did with one kept token: moved it to `to`, left it as it is, or could not move it, and why. */
type Migrated =
	| Readonly<{ kind: "moved"; module: string; from: string; to: string }>
	| Readonly<{ kind: "unchanged"; token: string }>
	| Readonly<{ kind: "unmoved"; token: string; why: string }>

/**
 * One kept token of a property of `module` migrated (run.ts translateToken): its case run on its values read as they
 * were meant, kept as recorded now, and that new token replayed, which must pass as its token says; a token the
 * migration leaves as it is is unchanged.
 */
const migratedToken = (module: string, token: string) =>
	Effect.gen(function* () {
		const named = yield* Effect.mapError(replayOf(token), (unreadable) => unreadable.message)
		const translation = yield* translateToken(root, named.suite, token)
		if (translation.kind === "untranslated") {
			return { kind: "unmoved", token, why: translation.why } satisfies Migrated
		}
		const moved = replayTokenOf(named.suite, translation.replayed)
		if (moved === token) {
			return { kind: "unchanged", token } satisfies Migrated
		}
		const replayed = yield* replayToken(root, named.suite, moved)
		return replayed.verdict.kind === "replayed"
			? ({ kind: "moved", module, from: token, to: moved } satisfies Migrated)
			: ({
					kind: "unmoved",
					token,
					why: `its migrated token ${moved} does not replay as it says: ${Arr.join(failureLines(replayed.verdict), " ")}`
				} satisfies Migrated)
	})

/**
 * `kept migrate [paths | property ids]`: every kept token of the properties named (every property of the package with
 * none named), written before a weighted decision recorded its option (toolchain 71eb30f), migrated (migratedToken)
 * and rewritten in its module where it moved, the literal's text replaced where the module holds it once. Each token is
 * printed moved, unchanged or unmoved with why; 1 when any is unmoved. A token is read as written before 71eb30f
 * whatever it is, so the command runs once, at the bump past it: run again, it would read a migrated token's options as
 * units.
 */
const kept = (args: ReadonlyArray<string>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const [verb, ...selected] = args
			if (verb !== "migrate") {
				return yield* CommandFailed.make({
					message: "kept takes migrate: toolchain-test kept migrate [paths | property ids]"
				})
			}
			const fs = yield* FileSystem.FileSystem
			const { discovered } = yield* loadPackage(root, selected)
			const migrated = yield* Effect.forEach(
				Arr.flatMap(discovered, (one) =>
					Arr.map(one.property.kept, (entry) => ({ module: one.module, token: entry.token }))
				),
				({ module, token }) => migratedToken(module, token),
				{ concurrency: "unbounded" }
			)
			const moves = Arr.filter(
				migrated,
				(one): one is Extract<Migrated, { kind: "moved" }> => one.kind === "moved"
			)
			const written = yield* Effect.forEach(
				Arr.dedupe(Arr.map(moves, (move) => move.module)),
				(module) =>
					Effect.gen(function* () {
						const path = `${root}/${module}`
						const text = yield* fs.readFileString(path)
						const ofModule = Arr.filter(moves, (move) => move.module === module)
						const once = Arr.filter(
							ofModule,
							(move) => Str.split(`"${move.from}"`)(text).length === 2
						)
						yield* fs.writeFileString(
							path,
							Arr.reduce(once, text, (rewritten, move) =>
								Str.replace(`"${move.from}"`, `"${move.to}"`)(rewritten)
							)
						)
						return Arr.map(ofModule, (move): Migrated =>
							Arr.contains(once, move)
								? move
								: {
										kind: "unmoved",
										token: move.from,
										why: `${module} does not hold its literal "${move.from}" once`
									}
						)
					})
			)
			const outcomes = [
				...Arr.filter(migrated, (one) => one.kind !== "moved"),
				...Arr.flatten(written)
			]
			yield* Console.log(
				Arr.join(
					Arr.map(outcomes, (one) => {
						switch (one.kind) {
							case "moved":
								return `moved ${one.from} -> ${one.to}`
							case "unchanged":
								return `unchanged ${one.token}`
							case "unmoved":
								return `UNMOVED ${one.token}: ${one.why}`
						}
					}),
					"\n"
				)
			)
			return Arr.some(outcomes, (one) => one.kind === "unmoved") ? 1 : 0
		})
	)

/**
 * `load`: every test module the runner config includes loaded apart, but those whose closure loaded before
 * (loads.ts loadCommand), keyed by the repository's load cache (affected.ts loadKeyingAt) where the closure hasher
 * loads, and with none recorded, saying why, where it does not; 1 when any module failed to load.
 */
const load = (args: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		if (Arr.isReadonlyArrayNonEmpty(args)) {
			return yield* CommandFailed.make({ message: "load takes no argument: toolchain-test load" })
		}
		return yield* loadCommand(root, (config, modules) =>
			Effect.flatMap(
				Effect.result(affectedModule),
				Result.match({
					onSuccess: (module) => module.loadKeyingAt(root, config, modules),
					onFailure: (unloaded) =>
						Effect.succeed({ kind: "unkeyed", why: unloaded.message } satisfies LoadKeying)
				})
			)
		)
	})

/**
 * The commands, by name. A lane's command is an entry here (affected, kills, mutate, fuzz, load), reading the package
 * as loadPackage and runPackage (run.ts) give it.
 */
const commands: Readonly<Record<string, Command>> = {
	run: (args) => failing(run(args)),
	replay: (args) => failing(replay(args)),
	census: (args) =>
		failing(Effect.flatMap(mutateModule, (module) => module.censusCommand(root, args))),
	kills: (args) =>
		failing(Effect.flatMap(mutateModule, (module) => module.killsCommand(root, args))),
	mutate: (args) =>
		failing(Effect.flatMap(mutateModule, (module) => module.mutateCommand(root, args))),
	verified: (args) =>
		failing(Effect.flatMap(affectedModule, (module) => module.verified(root, args))),
	fuzz: (args) => failing(fuzz(root, args)),
	load: (args) => failing(load(args)),
	keep: (args) => failing(keep(args)),
	kept: (args) => failing(kept(args))
}

/**
 * Runs a command under the flags it needs: in this process when it already has them, otherwise in a new process of
 * this script with them added, whose exit status this one answers.
 */
const main = Effect.gen(function* () {
	const [name, ...args] = Arr.drop(process.argv, 2)
	const required = yield* requiredFlagsAt(root)
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
