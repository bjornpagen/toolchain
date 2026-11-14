import { Effect } from "effect" // violation
import { type Option } from "effect" // violation
import * as Schema from "effect/Schema" // violation
import "@effect/platform-node" // violation
import type { Duration } from "effect"

export { Array } from "effect" // violation
export type { Order } from "effect"
export * from "effect/Function" // violation
export * as Stream from "effect/Stream" // violation

export const program: Effect.Effect<Option.Option<Duration.Duration>> = Effect.succeed(
	Schema.decodeUnknownOption(Schema.Duration)(0)
)
