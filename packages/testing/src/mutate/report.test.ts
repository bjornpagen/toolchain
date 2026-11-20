/**
 * What a mutation run names and reports (mutate/report.ts, `toolchain-test mutate`'s measurement in every repository).
 * The files a run's paths name in a drawn repository: a held file itself, a source directory every mutable file of
 * product source below it (no test module, no support module, no declaration file, no other file), and a path that
 * names none refused, every such path given back. The report of a drawn run's judged mutants: for survivors and for
 * the uncovered, a section a file in order, headed by its count, listing each of its mutants of that kind once and no
 * mutant of another kind. Oracle: the specification, stated in report.fixtures.ts (specifiedFiles) and in the checks.
 */
import { Array as Arr, Effect, Order, Result } from "effect"
import { assert } from "#assert.ts"
import { namings, productIn, runs, sectionsOf, specifiedFiles } from "#mutate/report.fixtures.ts"
import { listedReport, namedFiles } from "#mutate/report.ts"
import { property } from "#property.ts"

export const namedSourceFiles = property.explore(namings, {
	needs: {},
	situations: ["every path names a file", "a path names none"],
	check:
		(_resources, c) =>
		({ tracked, paths }) =>
			Effect.sync(() => {
				const specified = Arr.map(paths, (path) => [path, specifiedFiles(tracked, path)] as const)
				const unnamed = Arr.flatMap(specified, ([path, files]) =>
					Arr.isReadonlyArrayNonEmpty(files) ? [] : [path]
				)
				c.note(
					Arr.isReadonlyArrayNonEmpty(unnamed) ? "a path names none" : "every path names a file"
				)
				const expected: Result.Result<
					ReadonlyArray<string>,
					ReadonlyArray<string>
				> = Arr.isReadonlyArrayNonEmpty(unnamed)
					? Result.fail(unnamed)
					: Result.succeed(Arr.dedupe(Arr.flatMap(specified, ([, files]) => files)))
				const named: Result.Result<ReadonlyArray<string>, ReadonlyArray<string>> = namedFiles(
					tracked,
					productIn(tracked),
					paths
				)
				assert.deepEqual(named, expected)
			}),
	oracle: {
		kind: "specification",
		name: "a held file names itself, a directory every mutable product file below it, and a path naming none is refused with every other such path"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/mutate/report.ts",
			original: "(file) => Str.startsWith(directory)(file) && product(file) && isMutable(file)",
			replacement: "(file) => Str.startsWith(directory)(file) && isMutable(file)",
			why: "A source directory names its test and support modules too, so a run mutates the harness and scores its tests against themselves; the property fails."
		},
		{
			file: "packages/testing/src/mutate/report.ts",
			original: "\treturn Arr.isReadonlyArrayNonEmpty(unnamed)\n\t\t? Result.fail(unnamed)",
			replacement:
				"\treturn Arr.isReadonlyArrayNonEmpty(unnamed) && unnamed.length < 0\n\t\t? Result.fail(unnamed)",
			why: "A path that names no file is passed over, so a mistyped source directory measures nothing of it and the run says it measured; the property fails."
		}
	]
})

export const listedByFileAndOperator = property.explore(runs, {
	needs: {},
	situations: ["a survivor", "an uncovered mutant"],
	check: (_resources, c) => (judged) =>
		Effect.sync(() => {
			for (const kind of ["survived", "uncovered"] as const) {
				const these = Arr.filter(judged, ({ verdict }) => verdict.kind === kind)
				if (Arr.isReadonlyArrayNonEmpty(these)) {
					c.note(kind === "survived" ? "a survivor" : "an uncovered mutant")
				}
				const files = Arr.sort(
					Arr.dedupe(Arr.map(these, ({ mutant }) => mutant.file)),
					Order.String
				)
				assert.deepEqual(
					Arr.map(sectionsOf(listedReport(judged, kind)), (section) => ({
						...section,
						ids: Arr.sort(section.ids, Order.String)
					})),
					Arr.map(files, (file) => {
						const ids = Arr.flatMap(these, ({ mutant }) =>
							mutant.file === file ? [mutant.id] : []
						)
						return { file, count: String(ids.length), ids: Arr.sort(ids, Order.String) }
					})
				)
			}
		}),
	oracle: {
		kind: "specification",
		name: "for survivors and for the uncovered, a section a file in order, headed by its count, listing each of its mutants of that kind once and none of another"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/mutate/report.ts",
			original: '\t\tcase "uncovered":\n\t\t\treturn [edit]',
			replacement: '\t\tcase "uncovered":\n\t\t\treturn []',
			why: "The uncovered mutants are counted and never named, as `mutate` printed them before, so no one can tell which code no property runs; the property fails."
		},
		{
			file: "packages/testing/src/mutate/report.ts",
			original: "const listed = Arr.filter(judged, ({ verdict }) => verdict.kind === kind)",
			replacement: "const listed = judged",
			why: "Every judged mutant is listed under every kind, the killed among the survivors; the property fails."
		}
	]
})
