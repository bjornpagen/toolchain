import { Array as Arr, String as Str } from "effect"

/** Test modules, by their suffix alone: a test module exports properties, and only there module state is a test's own. */
export const TEST_SUFFIXES: ReadonlyArray<string> = [".test.ts", ".test.tsx"]

/** The suffixes of test scope: the test modules', and a fixtures module's, which holds what a test module reads. */
const SCOPE_SUFFIXES: ReadonlyArray<string> = [...TEST_SUFFIXES, ".fixtures.ts"]

/** The directories whose every module, at any depth, is test scope: test support, integration tests and their support. */
const SCOPE_DIRECTORIES: ReadonlyArray<string> = ["test", "integration", "support"]

/**
 * Test scope: every module a repository's tests are made of, which the test rules hold. A test module (`*.test.ts`,
 * `*.test.tsx`), a fixtures module (`*.fixtures.ts`), and every module beneath a `test/`, `integration/` or `support/`
 * directory at any depth. As oxlint globs, relative to the repository root; the preset scopes the test rules to them.
 */
export const TEST_SCOPE: ReadonlyArray<string> = [
	...Arr.map(SCOPE_SUFFIXES, (suffix) => `**/*${suffix}`),
	...Arr.map(SCOPE_DIRECTORIES, (directory) => `**/${directory}/**`)
]

/** Whether a repository-relative path is test scope: it ends in a test scope suffix, or a directory above it is one of
 * test scope's. */
export const isTestScope = (path: string): boolean => {
	const segments = Str.split("/")(path)
	return (
		Arr.some(SCOPE_SUFFIXES, (suffix) => Str.endsWith(suffix)(path)) ||
		Arr.some(Arr.dropRight(segments, 1), (segment) => Arr.contains(SCOPE_DIRECTORIES, segment))
	)
}

/** Whether a path from the repository root is product source: a file the repository holds, outside test scope. */
export type Product = (file: string) => boolean

/**
 * Product source in a repository that holds `tracked` (paths from its root, a submodule's files none of them): a file
 * of them outside test scope, which a kill must edit to show its property caught a bug.
 */
export const productOf =
	(tracked: ReadonlySet<string>): Product =>
	(file) =>
		tracked.has(file) && !isTestScope(file)
