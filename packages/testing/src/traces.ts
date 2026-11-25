import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	Order,
	type PlatformError,
	Result,
	Schema,
	String as Str
} from "effect"
import { Digest } from "effect/crypto"

/**
 * The reads a verifying trace keys a run by: a cache that answers a run while every read the run made stands (the
 * verdict cache's traces, grizzle's generate) records each read with what it read, and answers again exactly while
 * each reads alike. A read is what it reads of a path (READ_KINDS) and where the path lies (Place); what it reads as it
 * stands is standingOf's, the one implementation every such cache records and verifies by.
 */

/**
 * What a read reads of its path: a file's bytes (`file`); a directory's entries (`directory`); the path's presence and
 * kind (`presence`: opened and refused, stat, access); where the path resolves to, every symbolic link followed
 * (`resolution`: realpath); or a symbolic link's text (`link`: readlink). A read names its path as the program named it,
 * never resolved: following a link is a read of its own, so a link pointed elsewhere changes what it reads.
 */
export const READ_KINDS = ["file", "directory", "presence", "resolution", "link"] as const

/** One read: what it reads (READ_KINDS) of its absolute path. */
export type KeyedRead = Readonly<{ kind: (typeof READ_KINDS)[number]; path: string }>

/**
 * Where a read's path lies: under the repository, by its path from the repository's root (the root itself the empty
 * path), so every checkout of the repository reads its own copy and shares what another recorded; or the machine's,
 * absolute (a program, a library, an installation).
 */
export type Place =
	| Readonly<{ kind: "repository"; path: string }>
	| Readonly<{ kind: "machine"; path: string }>

/** A read as a trace keeps it: what it read, where, and the digest of what it read (standingOf). */
export const TracedRead = Schema.Struct({
	kind: Schema.Literals(READ_KINDS),
	place: Schema.Literals(["repository", "machine"]),
	path: Schema.String,
	digest: Schema.String
})

/** Where the absolute path `path` lies (Place), the repository's root `repository`. */
export const placeOf = (repository: string, path: string): Place =>
	path === repository
		? { kind: "repository", path: "" }
		: Str.startsWith(`${repository}/`)(path)
			? { kind: "repository", path: Str.slice(repository.length + 1)(path) }
			: { kind: "machine", path }

/** A place's absolute path in the repository at `repository` (placeOf's inverse). */
export const absoluteOf = (repository: string, place: Place): string =>
	place.kind === "machine"
		? place.path
		: place.path === ""
			? repository
			: `${repository}/${place.path}`

/** What a read reads of a path as it stands (standingOf): its digest, and when it last changed, in milliseconds. */
export type Standing = Readonly<{ digest: string; changed: number }>

/** A failed call's code: its errno's (ENOENT, EINVAL, ELOOP …) where the platform states one, else its kind. */
const failureOf = (error: PlatformError.PlatformError): string => {
	const reason = error.reason
	const cause: unknown = reason._tag === "BadArgument" ? undefined : reason.cause
	return typeof cause === "object" &&
		cause !== null &&
		"code" in cause &&
		typeof cause.code === "string"
		? cause.code
		: reason._tag
}

/** A file's modification time, in milliseconds since the epoch: 0 where its system states none. */
const modifiedOf = (info: FileSystem.File.Info): number =>
	Option.getOrElse(
		Option.map(info.mtime, (at) => at.getTime()),
		() => 0
	)

/**
 * When `path` itself last changed, no symbolic link followed: its own modification time, or its nearest existing
 * directory's where nothing is there.
 */
const changedAt = (path: string): Effect.Effect<number, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const info = yield* Effect.option(fs.lstat(path))
		if (Option.isSome(info)) {
			return modifiedOf(info.value)
		}
		const parent = process.getBuiltinModule("node:path").dirname(path)
		return parent === path ? 0 : yield* changedAt(parent)
	})

/** The SHA-256 of `bytes`, in hex. */
const sha256Of = (bytes: Uint8Array) =>
	Effect.flatMap(Digest.Digest, (digest) => digest.digestHex(Digest.sha256, bytes))

/**
 * What a read reads of a path as it stands (Standing), in the repository at `repository`, every digest SHA-256 in hex:
 * a file's bytes'; a directory's entries' (their names sorted by code unit and NUL-joined, since no name holds a NUL);
 * the path's presence and kind (`file`, `directory`, `other`); where it resolves to, every symbolic link followed, by its
 * place (`<repository | machine> <path>`, so every checkout of the repository resolves its own root alike); a symbolic
 * link's text (`to <text>`); each `absent` where nothing is there, a file's read of another kind of path that kind
 * (`directory`, `other`), a directory's of something else `no directory`, and a resolution or a link that fails the
 * failure's code (failureOf); and when it last changed (changedAt), which a cache weighs against when its run began: a
 * read that changed since may not be what the run read.
 */
export const standingOf = (
	repository: string,
	kind: KeyedRead["kind"],
	path: string
): Effect.Effect<Standing, never, FileSystem.FileSystem | Digest.Digest> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		switch (kind) {
			case "resolution": {
				const answer = yield* Effect.result(fs.realPath(path))
				const place = Result.map(answer, (to) => placeOf(repository, to))
				const digest = Result.isSuccess(place)
					? `${place.success.kind} ${place.success.path}`
					: failureOf(place.failure)
				return { digest, changed: yield* changedAt(path) }
			}
			case "link": {
				const answer = yield* Effect.result(fs.readLink(path))
				const digest = Result.isSuccess(answer) ? `to ${answer.success}` : failureOf(answer.failure)
				return { digest, changed: yield* changedAt(path) }
			}
			case "presence":
			case "directory":
			case "file": {
				const info = yield* Effect.option(fs.stat(path))
				if (Option.isNone(info)) {
					return { digest: "absent", changed: yield* changedAt(path) }
				}
				const changed = modifiedOf(info.value)
				const type = info.value.type
				if (kind === "presence") {
					return {
						digest: type === "Directory" ? "directory" : type === "File" ? "file" : "other",
						changed
					}
				}
				if (kind === "directory") {
					if (type !== "Directory") {
						return { digest: "no directory", changed }
					}
					const names = yield* Effect.orDie(fs.readDirectory(path))
					const digest = yield* sha256Of(
						new TextEncoder().encode(Arr.join(Arr.sort(names, Order.String), "\u0000"))
					)
					return { digest, changed }
				}
				if (type !== "File") {
					return { digest: type === "Directory" ? "directory" : "other", changed }
				}
				const bytes = yield* Effect.orDie(fs.readFile(path))
				return { digest: yield* sha256Of(bytes), changed }
			}
		}
	})
