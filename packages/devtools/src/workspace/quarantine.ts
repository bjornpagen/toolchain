import { Array as Arr, Option, Result, String as Str } from "effect"
import type { Finding } from "#shared/finding.ts"

/**
 * The quarantine: until the toolchain deletes its Vitest adapter, a package may keep the test modules it has not yet
 * converted on Vitest, under one configuration at its root, quarantine.vitest.config.ts, whose `include` names each
 * file outright. The list only falls: a file enters it only while it is still the legacy test module it was in the
 * parent commit, never a new one, and the oxlint override that exempts the quarantined modules from a test module's
 * shape names exactly them. The runner never reads a quarantined module.
 */

/** The one legacy configuration a package may keep, at its root. */
export const QUARANTINE = "quarantine.vitest.config.ts"

/** The characters a glob spells with: a quarantine names its files outright. */
const GLOB_MARKS: ReadonlyArray<string> = ["*", "?", "{", "}", "[", "]", "!"]

/** A repository's files at one commit: their paths from the root, and the text of each file a check reads. */
export type Snapshot = Readonly<{
	files: ReadonlyArray<string>
	textOf: (path: string) => Option.Option<string>
}>

/** The directory a path lies in, "" for the root. */
const directoryOf = (path: string): string => Arr.join(Arr.dropRight(Str.split("/")(path), 1), "/")

/** A path beneath a directory, "" being the root. */
const beneath = (directory: string, path: string): string =>
	directory === "" ? path : `${directory}/${path}`

/** The characters that part a list's items: spaces, line breaks and commas. */
const SEPARATORS: ReadonlyArray<string> = [" ", "\t", "\r", "\n", ","]

/** The quotes a string literal opens and closes with. */
const QUOTES: ReadonlyArray<string> = ['"', "'"]

/**
 * The string literals a list holds, in order, read left to right from just past its `[` to the `]` that closes it:
 * separators skipped, each literal from its quote to the same quote again. Anything else, a literal never closed or a
 * list never closed, is no list of literals.
 */
const literalsOf = (
	text: string,
	read: ReadonlyArray<string>
): Result.Result<ReadonlyArray<string>, string> => {
	const rest = Arr.join(
		Arr.dropWhile(Str.split("")(text), (character) => Arr.contains(SEPARATORS, character)),
		""
	)
	if (Str.isEmpty(rest)) {
		return Result.fail("holds an `include` list never closed")
	}
	const quote = Str.slice(0, 1)(rest)
	if (quote === "]") {
		return Result.succeed(read)
	}
	if (!Arr.contains(QUOTES, quote)) {
		return Result.fail("holds an `include` item that is no string literal")
	}
	return Option.match(Str.indexOf(quote)(Str.slice(1)(rest)), {
		onNone: () => Result.fail("holds a string literal never closed"),
		onSome: (length) =>
			literalsOf(Str.slice(length + 2)(rest), Arr.append(read, Str.slice(1, length + 1)(rest)))
	})
}

/**
 * The files a quarantine's `include` names, relative to its package's root: the string literals of the first array
 * after `include`, a line comment among them skipped. What is no such list, or an item that is no string literal, is
 * the problem it states instead.
 */
export const includedOf = (text: string): Result.Result<ReadonlyArray<string>, string> => {
	const list = Option.flatMap(Str.indexOf("include")(text), (at) => {
		const after = Str.slice(at)(text)
		return Option.map(Str.indexOf("[")(after), (open) => Str.slice(open + 1)(after))
	})
	return Option.match(list, {
		onNone: () => Result.fail("states no `include` list"),
		onSome: (items) =>
			literalsOf(
				Arr.join(
					Arr.filter(Str.split("\n")(items), (line) => !Str.startsWith("//")(Str.trim(line))),
					"\n"
				),
				[]
			)
	})
}

/** A finding of the quarantine, under the no-vitest-config gate. */
const findingAt = (root: string, path: string, message: string): Finding => ({
	file: `${root}/${path}`,
	line: 1,
	column: 1,
	rule: "no-vitest-config",
	message
})

/** The files a quarantine at a path may name: its parent's list where the parent held it (none, where that list cannot
 * be read), else every file the parent held beneath its package; anything where there is no parent commit. */
const allowedOf = (
	path: string,
	parent: Option.Option<Snapshot>
): Option.Option<ReadonlyArray<string>> =>
	Option.map(parent, (before) =>
		Option.match(before.textOf(path), {
			onNone: () =>
				Arr.filter(
					before.files,
					(file) => directoryOf(path) === "" || Str.startsWith(`${directoryOf(path)}/`)(file)
				),
			onSome: (text) =>
				Arr.map(
					Result.getOrElse(includedOf(text), (): ReadonlyArray<string> => []),
					(entry) => beneath(directoryOf(path), entry)
				)
		})
	)

/**
 * What the quarantine refuses: a quarantine outside a package's root, one whose list cannot be read, an entry that is
 * a glob, an entry naming no tracked file, an entry the parent commit did not allow (the list grew), and an exemption
 * from a test module's shape that names a file no quarantine holds. The paths of the quarantined files, from the
 * repository root, are what the runner leaves to Vitest.
 */
export const quarantineFindings = (
	input: Readonly<{
		root: string
		current: Snapshot
		parent: Option.Option<Snapshot>
		lintConfig: string
		shapeExemptions: ReadonlyArray<string>
	}>
): ReadonlyArray<Finding> => {
	const { root, current, parent } = input
	const quarantines = Arr.filter(
		current.files,
		(file) => file === QUARANTINE || Str.endsWith(`/${QUARANTINE}`)(file)
	)
	const perQuarantine = Arr.map(quarantines, (path) => {
		const directory = directoryOf(path)
		const atRoot = Arr.contains(current.files, beneath(directory, "package.json"))
			? []
			: [
					findingAt(
						root,
						path,
						`${QUARANTINE} lies at no package's root: it sits beside the package.json whose tests it keeps.`
					)
				]
		const listed = includedOf(Option.getOrElse(current.textOf(path), () => ""))
		if (Result.isFailure(listed)) {
			return {
				findings: [
					...atRoot,
					findingAt(
						root,
						path,
						`This quarantine ${listed.failure}: it names each file outright, as string literals in one \`include\` array.`
					)
				],
				quarantined: []
			}
		}
		const allowed = allowedOf(path, parent)
		const entries = listed.success
		const findings = Arr.flatMap(entries, (entry): ReadonlyArray<Finding> => {
			const file = beneath(directory, entry)
			if (Arr.some(GLOB_MARKS, (mark) => Str.includes(mark)(entry))) {
				return [
					findingAt(
						root,
						path,
						`The quarantine's entry ${entry} is a glob: a quarantine names each file outright.`
					)
				]
			}
			if (!Arr.contains(current.files, file)) {
				return [
					findingAt(root, path, `The quarantine's entry ${entry} names no tracked file: delete it.`)
				]
			}
			return Option.exists(allowed, (files) => !Arr.contains(files, file))
				? [
						findingAt(
							root,
							path,
							`The quarantine grew: ${entry} was no legacy test module of its list in the parent commit. A quarantine only falls; a new or converted test module is a property the runner runs.`
						)
					]
				: []
		})
		return {
			findings: [...atRoot, ...findings],
			quarantined: Arr.map(entries, (entry) => beneath(directory, entry))
		}
	})
	const quarantined = Arr.flatMap(perQuarantine, (one) => one.quarantined)
	const exemptions = Arr.filterMap(input.shapeExemptions, (glob): Result.Result<Finding, void> =>
		Arr.contains(quarantined, glob)
			? Result.failVoid
			: Result.succeed(
					findingAt(
						root,
						input.lintConfig,
						`The exemption from a test module's shape names ${glob}, which no quarantine holds: it names exactly the quarantined files.`
					)
				)
	)
	return [...Arr.flatMap(perQuarantine, (one) => one.findings), ...exemptions]
}
