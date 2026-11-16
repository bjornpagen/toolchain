import { Array as Arr, Brand, Effect, Record as Rec } from "effect"
import type { Need, Needs } from "#property.ts"

/**
 * The directory a worker runs in: the package's directory in the checkout, or, under a mutant whose property runs the
 * repository's code in child processes, in a worker tree (tree.ts) that holds the mutant on disk.
 */
export type CheckoutDir = string & Brand.Brand<"CheckoutDir">

const checkoutDir = Brand.nominal<CheckoutDir>()

/** The key of Checkout.dir, by which the mutator knows a property that needs it. */
const CHECKOUT_DIR = "bjornpagen.testing.checkout-dir"

/**
 * A property whose check runs the repository's code in a child process (a command line, a server, a compiler reading
 * the sources) needs the directory to run it from, and says so by needing it: `needs: { checkout: Checkout.dir }`. A
 * mutant reaches such a check only on disk, so the mutator runs the property's kills and mutants in worker trees, whose
 * directory this is; any other property loads its mutants through the module hook of its own workers.
 */
export const Checkout: Readonly<{ dir: Need<CheckoutDir> }> = {
	dir: {
		key: CHECKOUT_DIR,
		open: Effect.succeed(Effect.sync(() => checkoutDir(process.cwd())))
	}
}

/**
 * How a property's workers load the repository's code: in process, where its mutants reach them through the module
 * hook (hook.ts), or from a worker tree, for a property that needs Checkout.dir.
 */
export type Loading = "in-process" | "tree"

/** How the workers of a property with these needs load the repository's code. */
export const loadingOf = (needs: Needs): Loading =>
	Arr.some(Rec.values(needs), (need) => need.key === CHECKOUT_DIR) ? "tree" : "in-process"
