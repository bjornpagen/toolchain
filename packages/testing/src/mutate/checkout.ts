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
 * The CPU Checkout.dir's open may spend (property.ts Need budget): it reads this process's directory and makes nothing.
 *
 * @limitKind measured
 * @owner the testing library (mutate/checkout.ts Checkout.dir)
 * @unit milliseconds of CPU
 * @scope each open of Checkout.dir on a process, alone or in the group of needs it opens at once with
 * @evidence ~/Documents/toolchain/packages/testing/out/need-budget/20261121T132823/ (written in lane NEEDBUDGET's
 *   ~/.cache/toolchain/needbudget and copied there), the uncommitted record of `sh run.sh` in it: probe.mjs, which opens
 *   the need 300 times in a fresh scope each and reads its process tree's CPU before and after each open as the
 *   library's judge does (runner/work.ts ownWork); alone-*.json and together-*.json, every open's CPU and wall
 *   milliseconds; summary.txt and environment.txt
 * @observed 2026-11-21 13:35:48 to 13:36:11 UTC
 * @environment cassowary, Ubuntu 26.04 (Linux 7.0.0-1018-aws) on an AWS Graviton3 (arm64) instance with 64 logical
 *   CPUs and 247 GiB, Node 26.13.1; load average 394 to 447 and CPU pressure (some avg10) 81 to 86 % from other sessions;
 *   toolchain a6172d026 with lane NEEDBUDGET's change
 * @workload 300 opens a process, one after another: three processes alone, then four at once
 * @result 2,100 opens: CPU p50 0.14 ms, p99 2.0 ms alone and 1.3 ms at once, slowest 6.0 ms; no open failed
 * @decision 1 s: 168 times the slowest open measured. An open past it is a runaway (nothing it does can take long),
 *   and in a group it adds a second to a sum a template's budget dominates. Unmeasured: a process whose cwd is on a
 *   slow filesystem
 * @revalidate a change to what the open does, a Node upgrade, another machine
 */
const checkoutDirBudgetMillis = 1000

/**
 * A property whose check runs the repository's code in a child process (a command line, a server, a compiler reading
 * the sources) needs the directory to run it from, and says so by needing it: `needs: { checkout: Checkout.dir }`. A
 * mutant reaches such a check only on disk, so the mutator runs the property's kills and mutants in worker trees, whose
 * directory this is; any other property loads its mutants through the module hook of its own workers.
 */
export const Checkout: Readonly<{ dir: Need<CheckoutDir> }> = {
	dir: {
		key: CHECKOUT_DIR,
		budget: checkoutDirBudgetMillis,
		runNeeds: [],
		open: Effect.succeed(Effect.sync(() => checkoutDir(process.cwd())))
	}
}

/**
 * How a property's workers load the repository's code: in process, where its mutants reach them through the module
 * hook (hook.ts), or from a worker tree, for a property that needs Checkout.dir or reads a run need, which opens in
 * the runner's process from the directory its workers run in (property.ts RunNeed), so a mutant reaches it on disk
 * alone.
 */
export type Loading = "in-process" | "tree"

/** How the workers of a property with these needs load the repository's code. */
export const loadingOf = (needs: Needs): Loading =>
	Arr.some(
		Rec.values(needs),
		(need) => need.key === CHECKOUT_DIR || Arr.isReadonlyArrayNonEmpty(need.runNeeds)
	)
		? "tree"
		: "in-process"
