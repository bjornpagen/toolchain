#!/usr/bin/env -S node

import { Array as Arr, Console, Effect, Record, String as Str } from "effect"
import type { Exceptions } from "#lint/options.ts"
import { invocationOf } from "#shared/arguments.ts"
import { repositoryToolchain } from "#shared/config.ts"
import { type Finding, renderFindings, statusOf } from "#shared/finding.ts"
import { relativeTo, Repository } from "#shared/repository.ts"
import { runDevtool } from "#shared/run.ts"
import { tsOnlyExtensionFindings } from "#workspace/extensions.ts"
import { WORKSPACE_RULES } from "#workspace/rules.ts"
import { tsconfigFindings, workspaceFixtureMismatches } from "#workspace/tsconfigs.ts"

/**
 * The workspace gate: the checks of the repository as a whole, run once at its root, which read its JSON and its file
 * list and open no TypeScript program, so it costs a fraction of a second where a linter's program costs seconds. It
 * holds every tsconfig to the Effect diagnostics the standard sets and the repository rejects (rejected-diagnostics),
 * the shared base to the installed @effect/tsgo's roster (diagnostic-roster), the root tsconfig to the one Effect
 * plugin block every package inherits (effect-plugin-block), each Effect-free package's tsconfig and manifest to
 * carrying no Effect (effect-free-packages), and every file git shows to a TypeScript extension (ts-only-extensions).
 * The repository's decisions come from its toolchain.config.ts: its rejected diagnostics, its Effect-free packages, and
 * its exceptions, which excuse the files they list from a rule they name. `--fixtures` runs the tsconfig gate against
 * its fixture workspaces instead. Exit status 1 means findings, 2 that the gate itself failed.
 */

/** Whether an exception's path, relative to `root`, names the file or a directory above it: a path that ends in "/"
 * names a directory, any other one file, compared case-insensitively, as the linters match their exceptions. */
const isAt =
	(root: string, file: string) =>
	(path: string): boolean => {
		const folded = Str.toLowerCase(file)
		const named = Str.toLowerCase(`${root}/${path}`)
		return Str.endsWith("/")(path) ? Str.startsWith(named)(folded) : folded === named
	}

/** Whether the repository's exceptions excuse a finding: one names its rule and a path at or above its file. */
const isExcepted = (exceptions: Exceptions, root: string, finding: Finding): boolean =>
	Arr.some(
		exceptions,
		(exception) =>
			exception.rule === finding.rule && Arr.some(exception.files, isAt(root, finding.file))
	)

/** The fixture workspaces against the tsconfig gate, directory for directory. */
const checkFixtures = Effect.gen(function* () {
	const { root } = yield* Repository
	const workspaces = yield* workspaceFixtureMismatches
	const shown = relativeTo(root)
	yield* Console.log(
		Arr.isReadonlyArrayNonEmpty(workspaces.mismatches)
			? Arr.join(
					[
						...Arr.map(
							workspaces.mismatches,
							(mismatch) =>
								`${shown(mismatch.workspace)}: missing [${Arr.join(Arr.map(mismatch.missing, shown), ", ")}] unexpected [${Arr.join(Arr.map(mismatch.unexpected, shown), ", ")}]`
						),
						`workspace-gate fixtures: ${String(workspaces.mismatches.length)} workspace(s) disagree with the tsconfig gate`
					],
					"\n"
				)
			: `workspace-gate fixtures: the tsconfig gate agrees with its ${String(workspaces.workspaces)} workspaces`
	)
	return statusOf(workspaces.mismatches)
})

/** Every finding of the gate over the repository, less those its exceptions excuse. */
const checkRepository = Effect.gen(function* () {
	const { root } = yield* Repository
	const config = yield* repositoryToolchain
	const tsconfigs = yield* tsconfigFindings({
		effectFree: config.effectFree,
		rejectedDiagnostics: Record.keys(config.rejected.diagnostics)
	})
	const extensions = yield* tsOnlyExtensionFindings
	const exceptions = Arr.filter(config.exceptions, (exception) =>
		Arr.contains(WORKSPACE_RULES, exception.rule)
	)
	const findings = Arr.filter(
		[...tsconfigs, ...extensions],
		(finding) => !isExcepted(exceptions, root, finding)
	)
	yield* Console.log(renderFindings({ tool: "workspace-gate", root, findings }))
	return statusOf(findings)
})

const main = Effect.gen(function* () {
	const invocation = yield* invocationOf(["--fixtures"])
	return invocation.flags.has("--fixtures") ? yield* checkFixtures : yield* checkRepository
})

runDevtool(main)
