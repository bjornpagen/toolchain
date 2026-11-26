import { Effect } from "effect"
import { assert } from "#assert.ts"
import { Checkout } from "#mutate/checkout.ts"
import { property } from "#property.ts"
import { Scratch } from "#resources/scratch.ts"
import { budgetedRun, budgets, budgetEndOf } from "#runner/budget.fixtures.ts"

/**
 * A run spends at most its runner config's CPU budget (runner/config.ts RunBudget): the consumer's `toolchain-test run`
 * under its measured budget passes and says nothing of it; under a budget of none, 0 ms, it fails, in one line naming the
 * CPU its own JSON record says it spent with its backends' (usage.ts UsageReport metered) and the budget. Each case writes the consumer from the checkout's own library
 * (Checkout.dir, so a kill's mutant is in it) and runs it in a child process. Oracle: the specification, stated per case
 * (budget.fixtures.ts budgetEndOf), over the run's own record of what it spent.
 */
export const aRunSpendsAtMostItsBudget = property.exhaust(budgets, {
	box: "a consumer's toolchain-test run of two passing properties under its measured CPU budget, and under a budget of 0 ms",
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
		name: "a run within its CPU budget ends as its properties do; a run past it fails, naming what its record says it spent and its budget"
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
			original: "\treport.metered > budget.millis\n",
			replacement: "\treport.metered < budget.millis\n",
			why: "The budget's comparison turned around fails a run within its budget and passes one past it; the property fails."
		},
		{
			file: "packages/testing/src/runner/cli.ts",
			original: '\t\t\t\t\t\t...(spent.kind === "over" ? [spent.line] : [])\n',
			replacement: "",
			why: "A run past its budget fails without saying why, so its gate names no cause; the property fails."
		}
	]
})
