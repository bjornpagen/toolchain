import { Effect } from "effect"
import { type MutantPool, rebasedTo, type WorkerImage } from "#mutate/pool.ts"
import { type PoolFailed, poolOf } from "#runner/pool.ts"
import { WORKER_ENTRY } from "#runner/run.ts"
import { testWorkers } from "#workers.ts"

/**
 * The runner's pool as the mutator leases it (mutate/pool.ts MutantPool): its width, one worker a core, and a lease, a
 * pool of its own over `workers` workers started fresh from an image, which no other lease's batch reaches (each lease
 * steals only among its own workers). A path the runner knows in `checkout` (the worker's entry, the package root, which
 * is the checkout itself in a repository whose package is its root) is taken in the image's root instead (rebasedTo),
 * so a worker tree's workers load the tree's modules and its test.config.ts, and run in the tree's package directory; the image's flags follow this process's, and its environment adds to this process's. A worker
 * killed past its case deadline is forked again from the same image; closing the lease's scope disconnects every
 * worker and waits for it to exit on its own, so a coverage pass's dumps are written before the scope closes.
 */
export const mutantPoolOf = (checkout: string, packageRoot: string): MutantPool<PoolFailed> => ({
	width: testWorkers,
	lease: (image: WorkerImage, workers: number) =>
		Effect.gen(function* () {
			const rebased = rebasedTo(checkout, image.root)
			const root = rebased(packageRoot)
			const pool = yield* poolOf({
				entry: rebased(WORKER_ENTRY),
				root,
				cwd: root,
				env: image.env,
				workers,
				execArgv: [...process.execArgv, ...image.execArgv],
				guide: "notes"
			})
			return pool.evaluator
		})
})
