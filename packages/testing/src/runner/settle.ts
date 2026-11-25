import { Effect, Inspectable, Predicate, Schema } from "effect"

/** The closure hasher did not load: TypeScript 7, an optional peer of the library, is not installed. */
class HasherUnloaded extends Schema.TaggedError<
	HasherUnloaded,
	{ readonly brand: unique symbol }
>()("HasherUnloaded", { message: Schema.String }) {}

/**
 * The verdict cache's module (affected.ts, with closure.ts), which loads TypeScript's native compiler, an optional peer
 * of the library: only what uses it loads it, so `run` starts without TypeScript installed.
 */
export const affectedModule = Effect.tryPromise({
	try: () => import("#runner/affected.ts"),
	catch: (cause) =>
		HasherUnloaded.make({
			message: `the closure hasher did not load (TypeScript 7, an optional peer, must be installed): ${Predicate.isError(cause) ? cause.message : Inspectable.toStringUnknown(cause)}`
		})
})
