import { type Effect, Option, Schema, type Scope, String as Str } from "effect"
import type { MutatedFile, RealPath } from "#mutate/mutated.ts"
import type { CompileStore } from "#runner/compile-cache.ts"
import type { Evaluator } from "#runner/protocol.ts"

/**
 * What the mutator needs of the runner's pool (lane CORE's runner/pool.ts), and nothing more: an evaluator over workers
 * started fresh from an image it gives, and the pool's width. A mutant is a worker image, never a message, so a worker
 * that loaded one mutant never evaluates an unmutated case or another mutant's.
 */

/**
 * A mutant a worker's module hook serves in place of its file (hook.ts): the mutant, and the file of the run's directory
 * holding its text, which the hook reads. The pool both starts its workers with the hook (servedArgv) and hashes the
 * closures it answers them with over the files as they load them, the mutant's text in place of its file's
 * (runner/module-closure.ts), from this one value: so a template a worker builds under a mutant is named by the code
 * that built it (resources/template.ts identify), never by the checkout's.
 */
export type Served = Readonly<{ mutant: MutatedFile; textFile: string }>

/** A string as a JavaScript string literal that decodes to it: its URI encoding holds no quote and no backslash. */
const literal = (text: string) => `decodeURIComponent("${encodeURIComponent(text)}")`

/**
 * What Node runs before a worker's entry to serve `served`: an `--import` of a data: URL whose module calls the hook
 * (hook.ts) with the mutant's file and the file holding its text, so the worker reads them from its own command line and
 * nothing else; nothing for a worker that serves none.
 */
export const servedArgv = (served: Option.Option<Served>): ReadonlyArray<string> =>
	Option.match(served, {
		onNone: () => [],
		onSome: ({ mutant, textFile }) => [
			"--import",
			`data:text/javascript,${encodeURIComponent(
				`const { serve } = await import(${literal(import.meta.resolve("#mutate/hook.ts"))}); serve(${literal(mutant.target)}, ${literal(textFile)})`
			)}`
		]
	})

/**
 * How a fresh worker starts. `root` is the repository root its modules load from: the checkout's, or a worker tree's
 * (tree.ts). A module the runner knows at `<checkout>/<path>`, the worker's own entry included, loads from
 * `<root>/<path>`, and the worker runs in `<root>/<the package's path>`, so a check that runs the repository's code in a
 * child process runs the tree's. `served` is the mutant its module hook serves (Served), or none: a worker tree holds
 * its mutant on disk. `env` is what the worker's environment adds to the runner's: NODE_V8_COVERAGE for a coverage
 * pass, whose dump the worker writes as it exits, so a lease ends its workers by letting them exit, never by a signal.
 * `compile` is the store its workers keep Node's compile cache in (runner/compile-cache.ts): toolchain-test's for the
 * checkout, whose later runs reuse it, and the run's own for a worker tree, whose path no later run has.
 */
export type WorkerImage = Readonly<{
	root: RealPath
	served: Option.Option<Served>
	env: Readonly<Record<string, string>>
	compile: CompileStore
}>

/**
 * Where a file the runner knows in the checkout stands for a worker whose image's root is `root`: `<root>/<path>` for
 * the file at `<checkout>/<path>`, the root itself for the checkout (a package whose root is the repository's), and the
 * file as it is when it lies outside the checkout (an installed package, Node's own).
 */
export const rebasedTo =
	(checkout: string, root: string) =>
	(file: string): string => {
		if (file === checkout) {
			return root
		}
		return Str.startsWith(`${checkout}/`)(file)
			? `${root}/${Str.slice(checkout.length + 1)(file)}`
			: file
	}

/**
 * No worker of a lease started from its image: each ended before it was ready, as one does when a mutant (or a probe)
 * throws while the worker loads its own modules. Under a mutant's image this is a verdict, the program no longer
 * starts, which turns the property red; it is never the run's failure.
 */
export class Unstarted extends Schema.TaggedError<Unstarted, { readonly brand: unique symbol }>()(
	"Unstarted",
	{ message: Schema.String }
) {}

/**
 * The runner's pool as the mutator schedules it: its width (one worker a core, the Limit the runner reads), and a
 * lease: an evaluator over `workers` workers started fresh from `image` for the enclosing scope, which every batch it is
 * given runs on and no other lease's batch ever does (no stealing across leases); a worker the case deadline ends is
 * started again from the same image, and closing the scope ends them all; or Unstarted, when no worker starts. `guide`
 * is "blocks" when a property the lease serves guides its search by blocks, so its workers start V8's coverage before
 * they load a module, as a run's do (runner/run.ts); otherwise "notes". The mutator never leases more workers at once
 * than the width (schedule.ts).
 */
export type MutantPool<E> = Readonly<{
	width: number
	lease: (
		image: WorkerImage,
		workers: number,
		guide: "notes" | "blocks"
	) => Effect.Effect<Evaluator, E | Unstarted, Scope.Scope>
}>
