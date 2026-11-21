import { Array as Arr, Effect, Semaphore } from "effect"
import { type MutantPool, rebasedTo, type WorkerImage } from "#mutate/pool.ts"
import { runnerLimits } from "#runner/limits.ts"
import { type PoolFailed, poolOf } from "#runner/pool.ts"
import { WORKER_ENTRY } from "#runner/run.ts"
import { testWorkers } from "#workers.ts"

/**
 * The places of a pool `width` wide that leases take: `placesFor(workers)` takes that many places no other open lease
 * holds, in the caller's scope, waiting while too few are free, and gives them back as the scope closes, so the places
 * held at once are distinct and never more than the width.
 */
export const placesLeased = (width: number) => {
	const leasing = Semaphore.makeUnsafe(width)
	const free: Array<number> = Array.from({ length: width }, (_, place) => place)
	return {
		placesFor: (workers: number) =>
			Effect.acquireRelease(
				Effect.andThen(leasing.take(workers), () =>
					Effect.filterOrElse(
						Effect.sync(() => free.splice(0, workers)),
						Arr.isArrayNonEmpty,
						() => Effect.die("a lease took its permits with no place free")
					)
				),
				(taken) =>
					Effect.andThen(
						Effect.sync(() => {
							for (const place of taken) {
								free.push(place)
							}
						}),
						leasing.release(taken.length)
					)
			)
	}
}

/**
 * The runner's pool as the mutator leases it (mutate/pool.ts MutantPool): its width, one worker a core, and a lease, a
 * pool of its own over `workers` workers started fresh from an image, which no other lease's batch reaches (each lease
 * steals only among its own workers). A path the runner knows in `checkout` (the worker's entry, the package root, which
 * is the checkout itself in a repository whose package is its root) is taken in the image's root instead (rebasedTo),
 * so a worker tree's workers load the tree's modules and its test.config.ts, and run in the tree's package directory;
 * its workers take this process's flags and serve the image's mutant (PoolSpec served), and its environment adds to
 * this process's. A worker killed past its case deadline is forked again from the same image; closing the lease's
 * scope disconnects every worker and waits for it to exit on its own, so a coverage pass's dumps are written before the
 * scope closes.
 *
 * Every lease's workers take places among the pool's width that no other lease open at once holds (runner/pool.ts
 * Places), each taken as the lease opens and given back once its pool has closed, a lease waiting while too few are
 * free: so the workers of every lease open at once are never more than the width, and they report distinct places, as
 * one run's workers do. Leases of one worker each all at place 0 sent every kill trial's worker to one member when a
 * worker's member was fixed by its place, 64 workers for its 16 leases, the others idle (GZ-NETWORK: the kills of 32
 * network modules waited 300 s at substrate_lease_gate); a cluster's lease now puts each worker on the member where its
 * run holds fewest (pg/lease.ts).
 */
export const mutantPoolOf = (checkout: string, packageRoot: string): MutantPool<PoolFailed> => {
	const { placesFor } = placesLeased(testWorkers)
	return {
		width: testWorkers,
		lease: (image: WorkerImage, workers: number, guide: "notes" | "blocks") =>
			Effect.gen(function* () {
				const rebased = rebasedTo(checkout, image.root)
				const root = rebased(packageRoot)
				const taken = yield* placesFor(Math.max(1, Math.min(workers, testWorkers)))
				const pool = yield* poolOf({
					entry: rebased(WORKER_ENTRY),
					root,
					cwd: root,
					env: image.env,
					compile: image.compile,
					places: { at: taken, of: testWorkers },
					execArgv: process.execArgv,
					served: image.served,
					guide,
					open: runnerLimits.open
				})
				return pool.evaluator
			})
	}
}
