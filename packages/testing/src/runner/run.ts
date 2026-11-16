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
import { runnerLimits } from "#runner/limits.ts"
import { configOf, type Discovered, discover, type LoadFailed, modulesOf } from "#runner/load.ts"
import { type PoolFailed, poolOf } from "#runner/pool.ts"
import type { Reach, Verdict } from "#runner/protocol.ts"
import { testWorkers } from "#workers.ts"

/**
 * A run of a package's properties on the pool, as every command reads it: which properties, by identity or module, at
 * what reach and on what run seed; and what each property's search concluded. `toolchain-test run` prints it; a
 * command that judges kills or caches verdicts reads the same results.
 */

/** One property's run: its identity, its module, its kind, its oracle and kills, its verdict and its wall time. */
export type PropertyRun = Readonly<{
	id: PropertyId
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
		const config = yield* configOf(request.root)
		const modules = yield* modulesOf(request.root, config)
		const wanted = Arr.isReadonlyArrayNonEmpty(request.selected)
			? Arr.filter(modules, (module) =>
					Arr.some(request.selected, (argument) => {
						const named = moduleOfArgument(argument)
						return Str.includes("#")(argument) ? module === named : Str.startsWith(named)(module)
					})
				)
			: modules
		const loaded = yield* discover(request.root, wanted)
		const discovered = Arr.filter(
			loaded,
			(found) =>
				!Arr.isReadonlyArrayNonEmpty(request.selected) ||
				Arr.some(request.selected, (argument) => names(argument, found))
		)
		const pool = yield* poolOf({
			root: request.root,
			workers: testWorkers,
			execArgv: process.execArgv,
			guide: Arr.some(discovered, (found) => found.property.guide.kind === "blocks")
				? "blocks"
				: "notes"
		})
		const properties = yield* Effect.forEach(
			discovered,
			(found) =>
				Effect.gen(function* () {
					const start = yield* liveMillis
					const verdict = yield* found.property.search({
						id: found.id,
						seed: request.seed,
						limits: runnerLimits,
						evaluator: pool.evaluator,
						reach: request.reach
					})
					const end = yield* liveMillis
					return {
						id: found.id,
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
		const workers = yield* pool.cases
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
		const module = moduleOfArgument(id)
		const loaded = yield* discover(root, [module])
		const found = Arr.filter(loaded, (discovered) => discovered.id === id)
		const pool = yield* poolOf({
			root,
			workers: 1,
			execArgv: process.execArgv,
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
