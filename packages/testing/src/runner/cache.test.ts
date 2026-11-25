import { Effect, String as Str } from "effect"
import { Digest } from "effect/crypto"
import { agree, exact } from "#oracle.ts"
import { property } from "#property.ts"
import {
	aimedPrograms,
	cacheIn,
	describedOf,
	digests,
	gitBlobHashOf,
	hashesOf,
	identities,
	identitySituationsOf,
	type Ledger,
	performed,
	roundOf,
	scratch
} from "#runner/cache.fixtures.ts"
import { repositoryKeyOf } from "#runner/cache.ts"

/**
 * The verdict cache answers a key with a pass exactly when a pass was last recorded under it, every key's record kept
 * beside the others of its property: a failure removes the pass under its own key alone, a key one field away (its
 * property, closure, toolchain, environment, PostgreSQL (none or one), seed policy or edit (none or one)) is another key, a record whose text is not its key is refused
 * rather than read as a pass, and passes of distinct keys written at once all land. Oracle: a map from each key's identity to what was last recorded under it.
 */
export const verdictsAreWhatWasLastRecorded = property.explore(aimedPrograms, {
	needs: { digest: digests, directory: scratch },
	situations: [
		"a pass read back",
		"a key never passed read as none",
		"a key read as none after a failure cleared its pass",
		"a pass read beside another pass of its property",
		"a corrupt record refused",
		"a key whose property alone differs from a pass read as none",
		"a key whose closure alone differs from a pass read as none",
		"a key whose toolchain alone differs from a pass read as none",
		"a key whose environment alone differs from a pass read as none",
		"a key whose PostgreSQL alone differs from a pass read as none",
		"a key whose seed policy alone differs from a pass read as none",
		"a key whose edit alone differs from a pass read as none",
		"passes of distinct keys written at once"
	],
	check:
		({ digest, directory }, c) =>
		(program) =>
			Effect.gen(function* () {
				const sha = yield* digest
				const root = yield* directory
				const hashes = yield* hashesOf(sha)
				const cache = yield* cacheIn(root, sha)
				let ledger: Ledger = new Map()
				for (const round of program) {
					const model = roundOf(ledger, round)
					c.noteAll(model.situations)
					const answers = yield* Effect.forEach(
						round,
						(operation) => performed(cache, root, sha, hashes, operation),
						{ concurrency: "unbounded" }
					)
					yield* agree(
						[
							[`the model, over ${describedOf(round)}`, model.answers],
							["the cache", answers]
						],
						exact
					)
					ledger = model.after
				}
			}),
	oracle: {
		kind: "second-implementation",
		name: "a map from each key's identity to what was last recorded under it"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/cache.ts",
			original: "edit: Option.getOrNull(key.edit)",
			replacement: "edit: null",
			why: "a key's edit left out of its record: a mutant's red read as the pass of the property's search, and one mutant's as another's"
		},
		{
			file: "packages/testing/src/runner/cache.ts",
			original: "yield* Effect.mapError(fs.remove(file, { force: true }), unusable(file))",
			replacement: "yield* Effect.void",
			why: "a failure that leaves the pass its key held: the failure is read as a pass"
		},
		{
			file: "packages/testing/src/runner/cache.ts",
			original: "if (stored !== record) {",
			replacement: "if (false) {",
			why: "a record whose text is not its key read as a pass"
		},
		{
			file: "packages/testing/src/runner/cache.ts",
			original: "seeds: key.seeds,",
			replacement: 'seeds: "",',
			why: "a key that ignores its seed policy: a pass under one policy answers another"
		},
		{
			file: "packages/testing/src/runner/cache.ts",
			original: "toolchain: key.toolchain,",
			replacement: 'toolchain: "",',
			why: "a key that ignores its toolchain: a pass of one toolchain answers another's run, a runner or budget changed since"
		},
		{
			file: "packages/testing/src/runner/cache.ts",
			original: "environment: key.environment,",
			replacement: 'environment: "",',
			why: "a key that ignores its workers' environment: a pass under one variable's value answers a run under another"
		},
		{
			file: "packages/testing/src/runner/cache.ts",
			original: "postgres: Option.getOrNull(key.postgres),",
			replacement: "postgres: null,",
			why: "a key that ignores its PostgreSQL: a pass on one server build answers a run on another"
		}
	]
})

/**
 * A repository's cache key is the first twelve hex digits of git's blob hash of its identity, so every clone of one
 * repository names its verdicts alike. Oracle: `git hash-object --stdin`, git's own blob hash.
 */
export const repositoryKeyIsGitsBlobHash = property.explore(identities, {
	needs: { digest: digests },
	situations: ["an empty identity", "an identity beyond ASCII", "an identity of several lines"],
	check:
		({ digest }, c) =>
		(identity) =>
			Effect.gen(function* () {
				c.noteAll(identitySituationsOf(identity))
				const sha = yield* digest
				const key = yield* repositoryKeyOf(identity).pipe(Effect.provideService(Digest.Digest, sha))
				const git = yield* gitBlobHashOf(identity)
				yield* agree(
					[
						["git hash-object", Str.slice(0, 12)(git)],
						["repositoryKeyOf", key]
					],
					exact
				)
			}),
	oracle: {
		kind: "second-implementation",
		name: "git hash-object --stdin, git's own blob hash of a text"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/cache.ts",
			original: "const bytes = content.length",
			replacement: "const bytes = identity.length",
			why: "a blob header that counts UTF-16 units, not bytes: a repository named beyond ASCII gets another key than git's blob hash"
		}
	]
})
