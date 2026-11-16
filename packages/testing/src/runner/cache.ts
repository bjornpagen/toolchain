import { Array as Arr, Brand, Effect, FileSystem, Order, Schema, String as Str } from "effect"
import { Digest } from "effect/crypto"
import type { PropertyId } from "#property.ts"
import type { ClosureHash } from "#runner/closure-hash.ts"
import type { ContentHash } from "#runner/closure.ts"

/**
 * The verdict cache: which properties passed, keyed by everything their verdict depends on, so a pass is a known answer
 * for as long as its key stands and is never recomputed. A key is a property's identity, the closure hash of its module
 * (closure.ts), how the run seeded its cases, and its kills, each with the bytes of the file it mutates. Only passes are
 * stored, as files named by the hash of their key: a failure removes the pass its own key held and writes nothing, so a
 * failure is never read as a pass.
 *
 * Records are content-addressed and immutable: every pass is kept under its own key, so lanes that push different
 * trees one after another each find the passes of the trees before theirs, and no write removes another key's record.
 * Nothing is collected by age or by property: a record is a few hundred bytes, and one whose closure no live tree can
 * produce any more is the only kind a collection may remove. A record is safe to delete at any time; its property runs
 * again.
 *
 * Layout: `<directory>/<SHA-256 of the property id>/<SHA-256 of the key>.json`, each file the key itself as JSON. A write
 * goes to a temporary file in its directory and is renamed into place, so a reader sees a whole record or none, and
 * writers of distinct keys touch distinct files and take no lock. A record whose text is not its key's is refused
 * (VerdictCorrupt), never read as a pass.
 */

/**
 * How the run a verdict came from seeded its cases, as the runner names its policy: a pass under one policy answers
 * nothing under another.
 */
export type SeedPolicy = string & Brand.Brand<"SeedPolicy">

export const SeedPolicy = Brand.nominal<SeedPolicy>()

/** A kill as its verdict depends on it: the mutant, and the bytes of the file it mutates. */
export type KillContent = Readonly<{
	file: string
	original: string
	replacement: string
	content: ContentHash
}>

/** What a cached verdict answers for. */
export type VerdictKey = Readonly<{
	property: PropertyId
	closure: ClosureHash
	seeds: SeedPolicy
	kills: ReadonlyArray<KillContent>
}>

/** A run's verdict on a property and its kills, as the cache takes it: any outcome but a pass is a failure. */
export type Verdict = "passed" | "failed"

/** The cache's files could not be read or written. */
export class VerdictCacheUnusable extends Schema.TaggedError<
	VerdictCacheUnusable,
	{ readonly brand: unique symbol }
>()("VerdictCacheUnusable", { path: Schema.String, cause: Schema.Defect() }) {}

/** A record's text is not the key its name is the hash of: the file was written by something other than the cache. */
class VerdictCorrupt extends Schema.TaggedError<
	VerdictCorrupt,
	{ readonly brand: unique symbol }
>()("VerdictCorrupt", { path: Schema.String }) {}

/** The cache of one repository's verdicts. */
export type VerdictCache = Readonly<{
	/** Whether the key holds a pass. */
	passed: (key: VerdictKey) => Effect.Effect<boolean, VerdictCacheUnusable | VerdictCorrupt>
	/** Stores a pass under the key, or removes the pass a failure's key held. */
	record: (key: VerdictKey, verdict: Verdict) => Effect.Effect<void, VerdictCacheUnusable>
}>

/** A key as its record stores it: kills in one order, since a verdict on kills does not depend on their order. */
const KeyRecord = Schema.fromJsonString(
	Schema.Struct({
		property: Schema.String,
		closure: Schema.String,
		seeds: Schema.String,
		kills: Schema.Array(
			Schema.Struct({
				file: Schema.String,
				original: Schema.String,
				replacement: Schema.String,
				content: Schema.String
			})
		)
	})
)

const encodeKeyRecord = Schema.encodeEffect(KeyRecord)

/** Kills in the order a record stores them: by file, then original, replacement and content. */
const KILL_ORDER = Order.combineAll<KillContent>([
	Order.mapInput(Str.Order, (kill: KillContent) => kill.file),
	Order.mapInput(Str.Order, (kill: KillContent) => kill.original),
	Order.mapInput(Str.Order, (kill: KillContent) => kill.replacement),
	Order.mapInput(Str.Order, (kill: KillContent) => kill.content)
])

/** A key's record text: one text for every key that answers alike. */
const recordOf = (key: VerdictKey): Effect.Effect<string> =>
	Effect.orDie(
		encodeKeyRecord({
			property: key.property,
			closure: key.closure,
			seeds: key.seeds,
			kills: Arr.dedupe(Arr.sort(key.kills, KILL_ORDER))
		})
	)

/** The directory of a key's property under `directory`, the file its record is stored in, and the record's text. */
export const verdictFileOf = Effect.fn("verdictFileOf")(function* (
	directory: string,
	key: VerdictKey
) {
	const record = yield* recordOf(key)
	const digest = yield* Digest.Digest
	const property = yield* digest.digestHex(Digest.sha256, new TextEncoder().encode(key.property))
	const hash = yield* digest.digestHex(Digest.sha256, new TextEncoder().encode(record))
	return {
		shard: `${directory}/${property}`,
		file: `${directory}/${property}/${hash}.json`,
		record
	}
})

/** The verdict cache whose records are under `directory`, which it creates as it writes. */
export const verdictCacheAt = (
	directory: string
): Effect.Effect<VerdictCache, never, FileSystem.FileSystem | Digest.Digest> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const digest = yield* Digest.Digest
		const placed = (key: VerdictKey) =>
			verdictFileOf(directory, key).pipe(Effect.provideService(Digest.Digest, digest))
		const unusable = (path: string) => (cause: unknown) =>
			VerdictCacheUnusable.make({ path, cause })
		return {
			passed: (key) =>
				Effect.gen(function* () {
					const { file, record } = yield* placed(key)
					const exists = yield* Effect.mapError(fs.exists(file), unusable(file))
					if (!exists) {
						return false
					}
					const stored = yield* Effect.mapError(fs.readFileString(file), unusable(file))
					if (stored !== record) {
						return yield* VerdictCorrupt.make({ path: file })
					}
					return true
				}),
			record: (key, verdict) =>
				Effect.gen(function* () {
					const { shard, file, record } = yield* placed(key)
					switch (verdict) {
						case "passed": {
							yield* Effect.mapError(fs.makeDirectory(shard, { recursive: true }), unusable(shard))
							const temporary = yield* Effect.mapError(
								fs.makeTempFile({ directory: shard, prefix: ".verdict-" }),
								unusable(shard)
							)
							yield* Effect.mapError(fs.writeFileString(temporary, record), unusable(temporary))
							yield* Effect.mapError(fs.rename(temporary, file), unusable(file))
							return
						}
						case "failed":
							yield* Effect.mapError(fs.remove(file, { force: true }), unusable(file))
							return
					}
				})
		}
	})

/**
 * The first twelve hex digits of the git blob hash of a repository's identity (its origin remote's URL, else its
 * common git directory): the key toolchain-gate names the repository's snapshots by, so the gate's cache and this one
 * name a repository alike, and every clone of it shares one verdict cache, at
 * `${XDG_CACHE_HOME:-~/.cache}/toolchain-test/<key>/verdicts`.
 */
export const repositoryKeyOf = Effect.fn("repositoryKeyOf")(function* (identity: string) {
	const digest = yield* Digest.Digest
	const content = new TextEncoder().encode(identity)
	const bytes = content.length
	const header = new TextEncoder().encode(`blob ${bytes}\0`)
	const blob = new Uint8Array(header.length + content.length)
	blob.set(header)
	blob.set(content, header.length)
	const hash = yield* digest.digestHex(Digest.sha1, blob)
	return Str.slice(0, 12)(hash)
})
