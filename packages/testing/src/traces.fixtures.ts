import { Array as Arr, type Context, Effect } from "effect"
import { Digest } from "effect/crypto"
import { element, finite } from "#gen.ts"
import { absoluteOf, type KeyedRead, placeOf, standingOf } from "#traces.ts"

/**
 * What the reads property (traces.test.ts) reads: a repository written in a case's scratch directory, a read of one of
 * its paths (or of the repository's root, or of a file outside it), and what standingOf makes of it.
 *
 * The repository holds `data.txt` ("data\n"), a directory `dir` of the files `a`, `b` and `c<newline>d` (a name may hold
 * a newline, so only a NUL joins names unambiguously), a symbolic link `link` to `data.txt`, and one, `dangling`, to a
 * path that is not there; beside it lies `outside.txt`, the machine's.
 */

/** A path of a case: one of the repository's, its root, an absent one, or the file outside it. */
const TARGETS = ["data.txt", "dir", "link", "dangling", "missing", "root", "outside"] as const

type Target = (typeof TARGETS)[number]

/** One case: a read's kind and the path it reads. */
export type Read = Readonly<{ kind: KeyedRead["kind"]; target: Target }>

/** Every case: each read of the specification's (expectedOf) that a cache makes. */
const READS: ReadonlyArray<Read> & Readonly<{ 0: Read }> = [
	{ kind: "file", target: "data.txt" },
	{ kind: "file", target: "dir" },
	{ kind: "file", target: "missing" },
	{ kind: "directory", target: "dir" },
	{ kind: "directory", target: "data.txt" },
	{ kind: "presence", target: "data.txt" },
	{ kind: "presence", target: "dir" },
	{ kind: "presence", target: "missing" },
	{ kind: "resolution", target: "link" },
	{ kind: "resolution", target: "root" },
	{ kind: "resolution", target: "outside" },
	{ kind: "resolution", target: "dangling" },
	{ kind: "link", target: "link" },
	{ kind: "link", target: "data.txt" },
	{ kind: "link", target: "missing" }
]

export const reads = finite((source): Read => source.draw(element(READS)))

/** The repository and the file outside it, written afresh in `directory`: the repository's root, resolved. */
const repositoryIn = (directory: string): string => {
	const fs = process.getBuiltinModule("node:fs")
	fs.rmSync(`${directory}/repo`, { recursive: true, force: true })
	fs.mkdirSync(`${directory}/repo/dir`, { recursive: true })
	fs.writeFileSync(`${directory}/repo/data.txt`, "data\n")
	for (const name of ["a", "b", "c\nd"]) {
		fs.writeFileSync(`${directory}/repo/dir/${name}`, "")
	}
	fs.symlinkSync("data.txt", `${directory}/repo/link`)
	fs.symlinkSync("missing", `${directory}/repo/dangling`)
	fs.writeFileSync(`${directory}/outside.txt`, "outside\n")
	return fs.realpathSync(`${directory}/repo`)
}

/** The absolute path a case's target names in the repository at `repository`. */
const pathOf = (repository: string, target: Target): string =>
	target === "root"
		? repository
		: target === "outside"
			? `${process.getBuiltinModule("node:path").dirname(repository)}/outside.txt`
			: `${repository}/${target}`

/** What a case read: its digest as standingOf states it, and whether its path's place returns to the path. */
type Stood = Readonly<{ digest: string; placed: boolean }>

/**
 * What standingOf makes of `read` in a repository written in `directory`, its SHA-256 `digest`'s, and its path's
 * place's round trip; with the repository's resolved root, which the expectation reads.
 */
export const readOf = (
	directory: string,
	digest: Context.Service.Shape<typeof Digest.Digest>,
	read: Read
) =>
	Effect.gen(function* () {
		const repository = repositoryIn(directory)
		const path = pathOf(repository, read.target)
		const standing = yield* Effect.provideService(
			standingOf(repository, read.kind, path),
			Digest.Digest,
			digest
		)
		const stood: Stood = {
			digest: standing.digest,
			placed: absoluteOf(repository, placeOf(repository, path)) === path
		}
		return { repository, stood }
	})

/** The SHA-256 of a text, in hex, by node:crypto: a second implementation of the digest. */
const sha256 = (text: string): string =>
	process.getBuiltinModule("node:crypto").createHash("sha256").update(text).digest("hex")

/**
 * What a read must read, by the specification, in the repository at `repository`: a file's bytes' SHA-256, a
 * directory's names sorted and NUL-joined, a path's kind, a resolution's place from the repository's root (its root the
 * empty path, the file outside it the machine's), a link's text, `absent` or the failure's errno; and every path's place
 * returns to the path.
 */
export const expectedOf = (repository: string, read: Read): Stood => {
	const digest = (): string => {
		switch (read.kind) {
			case "file":
				return read.target === "data.txt"
					? sha256("data\n")
					: read.target === "dir"
						? "directory"
						: "absent"
			case "directory":
				return read.target === "dir"
					? sha256(Arr.join(["a", "b", "c\nd"], "\u0000"))
					: "no directory"
			case "presence":
				return read.target === "data.txt" ? "file" : read.target === "dir" ? "directory" : "absent"
			case "resolution":
				return read.target === "link"
					? "repository data.txt"
					: read.target === "root"
						? "repository "
						: read.target === "outside"
							? `machine ${pathOf(repository, "outside")}`
							: "ENOENT"
			case "link":
				return read.target === "link"
					? "to data.txt"
					: read.target === "data.txt"
						? "EINVAL"
						: "ENOENT"
		}
	}
	return { digest: digest(), placed: true }
}

/**
 * How a file is changed after a mark of the file system's clock: edited in place; or edited, then its first bytes put
 * back with the modification time of a backup a minute older than the mark, as cp -p or rsync -a restores one (utimes).
 */
export const AFTER_A_MARK = [
	"edited in place",
	"edited, then restored with an older modification time"
] as const
