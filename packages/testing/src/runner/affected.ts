import { layerDigest } from "@effect/platform-node/NodeCrypto"
import {
	Array as Arr,
	Config,
	Console,
	Effect,
	FileSystem,
	Inspectable,
	Layer,
	Option,
	Result,
	Schema,
	Stream,
	String as Str
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { loadingOf } from "#mutate/checkout.ts"
import { imagesOf } from "#mutate/image.ts"
import { type Judged, killsOf, redText } from "#mutate/kills.ts"
import { mutatorPool } from "#mutate/lease.ts"
import { realPathOf } from "#mutate/mutated.ts"
import { treesOf } from "#mutate/tree.ts"
import { type Kill, Property, type PropertyId } from "#property.ts"
import {
	type KillContent,
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
	contentHashOf,
	jointClosureOf,
	nativeSyntax,
	type RepoPath,
	repoPathOf,
	type Files,
	workingTree
} from "#runner/closure.ts"
import { runnerLimits } from "#runner/limits.ts"
import type { Discovered } from "#runner/load.ts"
import { failureLines, lineOf } from "#runner/report.ts"
import {
	loadPackage,
	type RunOutcome,
	runPackage,
	runSeedLogged,
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
 * version, the seed policy of a gate run (RUN_SEEDS), and each kill with the content hash of the file it mutates. So
 * an edit to a module a property loads, to the runner, to the config, to a lockfile entry a closure holds or to a
 * killed file makes its key new, and the property runs; nothing else does. What a property reads at run time without
 * importing it (a fixture file, a child process's code) is outside its closure: a full run per production version
 * covers it.
 *
 * `<ref>` (any tree-ish: the commit the remote held, or the empty tree for a new branch) names what the report counts
 * against: a property run is "changed since <ref>" when a file of its closure or a file one of its kills mutates
 * differs from `<ref>`, else "not verified at this content" (its key never passed here). Verdicts live in
 * `${XDG_CACHE_HOME:-~/.cache}/toolchain-test/<repository key>/verdicts`, the key toolchain-gate's (cache.ts), so every
 * clone of a repository and its gate snapshots share them.
 */

/**
 * The seed policy of every verdict the gate caches: a search at full reach, its floor and steered phases seeded by the
 * property's identity, its rotating stream by the run's seed. A pass under it answers for one run's sample.
 */
const RUN_SEEDS = SeedPolicy(
	"full reach: floor and steered phases seeded by the property's identity, the rotating stream by the run's seed"
)

/**
 * The seed policy of a cached kill verdict: the property's witnesses (kept tokens, floor and steered phase, fixed by
 * its identity) under the kill's mutant, as the kill gate runs them. A kill that turned them red is a known answer for
 * as long as the property's closure, the kill and its file's content stand.
 */
const KILL_SEEDS = SeedPolicy(
	"witnesses under the kill's mutant: kept tokens, floor and steered phase, fixed by the property's identity"
)

/** The affected command could not run: its usage, the repository or a ref it could not read. */
class AffectedRefused extends Schema.TaggedError<
	AffectedRefused,
	{ readonly brand: unique symbol }
>()("AffectedRefused", { message: Schema.String }) {}

/** git run in `cwd`: its trimmed standard output when it exits 0, none otherwise. */
const gitOf = (cwd: string, args: ReadonlyArray<string>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			const handle = yield* spawner.spawn(ChildProcess.make("git", args, { cwd, stdin: "ignore" }))
			const [stdout, exitCode] = yield* Effect.all(
				[Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode],
				{ concurrency: "unbounded" }
			)
			return exitCode === 0 ? Option.some(stdout) : Option.none()
		})
	)

/** A git answer that must exist, or the refusal `why` states. */
const required = (cwd: string, args: ReadonlyArray<string>, why: string) =>
	Effect.flatMap(gitOf(cwd, args), (answer) =>
		Option.match(answer, {
			onNone: () => Effect.fail(AffectedRefused.make({ message: why })),
			onSome: (text) => Effect.succeed(Str.trim(text))
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
const isChanged = (changed: ReadonlySet<string>, file: string): boolean =>
	Arr.reduce(Str.split("/")(file), { prefix: "", found: false }, (state, segment) => {
		const prefix = state.prefix === "" ? segment : `${state.prefix}/${segment}`
		return { prefix, found: state.found || changed.has(prefix) }
	}).found

/** A kill as its key holds it: the mutant and the content hash of its file, or none when the file is not there. */
const killContentOf = (tree: Files, kill: Kill) =>
	Effect.flatMap(Effect.transposeOption(Option.map(repoPathOf(kill.file), tree.read)), (read) =>
		Effect.transposeOption(
			Option.map(Option.flatten(read), (bytes) =>
				Effect.map(contentHashOf(bytes), (content): KillContent => ({
					file: kill.file,
					original: kill.original,
					replacement: kill.replacement,
					content
				}))
			)
		)
	)

/** One property as the gate weighs it: what it is, its joint closure, and its key (none when a kill's file is gone). */
type Weighed = Readonly<{
	found: Discovered
	closure: Closure
	key: Option.Option<VerdictKey>
	killKeys: ReadonlyArray<readonly [Kill, Option.Option<VerdictKey>]>
}>

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
		const toplevel = yield* gitOf(packageRoot, ["rev-parse", "--show-toplevel"])
		const repository = yield* Effect.transposeOption(
			Option.map(Option.map(toplevel, Str.trim), (top) => fs.realPath(top))
		)
		return { packageRoot, repository } satisfies Grounds
	})

/**
 * A package weighed for the verdict cache: its repository and package root (real paths), the repository's verdict
 * cache, and each property `selected` names (every one when it names none) with its joint closure and key.
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

/** Weighs the properties `selected` names in a package of a repository: their closures, keys and the repository's cache. */
const weighingOf = (packageRoot: string, repository: string, selected: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const identity = yield* Effect.flatMap(
			gitOf(repository, ["config", "--get", "remote.origin.url"]),
			(url) =>
				Option.match(Option.filter(Option.map(url, Str.trim), Str.isNonEmpty), {
					onSome: Effect.succeed,
					onNone: () =>
						required(
							repository,
							["rev-parse", "--path-format=absolute", "--git-common-dir"],
							"the repository has no git directory"
						)
				})
		)
		const home = yield* Config.String("HOME")
		const cacheHome = yield* Config.withDefault(Config.String("XDG_CACHE_HOME"), `${home}/.cache`)
		const { config, discovered } = yield* loadPackage(packageRoot, selected)
		const hashing = yield* Layer.build(Layer.merge(nativeSyntax, layerDigest))
		const tree = yield* workingTree(repository)
		const packageFile = (path: string) => underRepository(repository, `${packageRoot}/${path}`)
		const runnerRoots = yield* runnerRootsOf(repository)
		const configRoot = yield* Effect.flatMap(fs.realPath(`${packageRoot}/test.config.ts`), (real) =>
			underRepository(repository, real)
		)
		const runner = [...runnerRoots, configRoot]
		const modules = yield* Effect.forEach(
			Arr.dedupe(Arr.map(discovered, (found) => found.module)),
			(module) => Effect.map(packageFile(module), (path) => [module, path] as const)
		)
		const closures = yield* closuresOf({
			tree,
			conditions: config.conditions,
			runtime: process.version,
			roots: [...runner, ...Arr.map(modules, ([, path]) => path)]
		}).pipe(Effect.provide(hashing))
		const closureOf = (path: RepoPath) =>
			Effect.mapError(Effect.fromOption(Option.fromUndefinedOr(closures.get(path))), () =>
				AffectedRefused.make({ message: `${path} has no closure` })
			)
		const shared = yield* Effect.forEach(runner, closureOf)
		const paths = new Map(modules)
		const weighed = yield* Effect.forEach(discovered, (found) =>
			Effect.gen(function* () {
				const path = yield* Effect.mapError(
					Effect.fromOption(Option.fromUndefinedOr(paths.get(found.module))),
					() => AffectedRefused.make({ message: `${found.module} was not hashed` })
				)
				const own = yield* closureOf(path)
				const closure = yield* jointClosureOf([own, ...shared]).pipe(Effect.provide(hashing))
				const kills = yield* Effect.forEach(found.property.kills, (kill) =>
					killContentOf(tree, kill)
				).pipe(Effect.provide(hashing))
				const key = Option.map(Option.all(kills), (contents): VerdictKey => ({
					property: found.id,
					closure: closure.hash,
					seeds: RUN_SEEDS,
					kills: contents
				}))
				const killKeys = Arr.zip(
					found.property.kills,
					Arr.map(kills, (content) =>
						Option.map(content, (one): VerdictKey => ({
							property: found.id,
							closure: closure.hash,
							seeds: KILL_SEEDS,
							kills: [one]
						}))
					)
				)
				return { found, closure, key, killKeys } satisfies Weighed
			})
		)
		const repositoryKey = yield* repositoryKeyOf(identity).pipe(Effect.provide(hashing))
		const cache = yield* verdictCacheAt(
			`${cacheHome}/toolchain-test/${repositoryKey}/verdicts`
		).pipe(Effect.provide(hashing))
		return { repository, packageRoot, cache, weighed } satisfies Weighing
	})

/**
 * What a run settles to: a line for each kill (judged now, or a cached verdict), and the properties that passed with
 * every kill turning them red.
 */
type Settled = Readonly<{ lines: ReadonlyArray<string>; passing: ReadonlySet<PropertyId> }>

/** A kill whose verdict the cache already holds: it turned its property red under the same closure and file. */
type CachedKill = Readonly<{ property: PropertyId; kill: Kill }>

/**
 * A package's kill verdicts: `split` sets apart the kills of `subjects` the cache answers (each property's remaining
 * kills are the ones to judge), and `record` keeps each judged kill's verdict under its key, a kill that turned its
 * property red as a pass and any other as a failure. With no weighing (no git repository, no lockfile, a closure that
 * would not hash) nothing is answered and nothing recorded.
 */
type KillVerdicts = Readonly<{
	split: (
		subjects: ReadonlyArray<Discovered>
	) => Effect.Effect<
		Readonly<{ fresh: ReadonlyArray<Discovered>; cached: ReadonlyArray<CachedKill> }>,
		VerdictCacheUnusable
	>
	record: (judged: ReadonlyArray<Judged>) => Effect.Effect<void, VerdictCacheUnusable>
}>

/** A property whose kills are `kills`: the same search, needs and evaluation, judged against those kills alone. */
const withKills = (property: Property, kills: ReadonlyArray<Kill>): Property =>
	new Property({
		kind: property.kind,
		needs: property.needs,
		guide: property.guide,
		oracle: property.oracle,
		kills,
		search: property.search,
		replay: property.replay,
		keep: property.keep,
		ready: property.ready
	})

/** The kill verdicts of a weighing, or none to keep. */
const killVerdictsOf = (weighing: Option.Option<Weighing>): KillVerdicts => {
	const keyOf = (id: PropertyId, kill: Kill): Option.Option<VerdictKey> =>
		Option.flatMap(weighing, (weighed) =>
			Option.flatMap(
				Arr.findFirst(weighed.weighed, (one) => one.found.id === id),
				(one) =>
					Option.flatten(
						Option.map(
							Arr.findFirst(one.killKeys, ([own]) => own === kill),
							([, key]) => key
						)
					)
			)
		)
	const cache = Option.map(weighing, (weighed) => weighed.cache)
	const answered = (id: PropertyId, kill: Kill) =>
		Effect.gen(function* () {
			const key = keyOf(id, kill)
			if (Option.isNone(key) || Option.isNone(cache)) {
				return false
			}
			return yield* cache.value
				.passed(key.value)
				.pipe(Effect.catchTag("VerdictCorrupt", () => Effect.succeed(false)))
		})
	return {
		split: (subjects) =>
			Effect.gen(function* () {
				const fresh: Array<Discovered> = []
				const cached: Array<CachedKill> = []
				for (const found of subjects) {
					const remaining: Array<Kill> = []
					for (const kill of found.property.kills) {
						if (yield* answered(found.id, kill)) {
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
					Effect.gen(function* () {
						const key = keyOf(one.property, one.kill)
						if (Option.isSome(key) && Option.isSome(cache)) {
							yield* cache.value.record(
								key.value,
								one.verdict.kind === "killed" ? "passed" : "failed"
							)
						}
					}),
				{ discard: true }
			)
	}
}

/** A cached kill as a run reports it. */
const cachedLine = (cached: CachedKill): string =>
	`${cached.property}: killed (a cached verdict): ${cached.kill.why}`

/**
 * The kill verdicts of the package at `root` for the properties `selected` names, for a command that judges kills
 * itself (`toolchain-test kills`): none when the package has no verdict key.
 */
export const killVerdictsAt = (root: string, selected: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const grounds = yield* groundsOf(root)
		const weighing = yield* Option.match(grounds.repository, {
			onNone: () => Effect.succeedNone,
			onSome: (repository) => Effect.option(weighingOf(grounds.packageRoot, repository, selected))
		})
		return killVerdictsOf(weighing)
	})

/** Whether every run of a property (on every stack it ran on) passed its search, and it ran at all. */
const searchedPassed = (outcome: RunOutcome, id: PropertyId): boolean => {
	const runs = Arr.filter(outcome.properties, (ran) => ran.id === id)
	return (
		Arr.isReadonlyArrayNonEmpty(runs) && Arr.every(runs, (ran) => ran.verdict.kind !== "failed")
	)
}

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
		return yield* killsOf(
			mutatorPool(checkout, killedRoot),
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
 * git repository has no checkout to mutate and no verdict key: its kills are not judged and nothing is recorded. A
 * package whose properties have no verdict key (no lockfile, a module that resolves to nothing) has its kills judged
 * and records nothing. Each says so once, and the run's verdict is its searches' and kills'.
 */
export const recordedRun = (root: string, selected: ReadonlyArray<string>, outcome: RunOutcome) =>
	Effect.gen(function* () {
		const grounds = yield* groundsOf(root)
		const { discovered } = yield* loadPackage(root, selected)
		const passed = Arr.filter(discovered, (found) => searchedPassed(outcome, found.id))
		const ids = Arr.map(discovered, (found) => found.id)
		if (Option.isNone(grounds.repository)) {
			yield* Console.log(
				`kills not judged and verdicts not recorded: ${root} lies in no git repository`
			)
			return { lines: [], passing: passingOf(outcome, ids, []) } satisfies Settled
		}
		const repository = grounds.repository.value
		const weighing = yield* Effect.result(weighingOf(grounds.packageRoot, repository, selected))
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
			const weighing = yield* weighingOf(grounds.packageRoot, repository, [])
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
			const changedCount = Arr.filter(
				due,
				(one) =>
					Arr.some(one.closure.files, (file) => isChanged(changed, file)) ||
					(Arr.isReadonlyArrayNonEmpty(one.closure.packages) && changed.has("pnpm-lock.yaml")) ||
					Arr.some(one.found.property.kills, (kill) => isChanged(changed, kill.file))
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
