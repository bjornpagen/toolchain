import { Array as Arr, Option, String as Str } from "effect"

/** How the style options name files. A path is repository-relative and matched as a suffix of a file's absolute path
 * at a "/" boundary, so the same options read the same in every checkout; one ending in "/" names a directory and
 * matches every file under it. */

/** Whether a file is the one a repository-relative path names, or lies under the directory it names. */
export const isNamedBy =
	(path: string) =>
	(file: string): boolean => {
		if (Str.endsWith("/")(path)) {
			return Str.includes(`/${path}`)(file)
		}
		return file === path || Str.endsWith(`/${path}`)(file)
	}

/** Whether any of the paths names the file. */
export const isNamedByAny =
	(paths: ReadonlyArray<string>) =>
	(file: string): boolean =>
		Arr.some(paths, (path) => isNamedBy(path)(file))

/** The directories a file lies in, outermost first: its segments but its name. */
const directoriesOf = (file: string): ReadonlyArray<string> =>
	Arr.dropRight(Str.split("/")(file), 1)

/** Segments as a path names them: a `.` is dropped, and a `..` drops the segment before it. */
const resolvedSegments = (segments: ReadonlyArray<string>): ReadonlyArray<string> =>
	Arr.reduce(segments, Arr.empty<string>(), (resolved, segment) => {
		if (segment === ".") {
			return resolved
		}
		return segment === ".." ? Arr.dropRight(resolved, 1) : [...resolved, segment]
	})

const isRelativeModule = (module: string): boolean =>
	Str.startsWith("./")(module) || Str.startsWith("../")(module)

/** The file a stylesheet's `@import` of a relative module names, beside the importing file; none for a package's
 * module, which no path of the repository names. */
export const importedFile = (
	input: Readonly<{ file: string; module: string }>
): Option.Option<string> =>
	isRelativeModule(input.module)
		? Option.some(
				Arr.join(
					resolvedSegments([...directoriesOf(input.file), ...Str.split("/")(input.module)]),
					"/"
				)
			)
		: Option.none()

/** The module a stylesheet imports a file by: the file's path from the importing file's directory, `./` ahead of one
 * in that directory or under it. */
export const moduleOf = (input: Readonly<{ file: string; target: string }>): string => {
	const from = directoriesOf(input.file)
	const to = Str.split("/")(input.target)
	const shared = Arr.takeWhile(Arr.zip(from, to), ([left, right]) => left === right).length
	const up = Arr.map(Arr.drop(from, shared), () => "..")
	return Arr.join([...(Arr.isReadonlyArrayNonEmpty(up) ? up : ["."]), ...Arr.drop(to, shared)], "/")
}
