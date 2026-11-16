import { Array as Arr, Option, Result, String as Str } from "effect"
import type { Finding } from "#shared/finding.ts"
import type { Exceptions } from "#workspace/rules.ts"

/**
 * The dead-paths gate: every path a repository states about its files names one. An oxlint override whose globs match
 * no file lints nothing and says nothing true, and an exception whose path names no file excuses nothing; both outlive
 * the files they were written for. The globs the preset scopes its own blocks by (test modules, test scope) are the
 * standard's definitions, which a repository's files need not all match, and are left alone.
 */

/** A glob as the gate reads it: segments of literal text, `*` within a segment, `?` for one character, `**` for any
 * number of segments, and `{a,b}` alternatives. A character class or a negation is a glob it cannot read. */
const UNREAD = ["[", "]", "!"] as const

/** A glob's alternatives: its first `{a,b}` group expanded, then the rest of each, left to right. */
const expanded = (glob: string): ReadonlyArray<string> =>
	Option.match(
		Option.flatMap(Str.indexOf("{")(glob), (open) =>
			Option.map(
				Str.indexOf("}")(Str.slice(open)(glob)),
				(length) => [open, open + length] as const
			)
		),
		{
			onNone: () => [glob],
			onSome: ([open, close]) =>
				Arr.flatMap(Str.split(",")(Str.slice(open + 1, close)(glob)), (choice) =>
					expanded(`${Str.slice(0, open)(glob)}${choice}${Str.slice(close + 1)(glob)}`)
				)
		}
	)

/** The counts a wildcard may consume of `available` items: none up to all of them. */
const takings = (available: number): ReadonlyArray<number> =>
	Array.from({ length: available + 1 }, (_, taken) => taken)

/** Whether a segment matches a glob segment of literal characters, `*` and `?`. */
const segmentMatches = (pattern: ReadonlyArray<string>, text: ReadonlyArray<string>): boolean => {
	const [first, ...rest] = pattern
	if (first === undefined) {
		return text.length === 0
	}
	if (first === "*") {
		return Arr.some(takings(text.length), (taken) => segmentMatches(rest, Arr.drop(text, taken)))
	}
	const [character, ...others] = text
	return (
		character !== undefined &&
		(first === "?" || first === character) &&
		segmentMatches(rest, others)
	)
}

/** Whether a path's segments match a glob's: `**` consumes any number of segments, none included. */
const segmentsMatch = (glob: ReadonlyArray<string>, path: ReadonlyArray<string>): boolean => {
	const [first, ...rest] = glob
	if (first === undefined) {
		return path.length === 0
	}
	if (first === "**") {
		return Arr.some(takings(path.length), (taken) => segmentsMatch(rest, Arr.drop(path, taken)))
	}
	const [segment, ...others] = path
	return (
		segment !== undefined &&
		segmentMatches(Str.split("")(first), Str.split("")(segment)) &&
		segmentsMatch(rest, others)
	)
}

/** Whether a repository-relative path matches a glob. */
export const globMatches = (glob: string, path: string): boolean =>
	Arr.some(expanded(glob), (alternative) =>
		segmentsMatch(Str.split("/")(alternative), Str.split("/")(path))
	)

/** Whether an exception's path names a file: a path ending in "/" names a directory with a file beneath it, any other
 * path one file. */
const exceptionNames = (path: string, files: ReadonlyArray<string>): boolean =>
	Str.endsWith("/")(path)
		? Arr.some(files, (file) => Str.startsWith(Str.toLowerCase(path))(Str.toLowerCase(file)))
		: Arr.some(files, (file) => Str.toLowerCase(file) === Str.toLowerCase(path))

/** The 1-based line of a text that first holds `needle` in quotes, else the first. */
const lineOf = (text: string, needle: string): number =>
	Option.getOrElse(
		Arr.findFirstIndex(Str.split("\n")(text), (line) => Str.includes(`"${needle}"`)(line)),
		() => 0
	) + 1

/** What the dead-paths gate reads: the repository's root and files (by their path from the root), the globs of its
 * oxlint configuration's overrides beside the preset's own, its exceptions, and the two configuration files' texts and
 * paths, which a finding points into. */
export type Stated = Readonly<{
	root: string
	files: ReadonlyArray<string>
	lint: Readonly<{ path: string; text: string; globs: ReadonlyArray<string> }>
	toolchain: Readonly<{ path: string; text: string; exceptions: Exceptions }>
	standard: ReadonlyArray<string>
}>

/** Every glob of an override and every path of an exception that names no file of the repository. */
export const deadPathFindings = (stated: Stated): ReadonlyArray<Finding> => {
	const globs = Arr.dedupe(
		Arr.filter(stated.lint.globs, (glob) => !Arr.contains(stated.standard, glob))
	)
	const deadGlobs = Arr.filterMap(globs, (glob): Result.Result<Finding, void> => {
		if (Arr.some(UNREAD, (mark) => Str.includes(mark)(glob))) {
			return Result.succeed({
				file: `${stated.root}/${stated.lint.path}`,
				line: lineOf(stated.lint.text, glob),
				column: 1,
				rule: "dead-paths",
				message: `The override glob ${glob} holds a character class or a negation, which the gate cannot read: name the files with *, ** and {a,b}.`
			})
		}
		return Arr.some(stated.files, (file) => globMatches(glob, file))
			? Result.failVoid
			: Result.succeed({
					file: `${stated.root}/${stated.lint.path}`,
					line: lineOf(stated.lint.text, glob),
					column: 1,
					rule: "dead-paths",
					message: `The override glob ${glob} names no file of the repository: it lints nothing. Delete it, or name the files it was written for.`
				})
	})
	const deadExceptions = Arr.flatMap(stated.toolchain.exceptions, (exception) =>
		Arr.filterMap(exception.files, (path): Result.Result<Finding, void> =>
			exceptionNames(path, stated.files)
				? Result.failVoid
				: Result.succeed({
						file: `${stated.root}/${stated.toolchain.path}`,
						line: lineOf(stated.toolchain.text, path),
						column: 1,
						rule: "dead-paths",
						message: `The ${exception.rule} exception's path ${path} names no file of the repository: it excuses nothing. Delete it.`
					})
		)
	)
	return [...deadGlobs, ...deadExceptions]
}
