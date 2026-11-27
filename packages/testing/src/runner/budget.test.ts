import { Array as Arr, Effect } from "effect"
import { assert } from "#assert.ts"
import { Checkout } from "#mutate/checkout.ts"
import { property } from "#property.ts"
import { Scratch } from "#resources/scratch.ts"
import {
	budgetedRun,
	budgetEndOf,
	budgets,
	readyingBurns,
	readyingRun,
	runNeedBurns,
	runNeedRun,
	startsRun,
	startWorkers,
	WORKER_START_BUDGET
} from "#runner/budget.fixtures.ts"

/**
 * A run spends at most both parts of its runner config's CPU budget (runner/config.ts RunBudget): the consumer's
 * `toolchain-test run` under its measured budget passes and says nothing of it; under a run budget of none, 0 ms, it
 * fails in one line naming the CPU its own JSON record says it spent beyond its workers' starts and readyings
 * (usage.ts UsageReport run) and the run part; under an import budget of none, in a line for each property naming the
 * most its module took to import on a worker and the import part. Each case writes the consumer from the checkout's own
 * library (Checkout.dir, so a kill's mutant is in it) and runs it in a child process. Oracle: the specification, stated
 * per case (budget.fixtures.ts budgetEndOf), over the run's own record of what it spent.
 */
export const aRunSpendsAtMostItsBudget = property.exhaust(budgets, {
	box: "a consumer's toolchain-test run of two passing properties under its measured CPU budget, under a run budget of 0 ms, and under an import budget of 0 ms",
	needs: { directory: Scratch.dir, checkout: Checkout.dir },
	situations: [],
	check:
		({ directory, checkout }) =>
		(budgeted) =>
			Effect.gen(function* () {
				const scratch = yield* directory
				const library = yield* checkout
				const { ended, spent } = yield* budgetedRun(scratch, library, budgeted)
				assert.deepEqual(ended, budgetEndOf(budgeted, spent))
			}),
	oracle: {
		kind: "specification",
		name: "a run within both parts of its CPU budget ends as its properties do; a run past either fails, a line for each part it went past naming what its record says it spent and the part"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/cli.ts",
			original: '\t\t\treturn failing > 0 || spent.kind === "over" ? 1 : 0\n',
			replacement: "\t\t\treturn failing > 0 ? 1 : 0\n",
			why: "A run past its budget exits 0, so a suite that grew past what it was measured to spend passes its gate; the property fails."
		},
		{
			file: "packages/testing/src/runner/usage.ts",
			original: "\t\t...(report.run > budget.run\n",
			replacement: "\t\t...(report.run < budget.run\n",
			why: "The run part's comparison turned around fails a run within it and passes one past it; the property fails."
		},
		{
			file: "packages/testing/src/runner/usage.ts",
			original: "\t\t\treturn most > budget.import\n",
			replacement: "\t\t\treturn most < 0\n",
			why: "An import past the import part passes, so a module that grew to cost a whole worker's readying more passes its gate; the property fails."
		},
		{
			file: "packages/testing/src/runner/cli.ts",
			original: '\t\t\t\t\t\t...(spent.kind === "over" ? spent.lines : [])\n',
			replacement: "",
			why: "A run past its budget fails without saying why, so its gate names no cause; the property fails."
		}
	]
})

/**
 * A run's part beyond its workers' starts and readyings holds none of its readyings, so no width of the run moves it:
 * the readying consumer's need spends none, two or four seconds of CPU opening on each worker that readies it, and its
 * run with a costly open spends beyond its readyings within half that open of its run with a free one. A run on more
 * workers differs from one on fewer by more readyings (each worker imports its modules and opens its needs), and which
 * modules a further worker readies is its scheduler's choice (runner/schedule.ts), so the readying's own cost, varied at
 * one width, is what states the part's independence of every width outright. Each run writes the consumer from the
 * checkout's own library (Checkout.dir) and runs it on one worker. Oracle: the specification, over each run's own
 * record.
 */
export const aRunsPartHoldsNoReadying = property.exhaust(readyingBurns, {
	box: "a consumer of two light properties over a need that spends no CPU opening, and one that spends 2 or 4 s, each run on one worker",
	needs: { free: Scratch.dir, costly: Scratch.dir, checkout: Checkout.dir },
	situations: [],
	check:
		({ free, costly, checkout }) =>
		(burn) =>
			Effect.gen(function* () {
				const library = yield* checkout
				const freeDirectory = yield* free
				const costlyDirectory = yield* costly
				const none = yield* readyingRun(freeDirectory, library, 0)
				const some = yield* readyingRun(costlyDirectory, library, burn)
				assert.deepEqual(
					{
						run:
							Math.abs(some - none) < burn / 2
								? "the same whatever its readying spent"
								: `${String(none)} ms with a free open, ${String(some)} ms with one of ${String(burn)} ms`
					},
					{ run: "the same whatever its readying spent" }
				)
			}),
	oracle: {
		kind: "specification",
		name: "the run part holds the parent's CPU outside its run needs' opens and the cases', so a readying of any cost on any number of workers moves it by none of it"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/usage.ts",
			original: "\t\trun: usage.parent - usage.runNeeds + casesSpent,\n",
			replacement: "\t\trun: usage.parent + workers + children + backends,\n",
			why: "The run part counts every worker's start and readyings again, so a run on more workers, or one whose needs cost more to open, spends more, and a budget measured at one width is refused at another; the property fails."
		}
	]
})

/**
 * A run's part beyond its readyings holds none of its run needs' opens, which their own budgets hold: the run-need
 * consumer's run need spends four or eight seconds of the run parent's CPU opening, and the run's run part is less than
 * that, its parent's work beside it and its cases being a second or two. Each case writes the consumer from the
 * checkout's own library (Checkout.dir) and runs it on one worker. Oracle: the specification, over the run's own record.
 */
export const aRunNeedsOpenIsNoneOfTheRunPart = property.exhaust(runNeedBurns, {
	box: "a consumer of two light properties over a run need that spends 4 or 8 s of CPU opening, run on one worker",
	needs: { directory: Scratch.dir, checkout: Checkout.dir },
	situations: [],
	check:
		({ directory, checkout }) =>
		(burn) =>
			Effect.gen(function* () {
				const scratch = yield* directory
				const library = yield* checkout
				const run = yield* runNeedRun(scratch, library, burn)
				assert.deepEqual(
					{ run: run < burn ? "less than its run need's open" : `${String(run)} ms` },
					{ run: "less than its run need's open" }
				)
			}),
	oracle: {
		kind: "specification",
		name: "the run part holds the parent's CPU outside its run needs' opens, so a run need's open of more than the rest of the run is no part of it"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/usage.ts",
			original: "\t\trun: usage.parent - usage.runNeeds + casesSpent,\n",
			replacement: "\t\trun: usage.parent + casesSpent,\n",
			why: "The run part counts the run needs' opens, which their own budgets hold, so a run whose run need found its work done spends less than one that did it, and a budget measured warm is refused cold; the property fails."
		}
	]
})

/**
 * A run's worker starts within the toolchain's own budget for it (budget.fixtures.ts WORKER_START_BUDGET): the
 * consumer's run on at most one worker and on at most two, each worker it started, from its process's start to its
 * ready message, as its record states it. A worker's start is the toolchain's own work, which no package's budget holds
 * (runner/config.ts RunBudget), so a heavier runner entry fails here. Oracle: the specification, over the run's own
 * record.
 */
export const aWorkerStartsWithinItsBudget = property.exhaust(startWorkers, {
	box: "a consumer's toolchain-test run of two passing properties on at most one worker and on at most two",
	needs: { directory: Scratch.dir, checkout: Checkout.dir },
	situations: [],
	check:
		({ directory, checkout }) =>
		(workers) =>
			Effect.gen(function* () {
				const scratch = yield* directory
				const library = yield* checkout
				const starts = yield* startsRun(scratch, library, workers)
				assert.deepEqual(
					{
						starts:
							Arr.isReadonlyArrayNonEmpty(starts) &&
							Arr.every(starts, (start) => start <= WORKER_START_BUDGET)
								? "each within its budget"
								: `${Arr.join(Arr.map(starts, String), ", ")} ms`
					},
					{ starts: "each within its budget" }
				)
			}),
	oracle: {
		kind: "specification",
		name: "each worker's start, as the run's record states it, within the toolchain's budget for one"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/worker-entry.ts",
			original: "await worker()\n",
			replacement:
				"{\n\tconst cpu = () => process.cpuUsage().user / 1000\n\tconst until = cpu() + 3_960\n\twhile (cpu() < until) {}\n}\nawait worker()\n",
			why: "A worker entry that does more before it runs the worker spends past the toolchain's budget for a start at every worker of every run, which no package's budget holds; the property fails."
		}
	]
})
