import {
	Array as Arr,
	Console,
	Effect,
	FileSystem,
	Inspectable,
	Option,
	Path,
	Record,
	Result,
	Schema,
	String as Str
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { defineConfig, type OxlintConfig } from "oxlint"
import { RuleTester } from "oxlint/plugins-dev"
import type { OptionsOf, Plugin, Rule } from "#oxlint/rule.ts"
import { failureFrom } from "#shared/devtool.ts"
import { statusOf } from "#shared/finding.ts"
import { fixtureMismatchesOf, renderFixtureMismatches } from "#shared/fixtures.ts"
import { relativeTo, Repository } from "#shared/repository.ts"
import { runDevtool } from "#shared/run.ts"

/**
 * How an oxlint plugin's rules are proven: oxlint itself runs each rule over its fixtures through a configuration that
 * fixturesConfig makes, so the rule runs through the configuration loader, its options' validation and the plugin's
 * loading exactly as a repository's oxlint runs it. Every violating fixture marks the lines its rule must report and its
 * clean fixture draws none. A rule whose fixes a marker comment would disturb runs its cases on oxlint's RuleTester
 * instead. The shared plugin's fixtures (src/oxlint/fixtures.ts) and a repository's own plugin's are proven alike.
 */

/** The options each rule of a plugin runs under on its fixtures: every rule but the ones proven on RuleTester
 * (`Unmarked`), null for a rule that takes none. */
export type FixtureRules<P extends Plugin, Unmarked extends keyof P["rules"] = never> = Readonly<{
	[R in Exclude<keyof P["rules"], Unmarked>]: OptionsOf<P["rules"][R]>
}>

/** Every fixture is TSX, so a JSX rule and a TypeScript rule read their fixtures alike. */
const EXTENSION = ".tsx"

/**
 * The oxlint configuration a plugin's fixtures run under: no built-in rule, and each of the plugin's marked rules on its
 * own fixture directory only, with options that point into that directory. The specifier and the fixtures' directory
 * are as oxlint reads them from the configuration file: relative to it, or absolute.
 */
export const fixturesConfig = (
	input: Readonly<{
		plugin: Plugin
		specifier: string
		fixtures: string
		rules: Readonly<Record<string, unknown>>
	}>
): OxlintConfig =>
	defineConfig({
		plugins: [],
		jsPlugins: [input.specifier],
		categories: {
			correctness: "off",
			nursery: "off",
			pedantic: "off",
			perf: "off",
			restriction: "off",
			style: "off",
			suspicious: "off"
		},
		options: { respectEslintDisableDirectives: false },
		overrides: Arr.map(Record.toEntries(input.rules), ([rule, options]) => ({
			files: [`${input.fixtures}/${rule}/**`],
			rules: {
				[`${input.plugin.meta.name}/${rule}`]: options === null ? "error" : ["error", options]
			}
		}))
	})

/** A rule proven on oxlint's RuleTester: its name, the rule, and its cases. */
export type TesterCases = Readonly<{
	name: string
	rule: Rule
	cases: Parameters<RuleTester["run"]>[2]
}>

/** A plugin's fixtures, as the runner proves them. */
export type PluginFixtures = Readonly<{
	/** The plugin, whose name its rules' diagnostics carry. */
	plugin: Plugin
	/** The configuration file fixturesConfig's configuration is the default export of, by its absolute path. oxlint runs
	 * from its directory. */
	config: string
	/** The fixtures' directory, by its absolute path: a directory per marked rule, holding its violating and clean
	 * fixture, and any further set of the rule's fixtures in a directory beneath it. */
	fixtures: string
	/** The marked rules, with the options they run under: the map the configuration is made from. */
	rules: Readonly<Record<string, unknown>>
	/** The rules proven on oxlint's RuleTester instead. */
	tester: ReadonlyArray<TesterCases>
}>

const OxlintReport = Schema.fromJsonString(
	Schema.Struct({
		diagnostics: Schema.Array(
			Schema.Struct({
				message: Schema.String,
				code: Schema.optionalKey(Schema.String),
				filename: Schema.String,
				labels: Schema.Array(Schema.Struct({ span: Schema.Struct({ line: Schema.Finite }) }))
			})
		)
	})
)

const decodeReport = Schema.decodeUnknownEffect(OxlintReport)

/** oxlint's package.json, as far as the runner reads it: the file its oxlint command runs. */
const OxlintManifest = Schema.fromJsonString(
	Schema.Struct({ bin: Schema.Struct({ oxlint: Schema.String }) })
)

const decodeManifest = Schema.decodeUnknownEffect(OxlintManifest)

/** The oxlint command the dev tools install, resolved as Node resolves their own imports, so the runner needs no
 * oxlint on the PATH. */
const oxlintCommand = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const unresolved = failureFrom("oxlint's package.json does not resolve from the dev tools")
	const url = yield* Effect.try({
		try: () => new URL(import.meta.resolve("oxlint/package.json")),
		catch: unresolved
	})
	const manifestFile = yield* path.fromFileUrl(url).pipe(Effect.mapError(unresolved))
	const text = yield* fs.readFileString(manifestFile).pipe(Effect.mapError(unresolved))
	const manifest = yield* decodeManifest(text).pipe(
		Effect.mapError(failureFrom(`${manifestFile} names no oxlint command`))
	)
	return path.join(path.dirname(manifestFile), manifest.bin.oxlint)
})

/** One diagnostic oxlint reported, at its first label's line when it has one. */
type Reported = Readonly<{
	file: string
	code: Option.Option<string>
	line: Option.Option<number>
	message: string
}>

/** A RuleTester case its rule disagrees with: the case's name, and what oxlint's RuleTester said. */
type CaseFailure = Readonly<{ name: string; detail: string }>

/** Each tester rule's cases on oxlint's RuleTester, each case's failure collected instead of thrown, and how many ran
 * of each rule. */
const testerRuns = (tester: ReadonlyArray<TesterCases>) =>
	Effect.sync(() => {
		const failures: Array<CaseFailure> = []
		const suites: Array<string> = []
		let ran = 0
		RuleTester.describe = (suite, method) => {
			suites.push(suite)
			method()
			suites.pop()
		}
		RuleTester.it = (name, method) => {
			ran += 1
			const outcome = Result.try({ try: () => method(), catch: (cause) => cause })
			if (Result.isFailure(outcome)) {
				failures.push({
					name: Arr.join([...suites, name], " > "),
					detail: Inspectable.toStringUnknown(outcome.failure)
				})
			}
		}
		const tallies = Arr.map(tester, (entry) => {
			const before = { ran, failed: failures.length }
			new RuleTester().run(entry.name, entry.rule, entry.cases)
			const cases = ran - before.ran
			const agree = cases - (failures.length - before.failed)
			return `${entry.name}: ${agree} of ${cases} cases agree`
		})
		return { failures, tallies }
	})

/** The proof of a plugin's fixtures: 0 when every rule agrees with its fixtures and its cases, 1 otherwise. */
export const proveFixtures = (input: PluginFixtures) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const { root } = yield* Repository
		const directory = path.dirname(input.config)
		const code = (rule: string): string => `${input.plugin.meta.name}(${rule})`
		/** Whether a diagnostic is the report of `rule` at a line of its own fixture directory. */
		const isReportOf = (diagnostic: Reported, rule: string): boolean =>
			Option.contains(diagnostic.code, code(rule)) &&
			Option.isSome(diagnostic.line) &&
			Str.startsWith(`${input.fixtures}/${rule}/`)(diagnostic.file)
		const rules = Record.keys(input.rules)
		/** Each rule's fixture files, relative to the fixtures' directory: the files of its own directory and of every
		 * directory beneath it, none when it has no directory. */
		const filesOf = yield* Effect.forEach(rules, (rule) =>
			Effect.map(
				Effect.option(fs.readDirectory(`${input.fixtures}/${rule}`, { recursive: true })),
				(entries) =>
					Arr.map(
						Arr.filter(
							Option.getOrElse(entries, () => []),
							Str.endsWith(EXTENSION)
						),
						(entry) => path.join(rule, entry)
					)
			)
		)
		const files = Arr.flatten(filesOf)
		/** The fixture sets, each a directory relative to the fixtures' directory whose first segment is its rule: every
		 * rule's own directory, and each directory beneath it that holds a fixture. */
		const sets = Arr.dedupe([...rules, ...Arr.map(files, (file) => path.dirname(file))])
		const ruleOf = (set: string): string => Arr.headNonEmpty(Str.split("/")(set))
		const command = yield* oxlintCommand
		/** oxlint's diagnostics over the files, each read by its path, so no ignore file of the repository hides one. */
		const lint = (paths: Arr.NonEmptyReadonlyArray<string>) =>
			Effect.gen(function* () {
				const output = yield* spawner
					.string(
						ChildProcess.make(
							command,
							[
								"-c",
								input.config,
								"--format",
								"json",
								"--disable-nested-config",
								"--no-ignore",
								...Arr.map(paths, (file) => `${input.fixtures}/${file}`)
							],
							{ cwd: directory }
						)
					)
					.pipe(Effect.mapError(failureFrom("oxlint did not run")))
				const report = yield* decodeReport(output).pipe(
					Effect.mapError(failureFrom(`oxlint printed no JSON report:\n${output}`))
				)
				return report.diagnostics
			})
		const diagnostics = Arr.isReadonlyArrayNonEmpty(files) ? yield* lint(files) : []
		const reported = Arr.map(diagnostics, (diagnostic): Reported => ({
			file: path.resolve(directory, diagnostic.filename),
			code: Option.fromUndefinedOr(diagnostic.code),
			line: Option.map(Arr.head(diagnostic.labels), (label) => label.span.line),
			message: diagnostic.message
		}))
		const foreign = Arr.filter(
			reported,
			(diagnostic) => !Arr.some(rules, (rule) => isReportOf(diagnostic, rule))
		)
		const texts = yield* Effect.forEach(sets, (set) =>
			Effect.forEach(["violating", "clean"], (role) => {
				const file = `${input.fixtures}/${set}/${role}${EXTENSION}`
				return Effect.map(Effect.option(fs.readFileString(file)), (text) => [file, text] as const)
			})
		)
		const textOf = new Map(Arr.flatten(texts))
		const mismatches = fixtureMismatchesOf({
			root: input.fixtures,
			extensionOf: () => EXTENSION,
			rules: sets,
			runOf: ({ rule: set, file }) =>
				Option.map(Option.flatten(Option.fromUndefinedOr(textOf.get(file))), (text) => ({
					text,
					reported: Arr.filterMap(reported, (diagnostic) =>
						diagnostic.file === file && isReportOf(diagnostic, ruleOf(set))
							? Result.fromOption(diagnostic.line, () => undefined)
							: Result.failVoid
					)
				}))
		})
		const cases = yield* testerRuns(input.tester)
		yield* Console.log(
			Arr.join(
				[
					...Arr.map(cases.failures, (failure) => `case ${failure.name}\n${failure.detail}`),
					...cases.tallies,
					...Arr.map(
						foreign,
						(diagnostic) =>
							`${relativeTo(root)(diagnostic.file)}${Option.match(diagnostic.line, {
								onNone: () => "",
								onSome: (line) => `:${line}`
							})} ${Option.match(diagnostic.code, {
								onNone: () => "(no rule)",
								onSome: (rule) => rule
							})} ${diagnostic.message}`
					),
					renderFixtureMismatches({
						tool: `${input.plugin.meta.name} oxlint plugin`,
						root,
						rules: rules.length,
						mismatches
					})
				],
				"\n"
			)
		)
		return statusOf([...cases.failures, ...foreign, ...mismatches])
	})

/** Proves a plugin's fixtures as a dev tool: its entry point for a script of the plugin's own. */
export const runPluginFixtures = (input: PluginFixtures): void => runDevtool(proveFixtures(input))
