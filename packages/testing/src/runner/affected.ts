import { layerDigest } from "@effect/platform-node/NodeCrypto"
import { regex } from "arkregex"
import {
	Array as Arr,
	Config,
	Console,
	Effect,
	FileSystem,
	Layer,
	Option,
	Random,
	Schema,
	Stream,
	String as Str
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { loadingOf } from "#mutate/checkout.ts"
import { imagesOf } from "#mutate/image.ts"
import { type Judged, killsOf } from "#mutate/kills.ts"
import { mutatorPool } from "#mutate/lease.ts"
import { realPathOf } from "#mutate/mutated.ts"
import { treesOf } from "#mutate/tree.ts"
import type { Kill, PropertyId } from "#property.ts"
import {
	type KillContent,
	repositoryKeyOf,
	SeedPolicy,
	type VerdictCache,
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
import { loadPackage, type RunOutcome, runPackage, WORKER_ENTRY } from "#runner/run.ts"

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
type Weighed = Readonly<{ found: Discovered; closure: Closure; key: Option.Option<VerdictKey> }>

/** A judged kill as the gate reports it. */
const killLine = (judged: Judged): string => {
	const verdict = judged.verdict
	switch (verdict.kind) {
		case "killed":
			return `${judged.property}: killed: ${judged.kill.why}`
		case "survived":
			return `${judged.property}: SURVIVED${verdict.loaded ? "" : ", its workers never loaded the file"}: ${judged.kill.why} (${judged.kill.file})`
		case "stale":
			return `${judged.property}: STALE: ${verdict.stale.message}`
	}
}

/** A 32-bit run seed as a person writes it, as `toolchain-test run` reads TEST_SEED: decimal, or hexadecimal after 0x. */
const SeedText = Schema.String.check(Schema.isPattern(regex("^(0x[0-9a-fA-F]{1,8}|[0-9]{1,10})$")))

/** The run's seed: TEST_SEED's, as `toolchain-test run` reads it, or one drawn fresh. */
const seedOf = Effect.gen(function* () {
	const given = yield* Config.option(Config.String("TEST_SEED"))
	if (Option.isSome(given)) {
		const text = yield* Schema.decodeEffect(SeedText)(given.value)
		return { seed: Number(text), drawn: false }
	}
	const seed = yield* Random.nextIntBetween(0, 0xffff_ffff)
	return { seed, drawn: true }
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

/** Weighs the properties `selected` names in the package at `root`: their closures, keys and the repository's cache. */
const weighingOf = (root: string, selected: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const packageRoot = yield* fs.realPath(root)
		const toplevel = yield* required(
			packageRoot,
			["rev-parse", "--show-toplevel"],
			`${root} lies in no git repository`
		)
		const repository = yield* fs.realPath(toplevel)
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
		const { config, discovered } = yield* loadPackage(root, selected)
		const hashing = yield* Layer.build(Layer.merge(nativeSyntax, layerDigest))
		const tree = yield* workingTree(repository)
		const packageFile = (path: string) => underRepository(repository, `${packageRoot}/${path}`)
		const runner = yield* Effect.forEach(
			[`${import.meta.dirname}/cli.ts`, WORKER_ENTRY, `${packageRoot}/test.config.ts`],
			(file) => Effect.flatMap(fs.realPath(file), (real) => underRepository(repository, real))
		)
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
				return { found, closure, key } satisfies Weighed
			})
		)
		const repositoryKey = yield* repositoryKeyOf(identity).pipe(Effect.provide(hashing))
		const cache = yield* verdictCacheAt(
			`${cacheHome}/toolchain-test/${repositoryKey}/verdicts`
		).pipe(Effect.provide(hashing))
		return { repository, packageRoot, cache, weighed } satisfies Weighing
	})

/** What a run settles to: the kills it judged, and the properties that passed with every kill turning them red. */
type Settled = Readonly<{ judged: ReadonlyArray<Judged>; passing: ReadonlySet<PropertyId> }>

/**
 * Settles a run of `due`: the kills of each property whose searches passed (on every stack it ran on) are judged on leased workers (MUTATOR's
 * killsOf), and each property's verdict is recorded under its key: a pass when its search passed and every kill turned
 * its witnesses red, a failure otherwise. A property with no key (a kill's file gone) records nothing; its kill is
 * judged stale.
 */
const settledOf = (weighing: Weighing, due: ReadonlyArray<Weighed>, outcome: RunOutcome) =>
	Effect.gen(function* () {
		const passedSearch = Arr.filter(due, (one) => {
			const runs = Arr.filter(outcome.properties, (ran) => ran.id === one.found.id)
			return (
				Arr.isReadonlyArrayNonEmpty(runs) && Arr.every(runs, (ran) => ran.verdict.kind !== "failed")
			)
		})
		const killed = Arr.filter(passedSearch, (one) =>
			Arr.isReadonlyArrayNonEmpty(one.found.property.kills)
		)
		const checkout = yield* realPathOf(weighing.repository)
		const killedRoot = yield* realPathOf(weighing.packageRoot)
		const judged = Arr.isReadonlyArrayNonEmpty(killed)
			? yield* Effect.flatMap(
					Effect.flatMap(treesOf(checkout), (trees) => imagesOf(checkout, trees)),
					(images) =>
						killsOf(
							mutatorPool(checkout, killedRoot),
							{ seed: 0, limits: runnerLimits },
							checkout,
							images,
							Arr.map(killed, ({ found }) => ({
								id: found.id,
								property: found.property,
								loading: loadingOf(found.property.needs)
							}))
						)
				)
			: []
		const passing: ReadonlySet<PropertyId> = new Set(
			Arr.map(
				Arr.filter(
					passedSearch,
					(one) =>
						!Arr.some(
							judged,
							(verdict) => verdict.property === one.found.id && verdict.verdict.kind !== "killed"
						)
				),
				(one) => one.found.id
			)
		)
		yield* Effect.forEach(
			due,
			(one) =>
				Option.match(one.key, {
					onNone: () => Effect.void,
					onSome: (key) =>
						weighing.cache.record(key, passing.has(one.found.id) ? "passed" : "failed")
				}),
			{ discard: true }
		)
		return { judged, passing } satisfies Settled
	})

/**
 * The verdict cache's side of `toolchain-test run`, the full run per production version: it reads no cached pass, so
 * every property `selected` names ran (`outcome`); this judges the kills of each whose search passed and records every
 * verdict, so a property whose kills did not all turn red is a failure of the run, never a cached pass.
 */
export const recordedRun = (root: string, selected: ReadonlyArray<string>, outcome: RunOutcome) =>
	Effect.flatMap(weighingOf(root, selected), (weighing) =>
		settledOf(weighing, weighing.weighed, outcome)
	)

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
			const weighing = yield* weighingOf(root, [])
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
			const { seed, drawn } = yield* seedOf
			yield* Console.log(
				`TEST_SEED=${seed}${drawn ? " (drawn by this run; set it to reproduce the run)" : ""}`
			)
			const outcome = yield* runPackage({
				root,
				seed,
				reach: "full",
				selected: Arr.map(due, (one) => one.found.id)
			})
			const { judged, passing } = yield* settledOf(weighing, due, outcome)
			const failed = Arr.filter(outcome.properties, (ran) => ran.verdict.kind === "failed")
			const failing = due.length - passing.size
			yield* Console.log(
				Arr.join(
					[
						...Arr.map(outcome.properties, (ran) => lineOf(ran.label, ran.oracle, ran.verdict)),
						...Arr.map(judged, killLine),
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
