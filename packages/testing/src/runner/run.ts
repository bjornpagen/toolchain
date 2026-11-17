import type { NodeServices } from "@effect/platform-node/NodeServices"
import {
	Array as Arr,
	Console,
	Context,
	Effect,
	type FileSystem,
	Option,
	type Path,
	Scope,
	String as Str
} from "effect"
import type { Oracle } from "#explore.ts"
import { failureText } from "#failure.ts"
import { liveMillis } from "#live.ts"
import type { Kill, PropertyId, PropertyKind } from "#property.ts"
import { PgCluster } from "#resources/cluster.ts"
import { collect, templatesOf } from "#resources/collect.ts"
import type { DatabaseTemplate } from "#resources/template.ts"
import { type RunnerConfig, SMALL_STACK } from "#runner/config.ts"
import { runnerLimits } from "#runner/limits.ts"
import { configOf, type Discovered, discover, type LoadFailed, matchedBy } from "#runner/load.ts"
import { moduleClosureAt } from "#runner/module-closure.ts"
import { type Pool, PoolFailed, placesOf, poolOf } from "#runner/pool.ts"
import type { Reach, Verdict } from "#runner/protocol.ts"
import { ModuleClosure, WorkerIndex } from "#runner/services.ts"
import { labelOf, runOfLabel, type Stack } from "#runner/stack.ts"
import type { RunUsage } from "#runner/usage.ts"
import { testWorkers } from "#workers.ts"

/**
 * A run of a package's properties on the pool, as every command reads it: which properties, by identity or module, at
 * what reach and on what run seed; and what each property's search concluded. `toolchain-test run` prints it; a
 * command that judges kills or caches verdicts reads the same results.
 */

/**
 * One property's run: its identity, the stack it ran on and the label that names both (`<id>`, or `<id>@small-stack`),
 * its module, its kind, its oracle and kills, its verdict and its wall time.
 */
export type PropertyRun = Readonly<{
	id: PropertyId
	stack: Stack
	label: string
	module: string
	kind: PropertyKind
	oracle: Oracle
	kills: ReadonlyArray<Kill>
	verdict: Verdict
	millis: number
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

/**
 * What to run: the package root, the run seed, the reach (every phase, or the witnesses alone), and which properties:
 * every one, or those the arguments name, each a module path or a directory of them (a prefix of a module's path), or
 * a property identity (`<module>#<export>`, which names a family's every member too).
 */
export type RunRequest = Readonly<{
	root: string
	seed: number
	reach: Reach
	selected: ReadonlyArray<string>
}>

/** The worker's entry module, beside this one (runner/worker-entry.ts, which runs runner/worker.ts). */
export const WORKER_ENTRY = `${import.meta.dirname}/worker-entry.ts`

/**
 * Which workers a run's cases go to: its stack, and whether they start V8's precise coverage before loading any module
 * (a guided property's), so only a guided property's workers pay for counting blocks.
 */
type Workers = readonly [stack: Stack, guide: "notes" | "blocks"]

/** The workers a property's run on `stack` takes its cases to. */
const workersOf = (stack: Stack, found: Discovered): Workers => [stack, found.property.guide.kind]

/** A kind of workers as a key. */
const labelOfWorkers = ([stack, guide]: Workers): string => `${stack}/${guide}`

/** The flags a stack's workers run under: this process's, and the small stack's on top for the small stack. */
const flagsOf = (stack: Stack): ReadonlyArray<string> => {
	switch (stack) {
		case "default":
			return process.execArgv
		case "small":
			return [...process.execArgv, SMALL_STACK]
	}
}

/** Whether an argument names a property, by identity or by module. */
const names = (argument: string, discovered: Discovered): boolean =>
	Str.includes("#")(argument)
		? discovered.id === argument || Str.startsWith(`${argument}/`)(discovered.id)
		: Str.startsWith(argument)(discovered.module)

/** The module part of an argument: an identity's module, or the argument, a module or a directory. */
const moduleOfArgument = (argument: string): string =>
	Option.match(Str.indexOf("#")(argument), {
		onNone: () => argument,
		onSome: (hash) => Str.slice(0, hash)(argument)
	})

/**
 * A package as a command loads it: its runner config, the properties the arguments name, in discovery order, and the
 * one stack each runs on: the small stack for a module its config's smallStack names, the default for every other.
 */
type Loaded = Readonly<{
	config: RunnerConfig
	discovered: ReadonlyArray<Discovered>
	stackOf: (found: Discovered) => Stack
}>

/**
 * Loads a package's runner config and the properties `selected` names (every property when it names none): only the
 * test modules an argument names are imported.
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
		const wanted = Arr.isReadonlyArrayNonEmpty(selected)
			? Arr.filter(modules, (module) =>
					Arr.some(selected, (argument) => {
						const named = moduleOfArgument(argument)
						return Str.includes("#")(argument) ? module === named : Str.startsWith(named)(module)
					})
				)
			: modules
		const loaded = yield* discover(root, wanted)
		return {
			config,
			stackOf: (found) => (small.has(found.module) ? "small" : "default"),
			discovered: Arr.filter(
				loaded,
				(found) =>
					!Arr.isReadonlyArrayNonEmpty(selected) ||
					Arr.some(selected, (argument) => names(argument, found))
			)
		}
	})

/**
 * Collects the cluster before a run whose properties declare database templates: once, in this process, with the
 * repository's services built here (its PgCluster), every clone of an ended worker and every template none of the run's
 * properties declares is dropped (resources/collect.ts), so what killed runs and stale declarations left on the
 * cluster is gone before the run clones again. A run that declares no template builds no service and collects nothing;
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
							Effect.asVoid(
								collect(templates).pipe(
									Effect.provideService(PgCluster, cluster),
									Effect.provideService(ModuleClosure, closures)
								)
							)
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
 * Runs a package's properties on the pool, every property's search at once, its cases spread over every worker:
 * loads the package's runner config and the test modules the request names, forks the pool (one worker a core, under
 * this process's flags, the hardened flags and the config's conditions among them), and gives each property's verdict.
 * The pool is closed before it returns, every worker ended and what its needs held released (a lease's permit, a
 * seat's clone), so what the caller runs next (the kills' trials of `run` and `affected`, on workers of their own)
 * finds them free: a pool left open past its properties held every lease its workers had drawn while the kills' trials
 * waited for one (GZ-NETWORK: a run of 32 network modules hung, 64 idle workers holding their leases and five trials
 * of one worker each waiting on the lease gate).
 */
export const runPackage = (
	request: RunRequest
): Effect.Effect<RunOutcome, LoadFailed | PoolFailed, NodeServices> =>
	Effect.scoped(
		Effect.gen(function* () {
			const began = yield* liveMillis
			const { config, discovered, stackOf } = yield* loadPackage(request.root, request.selected)
			yield* collected(
				config,
				request.root,
				Arr.flatMap(discovered, (found) => templatesOf(found.property.needs))
			)
			const runs = Arr.map(discovered, (found) => ({ found, stack: stackOf(found) }))
			const kinds = new Map(
				Arr.map(runs, ({ found, stack }) => {
					const kind = workersOf(stack, found)
					return [labelOfWorkers(kind), kind] as const
				})
			)
			const pools = new Map<string, Pool>()
			for (const [label, [stack, guide]] of kinds) {
				const pool = yield* poolOf({
					entry: WORKER_ENTRY,
					root: request.root,
					cwd: request.root,
					env: {},
					places: placesOf(testWorkers),
					execArgv: flagsOf(stack),
					served: Option.none(),
					guide,
					open: runnerLimits.open
				})
				pools.set(label, pool)
			}
			const properties = yield* Effect.forEach(
				runs,
				({ found, stack }) =>
					Effect.gen(function* () {
						const start = yield* liveMillis
						const label = labelOf(found.id, stack)
						const pool = yield* Effect.mapError(
							Effect.fromOption(
								Option.fromUndefinedOr(pools.get(labelOfWorkers(workersOf(stack, found))))
							),
							() => PoolFailed.make({ message: `no pool was forked for ${label}` })
						)
						const evaluator = pool.evaluator
						const verdict = yield* found.property.search({
							id: label,
							seed: request.seed,
							limits: runnerLimits,
							evaluator,
							reach: request.reach
						})
						yield* pool.retire(label)
						const end = yield* liveMillis
						return {
							id: found.id,
							stack,
							label,
							module: found.module,
							kind: found.property.kind,
							oracle: found.property.oracle,
							kills: found.property.kills,
							verdict,
							millis: end - start
						}
					}),
				{ concurrency: "unbounded" }
			)
			const counted = yield* Effect.forEach(Arr.fromIterable(pools.values()), (pool) => pool.cases)
			const held = yield* Effect.forEach(Arr.fromIterable(pools.values()), (pool) => pool.held)
			const usages = yield* Effect.forEach(Arr.fromIterable(pools.values()), (pool) => pool.usage)
			const parent = yield* Effect.sync(() => process.cpuUsage())
			const ended = yield* liveMillis
			return {
				properties,
				millis: ended - began,
				workers: Arr.flatten(counted),
				held: Arr.flatten(held),
				usage: {
					parent: (parent.user + parent.system) / 1000,
					properties: Arr.flatMap(usages, (usage) => usage.properties),
					workers: Arr.flatMap(usages, (usage) => usage.workers),
					children: Arr.every(usages, (usage) => usage.children === "stated")
						? "stated"
						: "unstated"
				}
			}
		})
	)

/** Replays one token on a pool of one worker: the case it names, as it ran, under the run's flags and services. */
export const replayToken = (
	root: string,
	id: string,
	token: string
): Effect.Effect<
	Readonly<{ id: string; oracle: Oracle; verdict: Verdict }>,
	LoadFailed | PoolFailed,
	Scope.Scope | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		yield* configOf(root)
		const named = runOfLabel(id)
		const module = moduleOfArgument(named.id)
		const loaded = yield* discover(root, [module])
		const found = Arr.filter(loaded, (discovered) => discovered.id === named.id)
		const pool = yield* poolOf({
			entry: WORKER_ENTRY,
			root,
			cwd: root,
			env: {},
			places: placesOf(1),
			execArgv: flagsOf(named.stack),
			served: Option.none(),
			guide: "notes",
			open: runnerLimits.open
		})
		return yield* Option.match(Arr.head(found), {
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
			onSome: (discovered) =>
				Effect.map(
					discovered.property.replay(
						{ id, seed: 0, limits: runnerLimits, evaluator: pool.evaluator, reach: "full" },
						token
					),
					(verdict) => ({ id, oracle: discovered.property.oracle, verdict })
				)
		})
	})
