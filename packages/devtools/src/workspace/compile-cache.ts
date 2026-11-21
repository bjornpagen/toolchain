import { Array as Arr, Effect, Option, Schema, String as Str } from "effect"
import { DevtoolFailure } from "#shared/devtool.ts"
import type { Finding } from "#shared/finding.ts"
import { TURBO_CONFIG } from "#workspace/root-tasks.ts"

/**
 * The compile cache's way into turbo's tasks: toolchain-turbo sets NODE_COMPILE_CACHE to the toolchain's compile cache,
 * on disk (turbo.ts), and turbo's strict environment hands a task only what turbo.json lets through, so a turbo.json
 * whose globalPassThroughEnv does not name NODE_COMPILE_CACHE drops it, and a tool its tasks run that enables Node's
 * compile cache naming no directory (vite's, rolldown's, jiti's and alchemy's commands) keeps a file a module under
 * os.tmpdir(), a tmpfs of bounded inodes on a machine like cassowary (main, 2026-11-20: /tmp at 1,048,460 of its
 * 1,048,576 inodes, 435,000 of them node-compile-cache entries from an edullm clone's tasks, every lane's shell failing
 * with ENOSPC). The gate refuses such a turbo.json. A repository with no turbo.json runs no turbo task and is left
 * alone.
 */

/** The variable toolchain-turbo hands every task, which turbo.json's globalPassThroughEnv must name. */
export const COMPILE_CACHE = "NODE_COMPILE_CACHE"

/** turbo.json's key for the variables every task gets as they are, outside its hash. */
export const PASS_THROUGH = "globalPassThroughEnv"

/** What the gate reads of turbo.json: the variables it passes through to every task. */
const Turbo = Schema.fromJsonString(
	Schema.Struct({ globalPassThroughEnv: Schema.optionalKey(Schema.Array(Schema.String)) })
)

/** The 1-based line of turbo.json that holds the pass-through key, else the first. */
const passThroughLine = (text: string): number =>
	Option.match(Arr.findFirstIndex(Str.split("\n")(text), Str.includes(`"${PASS_THROUGH}":`)), {
		onNone: () => 1,
		onSome: (at) => at + 1
	})

/**
 * The finding of a turbo.json whose globalPassThroughEnv does not name NODE_COMPILE_CACHE, at that key (or the file's
 * first line, where it has none); none for one that names it or a repository with no turbo.json. A text that is not the
 * JSON the gate reads fails the gate.
 */
export const compileCacheFindings = (
	input: Readonly<{ root: string; turbo: Option.Option<string> }>
): Effect.Effect<ReadonlyArray<Finding>, DevtoolFailure> =>
	Option.match(input.turbo, {
		onNone: () => Effect.succeed([]),
		onSome: (text) =>
			Schema.decodeEffect(Turbo)(text).pipe(
				Effect.mapBoth({
					onSuccess: (config): ReadonlyArray<Finding> =>
						Arr.contains(config.globalPassThroughEnv ?? [], COMPILE_CACHE)
							? []
							: [
									{
										file: `${input.root}/${TURBO_CONFIG}`,
										line: passThroughLine(text),
										column: 1,
										rule: "turbo-compile-cache",
										message: `turbo.json passes no ${COMPILE_CACHE} to its tasks, so a tool a task runs that enables Node's compile cache naming no directory keeps it under os.tmpdir(), a tmpfs of bounded inodes, where toolchain-turbo hands every task the toolchain's compile cache on disk.`,
										suggestion: `Add "${COMPILE_CACHE}" to ${TURBO_CONFIG}'s ${PASS_THROUGH}.`
									}
								],
					onFailure: (cause) =>
						DevtoolFailure.make({
							detail: `${TURBO_CONFIG} is not a turbo configuration the gate reads`,
							cause
						})
				})
			)
	})
