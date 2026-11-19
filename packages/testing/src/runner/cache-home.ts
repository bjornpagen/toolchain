import { Config, Effect } from "effect"

/**
 * toolchain-test's cache, `${XDG_CACHE_HOME:-~/.cache}/toolchain-test`: every repository's verdicts (affected.ts), the
 * compile cache (compile-cache.ts), each run's CPU report (cli.ts) and a run's worker trees (mutate/tree.ts).
 */
export const toolchainTestCache = Effect.gen(function* () {
	const home = yield* Config.String("HOME")
	const cacheHome = yield* Config.withDefault(Config.String("XDG_CACHE_HOME"), `${home}/.cache`)
	return `${cacheHome}/toolchain-test`
})
