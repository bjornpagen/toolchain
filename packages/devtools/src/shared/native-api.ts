import { Array as Arr, Effect, Exit, type Scope } from "effect"
import type { createFileSystem, FileSystemCallbacks } from "typescript/fs"
import { API, type Project } from "typescript/sync"
import { DevtoolFailure } from "#shared/devtool.ts"

/**
 * A native compiler session, for a repository's own tools that read TypeScript with the native compiler (grizzle's
 * dev scripts parse with it). No check of the toolchain opens one: every lint rule reads syntax through oxlint, and the
 * typecheck is tsrs's. TypeScript's sync API starts tsgo as a child process and reaches it with synchronous reads and
 * writes on its pipes, so Node's event loop never runs while a call waits, and every call is a round trip: callers
 * batch their checker calls.
 */

/** Closes a session when its scope ends. After a failure the process may have ended already, and closing then fails
 * to release snapshots a gone process no longer holds: that follows from the failure the scope already carries. */
const closeNative = (api: API, exit: Exit.Exit<unknown, unknown>): Effect.Effect<void> =>
	Exit.isSuccess(exit)
		? Effect.sync(() => {
				api.close()
			})
		: Effect.ignore(
				Effect.try({
					try: () => api.close(),
					catch: (cause) =>
						DevtoolFailure.make({ detail: "The native compiler did not close", cause })
				})
			)

/** One native compiler session: the tsgo process lives exactly as long as the scope. */
export const nativeSession = (
	options: Readonly<{ cwd: string; fs?: FileSystemCallbacks }>
): Effect.Effect<API, DevtoolFailure, Scope.Scope> =>
	Effect.acquireRelease(
		Effect.try({
			try: () => new API(options),
			catch: (cause) =>
				DevtoolFailure.make({ detail: "The native TypeScript compiler did not start", cause })
		}),
		closeNative
	)

/** Opens one tsconfig project in its own snapshot, read from `fileSystem` when one is given (a full one is
 * total: nothing is read from the host). A config the compiler rejects is a failure. The snapshot is released when
 * the scope succeeds; after a failure, closing the session releases it with its process. */
export const openProject = (
	input: Readonly<{ api: API; config: string; fileSystem?: ReturnType<typeof createFileSystem> }>
): Effect.Effect<Project, DevtoolFailure, Scope.Scope> =>
	Effect.gen(function* () {
		const snapshot = yield* Effect.acquireRelease(
			Effect.try({
				try: () =>
					input.api.createSnapshot({ openProjects: [input.config], fileSystem: input.fileSystem }),
				catch: (cause) =>
					DevtoolFailure.make({ detail: "The native compiler could not build the program", cause })
			}),
			(opened, exit) =>
				Exit.isSuccess(exit)
					? Effect.sync(() => {
							opened[Symbol.dispose]()
						})
					: Effect.void
		)
		const project = snapshot.getConfiguredProject(input.config)
		if (project === undefined) {
			return yield* DevtoolFailure.make({
				detail: `The native compiler did not open ${input.config}`
			})
		}
		const diagnostics = yield* Effect.try({
			try: () => project.program.getConfigFileParsingDiagnostics(),
			catch: (cause) => DevtoolFailure.make({ detail: `${input.config} could not be read`, cause })
		})
		if (Arr.isReadonlyArrayNonEmpty(diagnostics)) {
			return yield* DevtoolFailure.make({
				detail: Arr.join(
					Arr.map(diagnostics, (diagnostic) => diagnostic.text),
					"\n"
				)
			})
		}
		return project
	})
