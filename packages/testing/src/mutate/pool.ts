import type { Effect, Scope } from "effect"
import type { RealPath } from "#mutate/mutated.ts"
import type { Evaluator } from "#runner/protocol.ts"

/**
 * What the mutator needs of the runner's pool (lane CORE's runner/pool.ts), and nothing more: an evaluator over workers
 * started fresh from an image it gives, and the pool's width. A mutant is a worker image, never a message, so a worker
 * that loaded one mutant never evaluates an unmutated case or another mutant's.
 */

/**
 * How a fresh worker starts. `root` is the repository root its modules load from: the checkout's, or a worker tree's
 * (tree.ts). A module the runner knows at `<checkout>/<path>`, the worker's own entry included, loads from
 * `<root>/<path>`, and the worker runs in `<root>/<the package's path>`, so a check that runs the repository's code in a
 * child process runs the tree's. `execArgv` is what Node runs before the worker's entry: a mutant's module hook
 * (hook.ts), or nothing. `env` is what the worker's environment adds to the runner's: NODE_V8_COVERAGE for a coverage
 * pass, whose dump the worker writes as it exits, so a lease ends its workers by letting them exit, never by a signal.
 */
export type WorkerImage = Readonly<{
	root: RealPath
	execArgv: ReadonlyArray<string>
	env: Readonly<Record<string, string>>
}>

/**
 * The runner's pool as the mutator schedules it: its width (one worker a core, the Limit the runner reads), and a
 * lease: an evaluator over `workers` workers started fresh from `image` for the enclosing scope, which every batch it is
 * given runs on and no other lease's batch ever does (no stealing across leases); a worker the case deadline ends is
 * started again from the same image, and closing the scope ends them all. The mutator never leases more workers at
 * once than the width (schedule.ts).
 */
export type MutantPool<E> = Readonly<{
	width: number
	lease: (image: WorkerImage, workers: number) => Effect.Effect<Evaluator, E, Scope.Scope>
}>
