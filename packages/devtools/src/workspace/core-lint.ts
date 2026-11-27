import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	Path,
	Record,
	Schema,
	String as Str
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { CORE_RULES, PLUGIN_MODULE } from "#preset.ts"
import { DevtoolFailure, failureFrom } from "#shared/devtool.ts"
import type { Finding } from "#shared/finding.ts"

/**
 * The core lint set (core-lint): every oxlint configuration a repository holds loads the dev tools' plugin and holds
 * every rule of its core that runs on every file at error (the preset's CORE_RULES), as oxlint resolves it
 * (`oxlint -c <configuration> --print-config`), never as its text reads, so a configuration built by hand, one that
 * names the plugin and a list of rules itself, or one of a package's own beside the root's, is refused the moment it
 * misses a core rule, as a hand-written list does once the toolchain adds one. Every configuration the preset's
 * standard builds holds the set. No exception excuses it: a repository that lints without the core set runs none of
 * the rules that hold its code, as qti-pie's package configuration, built on another preset, ran none.
 */

/** The rule's id, as its findings name it. */
const CORE_LINT = "core-lint"

/**
 * Whether a repository's file is an oxlint configuration oxlint reads: `.oxlintrc.json` or `.oxlintrc.jsonc`, or a
 * JavaScript or TypeScript configuration named `oxlint.config.<ext>` or `oxlint.<variant>.config.<ext>` (the commit
 * gate's oxlint.ast.config.ts among them).
 */
const isLintConfiguration = (file: string): boolean => {
	const name = Arr.lastNonEmpty(Str.split("/")(file))
	const parts = Str.split(".")(name)
	return (
		name === ".oxlintrc.json" ||
		name === ".oxlintrc.jsonc" ||
		(Arr.headNonEmpty(parts) === "oxlint" &&
			(parts.length === 3 || parts.length === 4) &&
			parts[parts.length - 2] === "config" &&
			Arr.contains(["ts", "mts", "js", "mjs"], Arr.lastNonEmpty(parts)))
	)
}

/**
 * A JavaScript plugin a configuration loads, as oxlint states one (its ExternalPluginEntry): the plugin's path or
 * package name, or that under a name of its own (`{ name, specifier }`, as ultracite writes its plugins).
 */
const PluginEntry = Schema.Union([
	Schema.String,
	Schema.Struct({ name: Schema.String, specifier: Schema.String })
])

/** The path or package name a plugin entry loads its plugin from (PluginEntry): the text itself, or its specifier. */
const specifierOf = (entry: typeof PluginEntry.Type): string =>
	typeof entry === "string" ? entry : entry.specifier

/**
 * A configuration as oxlint resolves it, as far as the gate reads it: the JavaScript plugins it loads (none, or none
 * stated: oxlint's `null | ExternalPluginEntry[]`) and its rules.
 */
const Resolved = Schema.fromJsonString(
	Schema.Struct({
		jsPlugins: Schema.optionalKey(Schema.NullOr(Schema.Array(PluginEntry))),
		rules: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown))
	})
)

/** A configuration of the repository as the gate judges it: its path and whether it loads the plugin and which core
 * rules it holds at error, as oxlint resolves it. */
export type JudgedConfiguration = Readonly<{
	file: string
	loadsPlugin: boolean
	rules: Readonly<Record<string, unknown>>
}>

/** Whether a resolved rule entry holds its rule at error: oxlint prints `deny`, alone or before the rule's options. */
const atError = (entry: unknown): boolean => {
	const level = Arr.isArray(entry) ? entry[0] : entry
	return level === "deny" || level === "error" || level === 2
}

/** What a configuration lacks of the core set: whether it loads no dev tools plugin, and each core rule it holds at
 * less than error, in the set's order. */
export type CoreFaults = Readonly<{ noPlugin: boolean; missing: ReadonlyArray<string> }>

/** What a configuration lacks of `core` (CoreFaults). */
export const coreFaults = (
	configuration: JudgedConfiguration,
	core: ReadonlyArray<string>
): CoreFaults => ({
	noPlugin: !configuration.loadsPlugin,
	missing: Arr.filter(
		core,
		(rule) => !atError(Option.getOrUndefined(Record.get(configuration.rules, rule)))
	)
})

/**
 * The findings of the repository's configurations against `core`: one for each configuration that loads no dev tools
 * plugin, and one for each that holds a core rule at less than error, naming every such rule (coreFaults).
 */
export const coreLintFindings = (
	configurations: ReadonlyArray<JudgedConfiguration>,
	core: ReadonlyArray<string>
): ReadonlyArray<Finding> =>
	Arr.flatMap(configurations, (configuration): ReadonlyArray<Finding> => {
		const { noPlugin, missing } = coreFaults(configuration, core)
		const at = { file: configuration.file, line: 1, column: 1, rule: CORE_LINT }
		const suggestion =
			"Build the configuration with @bjornpagen/devtools/preset's standard(toolchain).lintConfig(project), which loads the plugin and holds every core rule; never name the plugin or its rules by hand."
		return [
			...(noPlugin
				? [
						{
							...at,
							message:
								"this oxlint configuration loads no dev tools plugin, as oxlint resolves it, so none of the core rules that hold every repository's code runs on its files.",
							suggestion
						}
					]
				: []),
			...(Arr.isReadonlyArrayNonEmpty(missing)
				? [
						{
							...at,
							message: `this oxlint configuration holds ${missing.length} of the dev tools' ${core.length} core rules at less than error, as oxlint resolves it: ${Arr.join(missing, ", ")}.`,
							suggestion
						}
					]
				: [])
		]
	})

/**
 * A configuration judged as oxlint resolves it: `oxlint -c <file> --print-config` run at the repository's root, and
 * whether one of the JavaScript plugins it loads, a path absolute or relative to the configuration's directory, is the
 * dev tools' plugin module, by the file both name. A configuration oxlint cannot resolve fails the gate.
 */
export const judgedConfiguration = (
	root: string,
	file: string
): Effect.Effect<
	JudgedConfiguration,
	DevtoolFailure,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const absolute = path.resolve(root, file)
		const printed = yield* spawner
			.string(
				ChildProcess.make("oxlint", ["-c", absolute, "--print-config"], {
					cwd: root,
					stderr: "ignore"
				})
			)
			.pipe(Effect.mapError(failureFrom(`oxlint could not resolve ${file}`)))
		const resolved = yield* Schema.decodeEffect(Resolved)(printed).pipe(
			Effect.mapError(
				failureFrom(`oxlint's resolution of ${file} is not the configuration the gate reads`)
			)
		)
		const realOf = (target: string) =>
			fs.realPath(target).pipe(Effect.option, Effect.map(Option.getOrUndefined))
		const plugin = yield* realOf(PLUGIN_MODULE)
		const loaded = yield* Effect.forEach(
			Arr.map(resolved.jsPlugins ?? [], specifierOf),
			(specifier) =>
				path.isAbsolute(specifier) || Str.startsWith(".")(specifier)
					? realOf(path.resolve(path.dirname(absolute), specifier))
					: Effect.undefined
		)
		return {
			file: absolute,
			loadsPlugin: plugin !== undefined && Arr.contains(loaded, plugin),
			rules: resolved.rules ?? {}
		}
	})

/**
 * The repository's oxlint configurations: each tracked file oxlint reads as one (`files`, repository-relative), and each
 * one that stands in a workspace package's directory (`packages`, absolute, the repository's own and those it vendors,
 * Repository vendored), which git need not track: a package checked out as a submodule of its own, as edullm's qti-pie
 * is, lints by its own configuration, which no file the repository tracks names.
 */
const configurationsOf = (
	root: string,
	files: ReadonlyArray<string>,
	packages: ReadonlyArray<string>
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const own = yield* Effect.forEach(packages, (directory) =>
			fs.readDirectory(directory).pipe(
				Effect.mapBoth({
					onFailure: failureFrom(`${directory} could not be read`),
					onSuccess: (names) =>
						Arr.map(Arr.filter(names, isLintConfiguration), (name) =>
							path.relative(root, path.join(directory, name))
						)
				})
			)
		)
		return Arr.dedupe([...Arr.filter(files, isLintConfiguration), ...Arr.flatten(own)])
	})

/** The core-lint findings of the repository's configurations (configurationsOf). */
export const repositoryCoreLintFindings = (
	root: string,
	files: ReadonlyArray<string>,
	packages: ReadonlyArray<string>
) =>
	Effect.gen(function* () {
		const configurations = yield* configurationsOf(root, files, packages)
		const judged = yield* Effect.forEach(
			configurations,
			(file) => judgedConfiguration(root, file),
			{
				concurrency: "unbounded"
			}
		)
		return coreLintFindings(judged, CORE_RULES)
	})
