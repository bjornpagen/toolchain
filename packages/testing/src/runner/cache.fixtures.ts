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
	option,
	string,
	unicodeScalar
} from "#gen.ts"
import { plantedBudget } from "#planted.fixtures.ts"
import { type Need, NeedFailed, PropertyId } from "#property.ts"
import {
	type Edit,
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
 * and run at once, every key built from a few values of each of its fields so that keys one field apart come up. A
 * model (a map from each key's identity to its state) is the oracle.
 */

/** One edit of a key, by which of three mutants it is and which of two contents its file has. */
export type EditModel = Readonly<{ mutant: Mutant; content: number }>

/** Which of three mutants an edit is. */
type Mutant = 0 | 1 | 2

/** A key, by which of two values each field takes, and its edit, none for a search of the program as it stands. */
export type KeyModel = Readonly<{
	property: number
	closure: number
	seeds: number
	edit: Option.Option<EditModel>
}>

/** What an operation does to its key: records a pass or a failure, reads it, or overwrites its record with another's. */
const ACTIONS = ["read", "pass", "fail", "corrupt"] as const

export type Action = (typeof ACTIONS)[number]

/** One operation on one key. */
export type Operation = Readonly<{ key: KeyModel; action: Action }>

/** A program: rounds of operations, each round on distinct keys and run at once. */
export type Program = ReadonlyArray<ReadonlyArray<Operation>>

const edits: Gen<EditModel> = (source) => ({
	mutant: source.draw(element([0, 1, 2] as const)),
	content: source.draw(element([0, 1]))
})

const keys: Gen<KeyModel> = (source) => ({
	property: source.draw(element([0, 1])),
	closure: source.draw(element([0, 1])),
	seeds: source.draw(element([0, 1])),
	edit: source.draw(option(edits))
})

/** A key's edit as its identity names it: `-` for none. */
const editNameOf = (key: KeyModel): string =>
	Option.match(key.edit, {
		onNone: () => "-",
		onSome: (edit) => `${edit.mutant}.${edit.content}`
	})

/** A key's identity: equal for two keys exactly when the cache must answer them alike. */
const identityOf = (key: KeyModel): string =>
	`${key.property} ${key.closure} ${key.seeds} ${editNameOf(key)}`

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
			(left, right) => identityOf(left.key) === identityOf(right.key)
		),
	{ min: 1, max: 6 }
)

/** The two closure hashes and two content hashes a model key's fields choose between. */
export type Hashes = Readonly<{
	closures: readonly [ClosureHash, ClosureHash]
	contents: readonly [ContentHash, ContentHash]
	mutated: Readonly<Record<Mutant, ContentHash>>
}>

/** A parser for trees of JSON files alone, which no closure parses. */
const NO_CODE = ModuleSyntax.of({ runtimeSpecifiers: () => Effect.succeed([]) })

/**
 * Two closure hashes and two content hashes, made as closure.ts makes them (its brands are minted there alone): the
 * closures of two JSON modules of a tree of their own, two files' contents, and three mutants' edited contents.
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
	const [contents, mutated] = yield* Effect.all([
		Effect.all([contentHashOf(encoder.encode("0")), contentHashOf(encoder.encode("1"))]),
		Effect.all({
			0: contentHashOf(encoder.encode("mutant 0")),
			1: contentHashOf(encoder.encode("mutant 1")),
			2: contentHashOf(encoder.encode("mutant 2"))
		})
	]).pipe(Effect.provideService(Digest.Digest, digest))
	return { closures: [first.hash, second.hash], contents, mutated } as const
})

/** The key a model key stands for. */
const keyOf = (hashes: Hashes, key: KeyModel): VerdictKey => ({
	property: PropertyId(`src/cache.test.ts#property${key.property}`),
	closure: key.closure === 0 ? hashes.closures[0] : hashes.closures[1],
	seeds: SeedPolicy(`policy ${key.seeds}`),
	edit: Option.map(key.edit, (edit): Edit => ({
		file: `packages/testing/src/mutant${edit.mutant}.ts`,
		content: edit.content === 0 ? hashes.contents[0] : hashes.contents[1],
		mutated: hashes.mutated[edit.mutant]
	}))
})

/**
 * What one key's record holds in the model: nothing (never passed, or cleared by a failure under its own key), a pass,
 * or a foreign text.
 */
export type Held =
	| Readonly<{ kind: "absent"; why: "never" | "cleared" }>
	| Readonly<{ kind: "passed" }>
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
	budget: plantedBudget,
	runNeeds: [],
	open: Effect.map(Layer.build(layerDigest), (built) =>
		Effect.succeed(Context.get(built, Digest.Digest))
	)
}

/** A directory of the case's own, removed when the case ends. */
export const scratch: Need<string> = {
	key: "@bjornpagen/testing/runner/cache.fixtures/scratch",
	budget: plantedBudget,
	runNeeds: [],
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

/** git's own blob hash of a text: `printf '%s' | git hash-object --stdin`. */
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
	| "a pass read beside another pass of its property"
	| "a corrupt record refused"
	| "a key whose property alone differs from a pass read as none"
	| "a key whose closure alone differs from a pass read as none"
	| "a key whose seed policy alone differs from a pass read as none"
	| "a key whose edit alone differs from a pass read as none"
	| "passes of distinct keys written at once"

/** The one field two keys differ in; none when they differ in none or in more. */
const loneFieldOf = (left: KeyModel, right: KeyModel): Option.Option<KeyField> => {
	const differing = Arr.filter(
		[
			["property", left.property !== right.property],
			["closure", left.closure !== right.closure],
			["seeds", left.seeds !== right.seeds],
			["edit", editNameOf(left) !== editNameOf(right)]
		] as const,
		([, differs]) => differs
	)
	return differing.length === 1
		? Option.map(Arr.head(differing), ([field]) => field)
		: Option.none()
}

/** A key's fields. */
type KeyField = "property" | "closure" | "seeds" | "edit"

/** The situation of reading a key that differs from a passed key in one field alone. */
const LONE_FIELD_SITUATIONS: Readonly<Record<KeyField, CacheSituation>> = {
	property: "a key whose property alone differs from a pass read as none",
	closure: "a key whose closure alone differs from a pass read as none",
	seeds: "a key whose seed policy alone differs from a pass read as none",
	edit: "a key whose edit alone differs from a pass read as none"
}

/** What a read of an absent key reaches, by why it is absent. */
const ABSENT_SITUATIONS: Readonly<Record<"never" | "cleared", CacheSituation>> = {
	never: "a key never passed read as none",
	cleared: "a key read as none after a failure cleared its pass"
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
						situations.add("a pass read back")
						if (
							Arr.some(
								Arr.fromIterable(held.entries()),
								([other, entry]) =>
									other !== identity &&
									entry.key.property === key.property &&
									entry.held.kind === "passed"
							)
						) {
							situations.add("a pass read beside another pass of its property")
						}
						return Option.some("passed")
					case "corrupt":
						situations.add("a corrupt record refused")
						return Option.some("corrupt")
				}
			case "pass":
				after.set(identity, { key, held: { kind: "passed" } })
				return Option.none()
			case "fail":
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
		Arr.map(round, (operation) => `${operation.action} ${identityOf(operation.key)}`),
		"; "
	)

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
const keptPrograms: Gen<Program> = (source) => {
	const key = source.draw(keys)
	const newer: KeyModel = { ...key, closure: 1 - key.closure }
	return [
		[{ key, action: "pass" }],
		[{ key: newer, action: "pass" }],
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
 * record, a pass under a key one seed policy away, a failure after a pass, and a pass read after a newer pass of its
 * property.
 */
export const aimedPrograms = aimed<Program, CacheSituation>(programs, [
	["a pass read back", thenRead("pass", (key) => key)],
	["a corrupt record refused", thenRead("corrupt", (key) => key)],
	[
		"a key whose seed policy alone differs from a pass read as none",
		thenRead("pass", (key) => ({ ...key, seeds: 1 - key.seeds }))
	],
	["a key read as none after a failure cleared its pass", clearedPrograms],
	["a pass read beside another pass of its property", keptPrograms]
])
