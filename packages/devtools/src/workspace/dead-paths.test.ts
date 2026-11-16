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
 * live glob, a dead glob, an unreadable glob, a standard glob, a live exception, a dead exception; and, for the glob
 * forms alone, each way a live glob is built from its file.
 */
import { deepStrictEqual } from "@bjornpagen/testing/assert"
import { property } from "@bjornpagen/testing/property"
import { Array as Arr, Effect } from "effect"
import { expectedOf, findingsOf, matched, repositories } from "#workspace/dead-paths.fixtures.ts"
import { globMatches } from "#workspace/dead-paths.ts"

/** Finds exactly the globs and exception paths that name no file. */
export const deadPathsFound = property.explore(repositories, {
	needs: {},
	situations: [
		"a live glob",
		"a dead glob",
		"an unreadable glob",
		"a standard glob",
		"a live exception",
		"a dead exception"
	],
	check: (_resources, c) => (repository) =>
		Effect.sync(() => {
			c.noteAll(Arr.map(repository.stated, (one) => one.feature))
			deepStrictEqual(findingsOf(repository), expectedOf(repository))
		}),
	oracle: {
		kind: "specification",
		name: "the gate's stated contract: every path a repository states about its files names one"
	},
	kept: [],
	kills: []
})

/** Matches every file a live glob is built from, by each form the gate reads. */
export const liveGlobMatchesItsFile = property.explore(matched, {
	needs: {},
	situations: [
		"the file itself",
		"its name under **",
		"a directory above it",
		"its extension anywhere",
		"a star for its name",
		"a ? for one character",
		"a choice of names"
	],
	check: (_resources, c) => (one) =>
		Effect.sync(() => {
			c.note(one.built.form)
			deepStrictEqual(globMatches(one.built.glob, one.file), true)
		}),
	oracle: {
		kind: "specification",
		name: "the gate's glob forms: a glob built from a file matches it"
	},
	kept: [],
	kills: []
})
