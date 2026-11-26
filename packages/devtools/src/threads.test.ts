/**
 * Each task of a turbo run takes its share of the machine, the one width every tool and pool derives from (testing's
 * workers.ts processors, shareHere): each wrapper (toolchain-oxlint, toolchain-oxfmt, toolchain-fallow,
 * toolchain-typecheck), run as a task of a turbo run toolchain-turbo starts, hands its tool the machine's CPU allowance
 * over the tasks the run executes at once (the fewer of turbo's concurrency and the tasks its dry run plans that run a
 * script), rounded down and one at least, by the tool's own flag (oxlint's and oxfmt's `--threads=N`, fallow's
 * `--threads N`, tsrs's `--checkers N`) and by RAYON_NUM_THREADS always, and passes the caller's arguments on; and a
 * test task takes the same share, its test pool half of it (testWorkers) and the V8 pool of each Node process it starts
 * all of it (nodePoolFlag), so the tasks' pools sum to the run's allowance at most: so a narrow run's tools use the
 * machine (six tasks at every processor, a sixth each, where the concurrency alone would hand each one thread) and a
 * wide run's sum to the machine's CPUs at most, where every tool took the whole machine (GATETHREADS, 2026-11-20: 64
 * threads in each of 32 oxlint tasks, one live gate's oxlint at about 5,400% CPU). A load alone (loadWorkers) takes half
 * the run's allowance, not of its share: it is the check's long tail, and held to its share of a check of 24 tasks it
 * ran one process for 1h50m while the CPUs its siblings left stood idle (main's ruling, 2026-11-26, lane LOADFAST). So
 * the invariant that holds is: the run's tasks hold their shares, the allowance at most, and a load among them holds
 * half the allowance where it would hold its share, so the run holds at most one and a half times its allowance while
 * its tasks run beside its load, and half of it once only the load runs.
 * Each case runs toolchain-turbo from the checkout, turbo a stub on the PATH answering its configuration and dry run as
 * a turbo of the case's shape would and running the case's wrapper as its task, the wrapper's tool a stub that writes
 * down what it was handed. Oracle: the specification, threadsPerTask's JSDoc and turbo's documented concurrency (a whole
 * number of tasks, or a share of the processors).
 */
import { assert } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Effect, Option } from "effect"
import { allowanceOfRun, handedTo, tasksOf, threadings } from "#threads.fixtures.ts"

export const threadsShared = property.exhaust(threadings, {
	box: "each wrapper of the gate's tools and a test task, each a task of a run toolchain-turbo starts: six tasks at every processor, more tasks than processors at every processor, and more at a quarter of them, each under the kernel's allowance and under 4 given its starter",
	needs: { dir: Scratch.dir, checkout: Checkout.dir },
	situations: [],
	check:
		({ dir, checkout }) =>
		(threaded) =>
			Effect.gen(function* () {
				const directory = yield* dir
				const root = yield* checkout
				const cpus = allowanceOfRun(threaded)
				const tasks = tasksOf(threaded.shape, cpus)
				const share = Math.max(1, Math.floor(cpus / tasks))
				const run = yield* handedTo(root, directory, threaded)
				const { handed } = run
				const held = tasks * (handed.kind === "tool" ? handed.variable : handed.share)
				const heldBesideLoad = handed.kind === "tool" ? held : held - handed.share + handed.load
				assert.deepEqual(
					{
						status: run.status,
						handed,
						passed: run.passed,
						within: held <= cpus,
						withinBesideLoad: heldBesideLoad <= cpus + Math.floor(cpus / 2)
					},
					{
						status: 0,
						handed:
							threaded.wrapped.kind === "tool"
								? { kind: "tool", variable: share, flag: Option.some(share) }
								: {
										kind: "test",
										share,
										workers: Math.max(1, Math.floor(share / 2)),
										pool: share,
										load: Math.max(1, Math.floor(cpus / 2))
									},
						passed: true,
						within: true,
						withinBesideLoad: true
					}
				)
			}),
	oracle: {
		kind: "specification",
		name: "a tool of the gate is handed the machine's logical CPUs over the tasks its run executes at once, the fewer of its concurrency and its tasks, one at least, so a narrow run's tools use the machine and a wide run's hold it at most; a load takes half the run's allowance, so a run holds one and a half times its allowance at most"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/workers.ts",
			original: "\t\t\treturn threadsPerTask(allowance, tasksAtOnceHere(allowance))\n",
			replacement: "\t\t\treturn allowance\n",
			why: "Every tool is handed the whole machine, as each sized its pool before: a run of many tasks holds their count times the machine's CPUs (GATETHREADS: 32 oxlint tasks of 64 threads each); the property fails."
		},
		{
			file: "packages/devtools/src/shared/threads.ts",
			original: "\t\treturn widthOf(Math.min(width, tasks))\n",
			replacement: "\t\treturn widthOf(width)\n",
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
			file: "packages/testing/src/workers.ts",
			original: "\t\tonSome: (concurrency) => tasksUnder(concurrency, allowance),\n",
			replacement: "\t\tonSome: () => widthOf(1),\n",
			why: "A task toolchain-turbo told its run's width reads itself as a run of one, so every tool of a turbo run takes the whole machine; the property fails."
		},
		{
			file: "packages/testing/src/workers.ts",
			original: "widthOf((processors * Number(share)) / 100)",
			replacement: "widthOf(Number(share))",
			why: "A share of the processors is read as a count of tasks, so a run at a quarter of them hands each tool the CPUs over 25 tasks, not over a quarter of the machine; the property fails."
		},
		{
			file: "packages/devtools/src/shared/threads.ts",
			original: `\t\t\t\t\t\tenv: { RAYON_NUM_THREADS: \`\${threads}\` },\n`,
			replacement: "\t\t\t\t\t\tenv: {},\n",
			why: "No tool is handed RAYON_NUM_THREADS, so tsrs, which reads no thread flag, and oxlint's tsrs-lint child size their pools to the whole machine; the property fails."
		},
		{
			file: "packages/devtools/src/shared/threads.ts",
			original: `\t\tthreadArguments: (threads) => ["--checkers", \`\${threads}\`]\n`,
			replacement: "\t\tthreadArguments: () => []\n",
			why: "tsrs's checkers are left at its default of four beside its Rayon pool, so one typecheck handed one thread keeps about 1.45 cores busy (TOOLTRUST's probe at allowance 4); the property fails for the typecheck."
		},
		{
			file: "packages/testing/src/workers.ts",
			original: "export const testWorkers: Width = workersOf(processors)\n",
			replacement: 'export const testWorkers: Width = workersOf(allowanceOf(cpuFactsAt("")))\n',
			why: "A test task's pool takes half the whole allowance beside every other task of its run, four workers beside four tasks at an allowance of 4, where a test task holds its share; the property fails for the test task."
		},
		{
			file: "packages/testing/src/workers.ts",
			original: `export const nodePoolFlag = \`--v8-pool-size=\${processors}\`\n`,
			replacement: `export const nodePoolFlag = \`--v8-pool-size=\${allowanceOf(cpuFactsAt(""))}\`\n`,
			why: "Each Node process a task starts sizes V8's background pool to the whole allowance, not its share; the property fails for the test task."
		},
		{
			file: "packages/testing/src/workers.ts",
			original: "export const loadWorkers: Width = workersOf(runAllowance)\n",
			replacement: "export const loadWorkers: Width = workersOf(processors)\n",
			why: "A load takes half its task's share, as it did before: one process in a check of 24 tasks at an allowance of 32, every landing waiting 1h50m on it; the property fails for the test task of every run of more than one task."
		},
		{
			file: "packages/testing/src/workers.ts",
			original: "export const loadWorkers: Width = workersOf(runAllowance)\n",
			replacement: 'export const loadWorkers: Width = workersOf(allowanceOf(cpuFactsAt("")))\n',
			why: "A load takes half the kernel's allowance, not its run's: a check given 4 CPUs runs half the machine's worth of load processes; the property fails for every case given 4."
		},
		{
			file: "packages/devtools/src/turbo.ts",
			original: `\t\t\t\t\t[runAllowanceVariable]: \`\${processors}\`,\n`,
			replacement: "",
			why: "A run given 4 CPUs leaves its tasks to read the kernel's, as turbo strips the allowance it was given: each of four tasks took 64 over 4 and PRINTONCE3's gate at an allowance of 4 kept 13 to 16 cores busy; the property fails for every case given 4."
		}
	]
})
