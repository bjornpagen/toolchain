import type { NodeServices } from "@effect/platform-node/NodeServices"
import { Effect } from "effect"
import type { RealPath } from "#mutate/mutated.ts"
import { type MutantPool, Unstarted } from "#mutate/pool.ts"
import { mutantPoolOf } from "#runner/lease.ts"

/**
 * The runner's pool as the mutator leases it (runner/lease.ts mutantPoolOf): a lease whose workers all end before they
 * are ready, which the pool reports as PoolFailed as it starts, is Unstarted, a verdict on the image, since only a
 * mutant's or a probe's image stops workers that start unmutated. Every caller that judges kills or mutants leases from
 * this pool, so such a mutant turns its property red rather than failing the run.
 */
export const mutatorPool = (
	checkout: RealPath,
	packageRoot: RealPath,
	environment: Readonly<Record<string, string>>
): Effect.Effect<MutantPool<never>, never, NodeServices> =>
	Effect.map(mutantPoolOf(checkout, packageRoot, environment), (pool): MutantPool<never> => ({
		width: pool.width,
		lease: (image, workers, serves) =>
			Effect.catchTag(pool.lease(image, workers, serves), "PoolFailed", (failed) =>
				Effect.fail(Unstarted.make({ message: failed.message }))
			)
	}))
