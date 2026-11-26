import { Array as Arr, Brand, Effect, FileSystem, Option, Schema, String as Str } from "effect"
import { Digest } from "effect/crypto"
import type { PropertyId } from "#property.ts"
import type { ClosureHash } from "#runner/closure-hash.ts"
import { type ContentHash, contentHashOf, repoPathOf, specifiersOf } from "#runner/closure.ts"

/**
 * The verdict cache: which properties passed, keyed by everything their verdict depends on, so a pass is a known answer
 * for as long as its key stands and is never recomputed. A key is a property's identity, the closure hash of its module
 * (closure.ts; under an edit, joined with the edited file's, runner/affected.ts editKeyOf), the toolchain that runs it
 * (the digest of the runner's package, every file of it), the environment its workers are given (runner/environment.ts),
 * how the run seeded its cases, and the edit it ran under, none for its search
 * of the program as it stands: a file, its own bytes and its bytes edited (a kill applied, or an operator mutant). Only
 * passes are stored, as files named by the hash of their key: a failure removes the pass its own key held and writes
 * nothing, so a failure is never read as a pass. A pass of a property that observed past its key (runner/observe.ts)
 * is no pass to store: it is recorded as a failure, so it runs again every time. What a property reads at run time (a
 * fixture, what its child reads, the PostgreSQL serving a member it connects to) is its pass's trace, kept beside its
 * record and checked whenever its key is read (runner/traces.ts).
 *
 * Records are content-addressed and immutable: every pass is kept under its own key, so lanes that push different
 * trees one after another each find the passes of the trees before theirs, and no write removes another key's record.
 * Nothing is collected by age or by property: a record is a few hundred bytes, and one whose closure no live tree can
 * produce any more is the only kind a collection may remove. A record is safe to delete at any time; its property runs
 * again.
 *
 * The load cache (`toolchain-test load`, loadCacheAt) keeps its passes alike, one implementation (passCacheAt): a test
 * module's load, keyed by the module and its joint closure, its records beside the verdicts'.
 *
 * Layout: `<directory>/<SHA-256 of the property id, or the module>/<SHA-256 of the key>.json`, each file the key itself
 * as JSON. A write
 * goes to a temporary file in a directory of its own beside the record (removed when the write ends) and is renamed into
 * place, so a reader sees a whole record or none, and
 * writers of distinct keys touch distinct files and take no lock. A record whose text is not its key's is refused
 * (VerdictCorrupt), never read as a pass.
 */

/**
 * How the run a verdict came from seeded its cases, as the runner names its policy: a pass under one policy answers
 * nothing under another.
 */
export type SeedPolicy = string & Brand.Brand<"SeedPolicy">

export const SeedPolicy = Brand.nominal<SeedPolicy>()

/**
 * An edit of one file as a verdict depends on it: the file, the hash of its own bytes, and the hash of its bytes with the
 * edit applied. A kill (its original replaced where it stands once) and an operator mutant (its span replaced) are both
 * edits, and two that make one text are one edit: the program the property runs under it is the same. A verdict under
 * an edit is keyed by the closure of the property joined with the edited file's own (runner/affected.ts editKeyOf), so
 * an edit loads nothing its file's text does not: every module the edited program loads is in that closure.
 */
export type Edit = Readonly<{ file: string; content: ContentHash; mutated: ContentHash }>

/**
 * The edit that makes `own`, the text of `file` (a path from the repository root), into `mutated`; none when the edited
 * text loads a module the file's own does not (a runtime specifier its text names and the file's does not, as the
 * closure reads them, closure.ts specifiersOf), since that module is in no closure the edit's key joins, nor when
 * either text cannot be read for its specifiers: such an edit keys no verdict, and is judged on every run. An edited
 * text that loads less than the file's does is an edit: what it no longer loads is still in the file's closure.
 */
export const editOf = Effect.fn("editOf")(function* (file: string, own: string, mutated: string) {
	const ownBytes = new TextEncoder().encode(own)
	const editedBytes = new TextEncoder().encode(mutated)
	const content = yield* contentHashOf(ownBytes)
	const edited = yield* contentHashOf(editedBytes)
	const loads = yield* Effect.option(
		Effect.transposeOption(
			Option.map(repoPathOf(file), (path) =>
				Effect.all([specifiersOf(path, content, ownBytes), specifiersOf(path, edited, editedBytes)])
			)
		)
	)
	return Option.flatMap(Option.flatten(loads), ([before, after]) =>
		Arr.every(after, (specifier) => Arr.contains(before, specifier))
			? Option.some<Edit>({ file, content, mutated: edited })
			: Option.none()
	)
})

/**
 * What a cached verdict answers for: a property's search of the program as it stands (no edit), or its witnesses run
 * under one edit (a kill's trial, an operator mutant's), whose pass is their red.
 */
export type VerdictKey = Readonly<{
	property: PropertyId
	closure: ClosureHash
	toolchain: ContentHash
	environment: ContentHash
	seeds: SeedPolicy
	edit: Option.Option<Edit>
}>

/** A verdict as the cache takes it: any outcome but a pass is a failure. */
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

/** A cache of passes keyed by `K`, one repository's. */
export type PassCache<K> = Readonly<{
	/** Whether the key holds a pass. */
	passed: (key: K) => Effect.Effect<boolean, VerdictCacheUnusable | VerdictCorrupt>
	/** Stores a pass under the key, or removes the pass a failure's key held. */
	record: (key: K, verdict: Verdict) => Effect.Effect<void, VerdictCacheUnusable>
}>

/** The cache of one repository's verdicts. */
export type VerdictCache = PassCache<VerdictKey>

/** The cache of one repository's loads. */
export type LoadCache = PassCache<LoadKey>

/** A key as its record stores it, its edit null where it has none. */
const KeyRecord = Schema.fromJsonString(
	Schema.Struct({
		property: Schema.String,
		closure: Schema.String,
		toolchain: Schema.String,
		environment: Schema.String,
		seeds: Schema.String,
		edit: Schema.NullOr(
			Schema.Struct({ file: Schema.String, content: Schema.String, mutated: Schema.String })
		)
	})
)

const encodeKeyRecord = Schema.encodeEffect(KeyRecord)

/** A key's record text: one text for every key that answers alike. */
export const recordOf = (key: VerdictKey): Effect.Effect<string> =>
	Effect.orDie(
		encodeKeyRecord({
			property: key.property,
			closure: key.closure,
			toolchain: key.toolchain,
			environment: key.environment,
			seeds: key.seeds,
			edit: Option.getOrNull(key.edit)
		})
	)

/** Where a key's record lies: the directory of its subject, the file it is stored in, and the record's text. */
type Placed = Readonly<{ shard: string; file: string; record: string }>

/**
 * The place under `directory` of a record of `subject` (a property's identity, a module's path): the subject's
 * directory, named by the SHA-256 of the subject, and in it the file named by the SHA-256 of the record's text.
 */
const placedOf = Effect.fn("placedOf")(function* (
	directory: string,
	subject: string,
	record: string
) {
	const digest = yield* Digest.Digest
	const shard = yield* digest.digestHex(Digest.sha256, new TextEncoder().encode(subject))
	const hash = yield* digest.digestHex(Digest.sha256, new TextEncoder().encode(record))
	return {
		shard: `${directory}/${shard}`,
		file: `${directory}/${shard}/${hash}.json`,
		record
	} satisfies Placed
})

/** The directory of a key's property under `directory`, the file its record is stored in, and the record's text. */
export const verdictFileOf = (directory: string, key: VerdictKey) =>
	Effect.flatMap(recordOf(key), (record) => placedOf(directory, key.property, record))

/**
 * A cache of passes, each record placed by `placed`: whether a key holds a pass (its record there, its text the key's),
 * and a pass stored or a failure's removed, every write renamed into place from a temporary file beside it.
 */
const passCacheAt = <K>(
	placed: (key: K) => Effect.Effect<Placed, never, Digest.Digest>
): Effect.Effect<PassCache<K>, never, FileSystem.FileSystem | Digest.Digest> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const digest = yield* Digest.Digest
		const place = (key: K) => placed(key).pipe(Effect.provideService(Digest.Digest, digest))
		const unusable = (path: string) => (cause: unknown) =>
			VerdictCacheUnusable.make({ path, cause })
		return {
			passed: (key) =>
				Effect.gen(function* () {
					const { file, record } = yield* place(key)
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
					const { shard, file, record } = yield* place(key)
					switch (verdict) {
						case "passed":
							yield* Effect.mapError(fs.makeDirectory(shard, { recursive: true }), unusable(shard))
							yield* Effect.scoped(
								Effect.gen(function* () {
									const temporary = yield* Effect.mapError(
										fs.makeTempFileScoped({ directory: shard, prefix: ".verdict-" }),
										unusable(shard)
									)
									yield* Effect.mapError(fs.writeFileString(temporary, record), unusable(temporary))
									yield* Effect.mapError(fs.rename(temporary, file), unusable(file))
								})
							)
							return
						case "failed":
							yield* Effect.mapError(fs.remove(file, { force: true }), unusable(file))
							return
					}
				})
		}
	})

/** The verdict cache whose records are under `directory`, which it creates as it writes. */
export const verdictCacheAt = (
	directory: string
): Effect.Effect<VerdictCache, never, FileSystem.FileSystem | Digest.Digest> =>
	passCacheAt((key: VerdictKey) => verdictFileOf(directory, key))

/**
 * What a cached load answers for (`toolchain-test load`, runner/loads.ts): a test module, by its path from the package
 * root, and the joint closure of it, the package's runner config and the runner's own entry modules (affected.ts
 * loadKeyingAt), so a module loads again exactly when something it can load changed.
 */
export type LoadKey = Readonly<{ module: string; closure: ClosureHash }>

/** A load key as its record stores it. */
const LoadRecord = Schema.fromJsonString(
	Schema.Struct({ module: Schema.String, closure: Schema.String })
)

const encodeLoadRecord = Schema.encodeEffect(LoadRecord)

/** The cache of loads whose records are under `directory`, as the verdict cache keeps its passes. */
export const loadCacheAt = (
	directory: string
): Effect.Effect<LoadCache, never, FileSystem.FileSystem | Digest.Digest> =>
	passCacheAt((key: LoadKey) =>
		Effect.flatMap(Effect.orDie(encodeLoadRecord(key)), (record) =>
			placedOf(directory, key.module, record)
		)
	)

/**
 * The first twelve hex digits of the git blob hash of a repository's identity (its origin remote's URL, else its
 * common git directory), so every clone and workspace of the repository, whatever spelling of its URL it keeps (a
 * trailing / or .git), shares one verdict cache, at
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
