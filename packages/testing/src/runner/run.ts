import type { NodeServices } from "@effect/platform-node/NodeServices"
import { regex } from "arkregex"
import {
	Array as Arr,
	Config,
	Console,
	Context,
	Effect,
	type FileSystem,
	Option,
	type Path,
	Random,
	Schema,
	Scope,
	String as Str
} from "effect"
import type { Oracle } from "#explore.ts"
import { failureText } from "#failure.ts"
import { stopwatch } from "#live.ts"
import { type Property, type PropertyId, type PropertyKind, runNeedsOf } from "#property.ts"
import { PgCluster } from "#resources/cluster.ts"
import { collect, templatesOf } from "#resources/collect.ts"
import type { DatabaseTemplate } from "#resources/template.ts"
import { sharedStore } from "#runner/compile-cache.ts"
import { type RunnerConfig, SMALL_STACK } from "#runner/config.ts"
import { workerEnvironmentOf } from "#runner/environment.ts"
import { needStallMillis, runnerLimits } from "#runner/limits.ts"
import {
	configOf,
	type Discovered,
	discover,
	LoadFailed,
	matchedBy,
	type Pointed,
	pointedOf
} from "#runner/load.ts"
import { moduleClosureAt } from "#runner/module-closure.ts"
import { observationText } from "#runner/observe.ts"
import {
	type Observed,
	type Pool,
	PoolFailed,
	placesOf,
	placesShared,
	poolOf
} from "#runner/pool.ts"
import type { Reach, SearchRun, Verdict } from "#runner/protocol.ts"
import { failureLines, lineOf } from "#runner/report.ts"
import { openedRuns } from "#runner/runs.ts"
import type { Translation } from "#runner/search.ts"
import { ModuleClosure, WorkerIndex } from "#runner/services.ts"
import { labelOf, runOfLabel, type Stack } from "#runner/stack.ts"
import { landedText, type RunUsage } from "#runner/usage.ts"
import { runWorkers, widthOf } from "#workers.ts"

/**
 * A run of a package's properties on the pool, as every command reads it: which properties, by identity or module, at
 * what reach and on what run seed; and what each property's search concluded. `toolchain-test run` prints it; a
 * command that caches verdicts reads the same results.
 */

/**
 * One property's run: its identity, the stack it ran on and the label that names both (`<id>`, or `<id>@small-stack`),
 * its module, its kind, its oracle, its verdict, its wall time, and what it observed past its verdict's key as its
 * pools saw it (runner/pool.ts Observed): whether its verdict depends on something its key does not hold, and what the
 * property itself does.
 */
export type PropertyRun = Readonly<{
	id: PropertyId
	stack: Stack
	label: string
	module: string
	kind: PropertyKind
	oracle: Oracle
	verdict: Verdict
	millis: number
	observed: Observed
}>

/**
 * A whole run: each property's run in discovery order, the run's wall time, how many cases each worker ran, how many
 * test modules each worker held (readied a property of), and what the run cost in CPU, the parent's and its workers'
 * (runner/usage.ts).
 */
export type RunOutcome = Readonly<{
	properties: ReadonlyArray<PropertyRun>
	millis: number
	workers: ReadonlyArray<number>
	held: ReadonlyArray<number>
	usage: RunUsage
}>

/** The outcome of a run of no search: every property it was asked for answered before it (a cached run's). */
export const emptyOutcome: RunOutcome = {
	properties: [],
	millis: 0,
	workers: [],
	held: [],
	usage: { parent: 0, runNeeds: 0, properties: [], workers: [], children: "stated" }
}

/** Whether every run of a property (on every stack it ran on) passed its search, and it ran at all. */
export const searchedPassed = (outcome: RunOutcome, id: PropertyId): boolean => {
	const runs = Arr.filter(outcome.properties, (ran) => ran.id === id)
	return (
		Arr.isReadonlyArrayNonEmpty(runs) && Arr.every(runs, (ran) => ran.verdict.kind !== "failed")
	)
}

/**
 * What a property is known to do past its key (runner/observe.ts), as its last run did in windows of its own: nothing
 * (`clean`); keyable reads of its process alone (`reading`: a fixture, a prelude, a catalog), or through a child it
 * starts too (`spawning`: a compiler's sources and libraries, thousands of files), each of which every later trace of
 * its worker takes; or an act no key holds (`observing`), which leaves its worker unclean. Each takes workers of its own
 * kind (Workers), so a reader's reads reach no clean property's trace, a child's sources no mere reader's, and an
 * observer leaves no reader's worker unclean.
 */
export type Conduct = "clean" | "reading" | "spawning" | "observing"

/**
 * What to run: the package root, each property's seed (its rotating stream's: a run's derived from each property's
 * verdict key, or TEST_SEED's for all), what it is known to do past its key (Conduct: its workers are its conduct's
 * kind), the reach (every phase, or the witnesses alone), and which properties: every one, or those the arguments name,
 * each a module path or a directory of them (a prefix of a module's path), or a property identity
 * (`<module>#<export>`, which names a family's every member too).
 */
export type RunRequest = Readonly<{
	root: string
	seedOf: (id: PropertyId) => number
	conductOf: (id: PropertyId) => Conduct
	reach: Reach
	selected: ReadonlyArray<string>
}>

/** The worker's entry module, beside this one (runner/worker-entry.ts, which runs runner/worker.ts). */
export const WORKER_ENTRY = `${import.meta.dirname}/worker-entry.ts`

/**
 * Which workers a run's cases go to: its stack, whether they start V8's precise coverage before loading any module (a
 * guided property's), so only a guided property's workers pay for counting blocks, and what its properties are known to
 * do past their keys (Conduct), so a worker an observer makes unclean runs no property whose verdict could be kept, and
 * a reader's reads join no clean property's trace.
 */
type Workers = readonly [stack: Stack, guide: "notes" | "blocks", conduct: Conduct]

/** The workers a property's run on `stack` takes its cases to, `conduct` what it is known to do past its key. */
const workersOf = (stack: Stack, found: Discovered, conduct: Conduct): Workers => [
	stack,
	found.property.guide.kind,
	conduct
]

/** A kind of workers as a key. */
const labelOfWorkers = ([stack, guide, conduct]: Workers): string => `${stack}/${guide}/${conduct}`

/** The flags a stack's workers run under: this process's, and the small stack's on top for the small stack. */
const flagsOf = (stack: Stack): ReadonlyArray<string> => {
	switch (stack) {
		case "default":
			return process.execArgv
		case "small":
			return [...process.execArgv, SMALL_STACK]
	}
}

/**
 * An argument of a command, as it names properties: a module path or a directory of them, naming every property of
 * each module whose path it begins (`modules`); or a property identity (`<module>#<export>`, load.ts pointedOf), naming
 * its export's property and a family's every member (`identity`).
 */
type Argument =
	| Readonly<{ kind: "modules"; text: string }>
	| Readonly<{ kind: "identity"; text: string; pointed: Pointed }>

/** An argument as it names properties: an identity when it is one, else a module or a directory of them. */
const argumentOf = (text: string): Argument =>
	Option.match(pointedOf(text), {
		onNone: (): Argument => ({ kind: "modules", text }),
		onSome: (pointed): Argument => ({ kind: "identity", text, pointed })
	})

/** Whether an argument reaches a module: a module or directory each module its path begins, an identity its module. */
const reaches = (argument: Argument, module: string): boolean =>
	argument.kind === "modules"
		? Str.startsWith(argument.text)(module)
		: module === argument.pointed.module

/** Whether an argument names a property: every property of a module it reaches, or the one its identity names. */
const names = (argument: Argument, found: Discovered): boolean =>
	argument.kind === "modules"
		? reaches(argument, found.module)
		: found.id === argument.text || Str.startsWith(`${argument.text}/`)(found.id)

/** The export an identity names, and a family's key after it: the identity past its module. */
const exportOf = (pointed: Pointed): string =>
	Option.match(pointed.key, {
		onNone: () => pointed.name,
		onSome: (key) => `${pointed.name}/${key}`
	})

/**
 * Why `argument` names none of the `discovered` properties of the modules it reaches among the `included`: no included
 * module is one it reaches, or the modules it reaches export none it names; none when it names one.
 */
const unnamedOf = (
	argument: Argument,
	included: ReadonlyArray<string>,
	discovered: ReadonlyArray<Discovered>
): Option.Option<string> =>
	Arr.some(discovered, (found) => names(argument, found))
		? Option.none()
		: Option.some(
				!Arr.some(included, (module) => reaches(argument, module))
					? `${argument.text} is not in the runner config's include`
					: argument.kind === "modules"
						? `${argument.text} exports no property`
						: `${argument.pointed.module} exports no property ${exportOf(argument.pointed)}`
			)

/**
 * The properties `named` names among the `included` test modules under `root`, in discovery order: only the modules an
 * argument reaches are imported. An argument that names none fails the load, naming it and why, so a run of a module
 * left out of the include, or of a property its module does not export, is refused, never a pass of no property.
 */
const namedIn = (
	root: string,
	included: ReadonlyArray<string>,
	named: Arr.NonEmptyReadonlyArray<Argument>
): Effect.Effect<ReadonlyArray<Discovered>, LoadFailed, Path.Path> =>
	Effect.gen(function* () {
		const loaded = yield* discover(
			root,
			Arr.filter(included, (module) => Arr.some(named, (argument) => reaches(argument, module)))
		)
		const unnamed = Arr.flatMap(named, (argument) =>
			Option.toArray(
				Option.map(unnamedOf(argument, included, loaded), (why) => ({ argument, why }))
			)
		)
		if (Arr.isReadonlyArrayNonEmpty(unnamed)) {
			return yield* LoadFailed.make({
				path: Arr.join(
					Arr.map(unnamed, ({ argument }) => argument.text),
					" "
				),
				message: `no property is named by ${Arr.join(
					Arr.map(unnamed, ({ why }) => why),
					"; "
				)}`
			})
		}
		return Arr.filter(loaded, (found) => Arr.some(named, (argument) => names(argument, found)))
	})

/** The module part of an argument: an identity's module, or the argument, a module or a directory. */
const moduleOfArgument = (argument: string): string => {
	const parsed = argumentOf(argument)
	return parsed.kind === "modules" ? parsed.text : parsed.pointed.module
}

/**
 * A package as a command loads it: its runner config, the properties the arguments name, in discovery order, one at
 * least, and the one stack each runs on: the small stack for a module its config's smallStack names, the default for
 * every other.
 */
type Loaded = Readonly<{
	config: RunnerConfig
	discovered: Arr.NonEmptyReadonlyArray<Discovered>
	stackOf: (found: Discovered) => Stack
}>

/**
 * Loads a package's runner config and the properties `selected` names (every property when it names none): only the
 * test modules an argument reaches are imported, and an argument that names no property fails the load (namedIn). A
 * load of no property fails too, whatever the config includes: every command answers for the properties it loads, so a
 * run, a gate or a census of none would verify nothing and exit as if it had (the false green of edullm's gate,
 * 2026-11-24, whose run executed no test and passed).
 */
export const loadPackage = (
	root: string,
	selected: ReadonlyArray<string>
): Effect.Effect<Loaded, LoadFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const config = yield* configOf(root)
		const modules = yield* matchedBy(root, config.include)
		const smallModules = yield* matchedBy(root, config.smallStack)
		const small = new Set(smallModules)
		const named = Arr.map(selected, argumentOf)
		const discovered = yield* Arr.isReadonlyArrayNonEmpty(named)
			? namedIn(root, modules, named)
			: discover(root, modules)
		if (!Arr.isReadonlyArrayNonEmpty(discovered)) {
			return yield* LoadFailed.make({
				path: `${root}/test.config.ts`,
				message:
					"the runner config's include holds no property, so a run of it would verify nothing: a load of no property is refused"
			})
		}
		return {
			config,
			stackOf: (found) => (small.has(found.module) ? "small" : "default"),
			discovered
		}
	})

/**
 * Collects the cluster before a run whose properties declare database templates, and again once it has ended, its
 * pools closed and every worker gone: each time in this process, with the repository's services built here (its
 * PgCluster), every clone of an ended worker and every template none of the run's properties declares is dropped
 * (resources/collect.ts), so what killed runs and stale declarations left on the cluster is gone before the run clones
 * again, and a clone whose drop the server refused when its case ended (a session still in it past the drop's wait, an
 * autovacuum worker's under load) goes with the run that made it, never left to the next. A run that declares no template builds no service and collects nothing;
 * a repository that provides no cluster has nothing to collect. A collection that fails says so on stderr and the run
 * goes on: its properties' needs open, or fail, as they would.
 */
const collected = (
	config: RunnerConfig,
	root: string,
	templates: ReadonlyArray<DatabaseTemplate>
): Effect.Effect<void, never, NodeServices> =>
	Arr.isReadonlyArrayNonEmpty(templates)
		? Effect.scoped(
				Effect.gen(function* () {
					const scope = yield* Scope.Scope
					const closures = yield* moduleClosureAt(root, Option.none())
					const platform = yield* Effect.context<NodeServices>()
					const runner = Context.add(
						Context.add(
							Context.merge(Context.make(WorkerIndex, { index: 0, workers: 1 }), platform),
							ModuleClosure,
							closures
						),
						Scope.Scope,
						scope
					)
					const built = yield* Effect.provideContext(config.services, runner)
					yield* Option.match(Context.getOption(built, PgCluster), {
						onNone: () => Effect.void,
						onSome: (cluster) =>
							Effect.asVoid(collect.pipe(Effect.provideService(PgCluster, cluster)))
					})
				}).pipe(
					Effect.catchCause((cause) =>
						Console.error(
							`toolchain-test: the cluster was not collected before the run (its stale clones and templates stay): ${failureText(cause)}`
						)
					)
				)
			)
		: Effect.void

/**
 * `effect`, a run, between two collections of the cluster (collected): one before it, and one once it has ended, however
 * it ends, its pools closed and every worker gone, so a clone whose drop the server refused at its case's end (a session
 * still in it past the drop's wait) goes with the run that made it.
 */
export const collectedAround =
	(config: RunnerConfig, root: string, templates: ReadonlyArray<DatabaseTemplate>) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | NodeServices> =>
		Effect.andThen(
			collected(config, root, templates),
			Effect.ensuring(effect, collected(config, root, templates))
		)
/** A 32-bit run seed as a person writes it: decimal, or hexadecimal after `0x`. */
const SeedText = Schema.String.check(Schema.isPattern(regex("^(0x[0-9a-fA-F]{1,8}|[0-9]{1,10})$")))

/** TEST_SEED's seed, which reproduces a run, when it names one. */
export const givenSeed: Effect.Effect<
	Option.Option<number>,
	Config.ConfigError | Schema.SchemaError
> = Effect.flatMap(Config.option(Config.String("TEST_SEED")), (given) =>
	Effect.transposeOption(
		Option.map(given, (text) => Effect.map(Schema.decodeEffect(SeedText)(text), Number))
	)
)

/** A run seed drawn fresh, for a run whose seeds no key derives and TEST_SEED names none. */
export const drawnSeed: Effect.Effect<number> = Random.nextIntBetween(0, 0xffff_ffff)

/**
 * Runs a package's properties on the pool, every property's search at once, its cases spread over every worker, and
 * prints each property's verdict line the moment its search ends (a failure's case, failure and replay token under it),
 * with its time to its verdict and its wall time on the workers, so a run's first failure shows when it lands, never
 * only once the run ends:
 * loads the package's runner config and the test modules the request names, opens once, here, the run needs their
 * needs read (runner/runs.ts), forks the pool (a worker for every two
 * cores, and never more workers than the run has properties, runWorkers, so a run opens no connection it has no work
 * for, under this process's flags, the hardened flags and the config's conditions among them), and gives each
 * property's verdict. The pool is closed before it returns, every worker ended and what its needs held released (a
 * a template's clone, an owner's session), so nothing the caller runs next runs beside idle workers that still hold them.
 */
export const runPackage = (
	request: RunRequest
): Effect.Effect<RunOutcome, LoadFailed | PoolFailed, NodeServices> =>
	Effect.gen(function* () {
		const runTimed = yield* stopwatch
		const { config, discovered, stackOf } = yield* loadPackage(request.root, request.selected)
		const templates = Arr.flatMap(discovered, (found) => templatesOf(found.property.needs))
		return yield* collectedAround(
			config,
			request.root,
			templates
		)(
			Effect.scoped(
				Effect.gen(function* () {
					const opening = yield* Effect.sync(() => process.cpuUsage())
					const values = yield* openedRuns(
						runNeedsOf(Arr.map(discovered, (found) => found.property.needs)),
						request.root,
						needStallMillis
					)
					const opened = yield* Effect.sync(() => process.cpuUsage(opening))
					const runs = Arr.map(discovered, (found) => ({ found, stack: stackOf(found) }))
					const kinds = new Map(
						Arr.map(runs, ({ found, stack }) => {
							const kind = workersOf(stack, found, request.conductOf(found.id))
							return [labelOfWorkers(kind), kind] as const
						})
					)
					const weighed = Arr.map(Arr.fromIterable(kinds), ([label, kind]) => ({
						label,
						kind,
						properties: Arr.filter(
							runs,
							({ found, stack }) =>
								labelOfWorkers(workersOf(stack, found, request.conductOf(found.id))) === label
						).length
					}))
					const shared = Arr.isReadonlyArrayNonEmpty(weighed)
						? placesShared(
								runWorkers(runs.length),
								Arr.map(weighed, ({ properties }) => properties)
							)
						: []
					const pools = new Map<string, Pool>()
					for (const [{ label, kind }, places] of Arr.zip(weighed, shared)) {
						const [stack, guide] = kind
						const pool = yield* poolOf({
							entry: WORKER_ENTRY,
							root: request.root,
							cwd: request.root,
							env: workerEnvironmentOf(config.environment, process.env),
							compile: sharedStore,
							places,
							execArgv: flagsOf(stack),
							served: Option.none(),
							guide,
							runs: values,
							stall: needStallMillis,
							bounding: "summed"
						})
						pools.set(label, pool)
					}
					const properties = yield* Effect.forEach(
						runs,
						({ found, stack }) =>
							Effect.gen(function* () {
								const propertyTimed = yield* stopwatch
								const label = labelOf(found.id, stack)
								const pool = yield* Effect.mapError(
									Effect.fromOption(
										Option.fromUndefinedOr(
											pools.get(
												labelOfWorkers(workersOf(stack, found, request.conductOf(found.id)))
											)
										)
									),
									() => PoolFailed.make({ message: `no pool was forked for ${label}` })
								)
								const evaluator = pool.evaluator
								const verdict = yield* found.property.search({
									id: label,
									seed: request.seedOf(found.id),
									limits: runnerLimits,
									evaluator,
									reach: request.reach
								})
								yield* pool.retire(label)
								const landed = yield* propertyTimed.elapsed
								const usage = yield* pool.usage
								const observed = yield* pool.observed(label)
								const wall = Arr.reduce(
									Arr.filter(usage.properties, (one) => one.label === label),
									0,
									(sum, one) => sum + one.casesWall + one.readyingWall
								)
								yield* Console.log(
									Arr.join(
										[
											`${lineOf(label, found.property.oracle, verdict)}; ${landedText(landed, wall)}`,
											...Option.match(observed.unclean, {
												onNone: () => {
													const reads = Arr.reduce(observed.traces, 0, (sum, one) => sum + one.upTo)
													return reads > 0
														? [
																`  its verdict is kept with the trace of ${reads} reads its workers made at run time, and answers while they read alike`
															]
														: []
												},
												onSome: (observation) => [
													`  observed past its key, so its verdict is never cached: ${observationText(observation)}`
												]
											}),
											...failureLines(verdict)
										],
										"\n"
									)
								)
								return {
									id: found.id,
									stack,
									label,
									module: found.module,
									kind: found.property.kind,
									oracle: found.property.oracle,
									verdict,
									millis: landed,
									observed
								}
							}),
						{ concurrency: "unbounded" }
					)
					const counted = yield* Effect.forEach(
						Arr.fromIterable(pools.values()),
						(pool) => pool.cases
					)
					const held = yield* Effect.forEach(Arr.fromIterable(pools.values()), (pool) => pool.held)
					const usages = yield* Effect.forEach(
						Arr.fromIterable(pools.values()),
						(pool) => pool.usage
					)
					const parent = yield* Effect.sync(() => process.cpuUsage())
					const ran = yield* runTimed.elapsed
					return {
						properties,
						millis: ran,
						workers: Arr.flatten(counted),
						held: Arr.flatten(held),
						usage: {
							parent: (parent.user + parent.system) / 1000,
							runNeeds: (opened.user + opened.system) / 1000,
							properties: Arr.flatMap(usages, (usage) => usage.properties),
							workers: Arr.flatMap(usages, (usage) => usage.workers),
							children: Arr.every(usages, (usage) => usage.children === "stated")
								? ("stated" as const)
								: ("unstated" as const)
						}
					}
				})
			)
		)
	})

/**
 * The property a token's id names, loaded from its module under `root`, and a run of it on a pool of one worker under
 * the run's flags and services; none, with the module, when the module holds no such property.
 */
const tokenPropertyOf = (
	root: string,
	id: string
): Effect.Effect<
	Readonly<{
		module: string
		found: Option.Option<Readonly<{ property: Property; run: SearchRun }>>
	}>,
	LoadFailed | PoolFailed,
	Scope.Scope | NodeServices
> =>
	Effect.gen(function* () {
		const config = yield* configOf(root)
		const named = runOfLabel(id)
		const module = moduleOfArgument(named.id)
		const loaded = yield* discover(root, [module])
		const found = Arr.filter(loaded, (discovered) => discovered.id === named.id)
		const values = yield* openedRuns(
			runNeedsOf(Arr.map(found, (discovered) => discovered.property.needs)),
			root,
			needStallMillis
		)
		const pool = yield* poolOf({
			entry: WORKER_ENTRY,
			root,
			cwd: root,
			env: workerEnvironmentOf(config.environment, process.env),
			compile: sharedStore,
			places: placesOf(widthOf(1)),
			execArgv: flagsOf(named.stack),
			served: Option.none(),
			guide: "notes",
			runs: values,
			stall: needStallMillis,
			bounding: "summed"
		})
		return {
			module,
			found: Option.map(Arr.head(found), (discovered) => ({
				property: discovered.property,
				run: {
					id,
					seed: 0,
					limits: runnerLimits,
					evaluator: pool.evaluator,
					reach: "full"
				} as const
			}))
		}
	})

/** Replays one token on a pool of one worker: the case it names, as it ran, under the run's flags and services. */
export const replayToken = (
	root: string,
	id: string,
	token: string
): Effect.Effect<
	Readonly<{ id: string; oracle: Oracle; verdict: Verdict }>,
	LoadFailed | PoolFailed,
	Scope.Scope | NodeServices
> =>
	Effect.flatMap(tokenPropertyOf(root, id), ({ module, found }) =>
		Option.match(found, {
			onNone: () =>
				Effect.succeed({
					id,
					oracle: { kind: "unstated" } as const,
					verdict: {
						kind: "failed",
						finding: {
							kind: "stale",
							phase: "replayed",
							where: "the token",
							why: `${id} names no property of ${module}`
						}
					} as const
				}),
			onSome: ({ property, run }) =>
				Effect.map(property.replay(run, token), (verdict) => ({
					id,
					oracle: property.oracle,
					verdict
				}))
		})
	)

/**
 * Migrates one kept token on a pool of one worker (search.ts translate): the case it names, run on its values written
 * before a weighted decision recorded its option, read as they were meant, kept as a case records them now.
 */
export const translateToken = (
	root: string,
	id: string,
	token: string
): Effect.Effect<Translation, LoadFailed | PoolFailed, Scope.Scope | NodeServices> =>
	Effect.flatMap(tokenPropertyOf(root, id), ({ module, found }) =>
		Option.match(found, {
			onNone: () =>
				Effect.succeed<Translation>({
					kind: "untranslated",
					why: `${id} names no property of ${module}`
				}),
			onSome: ({ property, run }) => property.translate(run, token)
		})
	)
