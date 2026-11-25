import { parseArgs } from "node:util"
import { layerDigest } from "@effect/platform-node/NodeCrypto"
import {
	Array as Arr,
	Console,
	Effect,
	FileSystem,
	Layer,
	Option,
	Order,
	Path,
	Result,
	Schema,
	String as Str
} from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { stopwatch } from "#live.ts"
import { applied, OPERATORS } from "#mutants.ts"
import { type Catch, type Counted, censusOf, type Reading, type Standing } from "#mutate/census.ts"
import { loadingOf } from "#mutate/checkout.ts"
import { foreignPool, foreignSubject } from "#mutate/foreign.ts"
import { imagesOf } from "#mutate/image.ts"
import { type Judged, killsOf, redText } from "#mutate/kills.ts"
import { mutatorPool } from "#mutate/lease.ts"
import { realPathOf } from "#mutate/mutated.ts"
import { type Choice, type MutantJudged, mutationOf } from "#mutate/operators.ts"
import type { MutantPool } from "#mutate/pool.ts"
import { isMutable, listedReport, namedFiles } from "#mutate/report.ts"
import type { Subject } from "#mutate/schedule.ts"
import { treesOf } from "#mutate/tree.ts"
import { unjudgedText } from "#mutate/verdict.ts"
import { importClosuresAt, noVerdicts, trackedIn, verdictsAt } from "#runner/affected.ts"
import { editOf } from "#runner/cache.ts"
import { moduleSyntax } from "#runner/closure.ts"
import type { Mutation, RunnerConfig } from "#runner/config.ts"
import { workerEnvironmentOf } from "#runner/environment.ts"
import { runnerLimits } from "#runner/limits.ts"
import { type Discovered, statedConfigOf } from "#runner/load.ts"
import { loadPackage } from "#runner/run.ts"
import { productOf } from "#scope.ts"

/**
 * The mutator's commands, `toolchain-test kills`, `census` and `mutate` (runner/cli.ts's entries), run from a package
 * root inside a git checkout: the kill census, the census of caught bugs, and operator mutation, a measurement.
 */

/** A command's own refusal: arguments it cannot read, or a package root in no checkout. */
export class MutatorRefused extends Schema.TaggedError<
	MutatorRefused,
	{ readonly brand: unique symbol }
>()("MutatorRefused", { message: Schema.String }) {}

/** The checkout a package root lies in: the nearest directory at or above it that holds `.git`. */
const checkoutOf = (root: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		let at = path.resolve(root)
		for (;;) {
			const found = yield* fs.exists(path.join(at, ".git"))
			if (found) {
				return yield* realPathOf(at)
			}
			const parent = path.dirname(at)
			if (parent === at) {
				return yield* MutatorRefused.make({ message: `${root} lies in no git checkout` })
			}
			at = parent
		}
	})

/** The properties a command runs, as the mutator reads them: each with how its workers load the code. */
const subjectsOf = (discovered: ReadonlyArray<Discovered>): ReadonlyArray<Subject> =>
	Arr.map(discovered, (found) => ({
		id: found.id,
		property: found.property,
		loading: loadingOf(found.property.needs)
	}))

/** A judged kill on one line: killed, or why it fails the gate. */
export const judgedLine = (judged: Judged): string => {
	const { verdict, kill, property } = judged
	switch (verdict.kind) {
		case "killed":
			return `${property}: killed: ${kill.why}`
		case "survived":
			return `${property}: SURVIVED: ${kill.why} (${kill.file}), ${verdict.loaded ? "every witness passed with it applied" : "its workers never loaded the file: a check that runs it in a child process needs Checkout.dir"}`
		case "stale":
			return `${property}: STALE: ${verdict.stale.message}`
		case "unjudged":
			return `${property}: UNJUDGED: ${kill.why}, since ${unjudgedText(verdict.why, redText(verdict.red))}`
	}
}

/** What a kill that fails the gate prints under its property's line. */
const failingLine = (judged: Judged): ReadonlyArray<string> => {
	const { verdict, kill } = judged
	switch (verdict.kind) {
		case "killed":
			return []
		case "survived":
			return [
				`  SURVIVED ${kill.file}: ${kill.why}`,
				verdict.loaded
					? "    every witness passed with the kill applied"
					: "    its workers never loaded the file: a check that runs it in a child process needs Checkout.dir"
			]
		case "stale":
			return [`  STALE ${verdict.stale.message}`]
		case "unjudged":
			return [
				`  UNJUDGED ${kill.file}: ${kill.why}`,
				`    ${unjudgedText(verdict.why, redText(verdict.red))}`
			]
	}
}

/**
 * `kills [paths | ids]`, the kill census, the one command that judges a property's kills (no run does: a run answers
 * whether the product is right, this whether each test can still catch the bug it declares): every kill of every
 * property named, each applied in the checkout and the property's witnesses run on workers leased for that kill alone
 * (mutate/kills.ts), every kill at once over the pool, but a kill the verdict cache answers (runner/affected.ts: it
 * turned its property red under the same closure, kill and file content) is not run again, and each judged kill's
 * verdict is recorded. One line per property with kills, each failing kill under it, each cached kill, and a summary;
 * 1 when any kill survives, is stale or is unjudged.
 */
export const killsCommand = (root: string, selected: ReadonlyArray<string>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const timed = yield* stopwatch
			const checkout = yield* checkoutOf(root)
			const packageRoot = yield* realPathOf(root)
			const { config, discovered } = yield* loadPackage(root, selected)
			const verdicts = (yield* verdictsAt(root, config, discovered, [])).kills
			const { fresh, cached } = yield* verdicts.split(
				Arr.filter(discovered, (found) => Arr.isReadonlyArrayNonEmpty(found.property.kills))
			)
			const subjects = subjectsOf(fresh)
			const pool = yield* mutatorPool(
				checkout,
				packageRoot,
				workerEnvironmentOf(config.environment, process.env)
			)
			const trees = yield* treesOf(checkout)
			const images = yield* imagesOf(checkout, trees)
			const judged = yield* killsOf(
				pool,
				{ seed: 0, limits: runnerLimits },
				checkout,
				images,
				subjects
			)
			yield* verdicts.record(judged)
			const took = yield* timed.elapsed
			const byProperty = Arr.map(subjects, (subject): readonly [Subject, ReadonlyArray<Judged>] => [
				subject,
				Arr.filter(judged, (one) => one.property === subject.id)
			])
			const count = (kind: Judged["verdict"]["kind"]) =>
				Arr.filter(judged, (one) => one.verdict.kind === kind).length
			yield* Console.log(
				Arr.join(
					[
						...Arr.flatMap(byProperty, ([subject, its]) => [
							`${subject.id}: ${String(Arr.filter(its, (one) => one.verdict.kind === "killed").length)} of ${String(its.length)} kills killed`,
							...Arr.flatMap(its, failingLine)
						]),
						...Arr.map(
							cached,
							(one) => `${one.property}: killed (a cached verdict): ${one.kill.why}`
						),
						"",
						`${String(judged.length)} kills of ${String(subjects.length)} properties: ${String(count("killed"))} killed, ${String(count("survived"))} survived, ${String(count("stale"))} stale, ${String(count("unjudged"))} unjudged, in ${String(Math.round(took))} ms on ${String(pool.width)} workers; ${String(cached.length)} kills a cached verdict answered`
					],
					"\n"
				)
			)
			return Arr.some(judged, (one) => one.verdict.kind !== "killed") ? 1 : 0
		})
	)

/** What `mutate` reads from its arguments. */
type MutateArgs = Readonly<{
	files: Arr.NonEmptyReadonlyArray<string>
	against: ReadonlyArray<string>
	operators: ReadonlyArray<string>
	choice: Choice
}>

const Count = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0))

const Seed = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))

const refusedWith = (message: string) => () => MutatorRefused.make({ message })

/**
 * `mutate <file | directory>... [--against <path | id>]... [--operator <name>]... [--sample <n> --seed <s> | --mutant <id>...]`,
 * the files and source directories from the package root.
 */
const mutateArgsOf = (args: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const usage =
			"mutate <file | directory>... [--against <path | id>]... [--operator <name>]... [--sample <n> --seed <s> | --mutant <id>...]"
		const { values, positionals } = yield* Effect.try({
			try: () =>
				parseArgs({
					args: Arr.copy(args),
					allowPositionals: true,
					options: {
						against: { type: "string", multiple: true },
						operator: { type: "string", multiple: true },
						sample: { type: "string" },
						seed: { type: "string" },
						mutant: { type: "string", multiple: true }
					}
				}),
			catch: (cause) => MutatorRefused.make({ message: `${String(cause)}: ${usage}` })
		})
		if (!Arr.isReadonlyArrayNonEmpty(positionals)) {
			return yield* MutatorRefused.make({ message: `name the files to mutate: ${usage}` })
		}
		const files = positionals
		const sample = Option.fromUndefinedOr(values.sample)
		const seed = Option.fromUndefinedOr(values.seed)
		const mutants = values.mutant ?? []
		const choice: Choice = yield* Option.match(sample, {
			onNone: () =>
				Option.isSome(seed)
					? Effect.fail(MutatorRefused.make({ message: `--seed draws a --sample: ${usage}` }))
					: Effect.succeed<Choice>(
							Arr.isReadonlyArrayNonEmpty(mutants)
								? { kind: "named", ids: new Set(mutants) }
								: { kind: "every" }
						),
			onSome: (count) =>
				Effect.gen(function* () {
					if (Arr.isReadonlyArrayNonEmpty(mutants)) {
						return yield* MutatorRefused.make({
							message: `--sample and --mutant choose mutants two ways; name one: ${usage}`
						})
					}
					const given = yield* Effect.mapError(
						Effect.fromOption(seed),
						refusedWith(`a --sample is drawn by a --seed, which names none: ${usage}`)
					)
					const decodedCount = yield* Effect.mapError(
						Schema.decodeEffect(Count)(count),
						refusedWith(`--sample takes a whole number above zero, not ${count}`)
					)
					const decodedSeed = yield* Effect.mapError(
						Schema.decodeEffect(Seed)(given),
						refusedWith(`--seed takes a whole number, not ${given}`)
					)
					const sampled: Choice = { kind: "sample", count: decodedCount, seed: decodedSeed }
					return sampled
				})
		})
		const parsed: MutateArgs = {
			files,
			against: values.against ?? [],
			operators: values.operator ?? [],
			choice
		}
		return parsed
	})

/**
 * What a package's mutation runs add to the library's operators, loaded here and only here: `toolchain-test mutate` is
 * the one command that calls its config's load, so no run, worker or launcher imports what its families read.
 */
export const loadedMutation = (config: RunnerConfig): Effect.Effect<Mutation, MutatorRefused> =>
	Effect.tryPromise({
		try: config.mutation,
		catch: (cause) =>
			MutatorRefused.make({
				message: `test.config.ts's mutation did not load: ${String(cause)}`
			})
	})

/**
 * The run's operators each with how many of its mutants the run judged, in the order the run names them, so an operator
 * that found no site (a family aimed at code that moved) reads 0.
 */
const operatorsLine = (
	operators: ReadonlyArray<string>,
	judged: ReadonlyArray<MutantJudged<string>>
): string =>
	`by operator: ${Arr.join(
		Arr.map(
			operators,
			(operator) =>
				`${operator} ${String(Arr.filter(judged, ({ mutant }) => mutant.operator === operator).length)}`
		),
		", "
	)}`

/**
 * `mutate <file | directory>... [--against <path | id>]... [--operator <name>]... [--sample <n> --seed <s> | --mutant <id>...]`:
 * operator mutation of the files the paths name (from the package root: a file, or a source directory, every mutable
 * file of product source below it, report.ts namedFiles; a path naming none is refused) by the library's operators and the runner config's
 * families, but for the mutants it judges equivalent (its Mutation, loadedMutation), against the properties
 * `--against` names (every property of the package when it names none), on the pool (mutate/operators.ts), each kill
 * recorded in the verdict cache under its edit (runner/affected.ts EditVerdicts), which the census reads. A
 * measurement: it prints its counts, its score, its mutants by operator, and its survivors and its uncovered mutants
 * (those no property it ran against ran), each by file and operator (report.ts listedReport), and
 * answers 0 whatever it measured; a refusal (an equivalent judgment gone stale, a property red with no mutant, a probe a
 * property survived, a package that does not typecheck) is the command's failure.
 */
export const mutateCommand = (root: string, args: ReadonlyArray<string>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const path = yield* Path.Path
			const timed = yield* stopwatch
			const parsed = yield* mutateArgsOf(args)
			const checkout = yield* checkoutOf(root)
			const packageRoot = yield* realPathOf(root)
			const { config, discovered } = yield* loadPackage(root, parsed.against)
			const mutation = yield* loadedMutation(config)
			const subjects = yield* Effect.mapError(
				Effect.fromOption(
					Option.liftPredicate(subjectsOf(discovered), Arr.isReadonlyArrayNonEmpty)
				),
				refusedWith(`no property of ${root} is named by ${Arr.join(parsed.against, ", ")}`)
			)
			const every: ReadonlyArray<string> = [
				...OPERATORS,
				...Arr.flatMap(mutation.families, (family) => family.operators)
			]
			const unknown = Arr.filter(parsed.operators, (operator) => !Arr.contains(every, operator))
			if (Arr.isReadonlyArrayNonEmpty(unknown)) {
				return yield* MutatorRefused.make({
					message: `no operator is named ${Arr.join(unknown, ", ")}; the operators are ${Arr.join(every, ", ")}`
				})
			}
			const tracked = yield* Effect.mapError(trackedIn(checkout), (refused) =>
				MutatorRefused.make({ message: refused.message })
			)
			const files = yield* Result.match(
				namedFiles(
					tracked,
					productOf(tracked),
					Arr.map(parsed.files, (file): string => path.relative(checkout, path.resolve(root, file)))
				),
				{
					onSuccess: (named) => Effect.succeed(named),
					onFailure: (unnamed) =>
						MutatorRefused.make({
							message: `${Arr.join(unnamed, ", ")} names no file of the repository and no source directory holding one`
						})
				}
			)
			const pool = yield* mutatorPool(
				checkout,
				packageRoot,
				workerEnvironmentOf(config.environment, process.env)
			)
			const trees = yield* treesOf(checkout)
			const images = yield* imagesOf(checkout, trees)
			const operators = Arr.isReadonlyArrayNonEmpty(parsed.operators) ? parsed.operators : every
			const judged = yield* mutationOf(pool, images, {
				witnesses: { seed: 0, limits: runnerLimits },
				checkout,
				pkg: packageRoot,
				subjects,
				files,
				families: mutation.families,
				equivalent: mutation.equivalent,
				operators: new Set(operators),
				choice: parsed.choice
			})
			const { edits } = yield* verdictsAt(root, config, discovered, files)
			const hashing = yield* Layer.build(Layer.merge(moduleSyntax, layerDigest))
			yield* Effect.forEach(
				judged,
				({ mutant, verdict }) =>
					verdict.kind === "killed"
						? Effect.flatMap(editOf(mutant.file, mutant.source, applied(mutant)), (edit) =>
								Option.match(edit, {
									onNone: () => Effect.void,
									onSome: (one) => edits.record(verdict.property, one, true)
								})
							)
						: Effect.void,
				{ discard: true }
			).pipe(Effect.provide(hashing))
			const took = yield* timed.elapsed
			const count = (kind: MutantJudged<string>["verdict"]["kind"]) =>
				Arr.filter(judged, ({ verdict }) => verdict.kind === kind).length
			const killed = count("killed")
			const survived = count("survived")
			yield* Console.log(
				Arr.join(
					[
						`mutate: ${String(judged.length)} mutants of ${Arr.join(files, ", ")} against ${String(subjects.length)} properties: ${String(killed)} killed, ${String(survived)} survived, ${String(count("invalid"))} invalid, ${String(count("uncovered"))} uncovered, ${String(count("equivalent"))} equivalent; score ${String(killed)}/${String(killed + survived)}, in ${String(Math.round(took))} ms on ${String(pool.width)} workers`,
						operatorsLine(Arr.dedupe(operators), judged),
						...(survived > 0
							? ["survivors, by file and operator:", ...listedReport(judged, "survived")]
							: []),
						...(count("uncovered") > 0
							? ["uncovered, by file and operator:", ...listedReport(judged, "uncovered")]
							: [])
					],
					"\n"
				)
			)
			return 0
		})
	)

/** A text on one line of a table: its tabs and line breaks as spaces. */
const cell = (text: string): string =>
	Arr.join(
		Arr.map(Arr.fromIterable(text), (character) =>
			character === "\t" || character === "\n" || character === "\r" ? " " : character
		),
		""
	)

/** What showed that a property caught a bug, as its row says it. */
const caughtBy = (by: Catch): string => {
	switch (by.kind) {
		case "kill":
			return `kill: ${by.kill.why} (${by.kill.file})`
		case "mutant":
			return `mutant ${by.mutant.id} ${by.mutant.file}:${String(by.mutant.line)}:${String(by.mutant.column)} in ${by.mutant.fn}: ${by.mutant.original} -> ${by.mutant.replacement}`
	}
}

/** What showed a property's standing and why the census could not judge it, as its row says them. */
const shownBy = (standing: Standing): Readonly<{ by: string; why: string }> => {
	switch (standing.kind) {
		case "catches":
			return { by: caughtBy(standing.by), why: "" }
		case "never-caught":
			return { by: "", why: "" }
		case "unjudged":
			return { by: "", why: standing.why }
	}
}

/** The census table's header. */
const CENSUS_HEADER = [
	"property",
	"module",
	"standing",
	"by",
	"product kills",
	"killed",
	"other kills",
	"kept",
	"mutants tried",
	"why"
] as const

/** A property's row of the census table. */
const censusRow = (module: string, counted: Counted): string => {
	const { by, why } = shownBy(counted.standing)
	return Arr.join(
		Arr.map(
			[
				counted.id,
				module,
				counted.standing.kind,
				by,
				String(counted.productKills),
				String(counted.killedKills),
				String(counted.otherKills),
				String(counted.kept),
				String(counted.tried),
				why
			],
			cell
		),
		"\t"
	)
}

/** What `census` reads from its arguments: the properties it names, and a foreign command's modules. */
type CensusArgs = Readonly<{
	selected: ReadonlyArray<string>
	foreign: Option.Option<
		Readonly<{
			command: Arr.NonEmptyReadonlyArray<string>
			modules: Arr.NonEmptyReadonlyArray<string>
		}>
	>
}>

/** `census [paths | ids] [--foreign-command <command> --foreign <module>...]`. */
const censusArgsOf = (args: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const usage = "census [paths | ids] [--foreign-command <command> --foreign <module>...]"
		const { values, positionals } = yield* Effect.try({
			try: () =>
				parseArgs({
					args: Arr.copy(args),
					allowPositionals: true,
					options: {
						"foreign-command": { type: "string" },
						foreign: { type: "string", multiple: true }
					}
				}),
			catch: (cause) => MutatorRefused.make({ message: `${String(cause)}: ${usage}` })
		})
		const command = Arr.filter(Str.split(" ")(values["foreign-command"] ?? ""), Str.isNonEmpty)
		const modules = values.foreign ?? []
		if (Arr.isReadonlyArrayNonEmpty(command) !== Arr.isReadonlyArrayNonEmpty(modules)) {
			return yield* MutatorRefused.make({
				message: `--foreign-command and --foreign come together, the command and the modules it runs: ${usage}`
			})
		}
		const parsed: CensusArgs = {
			selected: positionals,
			foreign:
				Arr.isReadonlyArrayNonEmpty(command) && Arr.isReadonlyArrayNonEmpty(modules)
					? Option.some({ command, modules })
					: Option.none()
		}
		return parsed
	})

/**
 * `census [paths | ids] [--foreign-command <command> --foreign <module>...]`: whether each property named (every one of
 * the package when neither a property nor a foreign module is) has caught a bug (mutate/census.ts), its kills of
 * product source judged and, where none turned it red, the operator mutants of the product source it runs tried until
 * one does, on the pool, every verdict read from and kept in the verdict cache; and each module of a foreign test
 * command (a Vitest file, run as `<command> <module>` in the package root: mutate/foreign.ts) judged the same way, its
 * run whole its one witness. Product source is every file the checkout's repository holds outside test scope
 * (scope.ts); the mutants are of its TypeScript under the package root, by the library's operators and the config's
 * families, but those it judges equivalent. Standard output is the census as a table, a header and a tab-separated row
 * a test; standard error has each test's standing as it is settled and the counts. 1 when any test never caught a bug
 * or could not be judged.
 */
export const censusCommand = (root: string, args: ReadonlyArray<string>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const path = yield* Path.Path
			const timed = yield* stopwatch
			const parsed = yield* censusArgsOf(args)
			const checkout = yield* checkoutOf(root)
			const packageRoot = yield* realPathOf(root)
			const runsProperties =
				Arr.isReadonlyArrayNonEmpty(parsed.selected) || Option.isNone(parsed.foreign)
			const loaded = runsProperties
				? yield* Effect.asSome(loadPackage(root, parsed.selected))
				: Option.none()
			const config = Option.isSome(loaded)
				? Option.some(loaded.value.config)
				: yield* statedConfigOf(root)
			const properties = Option.match(loaded, {
				onNone: () => [],
				onSome: (package_) => package_.discovered
			})
			const mutation = yield* Option.match(config, {
				onNone: () => Effect.succeed<Mutation>({ families: [], equivalent: [] }),
				onSome: loadedMutation
			})
			const tracked = yield* Effect.mapError(trackedIn(checkout), (refused) =>
				MutatorRefused.make({ message: refused.message })
			)
			const product = productOf(tracked)
			const within = path.relative(checkout, packageRoot)
			const sources = Arr.filter(
				Arr.sort(Arr.fromIterable(tracked), Order.String),
				(file) =>
					product(file) && isMutable(file) && (within === "" || Str.startsWith(`${within}/`)(file))
			)
			const verdicts = Option.isSome(config)
				? yield* verdictsAt(root, config.value, properties, sources)
				: noVerdicts
			const trees = yield* treesOf(checkout)
			const images = yield* imagesOf(checkout, trees)
			const hashing = yield* Layer.build(Layer.merge(moduleSyntax, layerDigest))
			const spawner = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>()
			const settled = (one: Counted) => {
				const { by, why } = shownBy(one.standing)
				return Console.error(
					Arr.join(Arr.filter([`${one.id}: ${one.standing.kind}`, by, why], Str.isNonEmpty), "; ")
				)
			}
			const census = <E>(pool: MutantPool<E>, subjects: ReadonlyArray<Subject>, reading: Reading) =>
				censusOf(pool, images, {
					witnesses: { seed: 0, limits: runnerLimits },
					checkout,
					pkg: packageRoot,
					subjects,
					product,
					sources,
					families: mutation.families,
					equivalent: mutation.equivalent,
					kills: verdicts.kills,
					edits: verdicts.edits,
					reading,
					settled
				}).pipe(Effect.provide(hashing))
			const pool = yield* mutatorPool(
				checkout,
				packageRoot,
				workerEnvironmentOf(
					Option.match(config, { onNone: () => [], onSome: (stated) => stated.environment }),
					process.env
				)
			)
			const ofProperties = yield* census(pool, subjectsOf(properties), { kind: "places" })
			const ofForeign = yield* Option.match(parsed.foreign, {
				onNone: () => Effect.succeed([]),
				onSome: ({ command, modules }) =>
					Effect.flatMap(importClosuresAt(root, modules), (closures) =>
						census(
							foreignPool({ argv: command, directory: within }, spawner),
							Arr.map(modules, foreignSubject),
							{
								kind: "files",
								importClosure: (id) => Arr.map(closures.get(id) ?? [], (file) => file)
							}
						)
					)
			})
			const rows = [
				...Arr.map(Arr.zip(properties, ofProperties), ([found, one]) =>
					censusRow(found.module, one)
				),
				...Arr.map(ofForeign, (one) => censusRow(one.id, one))
			]
			const counted = [...ofProperties, ...ofForeign]
			const took = yield* timed.elapsed
			const count = (kind: Counted["standing"]["kind"]) =>
				Arr.filter(counted, (one) => one.standing.kind === kind).length
			yield* Console.log(Arr.join([Arr.join(CENSUS_HEADER, "\t"), ...rows], "\n"))
			yield* Console.error(
				`census: ${String(counted.length)} tests: ${String(count("catches"))} catch, ${String(count("never-caught"))} never caught, ${String(count("unjudged"))} unjudged; ${String(Arr.reduce(counted, 0, (sum, one) => sum + one.tried))} mutants tried over ${String(sources.length)} product files, in ${String(Math.round(took))} ms on ${String(pool.width)} workers`
			)
			return count("catches") === counted.length ? 0 : 1
		})
	)
