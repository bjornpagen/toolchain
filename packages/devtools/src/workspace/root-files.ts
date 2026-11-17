import { Array as Arr, Effect, FileSystem, Option, Result, Schema, String as Str } from "effect"
import { DevtoolFailure } from "#shared/devtool.ts"
import type { Finding } from "#shared/finding.ts"
import { ROOT_MANIFEST } from "#workspace/root-tasks.ts"

/**
 * The root's files: the TypeScript files under no workspace package, the root's own (its configuration, and in
 * grizzle its test, bench and script trees). The root tsconfig.json's include names them once, and both of the root's
 * checks read that one list: the root's typecheck is the program the include roots, and the root's lint is
 * `toolchain-oxlint-root`, oxlint over the include's paths. So a root file the include names is typechecked and linted,
 * and one it does not name is neither. The gate holds the three together: every root file lies at or under a path the
 * include names, each include entry is a path (a file or a directory, which oxlint reads as it is, never a glob), and
 * the root's oxlint script runs the root lint. Before this rule each repository listed its root lint's paths by hand
 * beside its include, and the lists drifted: toolchain.config.ts was typechecked and never linted in five repositories.
 */

/** The root tsconfig, whose include names the root's files. */
export const ROOT_TSCONFIG = "tsconfig.json"

/** The root manifest's lint script. */
export const LINT_SCRIPT = "oxlint"

/** The command of the root's lint: oxlint over the root tsconfig's include (src/oxlint-root.ts). */
export const ROOT_LINT = "toolchain-oxlint-root"

/** The extensions of the files the root's checks read: the TypeScript a repository holds (ts-only-extensions refuses
 * every other code extension). */
const TYPESCRIPT_EXTENSIONS: ReadonlyArray<string> = [".ts", ".tsx"]

/** The characters that make an include entry a glob, which oxlint would read as a literal path. */
const WILDCARDS: ReadonlyArray<string> = ["*", "?", "{", "["]

/** What the root's checks read of the root tsconfig: its include, the paths of the root's files. */
const RootTsconfig = Schema.fromJsonString(
	Schema.Struct({ include: Schema.NonEmptyArray(Schema.String) })
)

/** What the gate reads of the root manifest: its scripts. */
const Manifest = Schema.fromJsonString(
	Schema.Struct({ scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)) })
)

/** The include of the root tsconfig at `root`: the paths of the root's files. A root tsconfig with no include, or one
 * the dev tools cannot read, fails the tool, since the root's files are then whatever TypeScript defaults to. */
export const rootIncludeOf = Effect.fn("rootIncludeOf")(function* (root: string) {
	const fs = yield* FileSystem.FileSystem
	const path = `${root}/${ROOT_TSCONFIG}`
	const text = yield* fs
		.readFileString(path)
		.pipe(
			Effect.mapError((cause) =>
				DevtoolFailure.make({ detail: `${path} could not be read`, cause })
			)
		)
	const decoded = yield* Schema.decodeEffect(RootTsconfig)(text).pipe(
		Effect.mapError((cause) =>
			DevtoolFailure.make({
				detail: `${path} names the root's files in no include: list each root file or directory by path`,
				cause
			})
		)
	)
	return { text, include: decoded.include }
})

/** A path without a leading `./` or a trailing `/`, as the gate compares paths. */
const normal = (entry: string): string =>
	Str.endsWith("/")(entry)
		? normal(Str.slice(0, -1)(entry))
		: Str.startsWith("./")(entry)
			? normal(Str.slice(2)(entry))
			: entry

/** Whether a path names a file or lies under a directory: `.` names the root, and so every file. */
const under = (directory: string, file: string): boolean =>
	directory === "." || file === directory || Str.startsWith(`${directory}/`)(file)

/** The 1-based line of a text that first holds `needle`, else the first, as the gate's other lines fall back. */
const lineHolding = (text: string, needle: string): number =>
	Option.match(Arr.findFirstIndex(Str.split("\n")(text), Str.includes(needle)), {
		onNone: () => 1,
		onSome: (at) => at + 1
	})

/** A command's words, split at spaces and tabs. */
const wordsOf = (command: string): ReadonlyArray<string> =>
	Arr.filter(Str.split(" ")(Str.replaceAll("\t", " ")(command)), Str.isNonEmpty)

/**
 * The root files' findings, over the repository's file list (paths from the root), its workspace packages' directories
 * (from the root), the root tsconfig's include and text, and the root manifest's text: a root file no include entry
 * names, at the file; an include entry that is a glob, at its line; and, when the root holds any file, an oxlint
 * script that is not the root lint or none at all, at the manifest.
 */
export const rootFileFindings = (
	input: Readonly<{
		root: string
		files: ReadonlyArray<string>
		packages: ReadonlyArray<string>
		include: ReadonlyArray<string>
		tsconfig: string
		manifest: string
	}>
): Effect.Effect<ReadonlyArray<Finding>, DevtoolFailure> =>
	Effect.gen(function* () {
		const manifest = yield* Schema.decodeEffect(Manifest)(input.manifest).pipe(
			Effect.mapError((cause) =>
				DevtoolFailure.make({ detail: `${ROOT_MANIFEST} is not a manifest the gate reads`, cause })
			)
		)
		const entries = Arr.map(input.include, normal)
		const packages = Arr.map(input.packages, normal)
		const rootFiles = Arr.filter(
			input.files,
			(file) =>
				Arr.some(TYPESCRIPT_EXTENSIONS, (extension) => Str.endsWith(extension)(file)) &&
				!Arr.some(packages, (directory) => under(directory, file))
		)
		const unnamed = Arr.filterMap(rootFiles, (file): Result.Result<Finding, void> =>
			Arr.some(entries, (entry) => under(entry, file))
				? Result.failVoid
				: Result.succeed({
						file: `${input.root}/${file}`,
						line: 1,
						column: 1,
						rule: "root-files",
						message: `${file} is a root file, in no workspace package, and the root tsconfig's include names neither it nor a directory above it, so neither the root's typecheck nor its lint reads it.`,
						suggestion: `Add "${file}", or the directory that holds it, to ${ROOT_TSCONFIG}'s include.`
					})
		)
		const globs = Arr.filterMap(input.include, (entry): Result.Result<Finding, void> =>
			Arr.some(WILDCARDS, (wildcard) => Str.includes(wildcard)(entry))
				? Result.succeed({
						file: `${input.root}/${ROOT_TSCONFIG}`,
						line: lineHolding(input.tsconfig, `"${entry}"`),
						column: 1,
						rule: "root-files",
						message: `The include entry ${entry} is a glob: the root lint passes each entry to oxlint as a path, so a glob lints nothing.`,
						suggestion: "Name the root's files and directories by path."
					})
				: Result.failVoid
		)
		const lint = Option.fromUndefinedOr(manifest.scripts?.[LINT_SCRIPT])
		const linted = Option.exists(lint, (command) => Arr.contains(wordsOf(command), ROOT_LINT))
		const script: ReadonlyArray<Finding> =
			Arr.isReadonlyArrayNonEmpty(rootFiles) && !linted
				? [
						{
							file: `${input.root}/${ROOT_MANIFEST}`,
							line: Option.isSome(lint) ? lineHolding(input.manifest, `"${LINT_SCRIPT}":`) : 1,
							column: 1,
							rule: "root-files",
							message: `The root's ${LINT_SCRIPT} script is not the root lint, so the root's files are linted by whatever paths it names, not by the include its typecheck reads.`,
							suggestion: `Make the root's "${LINT_SCRIPT}" script \`${ROOT_LINT}\`.`
						}
					]
				: []
		return [...unnamed, ...globs, ...script]
	})
