import { regex } from "arkregex"
import { Array as Arr, Config, Effect, FileSystem, Option, Order, String as Str } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { type ContentHash, contentHashOf } from "#runner/closure.ts"
import type { RunnerConfig } from "#runner/config.ts"
import { workerEnvironmentOf, workerEnvironmentText } from "#runner/environment.ts"
import { allowanceVariable, processors } from "#workers.ts"

/**
 * What every verdict key of a run holds beside its property's own (runner/cache.ts VerdictKey): the toolchain that
 * runs it, the environment its workers are given, and the PostgreSQL that serves its databases, for a property that
 * declares a database template. Each is read once a run, in the runner's own process, as a digest of what a property
 * can observe of it.
 */
export type KeyGrounds = Readonly<{
	toolchain: ContentHash
	environment: ContentHash
	postgres: Option.Option<ContentHash>
}>

/**
 * The directories of a package of the toolchain that hold no file of it: what its repository's .gitignore names (an
 * install, a build, the tools' caches and run output), which no process of a run loads as the toolchain.
 */
const UNSHIPPED = ["node_modules", "dist", ".turbo", ".fallow", ".vitest", "out"] as const

/**
 * What a digest takes of a file system entry, by its type as stat reads it (following a link to what it names): a
 * directory's files, a file's bytes, and nothing of a device, a socket or a FIFO, which hold no content to load.
 */
const ENTRY_ROLES: Readonly<Record<FileSystem.File.Type, "directory" | "file" | "none">> = {
	File: "file",
	Directory: "directory",
	SymbolicLink: "none",
	BlockDevice: "none",
	CharacterDevice: "none",
	FIFO: "none",
	Socket: "none",
	Unknown: "none"
}

/** Whitespace, which separates the words of a unit's lines. */
const WHITESPACE = regex("\\s+")

/** The digest of a list of named digests: a line `<name>\0<digest>` each, in the order given. */
const listDigestOf = (entries: ReadonlyArray<readonly [name: string, digest: string]>) =>
	contentHashOf(
		new TextEncoder().encode(
			Arr.join(
				Arr.map(entries, ([name, digest]) => `${name}\0${digest}\n`),
				""
			)
		)
	)

/**
 * Every file under `directory`, by its path from it, sorted, each directory UNSHIPPED names passed over: what a tree's
 * digest covers. A link is followed as Node follows it.
 */
const filesUnder = (
	directory: string
): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const walk = (
			relative: string
		): Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem> =>
			Effect.gen(function* () {
				const here = relative === "" ? directory : `${directory}/${relative}`
				const names = yield* Effect.orDie(fs.readDirectory(here))
				const nested = yield* Effect.forEach(Arr.sort(names, Order.String), (name) =>
					Effect.gen(function* () {
						const path = relative === "" ? name : `${relative}/${name}`
						const info = yield* Effect.orDie(fs.stat(`${directory}/${path}`))
						switch (ENTRY_ROLES[info.type]) {
							case "directory":
								return Arr.contains(UNSHIPPED, name) ? [] : yield* walk(path)
							case "file":
								return [path]
							case "none":
								return []
						}
					})
				)
				return Arr.flatten(nested)
			})
		return yield* walk("")
	})

/**
 * The digest of the tree at `directory`: each file's path and the SHA-256 of its bytes (filesUnder), so two trees
 * digest alike exactly when they hold the same files with the same bytes.
 */
const treeDigestOf = (directory: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const files = yield* filesUnder(directory)
		const entries = yield* Effect.forEach(files, (file) =>
			Effect.map(
				Effect.flatMap(Effect.orDie(fs.readFile(`${directory}/${file}`)), contentHashOf),
				(hash) => [file, hash] as const
			)
		)
		return yield* listDigestOf(entries)
	})

/**
 * The toolchain that runs a verdict: the digest of the runner's own package (this module's, two directories up), every
 * file of it as it stands, its runner, its search and its budgets (runner/limits.ts) among them, whatever loads them:
 * the toolchain's commit, read from its files, so a toolchain moved, or edited in the working tree, keys anew.
 */
const toolchainDigest = Effect.flatMap(
	Effect.flatMap(FileSystem.FileSystem, (fs) =>
		Effect.orDie(fs.realPath(`${import.meta.dirname}/../..`))
	),
	treeDigestOf
)

/**
 * The environment a run's workers are given, as the verdict key holds it: the digest of each variable the pool gives
 * them (runner/environment.ts, the runner config's among them) and the run's CPU allowance, which every worker is
 * given. The compile cache's directory, which the pool gives a worker too, is none of it: it names the package root's
 * cache, a function of the checkout's path, and Node's compile cache changes no module's meaning.
 */
const environmentDigestOf = (config: RunnerConfig) =>
	contentHashOf(
		new TextEncoder().encode(
			workerEnvironmentText({
				...workerEnvironmentOf(config.environment, process.env),
				[allowanceVariable]: `${processors}`
			})
		)
	)

/** A program's standard output when it exits 0, and its failure, said, otherwise. */
const outputOf = (command: string, args: ReadonlyArray<string>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			return yield* Effect.orDie(
				spawner.string(ChildProcess.make(command, args, { stderr: "ignore" }))
			)
		})
	)

/**
 * The PostgreSQL a run's clusters are served by, as a property that declares a database template can observe it: the
 * digest of the installation the workbench's units run (the directory above `pg_config --bindir`, its programs,
 * libraries and shared files, every byte), of the workbench's unit template (`systemctl --user cat postgres@.service`,
 * its drop-ins among it) and of each file or directory its lines name under the account's home (its cluster script and
 * configuration files, %h read as the home), so another build, version or cluster configuration keys anew.
 */
const postgresDigest = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const printed = yield* outputOf("pg_config", ["--bindir"])
	const bin = Str.trim(printed)
	const installation = yield* treeDigestOf(Arr.join(Arr.dropRight(Str.split("/")(bin), 1), "/"))
	const unit = yield* outputOf("systemctl", ["--user", "cat", "postgres@.service"])
	const home = yield* Effect.orDie(Config.String("HOME"))
	const named = Arr.dedupe(
		Arr.filter(
			Arr.flatMap(Str.split(WHITESPACE)(Str.replaceAll("%h", home)(unit)), (word) =>
				Str.split("=")(word)
			),
			(word) => Str.startsWith(`${home}/`)(word)
		)
	)
	const configured = yield* Effect.forEach(Arr.sort(named, Order.String), (path) =>
		Effect.gen(function* () {
			const info = yield* Effect.option(fs.stat(path))
			if (Option.isNone(info)) {
				return Option.none()
			}
			switch (ENTRY_ROLES[info.value.type]) {
				case "directory":
					return Option.some([path, yield* treeDigestOf(path)] as const)
				case "file":
					return Option.some([
						path,
						yield* Effect.flatMap(Effect.orDie(fs.readFile(path)), contentHashOf)
					] as const)
				case "none":
					return Option.none()
			}
		})
	)
	const unitHash = yield* contentHashOf(new TextEncoder().encode(unit))
	return yield* listDigestOf([
		["installation", installation],
		["postgres@.service", unitHash],
		...Arr.getSomes(configured)
	])
})

/**
 * The grounds of a run's verdict keys (KeyGrounds) under `config`: the toolchain's digest, its workers' environment's,
 * and, where `templated` (some property of the run declares a database template), the PostgreSQL's.
 */
export const keyGroundsOf = (config: RunnerConfig, templated: boolean) =>
	Effect.gen(function* () {
		const toolchain = yield* toolchainDigest
		const environment = yield* environmentDigestOf(config)
		const postgres = templated ? yield* Effect.asSome(postgresDigest) : Option.none()
		return { toolchain, environment, postgres } satisfies KeyGrounds
	})
