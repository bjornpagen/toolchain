import { parseArgs } from "node:util"
import {
	Array as Arr,
	Console,
	Effect,
	FileSystem,
	Option,
	Order,
	Path,
	Schema,
	String as Str
} from "effect"
import { liveMillis } from "#live.ts"
import { OPERATORS } from "#mutants.ts"
import { loadingOf } from "#mutate/checkout.ts"
import { imagesOf } from "#mutate/image.ts"
import { type Judged, killsOf } from "#mutate/kills.ts"
import { mutatorPool } from "#mutate/lease.ts"
import { realPathOf } from "#mutate/mutated.ts"
import { type Choice, type MutantJudged, mutationOf } from "#mutate/operators.ts"
import type { Subject } from "#mutate/schedule.ts"
import { treesOf } from "#mutate/tree.ts"
import { killVerdictsAt } from "#runner/affected.ts"
import type { Mutation, RunnerConfig } from "#runner/config.ts"
import { runnerLimits } from "#runner/limits.ts"
import type { Discovered } from "#runner/load.ts"
import { loadPackage } from "#runner/run.ts"

/**
 * The mutator's commands, `toolchain-test kills` and `toolchain-test mutate` (runner/cli.ts's entries), run from a
 * package root inside a git checkout: the kill gate, and operator mutation, a measurement.
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
	}
}

/**
 * `kills [paths | ids]`: every kill of every property named, each applied in the checkout and the property's
 * witnesses run on workers leased for that kill alone (mutate/kills.ts), every kill at once over the pool, but a kill
 * the verdict cache answers (runner/affected.ts: it turned its property red under the same closure, kill and file
 * content) is not run again, and each judged kill's verdict is recorded. One line per property with kills, each
 * failing kill under it, each cached kill, and a summary; 1 when any kill survives or is stale.
 */
export const killsCommand = (root: string, selected: ReadonlyArray<string>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const began = yield* liveMillis
			const checkout = yield* checkoutOf(root)
			const packageRoot = yield* realPathOf(root)
			const { discovered } = yield* loadPackage(root, selected)
			const verdicts = yield* killVerdictsAt(root, selected)
			const { fresh, cached } = yield* verdicts.split(
				Arr.filter(discovered, (found) => Arr.isReadonlyArrayNonEmpty(found.property.kills))
			)
			const subjects = subjectsOf(fresh)
			const pool = mutatorPool(checkout, packageRoot)
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
			const ended = yield* liveMillis
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
						`${String(judged.length)} kills of ${String(subjects.length)} properties: ${String(count("killed"))} killed, ${String(count("survived"))} survived, ${String(count("stale"))} stale, in ${String(Math.round(ended - began))} ms on ${String(pool.width)} workers; ${String(cached.length)} kills a cached verdict answered`
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
 * `mutate <file>... [--against <path | id>]... [--operator <name>]... [--sample <n> --seed <s> | --mutant <id>...]`,
 * the files from the package root.
 */
const mutateArgsOf = (args: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const usage =
			"mutate <file>... [--against <path | id>]... [--operator <name>]... [--sample <n> --seed <s> | --mutant <id>...]"
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

/** A judged mutant as a survivor line prints it: its id, place, function, edit and the properties it faced. */
const survivorLine = ({ mutant, verdict }: MutantJudged<string>): ReadonlyArray<string> =>
	verdict.kind === "survived"
		? [
				`      ${mutant.id} ${String(mutant.line)}:${String(mutant.column)} in ${mutant.fn}: ${Str.replaceAll("\n", " ")(mutant.original)} -> ${Str.replaceAll("\n", " ")(mutant.replacement)}`,
				`        faced ${Arr.join(verdict.faced, ", ")}`
			]
		: []

/** The survivors of a run, by file and then by operator, each group with its count. */
const survivorsReport = (judged: ReadonlyArray<MutantJudged<string>>): ReadonlyArray<string> => {
	const survivors = Arr.filter(judged, ({ verdict }) => verdict.kind === "survived")
	const keys = (
		key: (one: MutantJudged<string>) => string,
		of: ReadonlyArray<MutantJudged<string>>
	) => Arr.sort(Arr.dedupe(Arr.map(of, key)), Order.String)
	return Arr.flatMap(
		keys(({ mutant }) => mutant.file, survivors),
		(file) => {
			const inFile = Arr.filter(survivors, ({ mutant }) => mutant.file === file)
			return [
				`  ${file}`,
				...Arr.flatMap(
					keys(({ mutant }) => mutant.operator, inFile),
					(operator) => {
						const these = Arr.filter(inFile, ({ mutant }) => mutant.operator === operator)
						return [`    ${operator}: ${String(these.length)}`, ...Arr.flatMap(these, survivorLine)]
					}
				)
			]
		}
	)
}

/**
 * `mutate <file>... [--against <path | id>]... [--operator <name>]... [--sample <n> --seed <s> | --mutant <id>...]`:
 * operator mutation of the files (paths from the package root) by the library's operators and the runner config's
 * families, but for the mutants it judges equivalent (its Mutation, loadedMutation), against the properties
 * `--against` names (every property of the package when it names none), on the pool (mutate/operators.ts). A
 * measurement: it prints its counts, its score, its mutants by operator and its survivors by file and operator, and
 * answers 0 whatever it measured; a refusal (an equivalent judgment gone stale, a property red with no mutant, a probe a
 * property survived, a package that does not typecheck) is the command's failure.
 */
export const mutateCommand = (root: string, args: ReadonlyArray<string>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const path = yield* Path.Path
			const began = yield* liveMillis
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
			const files = Arr.map(parsed.files, (file): string =>
				path.relative(checkout, path.resolve(root, file))
			)
			const pool = mutatorPool(checkout, packageRoot)
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
			const ended = yield* liveMillis
			const count = (kind: MutantJudged<string>["verdict"]["kind"]) =>
				Arr.filter(judged, ({ verdict }) => verdict.kind === kind).length
			const killed = count("killed")
			const survived = count("survived")
			yield* Console.log(
				Arr.join(
					[
						`mutate: ${String(judged.length)} mutants of ${Arr.join(files, ", ")} against ${String(subjects.length)} properties: ${String(killed)} killed, ${String(survived)} survived, ${String(count("invalid"))} invalid, ${String(count("uncovered"))} uncovered, ${String(count("equivalent"))} equivalent; score ${String(killed)}/${String(killed + survived)}, in ${String(Math.round(ended - began))} ms on ${String(pool.width)} workers`,
						operatorsLine(Arr.dedupe(operators), judged),
						...(survived > 0
							? ["survivors, by file and operator:", ...survivorsReport(judged)]
							: [])
					],
					"\n"
				)
			)
			return 0
		})
	)
