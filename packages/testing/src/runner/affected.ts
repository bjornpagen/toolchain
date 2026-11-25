import { layerDigest } from "@effect/platform-node/NodeCrypto"
import {
	Array as Arr,
	Console,
	Effect,
	FileSystem,
	Inspectable,
	Layer,
	Option,
	type Path,
	Result,
	Schema,
	Stream,
	String as Str
} from "effect"
import { Digest } from "effect/crypto"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { killApplied } from "#mutants.ts"
import type { Judged } from "#mutate/kills.ts"
import { type Kill, Property, type PropertyId } from "#property.ts"
import { templatesOf } from "#resources/collect.ts"
import { toolchainTestCache } from "#runner/cache-home.ts"
import {
	type Edit,
	editOf,
	loadCacheAt,
	recordOf,
	repositoryKeyOf,
	SeedPolicy,
	type VerdictCache,
	VerdictCacheUnusable,
	type VerdictKey,
	verdictCacheAt
} from "#runner/cache.ts"
import {
	type Closure,
	closuresOf,
	jointClosureOf,
	moduleSyntax,
	type RepoPath,
	repoPathOf,
	type Files,
	workingTree
} from "#runner/closure.ts"
import type { RunnerConfig } from "#runner/config.ts"
import { type KeyGrounds, keyGroundsOf } from "#runner/grounds.ts"
import type { Discovered } from "#runner/load.ts"
import type { LoadKeying } from "#runner/loads.ts"
import { observationText } from "#runner/observe.ts"
import type { Observed } from "#runner/pool.ts"
import { loadPackage, type RunOutcome, searchedPassed, WORKER_ENTRY } from "#runner/run.ts"

/**
 * The verdict cache's side of `toolchain-test run` (runKeyingAt) and of the commands that judge kills and mutants
 * (verdictsAt), and `toolchain-test verified <ref>`: every property of a package weighed, its key read. A property whose
 * key holds a pass is a known answer and never runs again while its key stands; every other runs, and its pass is kept
 * only when no worker that ran it observed past its key (runner/observe.ts); a failure removes the pass its key held.
 * No kill is judged here, as no run judges one: whether a property's kills still turn it red is the kill census's
 * (`toolchain-test kills`), whose verdicts are records of the same cache under edits (EDIT_SEEDS).
 *
 * A property's key (cache.ts VerdictKey) is its identity; the joint closure (closure.ts) of its module, the package's
 * test.config.ts, its pg.config.ts where it has one, and the runner's own entry modules (the CLI and the worker), each
 * hashed under the config's conditions and this Node's version; the run's grounds (grounds.ts: the toolchain's digest,
 * its workers' environment's, and the PostgreSQL's for a property that declares a database template); and its seeds, a
 * search's rotating stream seeded by the rest of its key unless TEST_SEED names a seed (Seeding). The runner that runs
 * must be the repository's own or installed in it (runnerRootsIn): another checkout's runner keys nothing. A verdict
 * under an edit joins the closure of the edited file (editKeyOf), and an edit that loads a module its file does not
 * keys nothing (cache.ts editOf). Verdicts live in `${XDG_CACHE_HOME:-~/.cache}/toolchain-test/<repository
 * key>/verdicts`, the repository's key (cache.ts), so every clone and workspace of a repository shares them.
 */

/**
 * The seed policy of a search's verdict: at full reach, its floor and steered phases seeded by the property's identity,
 * its rotating stream by `seed`, which a run derives from the rest of the key (derivedSeedOf) unless TEST_SEED names
 * one, so a search is a function of its key: a pass answers for exactly the cases a run at that key draws.
 */
const runSeedsOf = (seed: number): SeedPolicy =>
	SeedPolicy(
		`full reach: floor and steered phases seeded by the property's identity, the rotating stream by ${seed}`
	)

/** How a run seeds its searches' rotating streams: by TEST_SEED's seed, the same for every property, or each by its key. */
export type Seeding = Readonly<{ kind: "given"; seed: number }> | Readonly<{ kind: "derived" }>

/**
 * The seed a key's rest derives: the first 32 bits of the SHA-256 of its record with its seeds unnamed, so a property
 * whose closure, toolchain, environment or PostgreSQL moved draws a new rotating stream, and one whose key stands draws
 * the same.
 */
const derivedSeedOf = (unseeded: VerdictKey) =>
	Effect.gen(function* () {
		const digest = yield* Digest.Digest
		const record = yield* recordOf({ ...unseeded, seeds: SeedPolicy("derived") })
		const hex = yield* digest.digestHex(Digest.sha256, new TextEncoder().encode(record))
		return Number.parseInt(Str.slice(0, 8)(hex), 16)
	})

/**
 * The seed policy of a cached verdict under an edit: the property's witnesses (kept tokens, floor and steered phase,
 * fixed by its identity) with one file edited, as the kill census runs them under a kill and the mutator under an
 * operator mutant. Witnesses that went red under an edit are a known answer for as long as the property's closure and
 * the edit (its file's text, and the text it makes) stand, whichever of a kill or a mutant made it.
 */
const EDIT_SEEDS = SeedPolicy(
	"witnesses under an edit of one file: kept tokens, floor and steered phase, fixed by the property's identity"
)

/** A command of the verdict cache could not run: its usage, the repository or a ref it could not read. */
class AffectedRefused extends Schema.TaggedError<
	AffectedRefused,
	{ readonly brand: unique symbol }
>()("AffectedRefused", { message: Schema.String }) {}

/**
 * git run in `cwd`: its standard output when it exits 0, else how it failed, its exit status and what it said on its
 * standard error, which names the cause (a ref it cannot read, a directory that is no repository).
 */
export const gitOf = (cwd: string, args: ReadonlyArray<string>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			const handle = yield* spawner.spawn(ChildProcess.make("git", args, { cwd, stdin: "ignore" }))
			const [stdout, stderr, exitCode] = yield* Effect.all(
				[
					Stream.mkString(Stream.decodeText(handle.stdout)),
					Stream.mkString(Stream.decodeText(handle.stderr)),
					handle.exitCode
				],
				{ concurrency: "unbounded" }
			)
			return exitCode === 0
				? Result.succeed(stdout)
				: Result.fail(`git exited ${String(exitCode)}: ${Str.trim(stderr)}`)
		})
	)

/** The files the repository at `repository` holds, paths from its root: a submodule's files are another repository's. */
export const trackedIn = (repository: string) =>
	Effect.map(
		required(repository, ["ls-files", "-z"], `git ls-files failed in ${repository}`),
		(text): ReadonlySet<string> => new Set(Arr.filter(Str.split("\0")(text), Str.isNonEmpty))
	)

/** A git answer that must exist, or the refusal `why` states, with how git failed. */
const required = (cwd: string, args: ReadonlyArray<string>, why: string) =>
	Effect.flatMap(gitOf(cwd, args), (answer) =>
		Result.match(answer, {
			onFailure: (failed) => Effect.fail(AffectedRefused.make({ message: `${why}: ${failed}` })),
			onSuccess: (text) => Effect.succeed(Str.trim(text))
		})
	)

/** A path under the repository as a RepoPath, or the refusal that it lies outside. */
const underRepository = (repository: string, path: string) =>
	Effect.mapError(
		Effect.fromOption(
			Str.startsWith(`${repository}/`)(path)
				? repoPathOf(Str.slice(repository.length + 1)(path))
				: Option.none()
		),
		() =>
			AffectedRefused.make({
				message: `${path} lies outside the repository ${repository}, so its closure cannot be hashed`
			})
	)

/** The files that differ between `base` and the working tree, untracked ones among them, NUL-separated from git. */
const changedSince = (repository: string, base: string) =>
	Effect.map(
		Effect.all([
			required(repository, ["diff", "--name-only", "-z", base], `git diff against ${base} failed`),
			required(
				repository,
				["ls-files", "--others", "--exclude-standard", "-z"],
				"git ls-files failed"
			)
		]),
		([tracked, untracked]): ReadonlySet<string> =>
			new Set(
				Arr.filter([...Str.split("\0")(tracked), ...Str.split("\0")(untracked)], Str.isNonEmpty)
			)
	)

/** Whether a file, or a directory above it (a submodule's gitlink), is among the changed. */
export const isChanged = (changed: ReadonlySet<string>, file: string): boolean =>
	Arr.reduce(Str.split("/")(file), { prefix: "", found: false }, (state, segment) => {
		const prefix = state.prefix === "" ? segment : `${state.prefix}/${segment}`
		return { prefix, found: state.found || changed.has(prefix) }
	}).found

/**
 * A kill as the edit it makes of its file (cache.ts Edit): none when the file is not there or the kill's original does
 * not stand once in it, so a stale kill keys nothing and the kill census judges it, and refuses it, again; none too
 * when the kill's text loads a module its file does not (cache.ts editOf), so its verdict is judged on every run.
 */
const editOfKill = (tree: Files, kill: Kill) =>
	Effect.flatMap(Effect.transposeOption(Option.map(repoPathOf(kill.file), tree.read)), (read) =>
		Effect.map(
			Effect.transposeOption(
				Option.flatMap(Option.flatten(read), (bytes) => {
					const own = new TextDecoder().decode(bytes)
					return Option.map(Result.getSuccess(killApplied(kill, own)), (mutated) =>
						editOf(kill.file, own, mutated)
					)
				})
			),
			Option.flatten
		)
	)

/**
 * One property as the gate weighs it: what it is, its joint closure, the key of its search's verdict and the seed of
 * its rotating stream in it, whether it declares a database template (so its keys hold the PostgreSQL), and each kill
 * with its edit (none when the kill is stale), the key of the kill's verdict.
 */
type Weighed = Readonly<{
	found: Discovered
	closure: Closure
	key: VerdictKey
	seed: number
	templated: boolean
	killEdits: ReadonlyArray<readonly [Kill, Option.Option<Edit>]>
}>

/**
 * A property as a landing touches it: the files of its closure, whether its closure holds an installed package (whose
 * lockfile entry it reads), and whether its verdict key holds a pass.
 */
export type Touched = Readonly<{
	id: PropertyId
	files: ReadonlyArray<string>
	packages: boolean
	passed: boolean
}>

/**
 * Whether a landing whose changed files are `changed` touches a property: a file of its closure is among them (or
 * below a changed submodule's gitlink), or the lockfile is, where its closure holds a package.
 */
export const touchedBy = (changed: ReadonlySet<string>, one: Touched): boolean =>
	Arr.some(one.files, (file) => isChanged(changed, file)) ||
	(one.packages && changed.has("pnpm-lock.yaml"))

/**
 * The properties a landing touched that carry no green verdict at the closure it lands (`verified`'s refusals): each
 * one `touchedBy` the landing whose key holds no pass.
 */
export const unverifiedOf = (
	changed: ReadonlySet<string>,
	properties: ReadonlyArray<Touched>
): ReadonlyArray<PropertyId> =>
	Arr.flatMap(properties, (one) => (touchedBy(changed, one) && !one.passed ? [one.id] : []))

/** Where a package stands: its root, and the repository it lies in, none when it lies in no git repository. */
type Grounds = Readonly<{ packageRoot: string; repository: Option.Option<string> }>

/** The package at `root` and the git repository it lies in (real paths). */
const groundsOf = (root: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const packageRoot = yield* fs.realPath(root)
		const toplevel = yield* Effect.map(
			gitOf(packageRoot, ["rev-parse", "--show-toplevel"]),
			Result.getSuccess
		)
		const repository = yield* Effect.transposeOption(
			Option.map(Option.map(toplevel, Str.trim), (top) => fs.realPath(top))
		)
		return { packageRoot, repository } satisfies Grounds
	})

/**
 * A package weighed for the verdict cache: its repository and package root (real paths), the repository's verdict
 * cache, each property discovered with its joint closure and key, and the key of a property's witnesses under an edit
 * (editKeyOf), none when the weighing did not hash the edited file.
 */
type Weighing = Readonly<{
	repository: string
	packageRoot: string
	cache: VerdictCache
	notes: Notes
	weighed: ReadonlyArray<Weighed>
	keyUnder: (one: Weighed, edit: Edit) => Effect.Effect<Option.Option<VerdictKey>>
}>

/**
 * The runner's own entry modules (`entries`, real paths: the CLI, which reaches the search, its limits and the pool,
 * and the worker, which the pool forks by path) as roots of every verdict key of `repository`, by where the runner that
 * runs lies. A file of the repository (the toolchain's own packages, a workspace link such as grizzle's
 * vendor/toolchain): each a root. Installed in the repository's node_modules: no root, since the package's
 * test.config.ts imports it and its closure holds it as every external package is held, by its lockfile entry.
 * Anywhere else, another checkout's runner run in this one: refused, since no closure of this repository holds the
 * runner that judges, so no key of it answers for what that runner judged, and its verdicts key nothing.
 */
export const runnerRootsIn = (
	repository: string,
	entries: ReadonlyArray<string>
): Result.Result<ReadonlyArray<RepoPath>, AffectedRefused> => {
	const within = Arr.map(entries, (real) =>
		Str.startsWith(`${repository}/`)(real)
			? Option.some(Str.slice(repository.length + 1)(real))
			: Option.none()
	)
	const relative = Option.all(within)
	if (Option.isNone(relative)) {
		return Result.fail(
			AffectedRefused.make({
				message: `the runner at ${Arr.join(entries, ", ")} lies outside ${repository}: another checkout's runner keys no verdict of this repository`
			})
		)
	}
	if (
		Arr.some(
			relative.value,
			(path) => Str.startsWith("node_modules/")(path) || Str.includes("/node_modules/")(path)
		)
	) {
		return Result.succeed([])
	}
	return Result.fromOption(Option.all(Arr.map(relative.value, repoPathOf)), () =>
		AffectedRefused.make({
			message: `the runner at ${Arr.join(entries, ", ")} names no file of ${repository}`
		})
	)
}

/** The roots of every verdict key of `repository` that the runner running this process gives (runnerRootsIn). */
const runnerRootsOf = (repository: string) =>
	Effect.flatMap(
		Effect.forEach([`${import.meta.dirname}/cli-entry.ts`, WORKER_ENTRY], (file) =>
			Effect.flatMap(FileSystem.FileSystem, (fs) => fs.realPath(file))
		),
		(entries) => Effect.fromResult(runnerRootsIn(repository, entries))
	)

/** The repository's identity: its origin remote's URL, else its common git directory. */
const identityOf = (repository: string) =>
	Effect.flatMap(gitOf(repository, ["config", "--get", "remote.origin.url"]), (url) =>
		Option.match(Option.filter(Option.map(Result.getSuccess(url), Str.trim), Str.isNonEmpty), {
			onSome: Effect.succeed,
			onNone: () =>
				required(
					repository,
					["rev-parse", "--path-format=absolute", "--git-common-dir"],
					"the repository has no git directory"
				)
		})
	)

/**
 * What a package's verdict keys are hashed from: its tree, the runner config's conditions, the runtime, the runner's
 * roots (its own entry modules, runnerRootsIn, and the package's test.config.ts), its test modules, and the files an
 * edit a verdict is judged under may touch (a kill's file, an operator mutant's).
 */
export type ClosuresInput = Readonly<{
	tree: Files
	conditions: ReadonlyArray<string>
	runtime: string
	runner: ReadonlyArray<RepoPath>
	modules: ReadonlyArray<RepoPath>
	edited: ReadonlyArray<RepoPath>
}>

/**
 * The closures a package's verdicts are keyed by: each test module's joint closure with the runner's roots, a search's
 * (searchKeyOf), and each edited file's own, which the key of a verdict under an edit of it joins (editKeyOf); none for
 * a path the input did not name.
 */
type Closures = Readonly<{
	jointOf: (module: RepoPath) => Option.Option<Closure>
	editedOf: (file: RepoPath) => Option.Option<Closure>
}>

/** A package's closures (Closures), walked once for every root, under the input's conditions and runtime. */
export const closuresWeighedOf = Effect.fn("closuresWeighedOf")(function* (input: ClosuresInput) {
	const closures = yield* closuresOf({
		tree: input.tree,
		conditions: input.conditions,
		runtime: input.runtime,
		roots: [...input.runner, ...input.modules, ...input.edited]
	})
	const closureOf = (path: RepoPath) => Option.fromUndefinedOr(closures.get(path))
	const shared = Arr.getSomes(Arr.map(input.runner, closureOf))
	const owned = Arr.getSomes(
		Arr.map(input.modules, (module) =>
			Option.map(closureOf(module), (own) => [module, own] as const)
		)
	)
	const joined = yield* Effect.forEach(owned, ([module, own]) =>
		Effect.map(jointClosureOf([own, ...shared]), (joint) => [module, joint] as const)
	)
	const joints = new Map(joined)
	return {
		jointOf: (module) => Option.fromUndefinedOr(joints.get(module)),
		editedOf: closureOf
	} satisfies Closures
})

/**
 * A package's test modules as every cached answer of the repository weighs them: the working tree, the closure
 * hasher, the repository's cache directory (`<toolchain-test cache>/<repository key>`), each module's joint closure
 * with the package's test.config.ts, its pg.config.ts where it has one (which the runner loads by path, so no import
 * names it: pg/config-file.ts specAt) and the runner's own entry modules (runnerRootsOf), and the closure of each file of
 * `edited` (paths from the repository root) the tree holds, hashed under the config's conditions and this Node's
 * version (closuresWeighedOf), so an edit to anything a module, the config, the runner or an edited file loads makes
 * its closure new.
 */
const modulesWeighedOf = (
	packageRoot: string,
	repository: string,
	config: RunnerConfig,
	modules: ReadonlyArray<string>,
	edited: ReadonlyArray<string>
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const identity = yield* identityOf(repository)
		const cache = yield* toolchainTestCache
		const hashing = yield* Layer.build(Layer.merge(moduleSyntax, layerDigest))
		const tree = yield* workingTree(repository)
		const packageFile = (path: string) => underRepository(repository, `${packageRoot}/${path}`)
		const runnerRoots = yield* runnerRootsOf(repository)
		const configRoot = yield* Effect.flatMap(fs.realPath(`${packageRoot}/test.config.ts`), (real) =>
			underRepository(repository, real)
		)
		const clusterFile = `${packageRoot}/pg.config.ts`
		const clustered = yield* fs.exists(clusterFile)
		const clusterRoot = clustered
			? yield* Effect.asSome(
					Effect.flatMap(fs.realPath(clusterFile), (real) => underRepository(repository, real))
				)
			: Option.none()
		const pathEntries = yield* Effect.forEach(Arr.dedupe(modules), (module) =>
			Effect.map(packageFile(module), (path) => [module, path] as const)
		)
		const paths = new Map(pathEntries)
		const held = yield* Effect.forEach(
			Arr.getSomes(Arr.map(Arr.dedupe(edited), repoPathOf)),
			(path) => Effect.map(tree.read(path), (bytes) => Option.as(bytes, path))
		)
		const closures = yield* closuresWeighedOf({
			tree,
			conditions: config.conditions,
			runtime: process.version,
			runner: [...runnerRoots, configRoot, ...Option.toArray(clusterRoot)],
			modules: [...paths.values()],
			edited: Arr.getSomes(held)
		}).pipe(Effect.provide(hashing))
		const repositoryKey = yield* repositoryKeyOf(identity).pipe(Effect.provide(hashing))
		return {
			tree,
			hashing,
			home: `${cache}/${repositoryKey}`,
			editedOf: (file: string) => Option.flatMap(repoPathOf(file), closures.editedOf),
			jointOf: (module: string) =>
				Effect.mapError(
					Effect.fromOption(
						Option.flatMap(Option.fromUndefinedOr(paths.get(module)), closures.jointOf)
					),
					() => AffectedRefused.make({ message: `${module} was not hashed` })
				)
		}
	})

/**
 * The key of a property's search of the program as it stands: its identity and joint closure, the run's grounds (its
 * toolchain, its workers' environment, and its PostgreSQL where the property declares a database template, `templated`),
 * and its seeds, TEST_SEED's or derived from the rest of the key (Seeding).
 */
export const searchKeyOf = (
	property: PropertyId,
	searched: Closure,
	grounds: KeyGrounds,
	templated: boolean,
	seeding: Seeding
) =>
	Effect.gen(function* () {
		const unseeded: VerdictKey = {
			property,
			closure: searched.hash,
			toolchain: grounds.toolchain,
			environment: grounds.environment,
			postgres: templated ? grounds.postgres : Option.none(),
			seeds: SeedPolicy(""),
			edit: Option.none()
		}
		const seed = seeding.kind === "given" ? seeding.seed : yield* derivedSeedOf(unseeded)
		return { key: { ...unseeded, seeds: runSeedsOf(seed) } satisfies VerdictKey, seed }
	})

/**
 * The key of a property's witnesses run under an edit: its identity, its joint closure (`searched`, a search's) joined
 * with the closure of the edited file as the tree holds it (`edited`), the seeds of witnesses under an edit, and the
 * edit. So the key holds every module the edited program loads (those the property loads, and those the edited file
 * loads, to which an edit adds none, cache.ts editOf) whether or not the property's own closure holds the file: a check
 * that runs it in a child process, or reads it at run time, keyed by the file's bytes alone, kept a red the file's
 * imports had since taken away (grizzle's type properties and its CLI's, 58 of its 1,017 kills' files on 2026-11-23).
 */
export const editKeyOf = (
	property: PropertyId,
	searched: Closure,
	edited: Closure,
	edit: Edit,
	grounds: KeyGrounds,
	templated: boolean
) =>
	Effect.map(jointClosureOf([searched, edited]), (joint): VerdictKey => ({
		property,
		closure: joint.hash,
		toolchain: grounds.toolchain,
		environment: grounds.environment,
		postgres: templated ? grounds.postgres : Option.none(),
		seeds: EDIT_SEEDS,
		edit: Option.some(edit)
	}))

/**
 * Weighs the properties `discovered` of a package of a repository: their closures, keys and the repository's cache,
 * and the closures of the files of `edited` (paths from the repository root) that edits judged under it may touch.
 */
const weighingOf = (
	packageRoot: string,
	repository: string,
	config: RunnerConfig,
	discovered: ReadonlyArray<Discovered>,
	edited: ReadonlyArray<string>,
	seeding: Seeding
) =>
	Effect.gen(function* () {
		const weighed = yield* modulesWeighedOf(
			packageRoot,
			repository,
			config,
			Arr.map(discovered, (found) => found.module),
			edited
		)
		const templatedOf = (found: Discovered) =>
			Arr.isReadonlyArrayNonEmpty(templatesOf(found.property.needs))
		const grounds = yield* keyGroundsOf(config, Arr.some(discovered, templatedOf)).pipe(
			Effect.provide(weighed.hashing)
		)
		const properties = yield* Effect.forEach(discovered, (found) =>
			Effect.gen(function* () {
				const closure = yield* weighed.jointOf(found.module)
				const templated = templatedOf(found)
				const edits = yield* Effect.forEach(found.property.kills, (kill) =>
					editOfKill(weighed.tree, kill)
				).pipe(Effect.provide(weighed.hashing))
				const killEdits = Arr.zip(found.property.kills, edits)
				const { key, seed } = yield* searchKeyOf(
					found.id,
					closure,
					grounds,
					templated,
					seeding
				).pipe(Effect.provide(weighed.hashing))
				return { found, closure, key, seed, templated, killEdits } satisfies Weighed
			})
		)
		const verdicts = yield* verdictCacheAt(`${weighed.home}/verdicts`).pipe(
			Effect.provide(weighed.hashing)
		)
		const notes = yield* notesAt(`${weighed.home}/observing`).pipe(Effect.provide(weighed.hashing))
		return {
			repository,
			packageRoot,
			cache: verdicts,
			notes,
			weighed: properties,
			keyUnder: (one, edit) =>
				Effect.transposeOption(
					Option.map(weighed.editedOf(edit.file), (file) =>
						editKeyOf(one.found.id, one.closure, file, edit, grounds, one.templated)
					)
				).pipe(Effect.provide(weighed.hashing))
		} satisfies Weighing
	})

/**
 * How `toolchain-test load` keys the test modules `modules` of the package at `root` (runner/loads.ts): each module's
 * load key, its joint closure (modulesWeighedOf), in the repository's load cache (`<repository key>/loads`); or, where
 * no key can be made (no git repository, a closure that will not hash: a lockfile missing, a package undeclared), why,
 * every module then loaded and none recorded.
 */
export const loadKeyingAt = (
	root: string,
	config: RunnerConfig,
	modules: ReadonlyArray<string>
): Effect.Effect<
	LoadKeying,
	never,
	FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.scoped(
		Effect.gen(function* () {
			const grounds = yield* groundsOf(root)
			const repository = yield* Effect.mapError(Effect.fromOption(grounds.repository), () =>
				AffectedRefused.make({ message: `${root} lies in no git repository` })
			)
			const weighed = yield* modulesWeighedOf(grounds.packageRoot, repository, config, modules, [])
			const keys = yield* Effect.forEach(modules, (module) =>
				Effect.map(weighed.jointOf(module), (closure) => ({
					module,
					key: { module, closure: closure.hash }
				}))
			)
			const cache = yield* loadCacheAt(`${weighed.home}/loads`).pipe(
				Effect.provide(weighed.hashing)
			)
			return { kind: "keyed", cache, keys } satisfies LoadKeying
		})
	).pipe(
		Effect.catch((unkeyed) =>
			Effect.succeed({
				kind: "unkeyed",
				why: Inspectable.toStringUnknown(unkeyed, 0)
			} satisfies LoadKeying)
		)
	)

/** A kill whose verdict the cache already holds: it turned its property red under the same closure and edit. */
type CachedKill = Readonly<{ property: PropertyId; kill: Kill }>

/**
 * A package's verdicts under edits (cache.ts Edit), a kill's or an operator mutant's alike: `red` answers whether the
 * cache holds the red of a property's witnesses under an edit, at the property's closure, and `record` keeps a judged
 * one, a red as a pass of its key and anything else as a failure. With no weighing (no git repository, no lockfile, a
 * closure that would not hash) nothing is answered and nothing recorded.
 */
export type EditVerdicts = Readonly<{
	red: (id: PropertyId, edit: Edit) => Effect.Effect<boolean, VerdictCacheUnusable>
	record: (id: PropertyId, edit: Edit, red: boolean) => Effect.Effect<void, VerdictCacheUnusable>
}>

/**
 * A package's kill verdicts: `split` sets apart the kills of `subjects` the cache answers (each property's remaining
 * kills are the ones to judge), and `record` keeps each judged kill's verdict under its edit's key, a kill that turned
 * its property red as a pass and any other as a failure.
 */
export type KillVerdicts = Readonly<{
	split: <S extends Readonly<{ id: PropertyId; property: Property }>>(
		subjects: ReadonlyArray<S>
	) => Effect.Effect<
		Readonly<{ fresh: ReadonlyArray<S>; cached: ReadonlyArray<CachedKill> }>,
		VerdictCacheUnusable
	>
	record: (judged: ReadonlyArray<Judged>) => Effect.Effect<void, VerdictCacheUnusable>
}>

/** A property whose kills are `kills`: the same search, needs and evaluation, judged against those kills alone. */
export const withKills = (property: Property, kills: ReadonlyArray<Kill>): Property =>
	new Property({
		kind: property.kind,
		needs: property.needs,
		guide: property.guide,
		oracle: property.oracle,
		kept: property.kept,
		kills,
		search: property.search,
		replay: property.replay,
		translate: property.translate,
		keep: property.keep,
		ready: property.ready
	})

/** The verdicts under edits of a weighing, or none to keep. */
const editVerdictsOf = (weighing: Option.Option<Weighing>): EditVerdicts => {
	const keyOf = (id: PropertyId, edit: Edit) =>
		Option.match(weighing, {
			onNone: () => Effect.succeedNone,
			onSome: (weighed) =>
				Effect.map(
					Effect.transposeOption(
						Option.map(
							Arr.findFirst(weighed.weighed, (one) => one.found.id === id),
							(one) => weighed.keyUnder(one, edit)
						)
					),
					Option.flatten
				)
		})
	const cache = Option.map(weighing, (weighed) => weighed.cache)
	return {
		red: (id, edit) =>
			Effect.gen(function* () {
				const key = yield* keyOf(id, edit)
				if (Option.isNone(key) || Option.isNone(cache)) {
					return false
				}
				return yield* cache.value
					.passed(key.value)
					.pipe(Effect.catchTag("VerdictCorrupt", () => Effect.succeed(false)))
			}),
		record: (id, edit, red) =>
			Effect.gen(function* () {
				const key = yield* keyOf(id, edit)
				if (Option.isSome(key) && Option.isSome(cache)) {
					yield* cache.value.record(key.value, red ? "passed" : "failed")
				}
			})
	}
}

/** The kill verdicts of a weighing, each kill answered and recorded under its edit's key, or none to keep. */
const killVerdictsOf = (weighing: Option.Option<Weighing>): KillVerdicts => {
	const edits = editVerdictsOf(weighing)
	const killEdit = (id: PropertyId, kill: Kill): Option.Option<Edit> =>
		Option.flatMap(weighing, (weighed) =>
			Option.flatMap(
				Arr.findFirst(weighed.weighed, (one) => one.found.id === id),
				(one) =>
					Option.flatten(
						Option.map(
							Arr.findFirst(one.killEdits, ([own]) => own === kill),
							([, edit]) => edit
						)
					)
			)
		)
	return {
		split: <S extends Readonly<{ id: PropertyId; property: Property }>>(
			subjects: ReadonlyArray<S>
		) =>
			Effect.gen(function* () {
				const fresh: Array<S> = []
				const cached: Array<CachedKill> = []
				for (const found of subjects) {
					const remaining: Array<Kill> = []
					for (const kill of found.property.kills) {
						const edit = killEdit(found.id, kill)
						const answered = Option.isSome(edit) && (yield* edits.red(found.id, edit.value))
						if (answered) {
							cached.push({ property: found.id, kill })
						} else {
							remaining.push(kill)
						}
					}
					if (Arr.isReadonlyArrayNonEmpty(remaining)) {
						fresh.push({ ...found, property: withKills(found.property, remaining) })
					}
				}
				return { fresh, cached }
			}),
		record: (judged) =>
			Effect.forEach(
				judged,
				(one) =>
					Option.match(killEdit(one.property, one.kill), {
						onNone: () => Effect.void,
						onSome: (edit) => edits.record(one.property, edit, one.verdict.kind === "killed")
					}),
				{ discard: true }
			)
	}
}

/** The verdicts of a package with no verdict key: nothing answered, nothing kept. */
export const noVerdicts: Readonly<{ kills: KillVerdicts; edits: EditVerdicts }> = {
	kills: killVerdictsOf(Option.none()),
	edits: editVerdictsOf(Option.none())
}

/**
 * The verdicts under edits of the package at `root`, for the properties `discovered` of it under `config`, for a
 * command that judges kills or mutants itself (`toolchain-test kills`, `mutate` and `census`): its kills' and its
 * edits', none kept when the package has no verdict key. Each kill's file and each of `mutated` (the files the
 * command's operator mutants edit, paths from the repository root) is weighed for the keys of edits of it.
 */
export const verdictsAt = (
	root: string,
	config: RunnerConfig,
	discovered: ReadonlyArray<Discovered>,
	mutated: ReadonlyArray<string>
) =>
	Effect.gen(function* () {
		const grounds = yield* groundsOf(root)
		const edited = [
			...Arr.flatMap(discovered, (found) => Arr.map(found.property.kills, (kill) => kill.file)),
			...mutated
		]
		const weighing = yield* Option.match(grounds.repository, {
			onNone: () => Effect.succeedNone,
			onSome: (repository) =>
				Effect.option(
					weighingOf(grounds.packageRoot, repository, config, discovered, edited, {
						kind: "derived"
					})
				)
		})
		return { kills: killVerdictsOf(weighing), edits: editVerdictsOf(weighing) }
	})

/** A weighed property as a landing touches it, its key holding a pass or not. */
const touchedOf = (one: Weighed, passed: boolean): Touched => ({
	id: one.found.id,
	files: one.closure.files,
	packages: Arr.isReadonlyArrayNonEmpty(one.closure.packages),
	passed
})

/**
 * What a repository's runs know each property does past its key (runner/observe.ts), so a run gives one known to
 * observe workers of its own (runner/run.ts Workers) and the workers every other runs on stay clean: `observes` answers
 * whether its last run observed in a window of its own, and `kept` keeps what its run's pools saw it do (runner/pool.ts
 * Observed's own): a note where it observed, none where it did not. A note is a file `<directory>/<SHA-256 of the
 * property id>`, holding the observation's text, which no verdict reads: it only places a property's cases, and
 * deleting it at any time costs one run of the property on a clean worker. A property that observes only through a
 * value another left in a module may lose its note and find it again, run after run: it is never cached either way.
 */
type Notes = Readonly<{
	observes: (id: PropertyId) => Effect.Effect<boolean, VerdictCacheUnusable>
	kept: (
		id: PropertyId,
		seen: ReadonlyArray<Observed["own"]>
	) => Effect.Effect<void, VerdictCacheUnusable>
}>

/** The notes under `directory`, which it creates as it writes (Notes). */
const notesAt = (directory: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const digest = yield* Digest.Digest
		const fileOf = (id: PropertyId) =>
			Effect.map(
				digest.digestHex(Digest.sha256, new TextEncoder().encode(id)),
				(hash) => `${directory}/${hash}`
			)
		const unusable = (path: string) => (cause: unknown) =>
			VerdictCacheUnusable.make({ path, cause })
		return {
			observes: (id) =>
				Effect.flatMap(fileOf(id), (file) => Effect.mapError(fs.exists(file), unusable(file))),
			kept: (id, seen) =>
				Effect.gen(function* () {
					const file = yield* fileOf(id)
					const observed = Arr.findFirst(seen, Option.isSome)
					if (Option.isSome(observed) && Option.isSome(observed.value)) {
						const text = observationText(observed.value.value)
						yield* Effect.mapError(
							fs.makeDirectory(directory, { recursive: true }),
							unusable(directory)
						)
						yield* Effect.scoped(
							Effect.gen(function* () {
								const temporary = yield* Effect.mapError(
									fs.makeTempFileScoped({ directory, prefix: ".note-" }),
									unusable(directory)
								)
								yield* Effect.mapError(
									fs.writeFileString(temporary, `${text}\n`),
									unusable(temporary)
								)
								yield* Effect.mapError(fs.rename(temporary, file), unusable(file))
							})
						)
						return
					}
					if (Arr.isReadonlyArrayNonEmpty(seen)) {
						yield* Effect.mapError(fs.remove(file, { force: true }), unusable(file))
					}
				})
		} satisfies Notes
	})

/**
 * Whether a property's run answers for its key: every search of it passed, and no worker that ran it had observed past
 * its key by then (runner/observe.ts), so its verdict depends on nothing the key does not hold.
 */
const answersForItsKey = (outcome: RunOutcome, id: PropertyId): boolean =>
	searchedPassed(outcome, id) &&
	Arr.every(
		Arr.filter(outcome.properties, (ran) => ran.id === id),
		(ran) => Option.isNone(ran.observed.unclean)
	)

/**
 * Records each weighed property's verdict under its key: a pass when its run answers for its key (answersForItsKey), a
 * failure otherwise, which removes the pass its key held; and keeps what it does (Notes): known to observe when a run of
 * it observed, known not to when none did on a worker that had observed nothing before, as it stood otherwise.
 */
const recorded = (
	cache: VerdictCache,
	notes: Notes,
	due: ReadonlyArray<Weighed>,
	outcome: RunOutcome
) =>
	Effect.forEach(
		due,
		(one) =>
			Effect.andThen(
				cache.record(one.key, answersForItsKey(outcome, one.found.id) ? "passed" : "failed"),
				notes.kept(
					one.found.id,
					Arr.map(
						Arr.filter(outcome.properties, (ran) => ran.id === one.found.id),
						(ran) => ran.observed.own
					)
				)
			),
		{ discard: true }
	)

/** A property `run` answers from the cache: its identity and its key, which holds a pass. */
export type Cached = Readonly<{ id: PropertyId; key: VerdictKey }>

/**
 * How `toolchain-test run` reads and keeps the verdict cache (runner/cli.ts run). Keyed: each property loaded whose key
 * holds a pass is `cached`, answered without running; every other runs on its key's seed (`seedOf`), and `record` keeps
 * each verdict it ran under its key, and what each property is known to do (`observes`, Notes), so a run gives a
 * property known to observe past its key workers of its own kind. Unkeyed (a package in no git repository, a closure that will not hash, the
 * hasher's TypeScript not installed): every property runs, nothing is read or kept, and `why` says why.
 */
export type RunKeying =
	| Readonly<{
			kind: "keyed"
			cached: ReadonlyArray<Cached>
			seedOf: (id: PropertyId) => number
			observes: (id: PropertyId) => boolean
			record: (outcome: RunOutcome) => Effect.Effect<void, VerdictCacheUnusable>
	  }>
	| Readonly<{ kind: "unkeyed"; why: string }>

/**
 * The run keying of the properties `selected` names in the package at `root` (RunKeying), its seeds `seeding`'s: each
 * property weighed (its joint closure, the run's grounds and its seed), its key read; a record the cache refuses as
 * corrupt is said and its property runs.
 */
export const runKeyingAt = (root: string, selected: ReadonlyArray<string>, seeding: Seeding) =>
	Effect.gen(function* () {
		const grounds = yield* groundsOf(root)
		const { config, discovered } = yield* loadPackage(root, selected)
		const weighing = yield* Effect.result(
			Effect.flatMap(
				Effect.mapError(Effect.fromOption(grounds.repository), () =>
					AffectedRefused.make({ message: `${root} lies in no git repository` })
				),
				(repository) => weighingOf(grounds.packageRoot, repository, config, discovered, [], seeding)
			)
		)
		if (Result.isFailure(weighing)) {
			return {
				kind: "unkeyed",
				why: Inspectable.toStringUnknown(weighing.failure, 0)
			} satisfies RunKeying
		}
		const weighed = weighing.success
		const answered = yield* Effect.forEach(weighed.weighed, (one) =>
			weighed.cache.passed(one.key).pipe(
				Effect.map((passed) => ({ one, passed })),
				Effect.catchTag("VerdictCorrupt", (corrupt) =>
					Effect.as(
						Console.error(`${corrupt.path} is no record of its key; ${one.found.id} runs`),
						{ one, passed: false }
					)
				)
			)
		)
		const due = Arr.filterMap(answered, ({ one, passed }) =>
			passed ? Result.failVoid : Result.succeed(one)
		)
		const seeds = new Map(Arr.map(weighed.weighed, (one) => [one.found.id, one.seed] as const))
		const observing = yield* Effect.filter(
			Arr.map(due, (one) => one.found.id),
			(id) => weighed.notes.observes(id)
		)
		const known = new Set(observing)
		return {
			kind: "keyed",
			cached: Arr.filterMap(answered, ({ one, passed }) =>
				passed ? Result.succeed({ id: one.found.id, key: one.key }) : Result.failVoid
			),
			seedOf: (id) =>
				Option.getOrThrowWith(
					Option.fromUndefinedOr(seeds.get(id)),
					() => new Error(`${id} runs with no key weighed for it`)
				),
			observes: (id) => known.has(id),
			record: (outcome) => recorded(weighed.cache, weighed.notes, due, outcome)
		} satisfies RunKeying
	})

/**
 * `verified <ref>` in the package at `root`, the push gate of a repository whose gate runs no property itself (grizzle's,
 * whose database properties run only in the machine's one database job): every property the landing touched since
 * `<ref>` (touchedBy: a file of its closure, or the lockfile its closure reads) must carry a
 * green verdict at the closure it lands, a pass its verdict key holds, which `toolchain-test run` records
 * wherever the repository's clones run it (the cache is the repository's, cache.ts). It runs nothing: 1, naming each, when
 * a touched property carries none, so a landing never carries a property that did not run at its closure, as
 * grizzle's write/instants did from c79ffa503 on, its clock query a syntax error no run had read.
 */
export const verified = (root: string, args: ReadonlyArray<string>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const [ref, ...extra] = args
			if (ref === undefined || Arr.isReadonlyArrayNonEmpty(extra)) {
				return yield* AffectedRefused.make({
					message:
						"verified takes one ref, what the landing is weighed against: toolchain-test verified <ref>"
				})
			}
			const grounds = yield* groundsOf(root)
			const repository = yield* Effect.mapError(Effect.fromOption(grounds.repository), () =>
				AffectedRefused.make({ message: `${root} lies in no git repository` })
			)
			const { config, discovered } = yield* loadPackage(grounds.packageRoot, [])
			const weighing = yield* weighingOf(grounds.packageRoot, repository, config, discovered, [], {
				kind: "derived"
			})
			const base = yield* required(
				weighing.repository,
				["rev-parse", "--verify", "--quiet", `${ref}^{tree}`],
				`${ref} names no commit or tree`
			)
			const changed = yield* changedSince(weighing.repository, base)
			const properties = yield* Effect.forEach(weighing.weighed, (one) =>
				Effect.map(
					weighing.cache
						.passed(one.key)
						.pipe(Effect.catchTag("VerdictCorrupt", () => Effect.succeed(false))),
					(passed) => touchedOf(one, passed)
				)
			)
			const touched = Arr.filter(properties, (one) => touchedBy(changed, one))
			const unverified = unverifiedOf(changed, properties)
			yield* Console.log(
				Arr.join(
					[
						...Arr.map(
							unverified,
							(id) =>
								`${id}: UNVERIFIED: the landing touches it and no green verdict stands at its closure`
						),
						`${String(touched.length)} of ${String(properties.length)} properties touched since ${ref}: ${String(touched.length - unverified.length)} carry a green verdict at the closure they land, ${String(unverified.length)} do not${Arr.isReadonlyArrayNonEmpty(unverified) ? `; run them first: toolchain-test run, a database property in the machine's database job` : ""}`
					],
					"\n"
				)
			)
			return Arr.isReadonlyArrayNonEmpty(unverified) ? 1 : 0
		})
	)

/**
 * The repository files each of `modules` (paths from the package root at `root`) imports, itself and every module it
 * reaches by any import, under no export condition but Node's: what a foreign test command's module runs of the
 * repository's code, which another runner transforms as it loads, so no coverage offset of it is the file's own.
 */
export const importClosuresAt = (root: string, modules: ReadonlyArray<string>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const grounds = yield* groundsOf(root)
			const repository = yield* Effect.mapError(Effect.fromOption(grounds.repository), () =>
				AffectedRefused.make({ message: `${root} lies in no git repository` })
			)
			const hashing = yield* Layer.build(Layer.merge(moduleSyntax, layerDigest))
			const tree = yield* workingTree(repository)
			const paths = yield* Effect.forEach(modules, (module) =>
				Effect.map(
					underRepository(repository, `${grounds.packageRoot}/${module}`),
					(path) => [module, path] as const
				)
			)
			const closures = yield* closuresOf({
				tree,
				conditions: [],
				runtime: process.version,
				roots: Arr.map(paths, ([, path]) => path)
			}).pipe(Effect.provide(hashing))
			return new Map(
				Arr.map(paths, ([module, path]): readonly [string, ReadonlyArray<string>] => [
					module,
					Option.match(Option.fromUndefinedOr(closures.get(path)), {
						onNone: () => [],
						onSome: (closure) => closure.files
					})
				])
			)
		})
	)
