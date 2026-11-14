#!/usr/bin/env -S node

import {
	Array as Arr,
	Console,
	Effect,
	FileSystem,
	Option,
	Path,
	Result,
	String as Str
} from "effect"
import type * as ts from "typescript/ast"
import type { Checker, Project } from "typescript/sync"
import { bindRules, type Toolchain } from "#config.ts"
import { type Exceptions, FIXTURE_EXCEPTIONS, GRIZZLE_FIXTURE_OPTIONS } from "#lint/options.ts"
import { isAtAny } from "#lint/paths.ts"
import { GRIZZLE_RULES } from "#lint/rules/index.ts"
import { surfaceOf } from "#lint/surface.ts"
import type { BoundRule, FileContext, Visitor } from "#lint/types.ts"
import { invocationOf } from "#shared/arguments.ts"
import { repositoryToolchain } from "#shared/config.ts"
import { DevtoolFailure } from "#shared/devtool.ts"
import { type Finding, findingAt, renderFindings, statusOf } from "#shared/finding.ts"
import { fixtureMismatchesOf, renderFixtureMismatches } from "#shared/fixtures.ts"
import { type RoundTrip, withProgram } from "#shared/native-api.ts"
import { everyNode, preorder } from "#shared/nodes.ts"
import {
	covers,
	isGeneratedPath,
	isTypeScriptPath,
	isVendoredPath,
	relativeTo,
	Repository
} from "#shared/repository.ts"
import { runDevtool } from "#shared/run.ts"
import { selectFiles } from "#shared/selection.ts"
import { prepareSemantics } from "#shared/semantic.ts"
import { WORKSPACE_RULES } from "#workspace/rules.ts"

/**
 * Superlint: the repository's opinionated type-aware rules that oxlint has no rule for. It lints the package in the
 * working directory: each workspace package's `superlint` task runs it in the package, and the repository root's runs
 * it at the root; the checks of the repository as a whole are the workspace gate's (`workspace-gate.ts`). The
 * repository's decisions come from its toolchain.config.ts: the core, the packs it runs beside it with their names, its
 * own rules, and its exceptions. Explicit paths lint the files at or under them (a file the tsconfig excludes is added
 * to the program); `--fixtures` runs every rule against its fixtures instead (or, given fixtures directories laid out
 * as the shared ones are, the shared rules against those), and `--pending` runs the pending rules beside the rest. Exit status 1 means findings, 2 that the linter itself failed.
 */

/**
 * One lint run is one package's program: the nearest tsconfig.json at or above the package root, and only the
 * files whose nearest package.json is that package's. A workspace dependency's source the program loads is that
 * dependency's to lint, so no file is reported twice.
 */

const inspectionFailure = (subject: string) => (cause: unknown) =>
	DevtoolFailure.make({ detail: `${subject} could not be inspected`, cause })

/** The rules a repository's toolchain runs: the core, each pack it names beside it, and its own. */
const rulesOf = (config: Toolchain): ReadonlyArray<BoundRule> => [
	...Arr.flatMap(config.packs, (pack): ReadonlyArray<BoundRule> => {
		switch (pack.pack) {
			case "grizzle":
				return bindRules(GRIZZLE_RULES, pack.options)
			case "drizzle":
			case "web":
				return []
		}
	}),
	...Arr.flatMap(config.own, (own) => own.rules)
]

/** Every shared rule, bound to its pack's fixture options: what the shared fixtures prove. */
const SHARED_FIXTURE_RULES: ReadonlyArray<BoundRule> = [
	...bindRules(GRIZZLE_RULES, GRIZZLE_FIXTURE_OPTIONS)
]

/**
 * The repository's toolchain, checked against the rules it runs: an exception names a rule the toolchain runs or one
 * of the workspace gate's. A failure names what to fix in toolchain.config.ts.
 */
const projectToolchain = Effect.gen(function* () {
	const config = yield* repositoryToolchain
	const ids = Arr.map(rulesOf(config), (rule) => rule.id)
	const unknown = Arr.filter(
		config.exceptions,
		(exception) =>
			!Arr.contains(ids, exception.rule) && !Arr.contains(WORKSPACE_RULES, exception.rule)
	)
	if (Arr.isReadonlyArrayNonEmpty(unknown)) {
		return yield* DevtoolFailure.make({
			detail: `toolchain.config.ts lists exceptions for rules this repository does not run: ${Arr.join(
				Arr.map(unknown, (exception) => exception.rule),
				", "
			)}`
		})
	}
	return config
})

/** A source file the linter reports on, with the checker of the package's program and its session's round trip. */
type LintSource = Readonly<{
	sourceFile: ts.SourceFile
	checker: Checker
	roundTrip: RoundTrip
}>

/** The nearest ancestor directory holding a package.json, no higher than the repository root: the workspace leaf
 * that owns a file. Group folders (packages/data, packages/product, …) hold no package.json and own nothing. */
const leafResolver = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const { root } = yield* Repository
	const known = new Map<string, Option.Option<string>>()
	const lookup = (directory: string): Effect.Effect<Option.Option<string>, DevtoolFailure> =>
		Effect.gen(function* () {
			if (!covers({ selected: root, file: directory })) {
				return Option.none()
			}
			const manifest = yield* fs
				.exists(path.join(directory, "package.json"))
				.pipe(Effect.mapError(inspectionFailure(directory)))
			if (manifest) {
				return Option.some(directory)
			}
			const parent = path.dirname(directory)
			if (directory === root || parent === directory) {
				return Option.none()
			}
			return yield* leafOf(parent)
		})
	const leafOf = (directory: string): Effect.Effect<Option.Option<string>, DevtoolFailure> =>
		Effect.gen(function* () {
			const cached = known.get(directory)
			if (cached !== undefined) {
				return cached
			}
			const found = yield* lookup(directory)
			known.set(directory, found)
			return found
		})
	return leafOf
})

/** The nearest tsconfig.json at or above `directory`. */
const configOf = (
	directory: string
): Effect.Effect<string, DevtoolFailure, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const candidate = path.join(directory, "tsconfig.json")
		const exists = yield* fs.exists(candidate).pipe(Effect.mapError(inspectionFailure(candidate)))
		if (exists) {
			return candidate
		}
		const parent = path.dirname(directory)
		if (parent === directory) {
			return yield* DevtoolFailure.make({ detail: "tsconfig.json not found" })
		}
		return yield* configOf(parent)
	})

/** The source files of the package's program that the package owns. */
const ownedSourcesOf = (
	input: Readonly<{ project: Project; roundTrip: RoundTrip; packageRoot: string }>
) =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		const { apps } = yield* Repository
		const { project } = input
		const fileNames = yield* Effect.try({
			try: () => project.program.getSourceFileNames(),
			catch: (cause) =>
				DevtoolFailure.make({ detail: "The lint program's source files could not be read", cause })
		})
		const leafOf = yield* leafResolver
		const owned = yield* Effect.filter(
			Arr.filter(fileNames, (file) => !isGeneratedPath(file) && !isVendoredPath(apps)(file)),
			(file) =>
				Effect.map(leafOf(path.dirname(file)), (leaf) => Option.contains(leaf, input.packageRoot))
		)
		return yield* Effect.try({
			try: () =>
				Arr.filterMap(owned, (file): Result.Result<LintSource, void> => {
					const sourceFile = project.program.getSourceFile(file)
					if (sourceFile === undefined || sourceFile.isDeclarationFile) {
						return Result.failVoid
					}
					return Result.succeed({
						sourceFile,
						checker: project.checker,
						roundTrip: input.roundTrip
					})
				}),
			catch: (cause) =>
				DevtoolFailure.make({ detail: "The lint program's source files could not be read", cause })
		})
	})

/** A rule started on the program a run lints: the Visit each of its files gets. */
type StartedRule = Readonly<{ id: string; visit: Visitor<FileContext> }>

/**
 * Starts the rules on a program. A rule that guards the public surface starts with it: the source modules of the
 * public exports the manifests declare (lint/surface.ts), read only when such a rule runs. A module the surface names
 * that the program does not hold fails the lint, since its inputs could not be checked: an unread surface is never a
 * pass.
 */
const startRules = (
	input: Readonly<{
		project: Project
		rules: ReadonlyArray<BoundRule>
		manifests: ReadonlyArray<string>
	}>
) =>
	Effect.gen(function* () {
		const { root } = yield* Repository
		const readsSurface = Arr.some(input.rules, (rule) => rule.starting.reads === "surface")
		const surfaces = readsSurface
			? yield* Effect.forEach(input.manifests, surfaceOf, { concurrency: 1 })
			: []
		const surface = Arr.flatten(surfaces)
		const held = yield* Effect.try({
			try: () => input.project.program.getSourceFileNames(),
			catch: (cause) =>
				DevtoolFailure.make({ detail: "The lint program's source files could not be read", cause })
		})
		const unheld = Arr.filter(surface, (module) => !Arr.contains(held, module))
		if (Arr.isReadonlyArrayNonEmpty(unheld)) {
			return yield* DevtoolFailure.make({
				detail: `The public exports of ${Arr.join(Arr.map(input.manifests, relativeTo(root)), ", ")} name modules the package's program does not hold: ${Arr.join(Arr.map(unheld, relativeTo(root)), ", ")}`
			})
		}
		const { checker } = input.project
		return yield* Effect.try({
			try: () =>
				Arr.map(input.rules, (rule): StartedRule => {
					const { starting } = rule
					switch (starting.reads) {
						case "file":
							return { id: rule.id, visit: starting.visit }
						case "program":
							return { id: rule.id, visit: starting.start({ checker }) }
						case "surface":
							return { id: rule.id, visit: starting.start({ checker, surface }) }
					}
				}),
			catch: (cause) =>
				DevtoolFailure.make({ detail: "superlint failed while starting its rules", cause })
		})
	})

/** Every started rule over one file in a single traversal; the engine stamps each report with its rule's id. */
const findingsOf = (
	source: LintSource,
	input: Readonly<{ rules: ReadonlyArray<StartedRule>; exceptions: Exceptions; root: string }>
): ReadonlyArray<Finding> => {
	const { exceptions, root } = input
	const context: FileContext = {
		sourceFile: source.sourceFile,
		checker: source.checker,
		semantics: prepareSemantics(source),
		root
	}
	const excepted = Arr.filterMap(exceptions, (exception) =>
		isAtAny(root, exception.files, source.sourceFile.fileName)
			? Result.succeed(exception.rule)
			: Result.failVoid
	)
	const visitors = Arr.map(
		Arr.filter(input.rules, (rule) => !Arr.contains(excepted, rule.id)),
		(rule) => ({ rule: rule.id, visit: rule.visit(context) })
	)
	const findings: Array<Finding> = []
	for (const node of preorder(source.sourceFile, everyNode)) {
		for (const { rule, visit } of visitors) {
			for (const report of visit(node)) {
				findings.push(findingAt({ sourceFile: source.sourceFile, rule, report }))
			}
		}
	}
	return findings
}

const VIOLATING_FIXTURE = "/violating.ts"

/**
 * The fixture sets the rules run against, by their directory under the fixtures root: each rule's own directory, and
 * every directory beneath it that holds a violating fixture of its own, where the rule runs under the options that
 * name that directory (a second scope, a sanctioned reader). A set's first segment is its rule.
 */
const fixtureSetsOf = (
	fixtures: string,
	rules: ReadonlyArray<BoundRule>,
	files: ReadonlyArray<string>
): ReadonlyArray<string> =>
	Arr.flatMap(rules, (rule) => {
		const directory = `${fixtures}/${rule.id}/`
		const nested = Arr.filterMap(files, (file): Result.Result<string, void> =>
			Str.startsWith(directory)(file) &&
			Str.endsWith(VIOLATING_FIXTURE)(file) &&
			file !== `${directory}violating.ts`
				? Result.succeed(
						Str.slice(fixtures.length + 1, file.length - VIOLATING_FIXTURE.length)(file)
					)
				: Result.failVoid
		)
		return [rule.id, ...nested]
	})

/** The rule a fixture set proves: its directory's first segment. */
const ruleOfSet = (set: string): string => Arr.headNonEmpty(Str.split("/")(set))

/**
 * One fixtures directory against its rules: its own program (the directory's tsconfig.json), the rules started with
 * any public surface their fixtures declare (a package.json beside a rule's fixtures whose exports name fixture
 * modules), and each set's fixtures line for line, with the fixtures root as the root the options' paths are
 * relative to.
 */
const fixtureMismatchesIn = (
	input: Readonly<{
		fixtures: string
		rules: ReadonlyArray<BoundRule>
		exceptions: Exceptions
	}>
) =>
	withProgram({ config: `${input.fixtures}/tsconfig.json`, extraFiles: [] }, (project, roundTrip) =>
		Effect.gen(function* () {
			const rules = yield* startRules({
				project,
				rules: input.rules,
				manifests: Arr.map(input.rules, (rule) => `${input.fixtures}/${rule.id}/package.json`)
			})
			return yield* Effect.try({
				try: () =>
					fixtureMismatchesOf({
						root: input.fixtures,
						extensionOf: () => ".ts",
						rules: fixtureSetsOf(input.fixtures, input.rules, project.program.getSourceFileNames()),
						runOf: ({ rule: set, file }) =>
							Option.map(
								Option.fromUndefinedOr(project.program.getSourceFile(file)),
								(sourceFile) => ({
									text: sourceFile.text,
									reported: Arr.filterMap(
										findingsOf(
											{ sourceFile, checker: project.checker, roundTrip },
											{ rules, exceptions: input.exceptions, root: input.fixtures }
										),
										(finding) =>
											finding.rule === ruleOfSet(set)
												? Result.succeed(finding.line)
												: Result.failVoid
									)
								})
							)
					}),
				catch: (cause) => DevtoolFailure.make({ detail: "superlint fixtures failed to run", cause })
			})
		})
	)

/** The shared packs' fixtures, which compile in their own program; no other tool reads them. */
const FIXTURES_ROOT = `${import.meta.dirname}/lint/fixtures`

/** The dev tools' own package: the directory above their sources. */
const DEVTOOLS_ROOT = `${import.meta.dirname}/..`

/**
 * The fixtures a repository proves: its own rules' fixtures, and the shared packs' when the dev tools are the
 * repository's own package rather than vendored under its vendor/ directory (where the toolchain's gate proves them).
 */
const checkFixtures = Effect.gen(function* () {
	const path = yield* Path.Path
	const { root } = yield* Repository
	const config = yield* repositoryToolchain
	const devtools = path.resolve(DEVTOOLS_ROOT)
	const shared = !covers({ selected: `${root}/vendor`, file: devtools })
	const sharedMismatches = shared
		? yield* fixtureMismatchesIn({
				fixtures: FIXTURES_ROOT,
				rules: SHARED_FIXTURE_RULES,
				exceptions: FIXTURE_EXCEPTIONS
			})
		: []
	const ownMismatches = yield* Effect.forEach(
		config.own,
		(own) =>
			fixtureMismatchesIn({
				fixtures: own.fixtures,
				rules: own.fixtureRules,
				exceptions: []
			}),
		{ concurrency: 1 }
	)
	const mismatches = [...sharedMismatches, ...Arr.flatten(ownMismatches)]
	const rules =
		(shared ? SHARED_FIXTURE_RULES.length : 0) +
		Arr.reduce(config.own, 0, (count, own) => count + own.fixtureRules.length)
	yield* Console.log(renderFixtureMismatches({ tool: "superlint", root, rules, mismatches }))
	return statusOf(mismatches)
})

/**
 * Other fixtures directories against the shared rules, each with the shared fixture options: every rule whose
 * directory the fixtures root holds runs against its sets there. It proves that a copy's fixtures, laid out as the
 * shared ones are, agree with this engine.
 */
const checkFixturesAt = (directories: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const { root } = yield* Repository
		const perDirectory = yield* Effect.forEach(
			directories,
			(fixtures) =>
				Effect.gen(function* () {
					const rules = yield* Effect.filter(SHARED_FIXTURE_RULES, (rule) =>
						fs
							.exists(`${fixtures}/${rule.id}`)
							.pipe(Effect.mapError(inspectionFailure(`${fixtures}/${rule.id}`)))
					)
					const mismatches = yield* fixtureMismatchesIn({
						fixtures,
						rules,
						exceptions: FIXTURE_EXCEPTIONS
					})
					yield* Console.log(
						renderFixtureMismatches({
							tool: `superlint fixtures at ${relativeTo(root)(fixtures)}`,
							root,
							rules: rules.length,
							mismatches
						})
					)
					return mismatches
				}),
			{ concurrency: 1 }
		)
		return statusOf(Arr.flatten(perDirectory))
	})

/** Whether the repository's exceptions excuse a finding: one names its rule and a path at or above its file. */
const isExcepted = (exceptions: Exceptions, root: string, finding: Finding): boolean =>
	Arr.some(
		exceptions,
		(exception) => exception.rule === finding.rule && isAtAny(root, exception.files, finding.file)
	)

const main = Effect.gen(function* () {
	const invocation = yield* invocationOf(["--fixtures", "--pending"])
	if (invocation.flags.has("--fixtures")) {
		return Arr.isReadonlyArrayNonEmpty(invocation.paths)
			? yield* checkFixturesAt(invocation.paths)
			: yield* checkFixtures
	}
	const packageRoot = yield* Effect.sync(() => process.cwd())
	const { root } = yield* Repository
	const config = yield* projectToolchain
	const tsconfig = yield* configOf(packageRoot)
	const pending = invocation.flags.has("--pending")
	const findings = yield* withProgram(
		{ config: tsconfig, extraFiles: Arr.filter(invocation.paths, isTypeScriptPath) },
		(project, roundTrip) =>
			Effect.gen(function* () {
				const owned = yield* ownedSourcesOf({ project, roundTrip, packageRoot })
				const selected = yield* selectFiles({
					available: Arr.map(owned, (source) => source.sourceFile.fileName),
					paths: invocation.paths
				})
				const sources = Arr.filter(owned, (source) =>
					Arr.contains(selected, source.sourceFile.fileName)
				)
				const rules = yield* startRules({
					project,
					rules: Arr.filter(rulesOf(config), (rule) => pending || rule.gate === "on"),
					manifests: [`${packageRoot}/package.json`]
				})
				const perSource = yield* Effect.forEach(
					sources,
					(source) =>
						Effect.try({
							try: () => findingsOf(source, { rules, exceptions: config.exceptions, root }),
							catch: (cause) =>
								DevtoolFailure.make({
									detail: `superlint failed while collecting findings in ${relativeTo(root)(source.sourceFile.fileName)}`,
									cause
								})
						}),
					{ concurrency: 1 }
				)
				return Arr.filter(
					Arr.flatten(perSource),
					(finding) => !isExcepted(config.exceptions, root, finding)
				)
			})
	)
	yield* Console.log(renderFindings({ tool: "superlint", root, findings }))
	return statusOf(findings)
})

runDevtool(main)
