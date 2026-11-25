import { Brand, type Config, Effect, FileSystem, type PlatformError, type Scope } from "effect"
import type { Need } from "#property.ts"
import { toolchainTestCache } from "#runner/cache-home.ts"
import { unwatched } from "#runner/observe.ts"
import { NeedFailed } from "#runner/services.ts"

/** A directory that is one case's alone: made empty for it, removed with everything in it when the case ends. */
export type ScratchDir = string & Brand.Brand<"ScratchDir">

const scratchDir = Brand.nominal<ScratchDir>()

const key = "@bjornpagen/testing/resources Scratch.dir"

/**
 * The CPU Scratch.dir's open may spend (property.ts Need budget): it makes the worker's scratch root and starts its
 * remover (processScratch), a shell that waits on a pipe.
 *
 * @limitKind measured
 * @owner the testing library (resources/scratch.ts Scratch.dir)
 * @unit milliseconds of CPU, the remover's among them
 * @scope each open of Scratch.dir on a process, alone or in the group of needs it opens at once with
 * @evidence ~/Documents/toolchain/packages/testing/out/need-budget/20261121T132823/ (written in lane NEEDBUDGET's
 *   ~/.cache/toolchain/needbudget and copied there), the uncommitted record of `sh run.sh` in it: probe.mjs, which opens
 *   the need 300 times in a fresh scope each and reads its process tree's CPU before and after each open as the
 *   library's judge does (runner/work.ts ownWork); alone-*.json and together-*.json, every open's CPU and wall
 *   milliseconds; summary.txt and environment.txt
 * @observed 2026-11-21 13:35:48 to 13:36:11 UTC
 * @environment cassowary, Ubuntu 26.04 (Linux 7.0.0-1018-aws) on an AWS Graviton3 (arm64) instance with 64 logical
 *   CPUs and 247 GiB, Node 26.13.1; load average 394 to 447 and CPU pressure (some avg10) 81 to 86 % from other sessions;
 *   toolchain a6172d026 with lane NEEDBUDGET's change
 * @workload 300 opens a process, one after another, each in a scope closed after it (its root and remover gone): three
 *   processes alone, then four at once, the root in the run's temporary directory
 * @result 2,100 opens: CPU p50 2.7 ms, p99 14.0 ms alone and 17.2 ms at once, slowest 35.5 ms (wall slowest 321 ms);
 *   no open failed
 * @decision 1 s: 28 times the slowest open measured. An open past it is a runaway, and in a group it adds a second to a
 *   sum a template's budget dominates. Unmeasured: a temporary directory on a slow or full filesystem
 * @revalidate a change to what the open does (processScratch), a Node upgrade, another machine
 */
const scratchDirBudgetMillis = 1000

/** Node's child processes: a scratch directory's remover is started with a pipe the maker alone holds. */
/** node:child_process's spawn as it was before any guard: a scratch directory's remover is the runner's own process (runner/observe.ts). */
const childProcesses = unwatched

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
 * A temporary directory of this process's (processScratch) in toolchain-test's cache, `<cache>/scratch`
 * (runner/cache-home.ts): on the disk a user's caches share with a package manager's store, where the run's temporary
 * directory may be a tmpfs. A package installed into it is hardlinked from the store file by file, where a tmpfs, on
 * another filesystem, takes a copy of every file and an inode for each; and like every process scratch it is removed
 * when its scope closes or its process ends, however it ends.
 */
export const cachedScratch = (
	prefix: string
): Effect.Effect<
	string,
	PlatformError.PlatformError | Config.ConfigError,
	FileSystem.FileSystem | Scope.Scope
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const directory = `${yield* toolchainTestCache}/scratch`
		yield* fs.makeDirectory(directory, { recursive: true })
		return yield* processScratch({ prefix, directory })
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
	budget: scratchDirBudgetMillis,
	runNeeds: [],
	open: Effect.map(Effect.all([openRoot, FileSystem.FileSystem]), ([root, fs]) =>
		Effect.mapBoth(fs.makeTempDirectoryScoped({ directory: root, prefix: "case-" }), {
			onFailure: (error) => NeedFailed.make({ need: key, message: error.message }),
			onSuccess: scratchDir
		})
	)
}

/** Scratch directories: `Scratch.dir`, a case's own. */
export const Scratch = { dir } as const
