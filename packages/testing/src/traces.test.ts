/**
 * A read reads of its path what the specification says, as a cache records and verifies it (traces.ts standingOf): a
 * file's bytes' SHA-256, a directory's entry names sorted and NUL-joined (a name may hold a newline), a path's kind, a
 * resolution's place from the repository's root (the root itself its empty path, a path outside it the machine's), a
 * link's text, and `absent` or the failure's errno where nothing answers; and every path's place returns to the path
 * (placeOf, absoluteOf). Each case writes a small repository in its scratch directory and makes one read of it.
 * Oracle: the specification, stated per read, its digests node:crypto's (traces.fixtures.ts expectedOf).
 */
import { Effect } from "effect"
import { assert } from "#assert.ts"
import { property } from "#property.ts"
import { Scratch } from "#resources/scratch.ts"
import { digests } from "#runner/cache.fixtures.ts"
import { expectedOf, readOf, reads } from "#traces.fixtures.ts"

export const eachReadReadsWhatItsKindSays = property.exhaust(reads, {
	box: "one read of each kind of a small repository: a file, a directory of names one holding a newline, a path's presence, a link's resolution and its text, the repository's root and a file outside it, and absent paths",
	needs: { directory: Scratch.dir, digest: digests },
	situations: [],
	check:
		({ directory, digest }) =>
		(read) =>
			Effect.gen(function* () {
				const scratch = yield* directory
				const sha256 = yield* digest
				const { repository, stood } = yield* readOf(scratch, sha256, read)
				assert.deepEqual(stood, expectedOf(repository, read))
			}),
	oracle: {
		kind: "specification",
		name: "a file's SHA-256, a directory's names sorted and NUL-joined, a kind, a resolution's place, a link's text, absent or the errno; a place returns to its path"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/traces.ts",
			original: '(Arr.join(Arr.sort(names, Order.String), "\\u0000"))',
			replacement: '(Arr.join(Arr.sort(names, Order.String), "\\n"))',
			why: "A directory's names are joined by a newline, which a name may hold, so two listings read alike where they differ; the directory read of a name holding a newline fails."
		},
		{
			file: "packages/testing/src/traces.ts",
			original:
				'\tpath === repository\n\t\t? { kind: "repository", path: "" }\n\t\t: Str.startsWith',
			replacement: "\tStr.startsWith",
			why: "The repository's root is placed as the machine's, by its checkout's own path, so another checkout of the repository never reads alike; the root's resolution fails."
		},
		{
			file: "packages/testing/src/traces.ts",
			original: `\`to \${answer.success}\``,
			replacement: '"a link"',
			why: "A link's read keeps that a link is there, not its text, so a link pointed elsewhere reads alike; the link's read fails."
		},
		{
			file: "packages/testing/src/traces.ts",
			original: `\t\t\t\t\t? \`\${place.success.kind} \${place.success.path}\`\n`,
			replacement: '\t\t\t\t\t? "resolved"\n',
			why: "A resolution keeps that a path resolved, not where to, so a link pointed elsewhere reads alike; the link's resolution fails."
		},
		{
			file: "packages/testing/src/traces.ts",
			original: "\t\t? cause.code\n",
			replacement: "\t\t? reason._tag\n",
			why: "A failure is kept by its platform's kind, which folds errnos together (an absent path and a path through a file), so the reads that fail read alike where they differ; the dangling resolution fails."
		}
	]
})
