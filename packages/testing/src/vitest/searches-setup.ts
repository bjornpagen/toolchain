import { Effect } from "effect"
import { beforeEach, type TestContext } from "vitest"
import { searchesStarted } from "#searches.ts"
import { SEARCHES_KEY } from "#vitest/reporter.ts"

/**
 * Leaves a test's searches on the test: before each test it reads how many searches the process has started, and
 * once the test and its own hooks are done it writes how many more were started into the test's meta, which travels to
 * the reporter with the test's result, so the reporter knows the test ran a search however the search was reached
 * (`searched`, a helper, a search the test expects to fail) and whatever it found. An annotation would not do: Vitest
 * refuses one once the test's function has returned. `defineTestConfig` runs it in every project's processes.
 */
const recordSearches = (ctx: TestContext): (() => void) => {
	const before = Effect.runSync(searchesStarted)
	return () => {
		ctx.task.meta[SEARCHES_KEY] = Effect.runSync(searchesStarted) - before
	}
}

beforeEach(recordSearches)
