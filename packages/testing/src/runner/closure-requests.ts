import { type Context, Deferred, Effect } from "effect"
import type { ClosureAnswer, ClosureHash } from "#runner/closure-hash.ts"
import { ModuleClosure, NeedFailed } from "#runner/services.ts"

/**
 * ModuleClosure in a worker of the pool: the worker asks the parent, which hashes each module once for the whole pool
 * (runner/module-closure.ts, over the pool's root), and keeps each answer for its life. A worker loads no compiler and
 * hashes nothing itself, so a run pays a module's closure once, not once a worker.
 */

/** A worker's ModuleClosure, and where the worker's message loop hands it the parent's answers. */
export type AskedClosures = Readonly<{
	service: Context.Service.Shape<typeof ModuleClosure>
	answered: (module: string, answer: ClosureAnswer) => Effect.Effect<void>
}>

/** The ModuleClosure of a worker that asks the parent through `ask`: one question a module, every caller its answer. */
export const askedClosuresOf = (
	root: string,
	ask: (module: string) => Effect.Effect<void>
): AskedClosures => {
	const asked = new Map<string, Deferred.Deferred<ClosureHash, NeedFailed>>()
	return {
		service: ModuleClosure.of({
			root,
			hashOf: (module) =>
				Effect.suspend(() => {
					const held = asked.get(module)
					if (held !== undefined) {
						return Deferred.await(held)
					}
					const made = Deferred.makeUnsafe<ClosureHash, NeedFailed>()
					asked.set(module, made)
					return Effect.andThen(ask(module), Deferred.await(made))
				})
		}),
		answered: (module, answer) =>
			Effect.suspend(() => {
				const held = asked.get(module)
				if (held === undefined) {
					return Effect.void
				}
				return Effect.asVoid(
					answer.kind === "hashed"
						? Deferred.succeed(held, answer.hash)
						: Deferred.fail(
								held,
								NeedFailed.make({ need: "ModuleClosure", message: answer.message })
							)
				)
			})
	}
}
