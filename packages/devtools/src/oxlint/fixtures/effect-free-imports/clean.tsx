import type { Duration, Option } from "effect"
import type * as Schema from "effect/Schema"
import { Array as Arr } from "#fixture/plain.ts"
import { effectLike } from "effectful"

export type { Order } from "effect"
export type * as Types from "effect/Types"
export * from "#fixture/plain.ts"

export type Reading = Readonly<{
	after: Option.Option<Duration.Duration>
	codec: Schema.Codec<number>
}>

export const first = (values: ReadonlyArray<number>): number | undefined => Arr.head(values)

export const like = effectLike
