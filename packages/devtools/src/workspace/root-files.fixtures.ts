import { array, boolean, element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, Option, Order, String as Str } from "effect"
import { LINT_SCRIPT, ROOT_LINT, ROOT_TSCONFIG, rootFileFindings } from "#workspace/root-files.ts"
import { ROOT_MANIFEST } from "#workspace/root-tasks.ts"

/**
 * The repositories the root-files property draws (root-files.test.ts), from a grammar of the gate's contract read over
 * the names its module exports: workspace packages, and files at the root, in root directories and in packages (a
 * TypeScript file, a declaration file, a file of another kind, and a name that only begins like a package's directory
 * or an include entry); for each root TypeScript file, how the include names it (its own path, its directory, a
 * directory above it, with `./` or a trailing `/`, or not at all); entries that name nothing, and globs; and the root's
 * oxlint script (the root lint, the root lint with arguments, another command, or none). And the findings the gate
 * gives one.
 */

/** What a file, an entry or a script is in a repository, as the property names its situations. */
export type Feature =
	| "a root file the include names"
	| "a root file it does not name"
	| "a package's file"
	| "a file of another kind"
	| "a glob in the include"
	| "a root lint script"
	| "another lint script"
	| "no lint script"

/** The workspace packages a repository may hold, by directory. */
const PACKAGES = ["packages/a", "packages/b/c"] as const

/** A file no rule of the root reads: its path, and what it is. */
type File = Readonly<{ path: string; kind: "package" | "other" }>

/** How the include names a root file. */
type Naming = "path" | "directory" | "above" | "dotted" | "slashed" | "none"

/** The root files a repository draws: at the root, under a root directory, beside a package's directory by a name it
 * only begins like, and declarations. */
const ROOT_FILES = [
	"oxlint.config.ts",
	"toolchain.config.ts",
	"web.ts",
	"test/unit/x.test.ts",
	"scripts/gen/make.ts",
	"scripts/general.ts",
	"bugs/08-cliff/fit.tsx",
	"types/env.d.ts",
	"packages/ab/stray.ts",
	"packages/b/stray.ts"
] as const

/** Files no rule of the root reads: a package's TypeScript, and other kinds at the root. */
const PACKAGE_FILES = ["packages/a/src/x.ts", "packages/b/c/y.tsx"] as const

const OTHER_FILES = ["README.md", "test/data.json", "scripts/run.sh", "tsconfig.json"] as const

/** The directories the include names that hold no file, and globs, which oxlint would read as paths. */
const IDLE_ENTRIES = ["docs", "scripts/gen/none.ts"] as const

const GLOBS = ["test/**/*.ts", "*.config.ts", "scripts/{gen,dev}"] as const

/** The root's oxlint script: the root lint, it with arguments, another command, or none. */
type Script = "root" | "root with arguments" | "another" | "none"

const SCRIPTS: Readonly<Record<Script, string>> = {
	root: ROOT_LINT,
	"root with arguments": `${ROOT_LINT} --deny-warnings`,
	another: "toolchain-oxlint oxlint.config.ts oxlint.ast.config.ts",
	none: ""
}

/** A root file and how the include names it. */
type Named = Readonly<{ path: string; naming: Naming }>

/** A repository: its packages, its files, how the include names each root file, its idle entries and globs, and its
 * oxlint script. */
export type Repository = Readonly<{
	packages: ReadonlyArray<string>
	roots: ReadonlyArray<Named>
	others: ReadonlyArray<File>
	idle: ReadonlyArray<string>
	globs: ReadonlyArray<string>
	script: Script
}>

const namingGen: Gen<Naming> = element([
	"path",
	"directory",
	"above",
	"dotted",
	"slashed",
	"none"
] as const)

export const repositories: Gen<Repository> = (source) => {
	const packages = Arr.filter(PACKAGES, () => source.draw(boolean))
	const packageFiles = Arr.filter(PACKAGE_FILES, (path) =>
		Arr.some(packages, (directory) => Str.startsWith(`${directory}/`)(path))
	)
	return {
		packages,
		roots: Arr.map(
			Arr.dedupe(source.draw(array(element(ROOT_FILES), { min: 0, max: 4 }))),
			(path) => ({ path, naming: source.draw(namingGen) })
		),
		others: [
			...Arr.map(
				Arr.filter(packageFiles, () => source.draw(boolean)),
				(path): File => ({ path, kind: "package" })
			),
			...Arr.map(
				Arr.dedupe(source.draw(array(element(OTHER_FILES), { min: 0, max: 2 }))),
				(path): File => ({ path, kind: "other" })
			)
		],
		idle: Arr.dedupe(source.draw(array(element(IDLE_ENTRIES), { min: 0, max: 2 }))),
		globs: Arr.dedupe(source.draw(array(element(GLOBS), { min: 0, max: 1 }))),
		script: source.draw(element(["root", "root with arguments", "another", "none"] as const))
	}
}

const ROOT = "/repository"

/** A path's directory, `.` at the root. */
const directoryOf = (path: string): string => {
	const segments = Str.split("/")(path)
	return segments.length === 1 ? "." : Arr.join(Arr.dropRight(segments, 1), "/")
}

/** A path's first segment's directory: the topmost directory above it, `.` at the root. */
const topOf = (path: string): string => {
	const segments = Str.split("/")(path)
	return segments.length === 1 ? "." : Arr.headNonEmpty(segments)
}

/** The include entries that name a root file, by how it is drawn: none for a file the include leaves out. */
const ENTRIES: Readonly<Record<Naming, (path: string) => ReadonlyArray<string>>> = {
	path: (path) => [path],
	directory: (path) => [directoryOf(path)],
	above: (path) => [topOf(path)],
	dotted: (path) => [`./${path}`],
	slashed: (path) => [`${directoryOf(path)}/`],
	none: () => []
}

/** The include, its entries in drawing order. */
const includeOf = (repository: Repository): ReadonlyArray<string> =>
	Arr.dedupe([
		...Arr.flatMap(repository.roots, (named) => ENTRIES[named.naming](named.path)),
		...repository.idle,
		...repository.globs
	])

/** Whether an entry, as the contract reads it, names a path: the path, or a directory above it; `.` names all. */
const names = (entry: string, path: string): boolean => {
	const unslashed = Str.endsWith("/")(entry) ? Str.slice(0, -1)(entry) : entry
	const bare = Str.startsWith("./")(unslashed) ? Str.slice(2)(unslashed) : unslashed
	return bare === "." || bare === path || Str.startsWith(`${bare}/`)(path)
}

const tsconfigOf = (include: ReadonlyArray<string>): string =>
	Arr.join(
		[
			"{",
			'\t"extends": "./base.json",',
			'\t"include": [',
			Arr.join(
				Arr.map(include, (entry) => `\t\t"${entry}"`),
				",\n"
			),
			"\t]",
			"}"
		],
		"\n"
	)

const manifestOf = (script: Script): string =>
	script === "none"
		? '{\n\t"name": "root",\n\t"scripts": {\n\t\t"types": "turbo run typecheck"\n\t}\n}'
		: `{\n\t"name": "root",\n\t"scripts": {\n\t\t"types": "turbo run typecheck",\n\t\t"${LINT_SCRIPT}": "${SCRIPTS[script]}"\n\t}\n}`

/** A finding as the property compares them: its rule, its file from the root, and its line. */
type Seen = readonly [rule: string, file: string, line: number]

const bySeen = Order.combineAll<Seen>([
	Order.mapInput(Order.String, (seen: Seen) => seen[0]),
	Order.mapInput(Order.String, (seen: Seen) => seen[1]),
	Order.mapInput(Order.Number, (seen: Seen) => seen[2])
])

/** The gate's findings over a repository, sorted. */
export const outcomeOf = (repository: Repository) => {
	const include = includeOf(repository)
	const tsconfig = tsconfigOf(include)
	return Effect.map(
		rootFileFindings({
			root: ROOT,
			files: [
				...Arr.map(repository.roots, (named) => named.path),
				...Arr.map(repository.others, (file) => file.path)
			],
			packages: Arr.map(repository.packages, (directory) => `./${directory}/`),
			include,
			tsconfig,
			manifest: manifestOf(repository.script)
		}),
		(findings): ReadonlyArray<Seen> =>
			Arr.sort(
				Arr.map(findings, (finding): Seen => [
					finding.rule,
					Str.slice(ROOT.length + 1)(finding.file),
					finding.line
				]),
				bySeen
			)
	)
}

/** The 1-based line of a text that holds `needle`; 0, which no finding is at, when none does. */
const lineOf = (text: string, needle: string): number =>
	Option.match(Arr.findFirstIndex(Str.split("\n")(text), Str.includes(needle)), {
		onNone: () => 0,
		onSome: (at) => at + 1
	})

/** The manifest's finding, at a line. */
const scriptSeen = (line: number): Seen => ["root-files", ROOT_MANIFEST, line]

/** The findings the contract gives a repository: each root file no entry names, each glob at its line in the
 * tsconfig, and the manifest's script when the root holds a file and the script is not the root lint. */
export const expectedOf = (repository: Repository): ReadonlyArray<Seen> => {
	const include = includeOf(repository)
	const tsconfig = tsconfigOf(include)
	const manifest = manifestOf(repository.script)
	return Arr.sort(
		[
			...Arr.flatMap(repository.roots, (named): ReadonlyArray<Seen> =>
				Arr.some(include, (entry) => names(entry, named.path))
					? []
					: [["root-files", named.path, 1]]
			),
			...Arr.map(repository.globs, (glob): Seen => [
				"root-files",
				ROOT_TSCONFIG,
				lineOf(tsconfig, `"${glob}"`)
			]),
			...(Arr.isReadonlyArrayNonEmpty(repository.roots) &&
			(repository.script === "another" || repository.script === "none")
				? [scriptSeen(repository.script === "none" ? 1 : lineOf(manifest, `"${LINT_SCRIPT}":`))]
				: [])
		],
		bySeen
	)
}

/** The situation the root's oxlint script puts a repository in. */
const SCRIPT_FEATURES: Readonly<Record<Script, Feature>> = {
	root: "a root lint script",
	"root with arguments": "a root lint script",
	another: "another lint script",
	none: "no lint script"
}

/** The situations a repository reaches. */
export const featuresOf = (repository: Repository): ReadonlyArray<Feature> => {
	const include = includeOf(repository)
	return [
		...Arr.map(repository.roots, (named): Feature =>
			Arr.some(include, (entry) => names(entry, named.path))
				? "a root file the include names"
				: "a root file it does not name"
		),
		...Arr.map(repository.others, (file): Feature =>
			file.kind === "package" ? "a package's file" : "a file of another kind"
		),
		...Arr.map(repository.globs, (): Feature => "a glob in the include"),
		SCRIPT_FEATURES[repository.script]
	]
}
