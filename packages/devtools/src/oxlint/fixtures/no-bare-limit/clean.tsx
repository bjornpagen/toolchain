import { Duration, Effect, Schedule } from "effect"
import { pollTimeout, retryCount } from "#fixture/limits.ts"
declare const items: ReadonlyArray<number>
declare const seconds: number
type Spelled = "5 seconds"
export type Exported = Spelled
export const retries = 0
export const sequential = { concurrency: 1, times: 1 }
export const unbounded = { concurrency: "unbounded" }
export const timeoutMs = pollTimeout.value
export const scaled = { timeoutMs: seconds * 1000, maxBytes: items.length << 10 }
export const doubled = { timeoutMs: pollTimeout.value * 2 }
export const lastIndex = { max: items.length - 2 }
export const mask = { limit: 0xff, windowBits: 0b1010 }
export const millisPerSecond = 1000
export const daySeconds = 86_400
/** @formatConstant a SQLSTATE: five characters */
export const sqlstateMax = 5
export const retryLevel: 0 | 1 | 2 = 2
export const zero = Duration.millis(0)
export const yielded = Effect.sleep("0 millis")
export const now = setTimeout(() => undefined, 0)
export const width = 8
export const sum = items.length + 4
export const compared = items.length > 100 && items.length !== -1
export const label = "5 seconds ago"
export const read = Effect.timeout(Effect.void, Duration.millis(pollTimeout.value))
export const recur = Schedule.recurs(retryCount.value)
export const shorthand = { timeoutMs }
/** @formatConstant a frame's slots, by their offset */
const FRAME = { grace: 1, timeoutMs: 2 } as const
export const slot = FRAME.grace
