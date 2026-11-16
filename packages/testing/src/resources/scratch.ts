import { regex } from "arkregex"
import { Brand, Effect, FileSystem, Option, Path, Predicate, Result, type Scope } from "effect"
import type { Need } from "#property.ts"
import { NeedFailed } from "#runner/services.ts"

/** A directory that is one case's alone: made empty for it, removed with everything in it when the case ends. */
export type ScratchDir = string & Brand.Brand<"ScratchDir">

const scratchDir = Brand.nominal<ScratchDir>()

const key = "@bjornpagen/testing/resources Scratch.dir"

/**
 * A worker's scratch root in the run's temporary directory: `toolchain-scratch-<the worker's pid>-<random>`, which holds
 * every case directory the worker makes, so what a worker killed mid-case leaves (its case scopes never closed) is one
 * directory, named by the process that made it.
 */
const rootName = regex("^toolchain-scratch-([1-9][0-9]*)-")

/**
 * Whether a process of `pid` runs on this machine: signal 0 reaches it, or reaches a process of another user, which
 * refuses it (EPERM). Only an answer that no such process exists (ESRCH) says it has ended.
 */
const running = (pid: number): boolean =>
	Result.match(Result.try({ try: () => process.kill(pid, 0), catch: (error) => error }), {
		onSuccess: () => true,
		onFailure: (error) => !(Predicate.hasProperty(error, "code") && error.code === "ESRCH")
	})

/** The pid of the worker whose scratch root `name` is, when its process has ended; none for any other name. */
const endedOwner = (name: string): Option.Option<number> =>
	Option.filter(
		Option.map(Option.fromNullishOr(rootName.exec(name)?.[1]), Number),
		(pid) => !running(pid)
	)

/**
 * Opens a worker's scratch root, in the worker's scope (removed with what it holds when the worker ends), after removing
 * the roots of workers that have ended without removing theirs (a worker killed mid-case, a run cut short): the
 * temporary directory never holds more than the running workers' roots and the cases' directories in them.
 */
const openRoot: Effect.Effect<string, NeedFailed, FileSystem.FileSystem | Path.Path | Scope.Scope> =
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const root = yield* fs.makeTempDirectoryScoped({ prefix: `toolchain-scratch-${process.pid}-` })
		const base = path.dirname(root)
		const names = yield* fs.readDirectory(base)
		yield* Effect.forEach(
			names,
			(name) =>
				Option.match(endedOwner(name), {
					onNone: () => Effect.void,
					onSome: () => fs.remove(path.join(base, name), { recursive: true, force: true })
				}),
			{ discard: true }
		)
		return root
	}).pipe(Effect.mapError((error) => NeedFailed.make({ need: key, message: error.message })))

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
