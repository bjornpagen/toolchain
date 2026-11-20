import { Array as Arr, String as Str } from "effect"
import { array, element, type Gen, subset } from "#gen.ts"
import type { Mutant } from "#mutants.ts"
import type { MutantJudged, MutantVerdict } from "#mutate/operators.ts"
import { PropertyId } from "#property.ts"
import { isTestScope } from "#scope.ts"

/**
 * What the report properties (report.test.ts) draw: a repository's tracked files and the paths a run names of it, and
 * a run's judged mutants.
 */

/**
 * The files a drawn repository may hold: product modules at two depths of a source directory, a declaration file, a
 * file that is no TypeScript, a test module, a module of a support directory under the source directory, and a
 * product module of another directory.
 */
const FILES: ReadonlyArray<string> = [
	"pkg/src/a.ts",
	"pkg/src/deep/b.tsx",
	"pkg/src/c.d.ts",
	"pkg/src/d.json",
	"pkg/src/e.test.ts",
	"pkg/src/support/f.ts",
	"other/g.ts"
]

/**
 * The paths a run may name: the source directory, a directory below it and one above it, a held file, a directory
 * with a slash after it, a support directory, and a path the repository holds nothing under.
 */
const PATHS = [
	"pkg/src",
	"pkg/src/deep",
	"pkg",
	"pkg/src/a.ts",
	"other/",
	"pkg/src/support",
	"nowhere"
] as const

/** A drawn repository and run: the files it holds (one at least) and the paths the run names (one at least). */
export type Naming = Readonly<{
	tracked: ReadonlySet<string>
	paths: Arr.NonEmptyReadonlyArray<string>
}>

export const namings: Gen<Naming> = (source) => {
	const tracked = new Set(source.draw(subset(FILES, { min: 1, max: FILES.length })))
	const first = source.draw(element(PATHS))
	const rest = source.draw(subset(PATHS, { min: 0, max: 3 }))
	return { tracked, paths: [first, ...rest] }
}

/** Product source in a drawn repository: a file it holds outside test scope (scope.ts productOf's rule). */
export const productIn =
	(tracked: ReadonlySet<string>) =>
	(file: string): boolean =>
		tracked.has(file) && !isTestScope(file)

/**
 * The files a path names by the specification: itself when the repository holds it; else every file it holds below
 * the path that is product source and a module the mutator mutates (a .ts or .tsx file, no declaration file).
 */
export const specifiedFiles = (
	tracked: ReadonlySet<string>,
	path: string
): ReadonlyArray<string> => {
	if (tracked.has(path)) {
		return [path]
	}
	const below = Str.endsWith("/")(path) ? path : `${path}/`
	return Arr.filter(
		FILES,
		(file) =>
			tracked.has(file) &&
			Str.startsWith(below)(file) &&
			!isTestScope(file) &&
			(Str.endsWith(".ts")(file) || Str.endsWith(".tsx")(file)) &&
			!Str.endsWith(".d.ts")(file)
	)
}

/** The kinds of verdict a drawn mutant carries. */
type Kind = MutantVerdict["kind"]

const VERDICTS: Readonly<Record<Kind, MutantVerdict>> = {
	killed: {
		kind: "killed",
		property: PropertyId("p#killer"),
		red: { kind: "unstarted", message: "no worker started" }
	},
	survived: { kind: "survived", faced: [PropertyId("p#one"), PropertyId("p#two")] },
	invalid: { kind: "invalid" },
	uncovered: { kind: "uncovered" },
	equivalent: { kind: "equivalent", why: "judged so" }
}

/** One drawn mutant of a run: its file, operator and verdict, its id its position in the run. */
const judgedAt = (file: string, operator: string, kind: Kind, at: number): MutantJudged<string> => {
	const mutant: Mutant<string> = {
		id: `m${String(at)}`,
		file,
		source: "const x = 1 === 1\n",
		operator,
		start: 10,
		end: 17,
		replacement: "true",
		line: 1,
		column: 11,
		fn: "<module>",
		original: "1 === 1"
	}
	return { mutant, verdict: VERDICTS[kind] }
}

/** A run's judged mutants: none to a dozen, each of one of three files, one of two operators, and any verdict. */
export const runs: Gen<ReadonlyArray<MutantJudged<string>>> = (source) =>
	Arr.map(
		source.draw(
			array(
				(inner) =>
					[
						inner.draw(element(["src/b.ts", "src/a.ts", "lib/c.ts"] as const)),
						inner.draw(element(["negate", "remove"] as const)),
						inner.draw(
							element(["killed", "survived", "invalid", "uncovered", "equivalent"] as const)
						)
					] as const,
				{ min: 0, max: 12 }
			)
		),
		([file, operator, kind], at) => judgedAt(file, operator, kind, at)
	)

/** A report's section: the file its header line names (`  <file>: <count>`), its count, and the ids listed under it. */
export type Section = Readonly<{ file: string; count: string; ids: ReadonlyArray<string> }>

/** A report's sections, in its order, read back from its lines. */
export const sectionsOf = (lines: ReadonlyArray<string>): ReadonlyArray<Section> => {
	const sections: Array<Section> = []
	for (const line of lines) {
		const fields = Str.split(" ")(Str.trim(line))
		const head = Arr.getUnsafe(fields, 0)
		if (Str.startsWith("  ")(line) && !Str.startsWith("   ")(line)) {
			sections.push({ file: Str.slice(0, -1)(head), count: Arr.getUnsafe(fields, 1), ids: [] })
		} else if (Str.startsWith("      m")(line)) {
			const last = sections.pop()
			if (last !== undefined) {
				sections.push({ ...last, ids: [...last.ids, head] })
			}
		}
	}
	return sections
}
