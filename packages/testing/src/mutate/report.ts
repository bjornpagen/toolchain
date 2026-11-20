import { Array as Arr, Order, Result, String as Str } from "effect"
import type { MutantJudged } from "#mutate/operators.ts"
import type { Product } from "#scope.ts"

/**
 * What a mutation run names and what it reports (mutate/commands.ts mutateCommand, `toolchain-test mutate`, a
 * measurement in every repository): the source files its paths name, a file or a source directory each, and its judged
 * mutants of a kind, survived or uncovered, by file and then operator.
 */

/** Whether a file is TypeScript the mutator mutates: a module, never a declaration file. */
export const isMutable = (file: string): boolean =>
	Arr.some([".ts", ".tsx", ".mts", ".cts"], (extension) => Str.endsWith(extension)(file)) &&
	!Arr.some([".d.ts", ".d.mts", ".d.cts"], (extension) => Str.endsWith(extension)(file))

/**
 * The files a run's `paths` name (each from the checkout) in a repository that holds `tracked`, in order and each once:
 * a path that is a file the repository holds names that file; any other names every mutable file of product source
 * below it, a source directory (`packages/engine/src/runtime/write`), test scope and declaration files left out. A
 * path that names no file is refused, each such path given back, so a run never measures nothing and says it measured.
 */
export const namedFiles = (
	tracked: ReadonlySet<string>,
	product: Product,
	paths: Arr.NonEmptyReadonlyArray<string>
): Result.Result<Arr.NonEmptyReadonlyArray<string>, Arr.NonEmptyReadonlyArray<string>> => {
	const sorted = Arr.sort(Arr.fromIterable(tracked), Order.String)
	const named = Arr.map(paths, (path): Result.Result<Arr.NonEmptyReadonlyArray<string>, string> => {
		const directory = Str.endsWith("/")(path) ? path : `${path}/`
		const files = tracked.has(path)
			? [path]
			: Arr.filter(
					sorted,
					(file) => Str.startsWith(directory)(file) && product(file) && isMutable(file)
				)
		return Arr.isReadonlyArrayNonEmpty(files) ? Result.succeed(files) : Result.fail(path)
	})
	const unnamed = Arr.getFailures(named)
	return Arr.isReadonlyArrayNonEmpty(unnamed)
		? Result.fail(unnamed)
		: Result.succeed(
				Arr.dedupe(
					Arr.flatMap(named, (one) =>
						Result.match(one, { onSuccess: (files) => files, onFailure: (path) => [path] as const })
					)
				)
			)
}

/** A kind of judged mutant a run lists one by one: those that survived every property that ran them, and those none ran. */
export type Listed = "survived" | "uncovered"

/** A listed mutant's lines: its id, place, function and edit, and for a survivor the properties it faced. */
const listedLines = ({ mutant, verdict }: MutantJudged<string>): ReadonlyArray<string> => {
	const edit = `      ${mutant.id} ${String(mutant.line)}:${String(mutant.column)} in ${mutant.fn}: ${Str.replaceAll("\n", " ")(mutant.original)} -> ${Str.replaceAll("\n", " ")(mutant.replacement)}`
	switch (verdict.kind) {
		case "survived":
			return [edit, `        faced ${Arr.join(verdict.faced, ", ")}`]
		case "uncovered":
			return [edit]
		case "killed":
		case "invalid":
		case "equivalent":
			return []
	}
}

/**
 * The mutants of `kind` among `judged`, by file and then operator, each group headed by its count and each mutant a
 * line of its own (listedLines); no lines when there are none.
 */
export const listedReport = (
	judged: ReadonlyArray<MutantJudged<string>>,
	kind: Listed
): ReadonlyArray<string> => {
	const listed = Arr.filter(judged, ({ verdict }) => verdict.kind === kind)
	const keys = (
		key: (one: MutantJudged<string>) => string,
		of: ReadonlyArray<MutantJudged<string>>
	) => Arr.sort(Arr.dedupe(Arr.map(of, key)), Order.String)
	return Arr.flatMap(
		keys(({ mutant }) => mutant.file, listed),
		(file) => {
			const inFile = Arr.filter(listed, ({ mutant }) => mutant.file === file)
			return [
				`  ${file}: ${String(inFile.length)}`,
				...Arr.flatMap(
					keys(({ mutant }) => mutant.operator, inFile),
					(operator) => {
						const these = Arr.filter(inFile, ({ mutant }) => mutant.operator === operator)
						return [`    ${operator}: ${String(these.length)}`, ...Arr.flatMap(these, listedLines)]
					}
				)
			]
		}
	)
}
