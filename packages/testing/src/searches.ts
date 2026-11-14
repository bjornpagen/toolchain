import { Effect } from "effect"

declare global {
	var bjornpagenTestingSearches: number | undefined
}

/**
 * Counts a search's start in this process: explore's, exhaust's and interleave's, each the moment it is run, before it
 * reads its spec, so a search that refuses its spec or fails as its test expects is counted too. A test runner reads
 * the count before and after each test (`searchesStarted`) to learn whether the test ran a search, which Vitest's
 * adapter leaves on the test for its reporter. The count is the process's, as a test process runs one test at a time.
 */
export const searchStarted: Effect.Effect<void> = Effect.sync(() => {
	globalThis.bjornpagenTestingSearches = (globalThis.bjornpagenTestingSearches ?? 0) + 1
})

/** How many searches this process has started. */
export const searchesStarted: Effect.Effect<number> = Effect.sync(
	() => globalThis.bjornpagenTestingSearches ?? 0
)
