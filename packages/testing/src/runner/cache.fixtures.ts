import { layerDigest } from "@effect/platform-node/NodeCrypto"
import {
	Array as Arr,
	Context,
	Effect,
	FileSystem,
	Layer,
	Option,
	type PlatformError,
	Stream,
	String as Str
} from "effect"
import { Digest } from "effect/crypto"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import {
	aimed,
	array,
	boolean,
	characterOf,
	element,
	type Gen,
	oneOf,
	string,
	unicodeScalar
} from "#gen.ts"
import { type Need, NeedFailed, PropertyId } from "#property.ts"
import {
	type KillContent,
	SeedPolicy,
	type VerdictCache,
	type VerdictCacheUnusable,
	type VerdictKey,
	verdictCacheAt,
	verdictFileOf
} from "#runner/cache.ts"
import type { ClosureHash } from "#runner/closure-hash.ts"
import {
	type ContentHash,
	closuresOf,
	contentHashOf,
	ModuleSyntax,
	repoPathOf,
	type Files
} from "#runner/closure.ts"

/**
 * Programs over the verdict cache for cache.test.ts: rounds of operations, each round's operations on distinct keys
 * and run at once, every key built from a few values of each of its fields so that keys one field apart, and kill lists
 * in another order, come up. A model (a map from each key's identity to its state) is the oracle.
 */

/** One kill of a key, by which of three mutants it is and which of two contents its file has. */
export type KillModel = Readonly<{ mutant: number; content: number }>

/** A key, by which of two values each field takes, its kills as listed (their order is the property's). */
export type KeyModel = Readonly<{
	property: number
	closure: number
	seeds: number
	kills: ReadonlyArray<KillModel>
}>

/** What an operation does to its key: records a pass or a failure, reads it, or overwrites its record with another's. */
const ACTIONS = ["read", "pass", "fail", "corrupt"] as const

export type Action = (typeof ACTIONS)[number]

/** One operation on one key. */
export type Operation = Readonly<{ key: KeyModel; action: Action }>

/** A program: rounds of operations, each round on distinct keys and run at once. */
export type Program = ReadonlyArray<ReadonlyArray<Operation>>

const kills: Gen<KillModel> = (source) => ({
	mutant: source.draw(element([0, 1, 2])),
	content: source.draw(element([0, 1]))
})

const keys: Gen<KeyModel> = (source) => ({
	property: source.draw(element([0, 1])),
	closure: source.draw(element([0, 1])),
	seeds: source.draw(element([0, 1])),
	kills: source.draw(array(kills, { min: 0, max: 2 }))
})

/** A key's identity: equal for two keys exactly when the cache must answer them alike, its kills taken as a set. */
const identityOf = (key: KeyModel): string =>
	`${key.property} ${key.closure} ${key.seeds} ${Arr.join(
		Arr.dedupe(
			Arr.sort(
				Arr.map(key.kills, (kill) => `${kill.mutant}.${kill.content}`),
				Str.Order
			)
		),
		","
	)}`

/** A key's kills as listed, which two keys of one identity may list in different orders. */
const listedOf = (key: KeyModel): string =>
	Arr.join(
		Arr.map(key.kills, (kill) => `${kill.mutant}.${kill.content}`),
		","
	)

/** Up to six rounds of up to four operations, each round's keys distinct. */
const programs: Gen<Program> = array(
	(source) =>
		Arr.dedupeWith(
			source.draw(
				array(
					(inner): Operation => ({
						key: inner.draw(keys),
						action: inner.draw(element(ACTIONS))
					}),
					{ min: 1, max: 4 }
				)
			),
			(left, right) => left.key.property === right.key.property
		),
	{ min: 1, max: 6 }
)

/** The two closure hashes and two content hashes a model key's fields choose between. */
export type Hashes = Readonly<{
	closures: readonly [ClosureHash, ClosureHash]
	contents: readonly [ContentHash, ContentHash]
}>

/** A parser for trees of JSON files alone, which no closure parses. */
const NO_CODE = ModuleSyntax.of({ runtimeSpecifiers: () => Effect.succeed([]) })

/**
 * Two closure hashes and two content hashes, made as closure.ts makes them (its brands are minted there alone): the
 * closures of two JSON modules of a tree of their own, and two files' contents.
 */
export const hashesOf = Effect.fn("hashesOf")(function* (
	digest: Context.Service.Shape<typeof Digest.Digest>
) {
	const encoder = new TextEncoder()
	const files = new Map([
		["a.json", encoder.encode("0")],
		["b.json", encoder.encode("1")],
		["pnpm-lock.yaml", encoder.encode("lockfileVersion: '9.0'\n")]
	])
	const tree: Files = { read: (path) => Effect.succeed(Option.fromUndefinedOr(files.get(path))) }
	const [a, b] = yield* Effect.fromOption(Option.all([repoPathOf("a.json"), repoPathOf("b.json")]))
	const closures = yield* closuresOf({
		tree,
		conditions: [],
		runtime: "model",
		roots: [a, b]
	}).pipe(
		Effect.provideService(ModuleSyntax, NO_CODE),
		Effect.provideService(Digest.Digest, digest)
	)
	const [first, second] = yield* Effect.fromOption(
		Option.all([Option.fromUndefinedOr(closures.get(a)), Option.fromUndefinedOr(closures.get(b))])
	)
	const contents = yield* Effect.all([
		contentHashOf(encoder.encode("0")),
		contentHashOf(encoder.encode("1"))
	]).pipe(Effect.provideService(Digest.Digest, digest))
	return { closures: [first.hash, second.hash], contents } as const
})

/** The key a model key stands for. */
const keyOf = (hashes: Hashes, key: KeyModel): VerdictKey => ({
	property: PropertyId(`src/cache.test.ts#property${key.property}`),
	closure: key.closure === 0 ? hashes.closures[0] : hashes.closures[1],
	seeds: SeedPolicy(`policy ${key.seeds}`),
	kills: Arr.map(key.kills, (kill): KillContent => ({
		file: `packages/testing/src/mutant${kill.mutant}.ts`,
		original: `original ${kill.mutant}`,
		replacement: `replacement\n${kill.mutant}`,
		content: kill.content === 0 ? hashes.contents[0] : hashes.contents[1]
	}))
})

/**
 * What one key's record holds in the model: nothing (never passed, cleared by a failure under its own key, or collected
 * by a newer verdict of its property), a pass (and the kill order it was passed with), or a foreign text.
 */
export type Held =
	| Readonly<{ kind: "absent"; why: "never" | "cleared" | "collected" }>
	| Readonly<{ kind: "passed"; listed: string }>
	| Readonly<{ kind: "corrupt" }>

/** What a read of a key answers: a pass, none, or a refusal of a record that is not its key's. */
export type Answer = "passed" | "none" | "corrupt"

/** Writes a record at a key's file whose text is not its key: another key's record, as a stray writer would. */
const corrupted = Effect.fn("corrupted")(function* (directory: string, key: VerdictKey) {
	const fs = yield* FileSystem.FileSystem
	const { shard, file } = yield* verdictFileOf(directory, key)
	const other = yield* verdictFileOf(directory, { ...key, seeds: SeedPolicy(`${key.seeds} other`) })
	yield* fs.makeDirectory(shard, { recursive: true })
	yield* fs.writeFileString(file, other.record)
})

/** The verdict cache in `directory` and SHA-256 from Node's crypto. */
export const cacheIn = (directory: string, digest: Context.Service.Shape<typeof Digest.Digest>) =>
	verdictCacheAt(directory).pipe(Effect.provideService(Digest.Digest, digest))

/** Node's SHA-256, opened once per evaluating process. */
export const digests: Need<Context.Service.Shape<typeof Digest.Digest>> = {
	key: "@bjornpagen/testing/runner/cache.fixtures/digest",
	open: Effect.map(Layer.build(layerDigest), (built) =>
		Effect.succeed(Context.get(built, Digest.Digest))
	)
}

/** A directory of the case's own, removed when the case ends. */
export const scratch: Need<string> = {
	key: "@bjornpagen/testing/runner/cache.fixtures/scratch",
	open: Effect.map(FileSystem.FileSystem, (fs) =>
		Effect.mapError(fs.makeTempDirectoryScoped({ prefix: "toolchain-verdicts-" }), (failure) =>
			NeedFailed.make({ need: "scratch", message: failure.message })
		)
	)
}

/**
 * A repository's identity as git config or a path gives it: an origin URL, an absolute directory, or any text at all,
 * beyond ASCII and across lines among them.
 */
export const identities: Gen<string> = oneOf([
	(source) =>
		`https://github.com/${source.draw(string(characterOf(["a", "b", "-", "."]), { min: 1, max: 8 }))}/${source.draw(string(characterOf(["x", "y", "_"]), { min: 1, max: 8 }))}.git`,
	(source) =>
		`/home/${source.draw(string(characterOf(["a", "é", " ", "/"]), { min: 1, max: 12 }))}/.git`,
	string(unicodeScalar, { min: 0, max: 16 }),
	(source) => (source.draw(boolean) ? "" : "\n")
])

/** git's own blob hash of a text, as toolchain-gate's key_of takes it: `printf '%s' | git hash-object --stdin`. */
export const gitBlobHashOf = Effect.fn("gitBlobHashOf")(function* (text: string) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const [stdout, exitCode] = yield* Effect.scoped(
		Effect.flatMap(
			spawner.spawn(
				ChildProcess.make("git", ["hash-object", "--stdin"], {
					stdin: { stream: Stream.make(new TextEncoder().encode(text)) }
				})
			),
			(handle) =>
				Effect.all([Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode], {
					concurrency: "unbounded"
				})
		)
	)
	if (exitCode !== 0) {
		return yield* Effect.die(`git hash-object exited ${exitCode}`)
	}
	return Str.trim(stdout)
})

/** What a repository identity exercises. */
export type IdentitySituation =
	| "an empty identity"
	| "an identity beyond ASCII"
	| "an identity of several lines"

/** The situations an identity reaches. */
export const identitySituationsOf = (identity: string): ReadonlyArray<IdentitySituation> => [
	...(identity === "" ? ["an empty identity" as const] : []),
	...(Arr.some(Arr.fromIterable(identity), (character) =>
		Option.exists(Str.codePointAt(0)(character), (code) => code > 0x7f)
	)
		? ["an identity beyond ASCII" as const]
		: []),
	...(Str.includes("\n")(identity) ? ["an identity of several lines" as const] : [])
]

/** What a program exercises. */
export type CacheSituation =
	| "a pass read back"
	| "a key never passed read as none"
	| "a key read as none after a failure cleared its pass"
	| "a pass collected by a newer verdict of its property read as none"
	| "a corrupt record refused"
	| "kills in another order answering as one key"
	| "a key whose property alone differs from a pass read as none"
	| "a key whose closure alone differs from a pass read as none"
	| "a key whose seed policy alone differs from a pass read as none"
	| "a key whose kills alone differ from a pass read as none"
	| "passes of distinct keys written at once"

/** The one field two keys differ in, kills taken as a set; none when they differ in none or in more. */
const loneFieldOf = (left: KeyModel, right: KeyModel): Option.Option<KeyField> => {
	const [, , , leftKills = ""] = Str.split(" ")(identityOf(left))
	const [, , , rightKills = ""] = Str.split(" ")(identityOf(right))
	const differing = Arr.filter(
		[
			["property", left.property !== right.property],
			["closure", left.closure !== right.closure],
			["seeds", left.seeds !== right.seeds],
			["kills", leftKills !== rightKills]
		] as const,
		([, differs]) => differs
	)
	return differing.length === 1
		? Option.map(Arr.head(differing), ([field]) => field)
		: Option.none()
}

/** A key's fields. */
type KeyField = "property" | "closure" | "seeds" | "kills"

/** The situation of reading a key that differs from a passed key in one field alone. */
const LONE_FIELD_SITUATIONS: Readonly<Record<KeyField, CacheSituation>> = {
	property: "a key whose property alone differs from a pass read as none",
	closure: "a key whose closure alone differs from a pass read as none",
	seeds: "a key whose seed policy alone differs from a pass read as none",
	kills: "a key whose kills alone differ from a pass read as none"
}

/** What a read of an absent key reaches, by why it is absent. */
const ABSENT_SITUATIONS: Readonly<Record<"never" | "cleared" | "collected", CacheSituation>> = {
	never: "a key never passed read as none",
	cleared: "a key read as none after a failure cleared its pass",
	collected: "a pass collected by a newer verdict of its property read as none"
}

/** A write's collection in the model: every record its property holds under another key goes. */
const collect = (
	ledger: Map<string, Readonly<{ key: KeyModel; held: Held }>>,
	key: KeyModel
): void => {
	for (const [identity, entry] of ledger) {
		if (entry.key.property === key.property && entry.held.kind !== "absent") {
			ledger.set(identity, { key: entry.key, held: { kind: "absent", why: "collected" } })
		}
	}
}

/** What the model holds: each key's identity, the key last recorded under it, and what is held. */
export type Ledger = ReadonlyMap<string, Readonly<{ key: KeyModel; held: Held }>>

/** The model's run of one round: what each read must answer, the situations it reaches, and the state after. */
export const roundOf = (
	held: Ledger,
	round: ReadonlyArray<Operation>
): Readonly<{
	answers: ReadonlyArray<Option.Option<Answer>>
	situations: ReadonlyArray<CacheSituation>
	after: Ledger
}> => {
	const situations = new Set<CacheSituation>()
	const after = new Map(held)
	if (Arr.filter(round, (operation) => operation.action === "pass").length > 1) {
		situations.add("passes of distinct keys written at once")
	}
	const answers = Arr.map(round, ({ key, action }): Option.Option<Answer> => {
		const identity = identityOf(key)
		const state: Held = Option.match(Option.fromUndefinedOr(held.get(identity)), {
			onNone: () => ({ kind: "absent", why: "never" }),
			onSome: (entry) => entry.held
		})
		switch (action) {
			case "read":
				switch (state.kind) {
					case "absent": {
						const apart = Arr.getSomes(
							Arr.map(Arr.fromIterable(held.values()), (entry) =>
								entry.held.kind === "passed" ? loneFieldOf(entry.key, key) : Option.none()
							)
						)
						situations.add(ABSENT_SITUATIONS[state.why])
						for (const field of apart) {
							situations.add(LONE_FIELD_SITUATIONS[field])
						}
						return Option.some("none")
					}
					case "passed":
						situations.add(
							state.listed === listedOf(key)
								? "a pass read back"
								: "kills in another order answering as one key"
						)
						return Option.some("passed")
					case "corrupt":
						situations.add("a corrupt record refused")
						return Option.some("corrupt")
				}
			case "pass":
				collect(after, key)
				after.set(identity, { key, held: { kind: "passed", listed: listedOf(key) } })
				return Option.none()
			case "fail":
				collect(after, key)
				after.set(identity, {
					key,
					held: { kind: "absent", why: state.kind === "passed" ? "cleared" : "never" }
				})
				return Option.none()
			case "corrupt":
				after.set(identity, { key, held: { kind: "corrupt" } })
				return Option.none()
		}
	})
	return { answers, situations: Arr.fromIterable(situations), after }
}

/**
 * One operation on the cache in `directory`: a read answers what the cache answers (a refused record as `corrupt`),
 * and every write answers nothing.
 */
export const performed = (
	cache: VerdictCache,
	directory: string,
	digest: Context.Service.Shape<typeof Digest.Digest>,
	hashes: Hashes,
	operation: Operation
): Effect.Effect<
	Option.Option<Answer>,
	VerdictCacheUnusable | PlatformError.PlatformError,
	FileSystem.FileSystem
> => {
	const key = keyOf(hashes, operation.key)
	switch (operation.action) {
		case "read":
			return cache.passed(key).pipe(
				Effect.map((passed): Option.Option<Answer> => Option.some(passed ? "passed" : "none")),
				Effect.catchTag("VerdictCorrupt", () => Effect.succeedSome<Answer>("corrupt"))
			)
		case "pass":
			return Effect.as(cache.record(key, "passed"), Option.none())
		case "fail":
			return Effect.as(cache.record(key, "failed"), Option.none())
		case "corrupt":
			return Effect.as(
				corrupted(directory, key).pipe(Effect.provideService(Digest.Digest, digest)),
				Option.none()
			)
	}
}

/** A round as a report names it: each operation and its key's identity. */
export const describedOf = (round: ReadonlyArray<Operation>): string =>
	Arr.join(
		Arr.map(
			round,
			(operation) => `${operation.action} ${identityOf(operation.key)} (${listedOf(operation.key)})`
		),
		"; "
	)

/**
 * A program that passes a key whose two kills differ and then reads it with its kills listed the other way round,
 * before rounds of its own.
 */
const reorderedPrograms: Gen<Program> = (source) => {
	const key = source.draw(keys)
	const first = source.draw(kills)
	const second: KillModel = { mutant: (first.mutant + 1) % 3, content: first.content }
	return [
		[{ key: { ...key, kills: [first, second] }, action: "pass" }],
		[{ key: { ...key, kills: [second, first] }, action: "read" }],
		...source.draw(programs)
	]
}

/** A program that passes a key, records a failure under it, and reads it, before rounds of its own. */
const clearedPrograms: Gen<Program> = (source) => {
	const key = source.draw(keys)
	return [
		[{ key, action: "pass" }],
		[{ key, action: "fail" }],
		[{ key, action: "read" }],
		...source.draw(programs)
	]
}

/** A program that passes a key, then another key of its property, and reads the first, before rounds of its own. */
const collectedPrograms: Gen<Program> = (source) => {
	const key = source.draw(keys)
	const newer: KeyModel = { ...key, closure: 1 - key.closure }
	return [
		[{ key, action: "pass" }],
		[{ key: newer, action: source.draw(element(["pass", "fail"])) }],
		[{ key, action: "read" }],
		...source.draw(programs)
	]
}

/** A program that records `action` under a key and then reads `read` of it, before rounds of its own. */
const thenRead =
	(action: Action, read: (key: KeyModel) => KeyModel): Gen<Program> =>
	(source) => {
		const key = source.draw(keys)
		return [[{ key, action }], [{ key: read(key), action: "read" }], ...source.draw(programs)]
	}

/**
 * Programs, aimed at what a read meets after one write of its key's property: a pass under the same key, a corrupt
 * record, a pass under a key one seed policy away, kills listed in another order, a failure after a pass, and a pass a
 * newer verdict of its property collected.
 */
export const aimedPrograms = aimed<Program, CacheSituation>(programs, [
	["a pass read back", thenRead("pass", (key) => key)],
	["a corrupt record refused", thenRead("corrupt", (key) => key)],
	[
		"a key whose seed policy alone differs from a pass read as none",
		thenRead("pass", (key) => ({ ...key, seeds: 1 - key.seeds }))
	],
	["kills in another order answering as one key", reorderedPrograms],
	["a key read as none after a failure cleared its pass", clearedPrograms],
	["a pass collected by a newer verdict of its property read as none", collectedPrograms]
])
