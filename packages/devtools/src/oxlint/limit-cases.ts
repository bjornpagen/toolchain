import { Array as Arr } from "effect"
import type { RuleTester } from "oxlint/plugins-dev"
import { LIMIT_TESTS } from "#preset.ts"

/** The repository the cases' files lie in, which the linter runs in. */
const CWD = "/repository"

/** The files neither rule reads: the limits package's, and every kind of test file LIMIT_TESTS names. */
const EXEMPT: ReadonlyArray<string> = [
	"packages/limits/src/limits.ts",
	"packages/limits/src/data.ts",
	"src/run.test.ts",
	"src/view.test.tsx",
	"src/witness.fixtures.ts",
	"test/support/limits.ts",
	"packages/pg/tests/pool.ts",
	"packages/engine/src/test/clock.ts",
	"src/fixtures/sample.ts"
]

/** Files both rules read: source, a benchmark (bench/ is no test), a package whose name only starts like the limits
 * package's, and a source file beneath a directory named `test` that lies above the repository. */
const READ: ReadonlyArray<Readonly<{ filename: string; cwd: string }>> = [
	{ filename: `${CWD}/src/run.ts`, cwd: CWD },
	{ filename: `${CWD}/bench/harness/limits.ts`, cwd: CWD },
	{ filename: `${CWD}/packages/limits-extra/src/run.ts`, cwd: CWD },
	{ filename: "/home/test/repository/src/run.ts", cwd: "/home/test/repository" }
]

/** One rule's cases for its files: `code` passes in every exempt file and draws one report in every file it reads. */
const casesOf = (code: string): Parameters<RuleTester["run"]>[2] => {
	/** The options both rules run under in the cases: the repository's one limits package, and the preset's test files. */
	const options = [
		{
			packages: ["packages/limits"],
			tests: { suffixes: [...LIMIT_TESTS.suffixes], directories: [...LIMIT_TESTS.directories] }
		}
	]
	return {
		valid: Arr.map(EXEMPT, (file) => ({ code, filename: `${CWD}/${file}`, cwd: CWD, options })),
		invalid: Arr.map(READ, (file) => ({ code, ...file, options, errors: 1 }))
	}
}

/**
 * The limit rules' cases on oxlint's RuleTester, run by src/oxlint/fixtures.ts: which files each reads, by path, which a
 * marked fixture cannot prove, since its fixtures all lie in one directory and a set in an exempt directory could mark no
 * violation.
 */
export const NO_BARE_LIMIT_CASES = casesOf("export const timeoutMs = 5000\n")

export const LIMITS_SOLE_MINT_CASES = casesOf(
	'import { published } from "@bjornpagen/limit"\ndeclare const fields: Parameters<typeof published>[0]\nexport const quota = published(fields)\n'
)
