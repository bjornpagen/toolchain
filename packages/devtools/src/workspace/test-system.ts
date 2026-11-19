import { TEST_SUFFIXES } from "@bjornpagen/testing/scope"
import { Array as Arr, Option, Record, Result, Schema, String as Str } from "effect"
import type { PackName } from "#config.ts"
import type { Finding } from "#shared/finding.ts"
import { QUARANTINE, quarantineFindings, type Snapshot } from "#workspace/quarantine.ts"
import { TEST_SYSTEM_RULES, type TestSystemRule } from "#workspace/rules.ts"

/**
 * The workspace gate's checks of the test system, over the repository's file list and the text of the files they
 * read: the toolchain's runner is the one test runner and the case is its unit of parallelism, so no file of the
 * repository configures another runner, splits a test module into numbered shards, asks a runner for fewer workers,
 * or keeps a plant. The rules of the properties pack (another runner's configuration, a shard) hold a repository once
 * its tests are properties; the core's (a worker flag, a plant) hold every repository.
 */

/**
 * A repository's files as the checks read them: its root, every file git shows by its path from the root and the text
 * of each file a check reads (readsText); the parent commit's files and quarantine texts, none for a root commit; and
 * the globs of the oxlint overrides that exempt test modules from their shape, with the configuration's path.
 */
export type Tree = Snapshot &
	Readonly<{
		root: string
		parent: Option.Option<Snapshot>
		lintConfig: string
		shapeExemptions: ReadonlyArray<string>
	}>

/** The configuration files of Vitest, by their name's stem: every one is another runner's configuration. */
const VITEST_STEMS: ReadonlyArray<string> = ["vitest.config", "vitest.workspace"]

/** The configuration files of Vite, by their name's stem: one is Vitest's when it holds a test block. */
const VITE_STEMS: ReadonlyArray<string> = ["vite.config"]

/** The flags that tell a test runner how many workers to run, or to run its files one at a time: a whole token, or a
 * token beginning with one of WORKER_FLAG_PREFIXES. */
export const WORKER_FLAGS: ReadonlyArray<string> = [
	"--maxWorkers",
	"--minWorkers",
	"--no-file-parallelism",
	"--fileParallelism",
	"--runInBand",
	"--threads",
	"--no-threads",
	"--singleThread",
	"--singleFork"
]

/** The flag prefixes of a test runner's pool, every one of which picks or sizes its workers: `--pool`, `--poolOptions…`. */
export const WORKER_FLAG_PREFIXES: ReadonlyArray<string> = ["--pool"]

/** The directory a plant's patch lies under, at any depth. */
export const PLANTS_DIRECTORY = "plants"

/** The directory whose every file is a plant's: grizzle's test tree's. */
export const TEST_PLANTS = "test/plants/"

/** The package scripts that ran or checked plants: `plants`, and every `plants:` script. */
export const PLANT_SCRIPT = "plants"

/** The files whose text a check reads: package manifests, lefthook's configuration, shell scripts and Vite's
 * configurations. */
export const readsText = (path: string): boolean => {
	const name = baseNameOf(path)
	return (
		name === "package.json" ||
		name === "lefthook.yml" ||
		name === "lefthook.yaml" ||
		name === QUARANTINE ||
		Str.endsWith(".sh")(name) ||
		Option.isSome(stemIn(name, VITE_STEMS))
	)
}

const baseNameOf = (path: string): string => Arr.lastNonEmpty(Str.split("/")(path))

/** The stem of a file name among `stems`: `vite.config` of `vite.config.mts`. */
const stemIn = (name: string, stems: ReadonlyArray<string>): Option.Option<string> =>
	Arr.findFirst(stems, (stem) => Str.startsWith(`${stem}.`)(name))

/** A finding at a repository-relative path and line. */
const findingAt = (
	tree: Tree,
	path: string,
	line: number,
	rule: TestSystemRule,
	message: string
): Finding => ({ file: `${tree.root}/${path}`, line, column: 1, rule, message })

/** The 1-based lines of a text. */
const linesOf = (text: string): ReadonlyArray<readonly [line: number, text: string]> =>
	Arr.map(Str.split("\n")(text), (line, at) => [at + 1, line] as const)

/** A line's words as a shell or a manifest writes them: split at spaces, tabs and quotes, each word without its `=`
 * value. */
const wordsOf = (line: string): ReadonlyArray<string> =>
	Arr.map(
		Arr.filter(
			Str.split(" ")(
				Arr.join(
					Arr.map(Str.split("")(line), (character) =>
						Arr.contains(["\t", '"', "'", "`"], character) ? " " : character
					),
					""
				)
			),
			Str.isNonEmpty
		),
		(word) => Arr.headNonEmpty(Str.split("=")(word))
	)

/** Whether a word is a worker flag. */
const isWorkerFlag = (word: string): boolean =>
	Arr.contains(WORKER_FLAGS, word) ||
	Arr.some(WORKER_FLAG_PREFIXES, (prefix) => Str.startsWith(prefix)(word))

/** A package manifest's scripts, as far as the checks read it. */
const Manifest = Schema.fromJsonString(
	Schema.Struct({ scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)) })
)

const decodeManifest = Schema.decodeUnknownOption(Manifest)

/** The line of a text that first holds `needle`, else the first. */
const lineHolding = (text: string, needle: string): number =>
	Option.getOrElse(
		Arr.findFirst(linesOf(text), ([line, held]) =>
			Str.includes(needle)(held) ? Option.some(line) : Option.none()
		),
		() => 1
	)

/** A package script: its name, its command, and the line of its manifest it is written on. */
type Script = readonly [name: string, command: string, line: number]

/** A command a file runs, and its line. */
type Command = readonly [line: number, command: string]

/** The scripts of a package manifest with the line each is written on; none for a file that is no manifest. */
const scriptsOf = (text: string): ReadonlyArray<Script> =>
	Option.match(decodeManifest(text), {
		onNone: () => [],
		onSome: (manifest) =>
			Arr.map(
				Record.toEntries(manifest.scripts ?? {}),
				([name, command]) => [name, command, lineHolding(text, `"${name}"`)] as const
			)
	})

/** The commands a file runs, each with its line: a manifest's scripts, and every line of lefthook's configuration and
 * of a shell script but a comment. */
const commandsOf = (path: string, text: string): ReadonlyArray<Command> =>
	baseNameOf(path) === "package.json"
		? Arr.map(scriptsOf(text), ([, command, line]) => [line, command] as const)
		: Arr.filter(linesOf(text), ([, line]) => !Str.startsWith("#")(Str.trim(line)))

/** Whether a Vite configuration is Vitest's: it reads Vitest, or a line of it opens a `test` block. */
const isVitestBlock = (text: string): boolean =>
	Str.includes("vitest")(text) ||
	Arr.some(linesOf(text), ([, line]) => {
		const trimmed = Str.trim(line)
		return Str.startsWith("test:")(trimmed) || Str.startsWith("test :")(trimmed)
	})

/** Whether a file name is a numbered shard of a test module: `<stem>-<digits>.test.ts`. */
const isShard = (name: string): boolean =>
	Arr.some(TEST_SUFFIXES, (suffix) => {
		if (!Str.endsWith(suffix)(name)) {
			return false
		}
		const parts = Str.split("-")(Str.slice(0, -suffix.length)(name))
		return (
			parts.length > 1 &&
			Option.exists(
				Arr.last(parts),
				(last) =>
					Str.isNonEmpty(last) &&
					Arr.every(Str.split("")(last), (digit) => Arr.contains(DIGITS, digit))
			)
		)
	})

const DIGITS: ReadonlyArray<string> = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]

/** Whether a path is a plant: a patch beneath a plants directory at any depth, or any file under test/plants/. pnpm's
 * dependency patches lie under patches/ and are no plants. */
const isPlant = (path: string): boolean =>
	Str.startsWith(TEST_PLANTS)(path) ||
	Str.includes(`/${TEST_PLANTS}`)(path) ||
	(Str.endsWith(".patch")(path) &&
		Arr.contains(Arr.dropRight(Str.split("/")(path), 1), PLANTS_DIRECTORY))

/** Whether a package script runs or checks plants. */
const isPlantScript = (name: string): boolean =>
	name === PLANT_SCRIPT || Str.startsWith(`${PLANT_SCRIPT}:`)(name)

/** Each rule of the test system's gates: its part and its check. */
const RULES = {
	"no-vitest-config": {
		part: "properties",
		check: (tree: Tree): ReadonlyArray<Finding> => [
			...Arr.filterMap(tree.files, (path): Result.Result<Finding, void> => {
				const name = baseNameOf(path)
				const vitest = Option.isSome(stemIn(name, VITEST_STEMS))
				const vite =
					Option.isSome(stemIn(name, VITE_STEMS)) && Option.exists(tree.textOf(path), isVitestBlock)
				return vitest || vite
					? Result.succeed(
							findingAt(
								tree,
								path,
								1,
								"no-vitest-config",
								`Vitest is no longer the runner: the toolchain's runner reads test.config.ts (defineRunner). Delete this configuration; a Vite configuration keeps no test block, and a test module not yet converted waits in its package's ${QUARANTINE}.`
							)
						)
					: Result.failVoid
			}),
			...quarantineFindings({
				root: tree.root,
				current: tree,
				parent: tree.parent,
				lintConfig: tree.lintConfig,
				shapeExemptions: tree.shapeExemptions
			})
		]
	},
	"no-plants": {
		part: "core",
		check: (tree: Tree): ReadonlyArray<Finding> => [
			...Arr.filterMap(tree.files, (path): Result.Result<Finding, void> =>
				isPlant(path)
					? Result.succeed(
							findingAt(
								tree,
								path,
								1,
								"no-plants",
								"Plants are gone: a bug a property must catch is a kill on that property, which the runner applies and gates. Delete this plant."
							)
						)
					: Result.failVoid
			),
			...Arr.flatMap(
				Arr.filter(tree.files, (path) => baseNameOf(path) === "package.json"),
				(path: string): ReadonlyArray<Finding> =>
					Arr.filterMap(
						Option.match(tree.textOf(path), {
							onNone: (): ReadonlyArray<Script> => [],
							onSome: scriptsOf
						}),
						([name, , line]): Result.Result<Finding, void> =>
							isPlantScript(name)
								? Result.succeed(
										findingAt(
											tree,
											path,
											line,
											"no-plants",
											`The script ${name} runs or checks plants, which are gone: delete it.`
										)
									)
								: Result.failVoid
					)
			)
		]
	},
	"no-test-shards": {
		part: "properties",
		check: (tree: Tree): ReadonlyArray<Finding> =>
			Arr.filterMap(tree.files, (path): Result.Result<Finding, void> =>
				isShard(baseNameOf(path))
					? Result.succeed(
							findingAt(
								tree,
								path,
								1,
								"no-test-shards",
								"A numbered shard of a test module splits one property's cases by hand: the runner spreads a property's cases over every core. Merge the shards into one module."
							)
						)
					: Result.failVoid
			)
	},
	"no-worker-flags": {
		part: "core",
		check: (tree: Tree): ReadonlyArray<Finding> =>
			Arr.flatMap(
				Arr.filter(
					tree.files,
					(path) => readsText(path) && Option.isNone(stemIn(baseNameOf(path), VITE_STEMS))
				),
				(path: string): ReadonlyArray<Finding> =>
					Arr.filterMap(
						Option.match(tree.textOf(path), {
							onNone: (): ReadonlyArray<Command> => [],
							onSome: (text) => commandsOf(path, text)
						}),
						([line, command]): Result.Result<Finding, void> =>
							Option.match(Arr.findFirst(wordsOf(command), isWorkerFlag), {
								onNone: () => Result.failVoid,
								onSome: (flag) =>
									Result.succeed(
										findingAt(
											tree,
											path,
											line,
											"no-worker-flags",
											`${flag} sizes a test runner's workers or runs its files one at a time: the runner runs every case at full width, and no script narrows it. Delete the flag.`
										)
									)
							})
					)
			)
	}
} as const satisfies {
	readonly [R in TestSystemRule]: Readonly<{
		part: "core" | Extract<PackName, "properties">
		check: (tree: Tree) => ReadonlyArray<Finding>
	}>
}

/** The findings of the test system's gates a repository runs: the core's always, the properties pack's when it runs
 * that pack. */
export const testSystemFindings = (
	tree: Tree,
	packs: ReadonlyArray<PackName>
): ReadonlyArray<Finding> =>
	Arr.flatMap(TEST_SYSTEM_RULES, (rule) =>
		RULES[rule].part === "core" || Arr.contains(packs, RULES[rule].part)
			? RULES[rule].check(tree)
			: []
	)
