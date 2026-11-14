import { Array as Arr, String as Str } from "effect"

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
