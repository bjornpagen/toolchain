import { Duration, Effect, Schedule, Semaphore } from "effect"
declare const work: Effect.Effect<void>
declare const base: number
declare const options: { timeoutMs?: number }
export const timeoutMs = 5000 // violation
export const MAX_RETRIES = 3 // violation
export const pollIntervalMs = 1 // violation
export const settings = { concurrency: 4, pageSize: 50 } // violation
export const nested = {
	retry: { times: 3 } // violation
}
export const computed = { ["concurrency"]: 6 } // violation
export const sized = { batchSize: 100n } // violation
export const grace = Duration.seconds(5) // violation
export const second = Duration.seconds(1) // violation
export const spaced = Schedule.spaced("1 second") // violation
export const recurs = Schedule.recurs(5) // violation
export const backoff = Schedule.exponential(Duration.millis(base), 2) // violation
export const slept = Effect.sleep(250) // violation
export const timed = Effect.timeout(work, "30 seconds") // violation
export const delayed = Effect.delay(work, 100) // violation
export const permits = Semaphore.make(3) // violation
export const abort = AbortSignal.timeout(60_000) // violation
export const timer = setTimeout(() => undefined, 50) // violation
export const fallback = { timeoutMs: options.timeoutMs ?? 2000 } // violation
export const deadlineMillis = base + 500 // violation
export const fiveMinutesMs = 5 * 60 * 1000 // violation
export const clamped = { maxDepth: Math.min(base, 100) } // violation
export const chosen = { ttlSeconds: base > 0 ? base : 30 } // violation
const WIDTH = 8
export const wide = Effect.forEach([1], () => work, { concurrency: WIDTH }) // violation
export const text = "5 minutes" // violation
export class Poller {
	static readonly intervalMs = 3000 // violation
}
export const poll = (everyMs = 250): number => everyMs // violation
export const assign = (target: { timeoutMs: number }): void => {
	target.timeoutMs = 10_000 // violation
}
const Wait = (props: { delayMs: number }) => <p>{props.delayMs}</p>
export const Spinner = () => <Wait delayMs={300} /> // violation
