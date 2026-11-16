import { Brand, Effect, FileSystem } from "effect"
import type { Need } from "#property.ts"
import { NeedFailed } from "#runner/services.ts"

/** A directory that is one case's alone: made empty for it, removed with everything in it when the case ends. */
export type ScratchDir = string & Brand.Brand<"ScratchDir">

const scratchDir = Brand.nominal<ScratchDir>()

const key = "@bjornpagen/testing/resources Scratch.dir"

/**
 * Each case its own empty directory under the run's scratch root, the process's temporary directory (TMPDIR, which the
 * runner and its workers share), removed with its contents when the case ends, whatever its outcome.
 */
const dir: Need<ScratchDir> = {
	key,
	open: Effect.map(FileSystem.FileSystem, (fs) =>
		Effect.mapBoth(fs.makeTempDirectoryScoped({ prefix: "case-" }), {
			onFailure: (error) => NeedFailed.make({ need: key, message: error.message }),
			onSuccess: scratchDir
		})
	)
}

/** Scratch directories: `Scratch.dir`, a case's own. */
export const Scratch = { dir } as const
