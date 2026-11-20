/**
 * Each tool of the gate takes its task's share of the machine (shared/threads.ts, testing's workers.ts
 * threadsPerTask): each wrapper (toolchain-oxlint, toolchain-oxfmt, toolchain-fallow, toolchain-typecheck), run as a
 * task of a turbo run toolchain-turbo starts, hands its tool the machine's logical CPUs over the tasks the run executes
 * at once (the fewer of turbo's concurrency and the tasks its dry run plans that run a script), rounded down and one at
 * least, by the tool's own flag where it takes one and by RAYON_NUM_THREADS always, and passes the caller's arguments
 * on: so a narrow run's tools use the machine (six tasks at every processor, a sixth each, where the concurrency alone
 * would hand each one thread) and a wide run's sum to the machine's CPUs at most, where every tool took the whole
 * machine (GATETHREADS, 2026-11-20: 64 threads in each of 32 oxlint tasks, one live gate's oxlint at about 5,400% CPU).
 * Each case runs toolchain-turbo from the checkout, turbo a stub on the PATH answering its configuration and dry run as
 * a turbo of the case's shape would and running the case's wrapper as its task, the wrapper's tool a stub that writes
 * down what it was handed. Oracle: the specification, threadsPerTask's JSDoc and turbo's documented concurrency (a whole
 * number of tasks, or a share of the processors).
 */
import { assert } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { processors } from "@bjornpagen/testing/workers"
import { Effect, Option } from "effect"
import { handedTo, tasksOf, threadings } from "#threads.fixtures.ts"

export const threadsShared = property.exhaust(threadings, {
	box: "each wrapper of the gate's tools as a task of a run toolchain-turbo starts: six tasks at every processor, more tasks than processors at every processor, and more at a quarter of them",
	needs: { dir: Scratch.dir, checkout: Checkout.dir },
	situations: [],
	check:
		({ dir, checkout }) =>
		(threaded) =>
			Effect.gen(function* () {
				const directory = yield* dir
				const root = yield* checkout
				const tasks = tasksOf(threaded.shape)
				const share = Math.max(1, Math.floor(processors / tasks))
				const run = yield* handedTo(root, directory, threaded)
				assert.deepEqual(
					{
						status: run.status,
						handed: run.handed,
						passed: run.passed,
						within: tasks * run.handed.variable <= processors
					},
					{
						status: 0,
						handed: {
							variable: share,
							flag: threaded.wrapped.flag === "none" ? Option.none() : Option.some(share)
						},
						passed: true,
						within: true
					}
				)
			}),
	oracle: {
		kind: "specification",
		name: "a tool of the gate is handed the machine's logical CPUs over the tasks its run executes at once, the fewer of its concurrency and its tasks, one at least, so a narrow run's tools use the machine and a wide run's hold it at most"
	},
	kept: [],
	kills: [
		{
			file: "packages/devtools/src/shared/threads.ts",
			original: "\t\tconst threads = threadsPerTask(processors, width)\n",
			replacement: "\t\tconst threads = processors\n",
			why: "Every tool is handed the whole machine, as each sized its pool before: a run of many tasks holds their count times the machine's CPUs (GATETHREADS: 32 oxlint tasks of 64 threads each); the property fails."
		},
		{
			file: "packages/devtools/src/shared/threads.ts",
			original: "\t\treturn Math.max(1, Math.min(width, tasks))\n",
			replacement: "\t\treturn Math.max(1, width)\n",
			why: "A run is sized by its concurrency alone, so a check of six tasks at a concurrency of every processor hands each tool one thread and leaves the machine idle; the property fails for the narrow run."
		},
		{
			file: "packages/devtools/src/shared/threads.ts",
			original:
				"\t\treturn Arr.filter(plan.tasks, (task) => task.command !== NONEXISTENT).length\n",
			replacement: "\t\treturn plan.tasks.length\n",
			why: "A task the dry run plans for a package without the script counts as one the run executes, so a narrow run reads wider than it is and hands each tool less than its share; the property fails for the narrow run."
		},
		{
			file: "packages/devtools/src/shared/threads.ts",
			original: "\t\t\treturn tasksAtOnce(place.concurrency)\n",
			replacement: "\t\t\treturn Effect.succeed(1)\n",
			why: "A task toolchain-turbo told its run's width reads itself as a run of one, so every tool of a turbo run takes the whole machine; the property fails."
		},
		{
			file: "packages/devtools/src/shared/threads.ts",
			original: "Math.floor((processors * Number(share)) / 100)",
			replacement: "Math.floor(Number(share))",
			why: "A share of the processors is read as a count of tasks, so a run at a quarter of them hands each tool the CPUs over 25 tasks, not over a quarter of the machine; the property fails."
		},
		{
			file: "packages/devtools/src/shared/threads.ts",
			original: `\t\t\t\t\t\tenv: { RAYON_NUM_THREADS: \`\${threads}\` },\n`,
			replacement: "\t\t\t\t\t\tenv: {},\n",
			why: "No tool is handed RAYON_NUM_THREADS, so tsrs, which reads no thread flag, and oxlint's tsrs-lint child size their pools to the whole machine; the property fails."
		}
	]
})
