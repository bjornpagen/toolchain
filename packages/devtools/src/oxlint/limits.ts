import { Array as Arr, Schema, String as Str } from "effect"
import { type Context, isFileAt } from "#oxlint/rule.ts"

/**
 * What the two limit rules, no-bare-limit and limits-sole-mint, share: a repository's limits packages, where its limits
 * are minted and their numbers written, and its test files, which neither rule reads. The preset's LIMIT_TESTS is the
 * test files every repository starts from; a repository passes its own lists to narrow or widen them.
 */
export const LimitsOptions = Schema.Struct({
	/** The limits packages, by repository-relative directory (`packages/limits`), or a file. */
	packages: Schema.NonEmptyArray(Schema.String),
	/** The test files: those whose name ends with one of `suffixes`, and those beneath a directory named one of
	 * `directories`, at any depth (`test` holds `src/test/`). */
	tests: Schema.Struct({
		suffixes: Schema.Array(Schema.String),
		directories: Schema.Array(Schema.String)
	})
})

export type LimitsOptions = typeof LimitsOptions.Type

/** A directory path without its trailing "/". */
const trailingFree = (path: string): string =>
	Str.endsWith("/")(path) ? Str.slice(0, -1)(path) : path

/** A path of the options names the file itself, or a directory it lies beneath. */
const isWithin = (filename: string, path: string): boolean =>
	isFileAt(filename, path) || Str.includes(`/${path}/`)(filename)

/** The directories a file lies beneath, from the directory the linter runs in down, so a directory above the
 * repository never exempts it. */
const directoriesOf = (filename: string, cwd: string): ReadonlyArray<string> => {
	const relative = Str.startsWith(`${cwd}/`)(filename)
		? Str.slice(cwd.length + 1)(filename)
		: filename
	return Arr.dropRight(Str.split("/")(relative), 1)
}

/** Whether a file is one the limit rules leave alone: a file of a limits package, or a test file. */
export const isLimitsExempt = (context: Context, options: LimitsOptions): boolean =>
	Arr.some(options.packages, (path) => isWithin(context.filename, trailingFree(path))) ||
	Arr.some(options.tests.suffixes, (suffix) => Str.endsWith(suffix)(context.filename)) ||
	Arr.some(directoriesOf(context.filename, context.cwd), (directory) =>
		Arr.contains(options.tests.directories, directory)
	)

/** The limits packages as a message names them. */
export const packagesOf = (options: LimitsOptions): string => Arr.join(options.packages, " or ")
