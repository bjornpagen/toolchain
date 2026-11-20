#!/usr/bin/env -S node

import { Array as Arr, Effect, FileSystem, Option, Stdio } from "effect"
import { DevtoolFailure } from "#shared/devtool.ts"
import { runDevtool } from "#shared/run.ts"
import { TOOLS, toolRun } from "#shared/threads.ts"

/**
 * Build mode's arguments (`-b`, `--build`), which toolchain-typecheck refuses: a build reads each project's build info
 * to skip the projects it judges up to date, and takes no build info file of a run's own (TS5094).
 */
const BUILD_MODE: ReadonlySet<string> = new Set(["-b", "--build"])

/**
 * toolchain-typecheck: a package's typecheck, tsrs, Effect-patched by @effect/tsgo, over the tsconfig.json of the
 * directory it runs in (or the project `-p` names), handed its task's threads (shared/threads.ts), checked from scratch:
 * it reads no build info, so its verdict is a function of the files it checks, never of what a directory checked
 * before. TypeScript 7.1.0-beta's incremental check, tsgo's and tsrs's alike, passes code a check from scratch refuses:
 * once build info holds a file that uses an imported type, the file's next version, whose last use of the type moved
 * into the inferred type of an export, passes with the import unused (TS6196 missed), and the gate's snapshots, which
 * every clone shares, kept build info another tree wrote (METIS-BOOT, 2026-11-20: an unused `import type` passed
 * metis's commit and push gates). So whatever a project's tsconfig says, a composite project's included (TypeScript
 * keeps one incremental whatever it is told, TS6379), its build info is a file in a directory of this run's own
 * (`--tsBuildInfoFile` after every argument it is given, the last of which tsrs takes), removed when the run ends: no
 * run reads another's. Build mode is refused (BUILD_MODE); a composite project is checked with `-p`, as any other.
 * Every other argument passes through. It answers tsrs's exit status.
 */
const main = Effect.scoped(
	Effect.gen(function* () {
		const stdio = yield* Stdio.Stdio
		const args = yield* stdio.args
		if (Arr.some(args, (arg) => BUILD_MODE.has(arg))) {
			return yield* DevtoolFailure.make({
				detail:
					"toolchain-typecheck checks a project from scratch and reads no build info, so it refuses build mode (-b): check each project with -p, a composite one too"
			})
		}
		const fs = yield* FileSystem.FileSystem
		const directory = yield* fs.makeTempDirectoryScoped({ prefix: "toolchain-typecheck-" })
		return yield* toolRun(
			TOOLS.tsrs,
			[...args, "--tsBuildInfoFile", `${directory}/typecheck.tsbuildinfo`],
			Option.none()
		)
	})
)

runDevtool(main)
