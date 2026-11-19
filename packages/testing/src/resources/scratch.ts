import { Brand, Effect, FileSystem, type PlatformError, type Scope } from "effect"
import type { Need } from "#property.ts"
import { NeedFailed } from "#runner/services.ts"

/** A directory that is one case's alone: made empty for it, removed with everything in it when the case ends. */
export type ScratchDir = string & Brand.Brand<"ScratchDir">

const scratchDir = Brand.nominal<ScratchDir>()

const key = "@bjornpagen/testing/resources Scratch.dir"

/** Node's child processes: a scratch directory's remover is started with a pipe the maker alone holds. */
const childProcesses = process.getBuiltinModule("node:child_process")

/**
 * The remover of a scratch directory, `$1`: it reads its standard input to its end, then removes the directory with
 * everything in it. Its input is a pipe whose other end only the process that made the directory holds, so the end
 * comes when that process closes it (its scope closed) or ends however it ends: the kernel closes a process's end of
 * every pipe with the process, a SIGKILL's and a crash's included, where no finalizer of its runs.
 */
const REMOVER = 'while read -r _; do :; done; exec rm -rf -- "$1"'

/**
 * A temporary directory of this process's, named `<prefix><random>`, in `directory` or, where none is named, the run's
 * temporary directory (TMPDIR, which the runner and its workers share), removed with everything in it when the
 * enclosing scope closes or this process ends, however it ends. Its remover (REMOVER) runs in a session of its own, so a signal to this process's group
 * (the pool ending a worker's group, a hook's timeout) never ends it first; the scope's close ends its input and waits
 * for it, so the directory is gone when the close returns.
 */
export const processScratch = (
	at: Readonly<{ prefix: string; directory?: string }>
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const directory = yield* fs.makeTempDirectory(at)
		yield* Effect.acquireRelease(
			Effect.sync(() =>
				childProcesses.spawn("/bin/sh", ["-c", REMOVER, "sh", directory], {
					detached: true,
					stdio: ["pipe", "ignore", "ignore"]
				})
			),
			(remover) =>
				Effect.callback<void>((resume) => {
					if (remover.exitCode !== null || remover.signalCode !== null) {
						resume(Effect.void)
						return
					}
					remover.once("exit", () => resume(Effect.void))
					remover.once("error", () => resume(Effect.void))
					remover.stdin.end()
				})
		)
		return directory
	})

/**
 * Opens a worker's scratch root, `toolchain-scratch-<random>` in the run's temporary directory, which holds every case
 * directory the worker makes, so what a worker killed mid-case leaves (its case scopes never closed) is one directory,
 * removed when the worker ends however it ends (processScratch).
 */
const openRoot: Effect.Effect<string, NeedFailed, FileSystem.FileSystem | Scope.Scope> =
	processScratch({ prefix: "toolchain-scratch-" }).pipe(
		Effect.mapError((error) => NeedFailed.make({ need: key, message: error.message }))
	)

/**
 * Each case its own empty directory in its worker's scratch root (openRoot), under the run's temporary directory
 * (TMPDIR, which the runner and its workers share), removed with its contents when the case ends, whatever its outcome.
 */
const dir: Need<ScratchDir> = {
	key,
	open: Effect.map(Effect.all([openRoot, FileSystem.FileSystem]), ([root, fs]) =>
		Effect.mapBoth(fs.makeTempDirectoryScoped({ directory: root, prefix: "case-" }), {
			onFailure: (error) => NeedFailed.make({ need: key, message: error.message }),
			onSuccess: scratchDir
		})
	)
}

/** Scratch directories: `Scratch.dir`, a case's own. */
export const Scratch = { dir } as const
