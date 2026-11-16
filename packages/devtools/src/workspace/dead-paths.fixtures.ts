import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	oneOf,
	weighted
} from "@bjornpagen/testing/gen"
import { Array as Arr, Option, Result, String as Str } from "effect"
import { STANDARD_GLOBS } from "#preset.ts"
import { deadPathFindings } from "#workspace/dead-paths.ts"

/**
 * The repositories the dead-paths properties draw (dead-paths.test.ts), from a grammar of the gate's contract: a tree
 * of files, and the globs of its oxlint overrides and the paths of its exceptions, each built from a file of the tree
 * (live) or from a path no file holds (dead), beside globs the gate cannot read and the preset's own globs; and what
 * the gate finds in one.
 */

/** What a statement of a repository is, as the dead-paths property names its situations. */
type Feature =
	| "a live glob"
	| "a dead glob"
	| "an unreadable glob"
	| "a standard glob"
	| "a live exception"
	| "a dead exception"

/** The files of a tree: a few directories deep, names of a few letters, each with an extension. */
const segments = element(["src", "test", "lib", "a", "bb"] as const)

const names = element(["index", "main", "x", "reads", "a-b"] as const)

const extensions = element(["ts", "test.ts", "json"] as const)

const fileGen: Gen<string> = (source) =>
	Arr.join(
		[
			...source.draw(array(segments, { min: 0, max: 2 })),
			`${source.draw(names)}.${source.draw(extensions)}`
		],
		"/"
	)

/** How a live glob is built from its file, as the glob property names its situations. */
export type Form =
	| "the file itself"
	| "its name under **"
	| "a directory above it"
	| "its extension anywhere"
	| "a star for its name"
	| "a ? for one character"
	| "a choice of names"

/** A glob built from a live file, and how. */
export type Built = Readonly<{ glob: string; form: Form }>

/** A glob built from a live file: one that matches it, by every form the gate reads. */
const liveGlobOf =
	(file: string): Gen<Built> =>
	(source) => {
		const parts = Str.split("/")(file)
		const name = Arr.lastNonEmpty(parts)
		const directories = Arr.dropRight(parts, 1)
		const extension = Arr.lastNonEmpty(Str.split(".")(name))
		const beside = (last: string): string => Arr.join([...directories, last], "/")
		return source.draw(
			oneOf<Built>([
				constant({ glob: file, form: "the file itself" }),
				constant({ glob: `**/${name}`, form: "its name under **" }),
				constant(
					Arr.isReadonlyArrayNonEmpty(directories)
						? { glob: `${Arr.headNonEmpty(directories)}/**`, form: "a directory above it" }
						: { glob: `**/*.${extension}`, form: "its extension anywhere" }
				),
				constant({ glob: beside(`*.${extension}`), form: "a star for its name" }),
				constant({ glob: beside(`?${Str.slice(1)(name)}`), form: "a ? for one character" }),
				constant({ glob: beside(`{nothing,${name}}`), form: "a choice of names" })
			])
		)
	}

/** A file of a tree and a glob built from it. */
export type Matched = Readonly<{ file: string; built: Built }>

/** A file, and a glob built from it. */
export const matched: Gen<Matched> = (source) => {
	const file = source.draw(fileGen)
	return { file, built: source.draw(liveGlobOf(file)) }
}

/** A path no file of the tree holds: beneath a directory no file is under. */
const DEAD_ROOT = "gone"

const deadGlobGen: Gen<string> = (source) =>
	source.draw(
		element([
			`${DEAD_ROOT}/**`,
			`${DEAD_ROOT}/${source.draw(names)}.ts`,
			`**/${DEAD_ROOT}.ts`,
			`**/*.${DEAD_ROOT}`,
			`{${DEAD_ROOT},${DEAD_ROOT}2}/**`
		])
	)

/** One statement of a repository about its files, the findings the contract gives it, and what it is. */
type Stated =
	| Readonly<{ kind: "glob"; glob: string; findings: number; feature: Feature }>
	| Readonly<{ kind: "exception"; path: string; findings: number; feature: Feature }>

const statedOf = (files: Arr.NonEmptyReadonlyArray<string>): Gen<Stated> =>
	weighted([
		[
			3,
			(source): Stated => ({
				kind: "glob",
				glob: source.draw(liveGlobOf(source.draw(element(files)))).glob,
				findings: 0,
				feature: "a live glob"
			})
		],
		[
			2,
			(source): Stated => ({
				kind: "glob",
				glob: source.draw(deadGlobGen),
				findings: 1,
				feature: "a dead glob"
			})
		],
		[
			1,
			(source): Stated => ({
				kind: "glob",
				glob: source.draw(
					element(["src/[ab].ts", "!src/**", `${source.draw(element(files))}[0]`] as const)
				),
				findings: 1,
				feature: "an unreadable glob"
			})
		],
		[
			1,
			(source): Stated => ({
				kind: "glob",
				glob: source.draw(
					element(
						Option.getOrThrow(Option.liftPredicate(STANDARD_GLOBS, Arr.isReadonlyArrayNonEmpty))
					)
				),
				findings: 0,
				feature: "a standard glob"
			})
		],
		[
			2,
			(source): Stated => {
				const file = source.draw(element(files))
				const directories = Arr.dropRight(Str.split("/")(file), 1)
				return {
					kind: "exception",
					path:
						source.draw(boolean) && Arr.isReadonlyArrayNonEmpty(directories)
							? `${Arr.join(directories, "/")}/`
							: file,
					findings: 0,
					feature: "a live exception"
				}
			}
		],
		[
			2,
			(source): Stated => ({
				kind: "exception",
				path: source.draw(
					element([`${DEAD_ROOT}/`, `${DEAD_ROOT}/x.ts`, `src/${DEAD_ROOT}.ts`] as const)
				),
				findings: 1,
				feature: "a dead exception"
			})
		]
	])

/** What a statement states: a glob, or an exception's path, which the gate holds apart. */
const statedKey = (one: Stated): string =>
	one.kind === "glob" ? `glob ${one.glob}` : `path ${one.path}`

/** A repository: the files of its tree and what it states about them. */
export type Repository = Readonly<{ files: ReadonlyArray<string>; stated: ReadonlyArray<Stated> }>

export const repositories: Gen<Repository> = (source) => {
	const files = Arr.dedupe(source.draw(array(fileGen, { min: 1, max: 6 })))
	const nonEmpty = Option.getOrThrow(Option.liftPredicate(files, Arr.isArrayNonEmpty))
	const stated = source.draw(array(statedOf(nonEmpty), { min: 1, max: 5 }))
	return { files, stated: Arr.dedupeWith(stated, (a, b) => statedKey(a) === statedKey(b)) }
}

/** The dead-paths findings the gate gives a repository. */
export const findingsOf = (repository: Repository): number =>
	deadPathFindings({
		root: "/repository",
		files: repository.files,
		lint: {
			path: "oxlint.config.ts",
			text: "",
			globs: Arr.filterMap(repository.stated, (one) =>
				one.kind === "glob" ? Result.succeed(one.glob) : Result.failVoid
			)
		},
		toolchain: {
			path: "toolchain.config.ts",
			text: "",
			exceptions: [
				{
					rule: "ts-only-extensions",
					files: Arr.filterMap(repository.stated, (one) =>
						one.kind === "exception" ? Result.succeed(one.path) : Result.failVoid
					)
				}
			]
		},
		standard: STANDARD_GLOBS
	}).length

/** The findings the contract gives a repository: each statement's own. */
export const expectedOf = (repository: Repository): number =>
	Arr.reduce(repository.stated, 0, (sum, one) => sum + one.findings)
