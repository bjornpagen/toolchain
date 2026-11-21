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
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { killApplied } from "#mutants.ts"
import { loadingOf } from "#mutate/checkout.ts"
import { imagesOf } from "#mutate/image.ts"
import { type Judged, killsOf, redText } from "#mutate/kills.ts"
import { mutatorPool } from "#mutate/lease.ts"
import { realPathOf } from "#mutate/mutated.ts"
import { treesOf } from "#mutate/tree.ts"
import { type Kill, Property, type PropertyId } from "#property.ts"
import { toolchainTestCache } from "#runner/cache-home.ts"
import {
	type Edit,
	editOf,
	loadCacheAt,
	repositoryKeyOf,
	SeedPolicy,
	type VerdictCache,
	type VerdictCacheUnusable,
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
import { runnerLimits } from "#runner/limits.ts"
import type { Discovered } from "#runner/load.ts"
import type { LoadKeying } from "#runner/loads.ts"
import { failureLines, lineOf } from "#runner/report.ts"
import {
	loadPackage,
	type RunOutcome,
	runPackage,
	runSeedLogged,
	type Settled,
	searchedPassed,
	unjudgeable,
	WORKER_ENTRY
} from "#runner/run.ts"

/**
 * `toolchain-test affected <ref>`, the push gate's run: every property of the package whose verdict key holds no
 * cached pass, at full width, and the kills of each that passes; a property passes the gate when its search passes
 * and every kill of it turns its witnesses red, and only then is its pass cached. A cached pass is a known answer and
 * never runs again; a failure removes the pass its key held.
 *
 * A property's key is its identity, the joint closure (closure.ts) of its module, the package's test.config.ts and
 * the runner's own entry modules (the CLI and the worker), each hashed under the config's conditions and this Node's
 * version, the seed policy of a gate run (RUN_SEEDS), and each kill as the edit it makes of its file (cache.ts Edit). So
 * an edit to a module a property loads, to the runner, to the config, to a lockfile entry a closure holds or to a
 * killed file makes its key new, and the property runs; nothing else does. What a property reads at run time without
 * importing it (a fixture file, a child process's code) is outside its closure: a full run per production version
 * covers it.
 *
 * `<ref>` (any tree-ish: the commit the remote held, or the empty tree for a new branch) names what the report counts
 * against: a property run is "changed since <ref>" when a file of its closure or a file one of its kills mutates
 * differs from `<ref>`, else "not verified at this content" (its key never passed here). Verdicts live in
 * `${XDG_CACHE_HOME:-~/.cache}/toolchain-test/<repository key>/verdicts`, the repository's key (cache.ts), so every
 * clone and workspace of a repository shares them.
 */

/**
 * The seed policy of every verdict the gate caches: a search at full reach, its floor and steered phases seeded by the
 * property's identity, its rotating stream by the run's seed. A pass under it answers for one run's sample.
 */
const RUN_SEEDS = SeedPolicy(
	"full reach: floor and steered phases seeded by the property's identity, the rotating stream by the run's seed"
)

/**
 * The seed policy of a cached verdict under an edit: the property's witnesses (kept tokens, floor and steered phase,
 * fixed by its identity) with one file edited, as the kill gate runs them under a kill and the mutator under an
 * operator mutant. Witnesses that went red under an edit are a known answer for as long as the property's closure and
 * the edit (its file's text, and the text it makes) stand, whichever of a kill or a mutant made it.
 */
const EDIT_SEEDS = SeedPolicy(
	"witnesses under an edit of one file: kept tokens, floor and steered phase, fixed by the property's identity"
)

/** The affected command could not run: its usage, the repository or a ref it could not read. */
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
 * not stand once in it, so a stale kill keys nothing and its property is judged, and refused, again.
 */
const editOfKill = (tree: Files, kill: Kill) =>
	Effect.flatMap(Effect.transposeOption(Option.map(repoPathOf(kill.file), tree.read)), (read) =>
		Effect.transposeOption(
			Option.flatMap(Option.flatten(read), (bytes) => {
				const own = new TextDecoder().decode(bytes)
				return Option.map(Result.getSuccess(killApplied(kill, own)), (mutated) =>
					editOf(kill.file, own, mutated)
				)
			})
		)
	)

/**
 * One property as the gate weighs it: what it is, its joint closure, its key (none when a kill's edit is none), and
 * each kill with its edit.
 */
type Weighed = Readonly<{
	found: Discovered
	closure: Closure
	key: Option.Option<VerdictKey>
	killEdits: ReadonlyArray<readonly [Kill, Option.Option<Edit>]>
}>

/**
 * A property as a landing touches it: the files of its closure, whether its closure holds an installed package (whose
 * lockfile entry it reads), the files its kills edit, and whether its verdict key holds a pass.
 */
export type Touched = Readonly<{
	id: PropertyId
	files: ReadonlyArray<string>
	packages: boolean
	kills: ReadonlyArray<string>
	passed: boolean
}>

/**
 * Whether a landing whose changed files are `changed` touches a property: a file of its closure or one its kills edit is
 * among them (or below a changed submodule's gitlink), or the lockfile is, where its closure holds a package.
 */
export const touchedBy = (changed: ReadonlySet<string>, one: Touched): boolean =>
	Arr.some(one.files, (file) => isChanged(changed, file)) ||
	(one.packages && changed.has("pnpm-lock.yaml")) ||
	Arr.some(one.kills, (file) => isChanged(changed, file))

/**
 * The properties a landing touched that carry no green verdict at the closure it lands (`verified`'s refusals): each
 * one `touchedBy` the landing whose key holds no pass.
 */
export const unverifiedOf = (
	changed: ReadonlySet<string>,
	properties: ReadonlyArray<Touched>
): ReadonlyArray<PropertyId> =>
	Arr.flatMap(properties, (one) => (touchedBy(changed, one) && !one.passed ? [one.id] : []))

/** A judged kill as the gate reports it. */
export const killLine = (judged: Judged): string => {
	const verdict = judged.verdict
	switch (verdict.kind) {
		case "killed":
			return `${judged.property}: killed: ${judged.kill.why}`
		case "survived":
			return `${judged.property}: SURVIVED${verdict.loaded ? "" : ", its workers never loaded the file"}: ${judged.kill.why} (${judged.kill.file})`
		case "stale":
			return `${judged.property}: STALE: ${verdict.stale.message}`
		case "unjudged":
			return `${judged.property}: UNJUDGED: ${judged.kill.why}, since the property goes red with no mutant (${redText(verdict.red)})`
	}
}

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
 * cache, and each property discovered with its joint closure and key.
 */
type Weighing = Readonly<{
	repository: string
	packageRoot: string
	cache: VerdictCache
	weighed: ReadonlyArray<Weighed>
}>

/**
 * The runner's own entry modules as roots of every verdict key, when they are files of the repository (the toolchain's
 * own packages, a workspace link such as grizzle's vendor/toolchain): the CLI, which reaches the search, its limits and
 * the pool, and the worker, which the pool forks by path. An installed runner (under node_modules, or outside the
 * repository) is no root: the package's test.config.ts imports it, and its closure holds it as every external package
 * is held, by its lockfile entry.
 */
const runnerRootsOf = (repository: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const entries = yield* Effect.forEach(
			[`${import.meta.dirname}/cli-entry.ts`, WORKER_ENTRY],
			(file) => fs.realPath(file)
		)
		const own = Arr.every(
			entries,
			(real) => Str.startsWith(`${repository}/`)(real) && !Str.includes("/node_modules/")(real)
		)
		return own ? yield* Effect.forEach(entries, (real) => underRepository(repository, real)) : []
	})

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
 * A package's test modules as every cached answer of the repository weighs them: the working tree, the closure
 * hasher, the repository's cache directory (`<toolchain-test cache>/<repository key>`), and each module's joint
 * closure with the package's test.config.ts and the runner's own entry modules (runnerRootsOf), hashed under the
 * config's conditions and this Node's version, so an edit to anything a module, the config or the runner loads makes
 * its closure new.
 */
const modulesWeighedOf = (
	packageRoot: string,
	repository: string,
	config: RunnerConfig,
	modules: ReadonlyArray<string>
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
		const runner = [...runnerRoots, configRoot]
		const pathEntries = yield* Effect.forEach(Arr.dedupe(modules), (module) =>
			Effect.map(packageFile(module), (path) => [module, path] as const)
		)
		const paths = new Map(pathEntries)
		const closures = yield* closuresOf({
			tree,
			conditions: config.conditions,
			runtime: process.version,
			roots: [...runner, ...paths.values()]
		}).pipe(Effect.provide(hashing))
		const closureOf = (path: RepoPath) =>
			Effect.mapError(Effect.fromOption(Option.fromUndefinedOr(closures.get(path))), () =>
				AffectedRefused.make({ message: `${path} has no closure` })
			)
		const shared = yield* Effect.forEach(runner, closureOf)
		const repositoryKey = yield* repositoryKeyOf(identity).pipe(Effect.provide(hashing))
		return {
			tree,
			hashing,
			home: `${cache}/${repositoryKey}`,
			jointOf: (module: string) =>
				Effect.gen(function* () {
					const path = yield* Effect.mapError(
						Effect.fromOption(Option.fromUndefinedOr(paths.get(module))),
						() => AffectedRefused.make({ message: `${module} was not hashed` })
					)
					const own = yield* closureOf(path)
					return yield* jointClosureOf([own, ...shared]).pipe(Effect.provide(hashing))
				})
		}
	})

/** Weighs the properties `discovered` of a package of a repository: their closures, keys and the repository's cache. */
const weighingOf = (
	packageRoot: string,
	repository: string,
	config: RunnerConfig,
	discovered: ReadonlyArray<Discovered>
) =>
	Effect.gen(function* () {
		const weighed = yield* modulesWeighedOf(
			packageRoot,
			repository,
			config,
			Arr.map(discovered, (found) => found.module)
		)
		const properties = yield* Effect.forEach(discovered, (found) =>
			Effect.gen(function* () {
				const closure = yield* weighed.jointOf(found.module)
				const edits = yield* Effect.forEach(found.property.kills, (kill) =>
					editOfKill(weighed.tree, kill)
				).pipe(Effect.provide(weighed.hashing))
				const key = Option.map(Option.all(edits), (all): VerdictKey => ({
					property: found.id,
					closure: closure.hash,
					seeds: RUN_SEEDS,
					edits: all
				}))
				const killEdits = Arr.zip(found.property.kills, edits)
				return { found, closure, key, killEdits } satisfies Weighed
			})
		)
		const verdicts = yield* verdictCacheAt(`${weighed.home}/verdicts`).pipe(
			Effect.provide(weighed.hashing)
		)
		return { repository, packageRoot, cache: verdicts, weighed: properties } satisfies Weighing
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
			const weighed = yield* modulesWeighedOf(grounds.packageRoot, repository, config, modules)
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
	const keyOf = (id: PropertyId, edit: Edit): Option.Option<VerdictKey> =>
		Option.flatMap(weighing, (weighed) =>
			Option.map(
				Arr.findFirst(weighed.weighed, (one) => one.found.id === id),
				(one): VerdictKey => ({
					property: id,
					closure: one.closure.hash,
					seeds: EDIT_SEEDS,
					edits: [edit]
				})
			)
		)
	const cache = Option.map(weighing, (weighed) => weighed.cache)
	return {
		red: (id, edit) =>
			Effect.gen(function* () {
				const key = keyOf(id, edit)
				if (Option.isNone(key) || Option.isNone(cache)) {
					return false
				}
				return yield* cache.value
					.passed(key.value)
					.pipe(Effect.catchTag("VerdictCorrupt", () => Effect.succeed(false)))
			}),
		record: (id, edit, red) =>
			Effect.gen(function* () {
				const key = keyOf(id, edit)
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

/** A cached kill as a run reports it. */
const cachedLine = (cached: CachedKill): string =>
	`${cached.property}: killed (a cached verdict): ${cached.kill.why}`

/**
 * The verdicts under edits of the package at `root`, for the properties `discovered` of it under `config`, for a
 * command that judges kills or mutants itself (`toolchain-test kills`, `mutate` and `census`): its kills' and its
 * edits', none kept when the package has no verdict key.
 */
export const verdictsAt = (
	root: string,
	config: RunnerConfig,
	discovered: ReadonlyArray<Discovered>
) =>
	Effect.gen(function* () {
		const grounds = yield* groundsOf(root)
		const weighing = yield* Option.match(grounds.repository, {
			onNone: () => Effect.succeedNone,
			onSome: (repository) =>
				Effect.option(weighingOf(grounds.packageRoot, repository, config, discovered))
		})
		return { kills: killVerdictsOf(weighing), edits: editVerdictsOf(weighing) }
	})

/** The kills of `subjects` judged on leased workers (MUTATOR's killsOf), in the checkout of `repository`. */
const judgedOf = (repository: string, packageRoot: string, subjects: ReadonlyArray<Discovered>) =>
	Effect.gen(function* () {
		const killed = Arr.filter(subjects, (found) =>
			Arr.isReadonlyArrayNonEmpty(found.property.kills)
		)
		if (!Arr.isReadonlyArrayNonEmpty(killed)) {
			return []
		}
		const checkout = yield* realPathOf(repository)
		const killedRoot = yield* realPathOf(packageRoot)
		const trees = yield* treesOf(checkout)
		const images = yield* imagesOf(checkout, trees)
		const pool = yield* mutatorPool(checkout, killedRoot)
		return yield* killsOf(
			pool,
			{ seed: 0, limits: runnerLimits },
			checkout,
			images,
			Arr.map(killed, (found) => ({
				id: found.id,
				property: found.property,
				loading: loadingOf(found.property.needs)
			}))
		)
	})

/** The kills of `subjects` judged, those the cache answers left alone, and every judged verdict recorded. */
const settledKills = (
	verdicts: KillVerdicts,
	repository: string,
	packageRoot: string,
	subjects: ReadonlyArray<Discovered>
) =>
	Effect.gen(function* () {
		const { fresh, cached } = yield* verdicts.split(subjects)
		const judged = yield* judgedOf(repository, packageRoot, fresh)
		yield* verdicts.record(judged)
		return { judged, lines: [...Arr.map(judged, killLine), ...Arr.map(cached, cachedLine)] }
	})

/** The properties whose searches passed and whose every judged kill turned them red. */
const passingOf = (
	outcome: RunOutcome,
	ids: ReadonlyArray<PropertyId>,
	judged: ReadonlyArray<Judged>
): ReadonlySet<PropertyId> =>
	new Set(
		Arr.filter(
			ids,
			(id) =>
				searchedPassed(outcome, id) &&
				!Arr.some(judged, (verdict) => verdict.property === id && verdict.verdict.kind !== "killed")
		)
	)

/** A weighed property as a landing touches it, its key holding a pass or not. */
const touchedOf = (one: Weighed, passed: boolean): Touched => ({
	id: one.found.id,
	files: one.closure.files,
	packages: Arr.isReadonlyArrayNonEmpty(one.closure.packages),
	kills: Arr.map(one.found.property.kills, (kill) => kill.file),
	passed
})

/** Records each weighed property's verdict under its key: a pass when it is passing, a failure otherwise. */
const recorded = (
	cache: VerdictCache,
	due: ReadonlyArray<Weighed>,
	passing: ReadonlySet<PropertyId>
) =>
	Effect.forEach(
		due,
		(one) =>
			Option.match(one.key, {
				onNone: () => Effect.void,
				onSome: (key) => cache.record(key, passing.has(one.found.id) ? "passed" : "failed")
			}),
		{ discard: true }
	)

/**
 * The verdict cache's side of `toolchain-test run`, the full run per production version: it reads no cached pass, so
 * every property `selected` names ran (`outcome`); this judges the kills of each whose searches passed and records every
 * verdict, so a property whose kills did not all turn red is a failure of the run, never a cached pass. A package in no
 * git repository has no checkout to mutate and no verdict key: no kill of its can be judged, so each fails its
 * property (run.ts unjudgeable), and nothing is recorded. A
 * package whose properties have no verdict key (no lockfile, a module that resolves to nothing) has its kills judged
 * and records nothing. Each says so once, and the run's verdict is its searches' and kills'.
 */
export const recordedRun = (root: string, selected: ReadonlyArray<string>, outcome: RunOutcome) =>
	Effect.gen(function* () {
		const grounds = yield* groundsOf(root)
		const { config, discovered } = yield* loadPackage(root, selected)
		const passed = Arr.filter(discovered, (found) => searchedPassed(outcome, found.id))
		const ids = Arr.map(discovered, (found) => found.id)
		if (Option.isNone(grounds.repository)) {
			return yield* unjudgeable(outcome, `${root} lies in no git repository`)
		}
		const repository = grounds.repository.value
		const weighing = yield* Effect.result(
			weighingOf(grounds.packageRoot, repository, config, discovered)
		)
		const { judged, lines } = yield* settledKills(
			killVerdictsOf(Result.getSuccess(weighing)),
			repository,
			grounds.packageRoot,
			passed
		)
		const passing = passingOf(outcome, ids, judged)
		yield* Result.match(weighing, {
			onSuccess: (weighed) => recorded(weighed.cache, weighed.weighed, passing),
			onFailure: (why) =>
				Console.log(`verdicts not recorded: ${Inspectable.toStringUnknown(why, 0)}`)
		})
		return { lines, passing } satisfies Settled
	})

/** `affected <ref>` in the package at `root`: 0 when every affected property and its kills passed, 1 otherwise. */
export const affected = (root: string, args: ReadonlyArray<string>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const [ref, ...extra] = args
			if (ref === undefined || Arr.isReadonlyArrayNonEmpty(extra)) {
				return yield* AffectedRefused.make({
					message:
						"affected takes one ref, what the report counts changes against: toolchain-test affected <ref>"
				})
			}
			const grounds = yield* groundsOf(root)
			const repository = yield* Effect.mapError(Effect.fromOption(grounds.repository), () =>
				AffectedRefused.make({ message: `${root} lies in no git repository` })
			)
			const { config, discovered } = yield* loadPackage(grounds.packageRoot, [])
			const weighing = yield* weighingOf(grounds.packageRoot, repository, config, discovered)
			const base = yield* required(
				weighing.repository,
				["rev-parse", "--verify", "--quiet", `${ref}^{tree}`],
				`${ref} names no commit or tree`
			)
			const answered = yield* Effect.forEach(weighing.weighed, (one) =>
				Option.match(one.key, {
					onNone: () => Effect.succeed({ one, cached: false }),
					onSome: (key) =>
						weighing.cache.passed(key).pipe(
							Effect.map((cached) => ({ one, cached })),
							Effect.catchTag("VerdictCorrupt", (corrupt) =>
								Effect.as(
									Console.error(`${corrupt.path} is no record of its key; ${one.found.id} runs`),
									{ one, cached: false }
								)
							)
						)
				})
			)
			const due = Arr.map(
				Arr.filter(answered, ({ cached }) => !cached),
				({ one }) => one
			)
			const cachedCount = answered.length - due.length
			if (!Arr.isReadonlyArrayNonEmpty(due)) {
				yield* Console.log(`${answered.length} properties, every one a cached pass`)
				return 0
			}
			const changed = yield* changedSince(weighing.repository, base)
			const changedCount = Arr.filter(due, (one) =>
				touchedBy(changed, touchedOf(one, false))
			).length
			const { seed } = yield* runSeedLogged
			const outcome = yield* runPackage({
				root,
				seed,
				reach: "full",
				selected: Arr.map(due, (one) => one.found.id)
			})
			const { judged, lines } = yield* settledKills(
				killVerdictsOf(Option.some(weighing)),
				weighing.repository,
				weighing.packageRoot,
				Arr.filter(
					Arr.map(due, (one) => one.found),
					(found) => searchedPassed(outcome, found.id)
				)
			)
			const passing = passingOf(
				outcome,
				Arr.map(due, (one) => one.found.id),
				judged
			)
			yield* recorded(weighing.cache, due, passing)
			const failed = Arr.filter(outcome.properties, (ran) => ran.verdict.kind === "failed")
			const failing = due.length - passing.size
			yield* Console.log(
				Arr.join(
					[
						...Arr.map(outcome.properties, (ran) => lineOf(ran.label, ran.oracle, ran.verdict)),
						...lines,
						...Arr.flatMap(failed, (ran) => ["", `${ran.label}:`, ...failureLines(ran.verdict)]),
						"",
						`${answered.length} properties: ${cachedCount} cached passes; ${due.length} run (${changedCount} changed since ${ref}, ${due.length - changedCount} not verified at this content), ${failing} failed, in ${Math.round(outcome.millis)} ms on ${outcome.workers.length} workers`
					],
					"\n"
				)
			)
			return failing > 0 ? 1 : 0
		})
	)

/**
 * `verified <ref>` in the package at `root`, the push gate of a repository whose gate runs no property itself (grizzle's,
 * whose database properties run only in the machine's one database job): every property the landing touched since
 * `<ref>` (touchedBy: a file of its closure, a file a kill of it edits, or the lockfile its closure reads) must carry a
 * green verdict at the closure it lands, a pass its verdict key holds, which `toolchain-test affected` or `run` records
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
			const weighing = yield* weighingOf(grounds.packageRoot, repository, config, discovered)
			const base = yield* required(
				weighing.repository,
				["rev-parse", "--verify", "--quiet", `${ref}^{tree}`],
				`${ref} names no commit or tree`
			)
			const changed = yield* changedSince(weighing.repository, base)
			const properties = yield* Effect.forEach(weighing.weighed, (one) =>
				Effect.map(
					Option.match(one.key, {
						onNone: () => Effect.succeed(false),
						onSome: (key) =>
							weighing.cache
								.passed(key)
								.pipe(Effect.catchTag("VerdictCorrupt", () => Effect.succeed(false)))
					}),
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
						`${String(touched.length)} of ${String(properties.length)} properties touched since ${ref}: ${String(touched.length - unverified.length)} carry a green verdict at the closure they land, ${String(unverified.length)} do not${Arr.isReadonlyArrayNonEmpty(unverified) ? `; run them first: toolchain-test affected ${ref}, a database property in the machine's database job` : ""}`
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
