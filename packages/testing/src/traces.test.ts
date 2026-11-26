/**
 * A read reads of its path what the specification says, as a cache records and verifies it (traces.ts standingOf): a
 * file's bytes' SHA-256, a directory's entry names sorted and NUL-joined (a name may hold a newline), a path's kind, a
 * resolution's place from the repository's root (the root itself its empty path, a path outside it the machine's), a
 * link's text, and `absent` or the failure's errno where nothing answers; and every path's place returns to the path
 * (placeOf, absoluteOf). Each case writes a small repository in its scratch directory and makes one read of it.
 * Oracle: the specification, stated per read, its digests node:crypto's (traces.fixtures.ts expectedOf). And a file
 * changed after a mark of the file system's clock reads as changed since it, an edit reverted with an older
 * modification time (cp -p) among them.
 */
import { Effect, FileSystem, Option } from "effect"
import { Digest } from "effect/crypto"
import { assert } from "#assert.ts"
import { element, finite } from "#gen.ts"
import { property } from "#property.ts"
import { Scratch } from "#resources/scratch.ts"
import { digests } from "#runner/cache.fixtures.ts"
import { expectedOf, readOf, reads } from "#traces.fixtures.ts"
import { standingOf } from "#traces.ts"

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

/**
 * How a file is changed after a mark of the file system's clock: edited in place; or edited, then its first bytes put
 * back with the modification time of a backup a minute older than the mark, as cp -p or rsync -a restores one (utimes).
 */
const AFTER_A_MARK = [
	"edited in place",
	"edited, then restored with an older modification time"
] as const

export const aChangeAfterAMarkReadsAsChanged = property.exhaust(
	finite((source) => source.draw(element(AFTER_A_MARK))),
	{
		box: "a file read after a mark of the file system's clock, edited in place since it, or edited and restored with its first bytes and an older modification time",
		needs: { directory: Scratch.dir, digest: digests },
		situations: [],
		check:
			({ directory, digest }) =>
			(change) =>
				Effect.gen(function* () {
					const scratch = yield* directory
					const sha256 = yield* digest
					const fs = yield* FileSystem.FileSystem
					const file = `${scratch}/read.txt`
					yield* fs.writeFileString(file, "first\n")
					yield* fs.writeFileString(`${scratch}/mark`, "")
					const marked = yield* fs.stat(`${scratch}/mark`)
					const began = Option.getOrElse(
						Option.map(marked.mtime, (at) => at.getTime()),
						() => 0
					)
					yield* fs.writeFileString(file, "second\n")
					if (change === "edited, then restored with an older modification time") {
						yield* fs.writeFileString(file, "first\n")
						const backupSeconds = (began - 60_000) / 1000
						yield* fs.utimes(file, backupSeconds, backupSeconds)
					}
					const standing = yield* Effect.provideService(
						standingOf(scratch, "file", file),
						Digest.Digest,
						sha256
					)
					assert.ok(standing.changed >= began)
				}),
		oracle: {
			kind: "specification",
			name: "a file changed after a mark reads as changed since it, whatever modification time it was given back"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/traces.ts",
				original: "\t\tOption.map((info) => Math.max(info.mtimeMs, info.ctimeMs))\n",
				replacement: "\t\tOption.map((info) => info.mtimeMs)\n",
				why: "A read's change is its modification time alone, which cp -p, rsync -a or a backup moved back set to an older one, so an edit reverted so after a run began reads as unchanged since, and a pass keeps a trace of what the run may not have read; the restored file fails."
			}
		]
	}
)
