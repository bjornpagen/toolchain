import type { Duration, Option } from "effect"
import type * as Schema from "effect/Schema"
import { Array as Arr } from "#lint/fixtures/effect-free-packages/plain.ts"

export type { Order } from "effect"

export type Reading = Readonly<{
	after: Option.Option<Duration.Duration>
	codec: Schema.Codec<number>
}>

export const first = (values: ReadonlyArray<number>): number | undefined => Arr.head(values)
