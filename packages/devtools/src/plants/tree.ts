import {
	Array as Arr,
	Effect,
	FileSystem,
	Order,
	Record as Rec,
	Result,
	String as Str
} from "effect"
import { type Citation, plantRoot, readingOf } from "#plants/citations.ts"
import { failureFrom } from "#shared/devtool.ts"
import { gitFilesUnder } from "#shared/git.ts"
import { relativeTo, Repository } from "#shared/repository.ts"
import { isTestFile } from "#shared/tests.ts"

/** A TypeScript file of the repository: its path from the repository's root, and its text. */
export interface Source {
	readonly path: string
	readonly text: string
}

/** What the check reads: every TypeScript file git shows, and every file under plants/, by path from the root. */
export interface Tree {
	readonly sources: ReadonlyArray<Source>
	readonly plants: ReadonlyArray<string>
}

/** Where a citation is: the file that makes it, the line its tag starts on, and the plant it names. */
type At = Readonly<{ file: string; line: number; plant: string }>

/**
 * What the check refuses, each a way a citation and its plant can fail to meet:
 * - `malformed`: a plant tag whose first word is no plant path, or that names no bug;
 * - `outsideTest`: a citation in a file that is no test, so no test runs while its plant is planted;
 * - `dangling`: a citation of a plant that is no file;
 * - `uncited`: a file under plants/ that no citation names, so nothing runs it;
 * - `sameName`: two plants under one name, which a plant's name alone no longer tells apart.
 */
export type Finding =
	| Readonly<{ kind: "malformed"; file: string; line: number; text: string }>
	| (Readonly<{ kind: "outsideTest" }> & At)
	| (Readonly<{ kind: "dangling" }> & At)
	| Readonly<{ kind: "uncited"; plant: string }>
	| Readonly<{ kind: "sameName"; name: string; plants: Arr.NonEmptyReadonlyArray<string> }>

/** A citation and the file that makes it. */
interface Cited {
	readonly file: string
	readonly citation: Citation
}

/** Every citation the tree's sources make, in source order. */
const citedIn = (tree: Tree): ReadonlyArray<Cited> =>
	Arr.flatMap(tree.sources, (source) =>
		Arr.map(readingOf(source.text).citations, (citation) => ({ file: source.path, citation }))
	)

/** A plant's name: the last segment of its path. */
const nameOf = (plant: string): string => Arr.lastNonEmpty(Str.split("/")(plant))

/** The entries of a grouping, in the order of their keys. */
const byKey = <A>(groups: Readonly<Record<string, Arr.NonEmptyArray<A>>>) =>
	Arr.sort(
		Rec.toEntries(groups),
		Order.mapInput(Order.String, (entry: readonly [string, Arr.NonEmptyArray<A>]) => entry[0])
	)

/**
 * Every finding of the tree, in a fixed order: each source's malformed tags, citations outside tests and dangling
 * citations, in source order; then each plant no citation names, in path order; then each name two plants share.
 */
export const findingsOf = (tree: Tree): ReadonlyArray<Finding> => {
	const plants = new Set(tree.plants)
	const named = new Set(Arr.map(citedIn(tree), ({ citation }) => citation.plant))
	const ofSources = Arr.flatMap(tree.sources, (source): ReadonlyArray<Finding> => {
		const reading = readingOf(source.text)
		const malformed = Arr.map(reading.malformed, (tag): Finding => ({
			kind: "malformed",
			file: source.path,
			line: tag.line,
			text: tag.text
		}))
		const placed = Arr.flatMap(reading.citations, (citation): ReadonlyArray<Finding> => {
			const at: At = { file: source.path, line: citation.line, plant: citation.plant }
			const outside: ReadonlyArray<Finding> = isTestFile(source.path)
				? []
				: [{ kind: "outsideTest", ...at }]
			const dangling: ReadonlyArray<Finding> = plants.has(citation.plant)
				? []
				: [{ kind: "dangling", ...at }]
			return Arr.appendAll(outside, dangling)
		})
		return Arr.appendAll(malformed, placed)
	})
	const uncited = Arr.map(
		Arr.sort(
			Arr.filter(tree.plants, (plant) => !named.has(plant)),
			Order.String
		),
		(plant): Finding => ({ kind: "uncited", plant })
	)
	const shared = Arr.flatMap(
		byKey(Arr.groupBy(tree.plants, nameOf)),
		([name, group]): ReadonlyArray<Finding> =>
			group.length > 1 ? [{ kind: "sameName", name, plants: Arr.sort(group, Order.String) }] : []
	)
	return [...ofSources, ...uncited, ...shared]
}

/** A finding in words, led by where it is. */
export const findingText = (finding: Finding): string => {
	switch (finding.kind) {
		case "malformed":
			return `${finding.file}:${String(finding.line)}: a plant tag names a plant by its path under ${plantRoot}, ending .patch, then the bug it plants: ${finding.text}`
		case "outsideTest":
			return `${finding.file}:${String(finding.line)}: ${finding.plant} is cited outside a test, so no test runs while it is planted: cite it in the header of the test it turns red`
		case "dangling":
			return `${finding.file}:${String(finding.line)}: ${finding.plant} is no file: a test cites only a plant the repository holds`
		case "uncited":
			return `${finding.plant}: no test cites it, so nothing runs it: cite it with a plant tag in the test it turns red, or remove it`
		case "sameName":
			return `${finding.name} names ${String(finding.plants.length)} plants, ${Arr.join(finding.plants, ", ")}: give each its own name`
	}
}

/** A plant and the tests that cite it, each of which must turn red while it is planted. */
export interface Trial {
	readonly plant: string
	readonly tests: Arr.NonEmptyReadonlyArray<string>
}

/** What a run tries: every cited plant, or the plants of the tests and the plants it names. */
export type Targets =
	| Readonly<{ kind: "all" }>
	| Readonly<{ kind: "named"; names: Arr.NonEmptyReadonlyArray<string> }>

/** Whether a citation is one a name picks: the name is the test that makes it, or the plant it names. */
const picks =
	(name: string) =>
	({ file, citation }: Cited): boolean =>
		file === name || citation.plant === name

/** The citations named targets pick, or the names that pick none. */
const pickedBy = (
	pairs: ReadonlyArray<Cited>,
	names: Arr.NonEmptyReadonlyArray<string>
): Result.Result<ReadonlyArray<Cited>, Arr.NonEmptyReadonlyArray<string>> => {
	const unknown = Arr.filter(names, (name) => !Arr.some(pairs, picks(name)))
	return Arr.isReadonlyArrayNonEmpty(unknown)
		? Result.fail(unknown)
		: Result.succeed(Arr.filter(pairs, (pair) => Arr.some(names, (name) => picks(name)(pair))))
}

/**
 * The trials a run makes, one per plant in path order, each with its tests in path order: for `all`, every plant a test
 * cites, with every test that cites it; for a named test, each plant it cites, with that test; for a named plant, every
 * test that cites it. A name that is neither a test citing a plant nor a plant a test cites fails the plan, so a run
 * never passes for want of anything to try.
 */
export const planOf = (
	tree: Tree,
	targets: Targets
): Result.Result<ReadonlyArray<Trial>, Arr.NonEmptyReadonlyArray<string>> => {
	const pairs = Arr.filter(citedIn(tree), ({ file }) => isTestFile(file))
	const chosen = targets.kind === "all" ? Result.succeed(pairs) : pickedBy(pairs, targets.names)
	return Result.map(chosen, (picked) =>
		Arr.map(
			byKey(Arr.groupBy(picked, ({ citation }) => citation.plant)),
			([plant, group]): Trial => ({
				plant,
				tests: Arr.sort(Arr.dedupe(Arr.map(group, ({ file }) => file)), Order.String)
			})
		)
	)
}

/** A file a citation may sit in: any TypeScript file, so a tag outside a test is read, and refused. */
const isSource = (file: string): boolean => Str.endsWith(".ts")(file) || Str.endsWith(".tsx")(file)

/**
 * The tree as the repository holds it: every TypeScript file git shows, tracked or untracked but not ignored, with its
 * text, and every file under plants/, each by its path from the repository's root.
 */
export const readTree = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const { root } = yield* Repository
	const listed = yield* gitFilesUnder(root)
	const files = Arr.map(listed, relativeTo(root))
	const sources = yield* Effect.forEach(Arr.filter(files, isSource), (file) =>
		Effect.mapBoth(fs.readFileString(`${root}/${file}`), {
			onFailure: failureFrom(`${file} could not be read`),
			onSuccess: (text): Source => ({ path: file, text })
		})
	)
	const tree: Tree = { sources, plants: Arr.filter(files, Str.startsWith(plantRoot)) }
	return tree
})
