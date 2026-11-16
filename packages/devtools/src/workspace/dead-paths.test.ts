import { drawn, explore } from "@bjornpagen/testing/explore"
import { required } from "@bjornpagen/testing/features"
import { array, boolean, element, type Gen, weighted } from "@bjornpagen/testing/gen"
import { notesOnly } from "@bjornpagen/testing/sense"
import { completeShrink } from "@bjornpagen/testing/shrink"
import { searched } from "@bjornpagen/testing/vitest"
/**
 * The dead-paths gate (src/workspace/dead-paths.ts), searched over repositories drawn from a grammar of its contract:
 * a tree of files, and the globs of its oxlint overrides and the paths of its exceptions, each built from a file of the
 * tree (live: the file itself, a directory above it with `**`, its name under `**`, a star for one segment's part, a
 * `?` for one character, a choice of `{a,b}`) or from a path no file holds (dead: a file beside the tree's, a
 * directory beneath none, a name no file ends in), beside a glob the gate cannot read (a character class, a negation)
 * and the preset's own globs (test modules, test scope), which it leaves alone. Every glob and path carries the
 * findings the contract gives it, one for a dead or unreadable one and none else, and the gate's findings over the
 * repository must be exactly that many.
 *
 * Oracle: the specification, the gate's JSDoc: every path a repository states about its files names one. Features: a
 * live glob, a dead glob, an unreadable glob, a standard glob, a live exception, a dead exception.
 */
import { describe, it } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { Array as Arr, Duration, Effect, Formatter, Option, Result, String as Str } from "effect"
import { STANDARD_GLOBS } from "#preset.ts"
import { deadPathFindings, globMatches } from "#workspace/dead-paths.ts"

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

/** A glob built from a live file: one that matches it, by every form the gate reads. */
const liveGlobOf =
	(file: string): Gen<string> =>
	(source) => {
		const parts = Str.split("/")(file)
		const name = Arr.lastNonEmpty(parts)
		const directories = Arr.dropRight(parts, 1)
		const extension = Arr.lastNonEmpty(Str.split(".")(name))
		return source.draw(
			element([
				file,
				`**/${name}`,
				Arr.isReadonlyArrayNonEmpty(directories)
					? `${Arr.headNonEmpty(directories)}/**`
					: `**/*.${extension}`,
				Arr.join([...directories, `*.${extension}`], "/"),
				Arr.join([...directories, `?${Str.slice(1)(name)}`], "/"),
				Arr.join([...directories, `{nothing,${name}}`], "/")
			])
		)
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
				glob: source.draw(liveGlobOf(source.draw(element(files)))),
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

type Repository = Readonly<{ files: ReadonlyArray<string>; stated: ReadonlyArray<Stated> }>

const repositories: Gen<Repository> = (source) => {
	const files = Arr.dedupe(source.draw(array(fileGen, { min: 1, max: 6 })))
	const nonEmpty = Option.getOrThrow(Option.liftPredicate(files, Arr.isArrayNonEmpty))
	const stated = source.draw(array(statedOf(nonEmpty), { min: 1, max: 5 }))
	return { files, stated: Arr.dedupeWith(stated, (a, b) => statedKey(a) === statedKey(b)) }
}

/** The dead-paths findings the gate gives a repository. */
const findingsOf = (repository: Repository): number =>
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

describe("dead-paths", () => {
	it.effect("finds exactly the globs and exception paths that name no file", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "workspace/dead-paths",
					oracle: {
						kind: "specification",
						name: "the gate's stated contract: every path a repository states about its files names one"
					},
					draw: drawn(repositories),
					literal: Formatter.format,
					coverage: required<Feature>(
						[
							"a live glob",
							"a dead glob",
							"an unreadable glob",
							"a standard glob",
							"a live exception",
							"a dead exception"
						],
						{ cases: 300, sense: notesOnly }
					),
					kept: [],
					runs: 300,
					shrink: completeShrink,
					steerEvery: 16,
					caseHang: Duration.minutes(1)
				},
				(repository, c) =>
					Effect.sync(() => {
						for (const one of repository.stated) {
							c.note(one.feature)
						}
						deepStrictEqual(
							findingsOf(repository),
							Arr.reduce(repository.stated, 0, (sum, one) => sum + one.findings)
						)
					})
			)
		)
	)
	it.effect("matches every file a live glob is built from", (ctx) =>
		searched(
			ctx,
			explore(
				{
					suite: "workspace/dead-paths/glob",
					oracle: {
						kind: "specification",
						name: "the gate's glob forms: a glob built from a file matches it"
					},
					draw: drawn((source) => {
						const file = source.draw(fileGen)
						return { file, glob: source.draw(liveGlobOf(file)) }
					}),
					literal: Formatter.format,
					coverage: required<"a glob matched">(["a glob matched"], {
						cases: 100,
						sense: notesOnly
					}),
					kept: [],
					runs: 100,
					shrink: completeShrink,
					steerEvery: 16,
					caseHang: Duration.minutes(1)
				},
				({ file, glob }, c) =>
					Effect.sync(() => {
						c.note("a glob matched")
						deepStrictEqual(globMatches(glob, file), true)
					})
			)
		)
	)
})
