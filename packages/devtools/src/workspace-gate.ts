#!/usr/bin/env -S node

import { Array as Arr, Console, Effect, FileSystem, Option, Record, String as Str } from "effect"
import { STANDARD_GLOBS } from "#preset.ts"
import { invocationOf } from "#shared/arguments.ts"
import {
	CONFIG_FILE,
	LINT_CONFIG_FILE,
	repositoryOverrides,
	repositoryToolchain
} from "#shared/config.ts"
import { failureFrom } from "#shared/devtool.ts"
import { type Finding, renderFindings, statusOf } from "#shared/finding.ts"
import { gitFilesUnder } from "#shared/git.ts"
import { relativeTo, Repository } from "#shared/repository.ts"
import { runDevtool } from "#shared/run.ts"
import { deadPathFindings } from "#workspace/dead-paths.ts"
import { tsOnlyExtensionFindings } from "#workspace/extensions.ts"
import { parentSnapshot } from "#workspace/parent.ts"
import { rootFileFindings, rootIncludeOf } from "#workspace/root-files.ts"
import { ROOT_MANIFEST, rootTaskFindings, TURBO_CONFIG } from "#workspace/root-tasks.ts"
import type { Exceptions } from "#workspace/rules.ts"
import { readsText, testSystemFindings } from "#workspace/test-system.ts"
import { tsconfigFindings, workspaceFixtureMismatches } from "#workspace/tsconfigs.ts"

/**
 * The workspace gate: the checks of the repository as a whole, run once at its root, which read its JSON and its file
 * list and open no TypeScript program, so it costs a fraction of a second where a linter's program costs seconds. It
 * holds every tsconfig to the Effect diagnostics the standard sets and the repository rejects (rejected-diagnostics),
 * the shared base to the installed @effect/tsgo's roster (diagnostic-roster), the root tsconfig to the one Effect
 * plugin block every package inherits (effect-plugin-block), each Effect-free package's tsconfig and manifest to
 * carrying no Effect (effect-free-packages), every file git shows to a TypeScript extension (ts-only-extensions), every
 * oxlint override glob and exception path to naming a file (dead-paths), every root script named as a generic turbo
 * task to a root task turbo.json registers, so no `turbo run` passes over the root's own files (root-tasks), every
 * TypeScript file under no workspace package to a path the root tsconfig's include names, which the root's typecheck
 * and its lint (`toolchain-oxlint-root`) both read, and the root's oxlint script to that lint (root-files), and the
 * test system's gates (workspace/test-system.ts): no worker flag in a script, and, in a repository that runs the
 * properties pack, no Vitest configuration, no plant and no numbered shard of a test module.
 * The repository's decisions come from its toolchain.config.ts: its rejected diagnostics, its Effect-free packages, and
 * its exceptions, which excuse the files they list from one of these rules and name no other. `--fixtures` runs the
 * tsconfig gate against its fixture workspaces instead. Exit status 1 means findings, 2 that the gate itself failed.
 */

/** A path with its `.` segments dropped, so a root package's `<root>/./package.json` is `<root>/package.json`. */
const withoutDots = (path: string): string =>
	Arr.join(
		Arr.filter(Str.split("/")(path), (segment) => segment !== "."),
		"/"
	)

/** Whether an exception's path, relative to `root`, names the file or a directory above it: a path that ends in "/"
 * names a directory, any other one file, compared case-insensitively. */
const isAt =
	(root: string, file: string) =>
	(path: string): boolean => {
		const folded = Str.toLowerCase(withoutDots(file))
		const named = Str.toLowerCase(withoutDots(`${root}/${path}`))
		return Str.endsWith("/")(path) ? Str.startsWith(named)(folded) : folded === named
	}

/** Whether the repository's exceptions excuse a finding: one names its rule and a path at or above its file. */
const isExcepted = (exceptions: Exceptions, root: string, finding: Finding): boolean =>
	Arr.some(
		exceptions,
		(exception) =>
			exception.rule === finding.rule && Arr.some(exception.files, isAt(root, finding.file))
	)

/** The testing plugin's rule of a test module's shape, as a configuration names it: an override that turns it off
 * exempts the quarantined modules. */
const SHAPE_RULE = "testing/test-module-shape"

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
	const { root, packages } = yield* Repository
	const config = yield* repositoryToolchain
	const tsconfigs = yield* tsconfigFindings({
		effectFree: config.effectFree,
		rejectedDiagnostics: Record.keys(config.rejected.diagnostics)
	})
	const extensions = yield* tsOnlyExtensionFindings
	const fs = yield* FileSystem.FileSystem
	const read = (path: string) =>
		fs
			.readFileString(`${root}/${path}`)
			.pipe(Effect.mapError(failureFrom(`${path} could not be read`)))
	const tracked = yield* gitFilesUnder(root)
	const files = Arr.map(tracked, relativeTo(root))
	const textsRead = yield* Effect.forEach(
		Arr.filter(files, readsText),
		(path) => Effect.map(read(path), (text) => [path, text] as const),
		{ concurrency: "unbounded" }
	)
	const texts = new Map(textsRead)
	const overrides = yield* repositoryOverrides
	const parent = yield* parentSnapshot(root)
	const testSystem = testSystemFindings(
		{
			root,
			files,
			textOf: (path) => Option.fromUndefinedOr(texts.get(path)),
			parent,
			lintConfig: LINT_CONFIG_FILE,
			shapeExemptions: Arr.flatMap(overrides, (override) =>
				Option.exists(Option.fromUndefinedOr(override.rules), (rules) =>
					Arr.contains(["off", 0], rules[SHAPE_RULE])
				)
					? override.files
					: []
			)
		},
		Arr.map(config.packs, (pack) => pack.pack)
	)
	const lintText = yield* read(LINT_CONFIG_FILE)
	const globs = Arr.flatMap(overrides, (override) => [
		...override.files,
		...(override.excludeFiles ?? [])
	])
	const toolchainText = yield* read(CONFIG_FILE)
	const deadPaths = deadPathFindings({
		root,
		files,
		lint: { path: LINT_CONFIG_FILE, text: lintText, globs },
		toolchain: { path: CONFIG_FILE, text: toolchainText, exceptions: config.exceptions },
		standard: STANDARD_GLOBS
	})
	const manifest = yield* read(ROOT_MANIFEST)
	const turboPresent = yield* fs
		.exists(`${root}/${TURBO_CONFIG}`)
		.pipe(Effect.mapError(failureFrom(`${TURBO_CONFIG} could not be read`)))
	const turbo = turboPresent ? yield* Effect.asSome(read(TURBO_CONFIG)) : Option.none<string>()
	const rootTasks = yield* rootTaskFindings({ root, manifest, turbo })
	const rootTsconfig = yield* rootIncludeOf(root)
	const rootFiles = yield* rootFileFindings({
		root,
		files,
		packages: Arr.map(packages, relativeTo(root)),
		include: rootTsconfig.include,
		tsconfig: rootTsconfig.text,
		manifest
	})
	const findings = Arr.filter(
		[...tsconfigs, ...extensions, ...testSystem, ...deadPaths, ...rootTasks, ...rootFiles],
		(finding) => !isExcepted(config.exceptions, root, finding)
	)
	yield* Console.log(renderFindings({ tool: "workspace-gate", root, findings }))
	return statusOf(findings)
})

const main = Effect.gen(function* () {
	const invocation = yield* invocationOf(["--fixtures"])
	return invocation.flags.has("--fixtures") ? yield* checkFixtures : yield* checkRepository
})

runDevtool(main)
