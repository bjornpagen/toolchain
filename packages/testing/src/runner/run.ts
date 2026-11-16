import {
	Array as Arr,
	Effect,
	type FileSystem,
	Option,
	type Path,
	type Scope,
	String as Str
} from "effect"
import type { Oracle } from "#explore.ts"
import { liveMillis } from "#live.ts"
import type { Kill, PropertyId, PropertyKind } from "#property.ts"
import { type RunnerConfig, SMALL_STACK } from "#runner/config.ts"
import { runnerLimits } from "#runner/limits.ts"
import { configOf, type Discovered, discover, type LoadFailed, matchedBy } from "#runner/load.ts"
import { type Pool, PoolFailed, poolOf } from "#runner/pool.ts"
import type { Reach, Verdict } from "#runner/protocol.ts"
import { labelOf, runOfLabel, type Stack } from "#runner/stack.ts"
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

/** A whole run: each property's run in discovery order, the run's wall time, and how many cases each worker ran. */
export type RunOutcome = Readonly<{
	properties: ReadonlyArray<PropertyRun>
	millis: number
	workers: ReadonlyArray<number>
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

/** The worker's entry module, beside this one. */
export const WORKER_ENTRY = `${import.meta.dirname}/worker.ts`

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
 * stacks each runs on (the default, and the small stack for a module its config's smallStack names).
 */
type Loaded = Readonly<{
	config: RunnerConfig
	discovered: ReadonlyArray<Discovered>
	stacksOf: (found: Discovered) => ReadonlyArray<Stack>
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
			stacksOf: (found) => (small.has(found.module) ? ["default", "small"] : ["default"]),
			discovered: Arr.filter(
				loaded,
				(found) =>
					!Arr.isReadonlyArrayNonEmpty(selected) ||
					Arr.some(selected, (argument) => names(argument, found))
			)
		}
	})

/**
 * Runs a package's properties on the pool, every property's search at once, its cases spread over every worker:
 * loads the package's runner config and the test modules the request names, forks the pool (one worker a core, under
 * this process's flags, the hardened flags and the config's conditions among them), and gives each property's verdict.
 */
export const runPackage = (
	request: RunRequest
): Effect.Effect<
	RunOutcome,
	LoadFailed | PoolFailed,
	Scope.Scope | FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const began = yield* liveMillis
		const { discovered, stacksOf } = yield* loadPackage(request.root, request.selected)
		const runs = Arr.flatMap(discovered, (found) =>
			Arr.map(stacksOf(found), (stack) => ({ found, stack }))
		)
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
				workers: testWorkers,
				execArgv: flagsOf(stack),
				guide
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
		const workers = Arr.flatten(counted)
		const ended = yield* liveMillis
		return { properties, millis: ended - began, workers }
	})

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
			workers: 1,
			execArgv: flagsOf(named.stack),
			guide: "notes"
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
