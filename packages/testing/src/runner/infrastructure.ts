import { Context, Effect, Fiber } from "effect"

/**
 * Whether the running fiber does the runner's own work on a property's behalf: a worker's services built, a cluster's
 * members held, brought up and settled, its sessions opened (resources/cluster.ts). The guard (runner/observe.ts) counts
 * no act of such a fiber as a property's, since the toolchain digest keys the code that does it; a connection to one of
 * the run's own servers is a keyable read of the PostgreSQL that serves it whoever opens it.
 */
const Infrastructure = Context.Reference<boolean>(
	"@bjornpagen/testing/runner/infrastructure/Infrastructure",
	{ defaultValue: () => false }
)

/** `effect` as the runner's own work (Infrastructure), and every fiber it forks. */
export const asInfrastructure = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
	Effect.provideService(effect, Infrastructure, true)

/** Whether the fiber running now does the runner's own work (Infrastructure): what the guard asks of each act. */
export const inInfrastructure = (): boolean => {
	const fiber = Fiber.getCurrent()
	return fiber !== undefined && Context.get(fiber.context, Infrastructure)
}
