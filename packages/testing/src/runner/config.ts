import type { NodeServices } from "@effect/platform-node/NodeServices"
import { type Cause, type Context, Effect, Layer, Schema, type Scope } from "effect"
import { failureText } from "#failure.ts"
import type { Family as OperatorFamily } from "#mutants.ts"
import type { RunnerServices } from "#property.ts"
import type { WorkerIndex } from "#runner/services.ts"

/**
 * The flags every process of a run runs under, the parent and each worker: no `__proto__` accessor and no inspector
 * opened on SIGUSR1; a deprecated Node API, a pending deprecation included, throws instead of warning; only
 * context-aware native addons load; no module resolves from the global folders; and an unhandled rejection is an
 * uncaught exception. V8's JIT and code generation from strings stay on.
 */
export const HARDENED_FLAGS: ReadonlyArray<string> = [
	"--disable-proto=delete",
	"--disable-sigusr1",
	"--throw-deprecation",
	"--pending-deprecation",
	"--force-context-aware",
	"--no-global-search-paths",
	"--unhandled-rejections=strict"
]

/** What the runner provides every need itself: the platform and the worker's index. */
export type RunnerProvided = NodeServices | WorkerIndex

/** The services a repository's runner config provides through its layer: every RunnerServices entry it declares. */
export type RepositoryServices = Exclude<RunnerServices[keyof RunnerServices], RunnerProvided>

/** A repository's runner services failed to build: every need that would have used them fails with this. */
export class RunnerServicesFailed extends Schema.TaggedError<
	RunnerServicesFailed,
	{ readonly brand: unique symbol }
>()("RunnerServicesFailed", { message: Schema.String }) {}

/**
 * A package's runner config, `test.config.ts`'s default export: which files are its test modules (globs from the
 * package root), the export conditions its code resolves with (on every process of the run), its services, built
 * from its layer in a worker the first time a case there opens a need, so a run whose needs use no service (unit
 * properties) never builds them, and the operator families its mutation runs add to the library's operators (mutants.ts
 * Family: a domain's slips, such as the SQL a compiler prints). Its class is how the runner tells it from any other
 * default export.
 */
export class RunnerConfig {
	readonly include: ReadonlyArray<string>
	readonly conditions: ReadonlyArray<string>
	readonly families: ReadonlyArray<OperatorFamily<string>>
	readonly services: Effect.Effect<
		Context.Context<RepositoryServices>,
		RunnerServicesFailed,
		Scope.Scope | RunnerProvided
	>

	constructor(
		include: ReadonlyArray<string>,
		conditions: ReadonlyArray<string>,
		families: ReadonlyArray<OperatorFamily<string>>,
		services: RunnerConfig["services"]
	) {
		this.include = include
		this.conditions = conditions
		this.families = families
		this.services = services
	}
}

/**
 * What a package states in its test.config.ts: its test modules, its export conditions, its services' layer, and its
 * mutation runs' operator families (none for the library's operators alone).
 */
export type RunnerSpec<E> = Readonly<{
	include: ReadonlyArray<string>
	conditions: ReadonlyArray<string>
	layer: Layer.Layer<RepositoryServices, E, RunnerProvided>
	families: ReadonlyArray<OperatorFamily<string>>
}>

/** The failure of a layer that would not build, as its message states it. */
const servicesFailed = <E>(cause: Cause.Cause<E>) =>
	RunnerServicesFailed.make({ message: failureText(cause) })

/**
 * A package's runner config: `export default defineRunner({ include: ["src/**\/*.test.ts"], conditions: [], layer,
 * families: [] })`, where `layer` provides the RunnerServices the repository declares (Layer.empty when it declares
 * none). There is no
 * worker, width or timeout option: a run is one worker a core, and budgets are the runner's Limits.
 */
export const defineRunner = <E>(spec: RunnerSpec<E>): RunnerConfig =>
	new RunnerConfig(
		spec.include,
		spec.conditions,
		spec.families,
		Effect.catchCause(Layer.build(spec.layer), (cause) => Effect.fail(servicesFailed(cause)))
	)
