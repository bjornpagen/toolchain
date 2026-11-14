import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	Path,
	Record,
	Result,
	Schema,
	String as Str
} from "effect"
import { DevtoolFailure } from "#shared/devtool.ts"
import type { Finding } from "#shared/finding.ts"
import { covers, relativeTo, Repository } from "#shared/repository.ts"
import { EffectFree } from "#workspace/rules.ts"

/**
 * The repository's tsconfig gate, run by the workspace gate at the repository root: the Effect diagnostics every
 * tsconfig sets, the shared base's list held to the installed @effect/tsgo's roster, the one plugin block the root
 * tsconfig declares, and the Effect-free packages the repository's toolchain lists. It reads JSON alone and opens no
 * TypeScript program. A workspace package under the root's vendor/ is another repository's, checked by that
 * repository's own gate, so the gate leaves it alone.
 */

const inspectionFailure = (subject: string) => (cause: unknown) =>
	DevtoolFailure.make({ detail: `${subject} could not be inspected`, cause })

/** The Effect language service's plugin name in a tsconfig's `compilerOptions.plugins`. */
const EFFECT_PLUGIN = "@effect/language-service"

/** What the gate reads of a tsconfig: the config it extends, and the plugins it declares with the severity each sets
 * per diagnostic. */
const Tsconfig = Schema.fromJsonString(
	Schema.Struct({
		extends: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
		compilerOptions: Schema.optionalKey(
			Schema.Struct({
				plugins: Schema.optionalKey(
					Schema.Array(
						Schema.Struct({
							name: Schema.String,
							diagnosticSeverity: Schema.optionalKey(Schema.Record(Schema.String, Schema.String))
						})
					)
				)
			})
		)
	})
)

const decodeTsconfig = Schema.decodeUnknownEffect(Tsconfig)

/** The severities each Effect language-service plugin a tsconfig declares sets, by diagnostic. */
const severitiesIn = (
	config: typeof Tsconfig.Type
): ReadonlyArray<Readonly<Record<string, string>>> => {
	const plugins = config.compilerOptions?.plugins ?? []
	return Arr.filterMap(plugins, (plugin) =>
		plugin.name === EFFECT_PLUGIN
			? Result.succeed(plugin.diagnosticSeverity ?? {})
			: Result.failVoid
	)
}

/** The tsconfig base the dev tools ship, which sets every diagnostic of the installed @effect/tsgo to error: each
 * repository's root tsconfig restates the plugin once with its own rejections off. */
const TSCONFIG_BASE = `${import.meta.dirname}/../../tsconfig.base.json`

const readTsconfig = (config: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const text = yield* fs.readFileString(config).pipe(Effect.mapError(inspectionFailure(config)))
		return yield* decodeTsconfig(text).pipe(
			Effect.mapError((cause) =>
				DevtoolFailure.make({ detail: `${config} is not a tsconfig this lint reads`, cause })
			)
		)
	})

/** The diagnostics the shared base lists, by name. */
const listedDiagnostics = Effect.gen(function* () {
	const path = yield* Path.Path
	const base = path.resolve(TSCONFIG_BASE)
	const config = yield* readTsconfig(base)
	return { base, listed: Arr.flatMap(severitiesIn(config), Record.keys) }
})

/** Whether a workspace package is another repository's, vendored under the root's vendor/ directory. */
const isVendoredPackage =
	(root: string) =>
	(leaf: string): boolean =>
		covers({ selected: `${root}/vendor`, file: leaf })

/** The repository's own workspace packages: every one but those vendored from another repository. */
const ownPackagesOf = (root: string, packages: ReadonlyArray<string>): ReadonlyArray<string> =>
	Arr.filter(packages, (leaf) => !isVendoredPackage(root)(leaf))

/** The root tsconfig and every own workspace package's tsconfig.json that exists. */
const workspaceTsconfigs = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const { root, packages } = yield* Repository
	const configs = Arr.map(ownPackagesOf(root, packages), (leaf) => `${leaf}/tsconfig.json`)
	const present = yield* Effect.filter(configs, (config) =>
		fs.exists(config).pipe(Effect.mapError(inspectionFailure(config)))
	)
	return [`${root}/tsconfig.json`, ...present]
})

/**
 * Every Effect diagnostic the shared base lists is set the same way in every tsconfig that declares the plugin. The
 * base sets each to error, since a rejection is a repository's own; the repository's tsconfigs set it off exactly when
 * the repository's toolchain rejects it, with its reason, and error otherwise. So a diagnostic is rejected with its
 * reason or not at all, and the root tsconfig, which restates the plugin with the repository's rejections and its
 * per-file overrides, cannot drift from the standard.
 */
const standardFindings = (rejected: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const { root } = yield* Repository
		const shown = relativeTo(root)
		const { base, listed } = yield* listedDiagnostics
		const workspace = yield* workspaceTsconfigs
		const held = [
			{ config: base, rejected: [] },
			...Arr.map(workspace, (config) => ({ config, rejected }))
		]
		const findings = yield* Effect.forEach(
			held,
			(standard) =>
				Effect.map(readTsconfig(standard.config), (decoded) => {
					const expected = (diagnostic: string): string =>
						Arr.contains(standard.rejected, diagnostic) ? "off" : "error"
					const { config } = standard
					return Arr.flatMap(severitiesIn(decoded), (severities) => [
						...Arr.filterMap(
							Arr.dedupe([...listed, ...standard.rejected]),
							(diagnostic): Result.Result<Finding, void> => {
								const set = Record.get(severities, diagnostic)
								if (Option.contains(set, expected(diagnostic))) {
									return Result.failVoid
								}
								return Result.succeed({
									file: config,
									line: 1,
									column: 1,
									rule: "rejected-diagnostics",
									message: `${shown(config)} ${Option.match(set, {
										onNone: () => "does not list",
										onSome: (severity) => `sets ${severity} for`
									})} the Effect diagnostic ${diagnostic}, which the standard sets to ${expected(diagnostic)}.`,
									suggestion: Arr.contains(standard.rejected, diagnostic)
										? "The repository's toolchain rejects it: set it to off."
										: "Set it to error, or reject it in toolchain.config.ts's rejected.diagnostics with its reason, which needs the owner."
								})
							}
						),
						...Arr.map(Arr.difference(Record.keys(severities), listed), (diagnostic): Finding => ({
							file: config,
							line: 1,
							column: 1,
							rule: "rejected-diagnostics",
							message: `${shown(config)} lists the Effect diagnostic ${diagnostic}, which the shared base does not.`,
							suggestion: "List every diagnostic in the shared base, and only those."
						}))
					])
				}),
			{ concurrency: 1 }
		)
		return Arr.flatten(findings)
	})

/** The oxlint plugin namespace every preset rule sits in, as `effecttsgo/<kebab-case diagnostic>`. */
const ROSTER_NAMESPACE = "effecttsgo/"

/** One oxlint preset of @effect/tsgo: its rules by name. */
const RosterPreset = Schema.fromJsonString(
	Schema.Struct({ rules: Schema.Record(Schema.String, Schema.Unknown) })
)

const decodeRosterPreset = Schema.decodeUnknownEffect(RosterPreset)

/** A diagnostic's name as the roster and the tsconfig spell it alike: lowercase, hyphens removed. */
const comparable = (name: string): string => Str.replaceAll("-", "")(Str.toLowerCase(name))

/**
 * Every diagnostic of the installed @effect/tsgo, the one the dev tools resolve, in its oxlint presets' kebab case: every
 * rule its presets name. A preset directory that cannot be found or read, that holds no preset, whose presets this
 * gate cannot read, that names a rule outside the namespace or that names no rule fails the run: an unknown roster is
 * never a pass.
 */
const installedRoster = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const manifestUrl = yield* Effect.try({
		try: () => new URL(import.meta.resolve("@effect/tsgo/package.json")),
		catch: inspectionFailure("@effect/tsgo")
	})
	const manifest = yield* path
		.fromFileUrl(manifestUrl)
		.pipe(Effect.mapError(inspectionFailure(manifestUrl.href)))
	const directory = path.join(path.dirname(manifest), "oxlint-presets")
	const entries = yield* fs
		.readDirectory(directory)
		.pipe(Effect.mapError(inspectionFailure(directory)))
	const presets = Arr.filter(entries, Str.endsWith(".json"))
	if (!Arr.isReadonlyArrayNonEmpty(presets)) {
		return yield* DevtoolFailure.make({
			detail: `${directory} holds no @effect/tsgo oxlint preset`
		})
	}
	const rulesByPreset = yield* Effect.forEach(
		presets,
		(preset) =>
			Effect.gen(function* () {
				const file = path.join(directory, preset)
				const text = yield* fs.readFileString(file).pipe(Effect.mapError(inspectionFailure(file)))
				const decoded = yield* decodeRosterPreset(text).pipe(
					Effect.mapError((cause) =>
						DevtoolFailure.make({
							detail: `${file} is not an oxlint preset this gate reads`,
							cause
						})
					)
				)
				return Record.keys(decoded.rules)
			}),
		{ concurrency: 1 }
	)
	const rules = Arr.dedupe(Arr.flatten(rulesByPreset))
	const foreign = Arr.filter(rules, (rule) => !Str.startsWith(ROSTER_NAMESPACE)(rule))
	if (Arr.isReadonlyArrayNonEmpty(foreign)) {
		return yield* DevtoolFailure.make({
			detail: `${directory} names rules outside ${ROSTER_NAMESPACE}: ${Arr.join(foreign, ", ")}`
		})
	}
	if (!Arr.isReadonlyArrayNonEmpty(rules)) {
		return yield* DevtoolFailure.make({ detail: `${directory} names no @effect/tsgo rule` })
	}
	return Arr.map(rules, (rule) => Str.slice(ROSTER_NAMESPACE.length)(rule))
})

/**
 * The shared base lists exactly the diagnostics the installed @effect/tsgo ships, compared by name with case and
 * hyphens set aside: a diagnostic a new release adds is listed, at error or rejected with its reason, and one it
 * drops goes.
 */
const rosterFindings = Effect.gen(function* () {
	const { root } = yield* Repository
	const { base, listed } = yield* listedDiagnostics
	const roster = yield* installedRoster
	const listedComparable = Arr.map(listed, comparable)
	const rosterComparable = Arr.map(roster, comparable)
	const at = (message: string, suggestion: string): Finding => ({
		file: base,
		line: 1,
		column: 1,
		rule: "diagnostic-roster",
		message,
		suggestion
	})
	return [
		...Arr.filterMap(roster, (diagnostic) =>
			Arr.contains(listedComparable, comparable(diagnostic))
				? Result.failVoid
				: Result.succeed(
						at(
							`${relativeTo(root)(base)} does not list the Effect diagnostic ${diagnostic}, which the installed @effect/tsgo ships.`,
							"List it at error, or reject it in toolchain.config.ts's rejected.diagnostics with its reason, which needs the owner."
						)
					)
		),
		...Arr.filterMap(listed, (diagnostic) =>
			Arr.contains(rosterComparable, comparable(diagnostic))
				? Result.failVoid
				: Result.succeed(
						at(
							`${relativeTo(root)(base)} lists the Effect diagnostic ${diagnostic}, which the installed @effect/tsgo does not ship.`,
							"Remove it from the shared base and every tsconfig that restates the plugin."
						)
					)
		)
	]
})

/** The configs a tsconfig extends: none, the one it names, or each of a list. */
const extendedOf = (config: typeof Tsconfig.Type): ReadonlyArray<string> => {
	const named = config.extends
	if (named === undefined) {
		return []
	}
	return typeof named === "string" ? [named] : named
}

/** The dependency fields of a package.json, each by package name. */
const Dependencies = Schema.optionalKey(Schema.Record(Schema.String, Schema.String))

/** What the gate reads of a package's package.json: every package it depends on, by field. */
const PackageManifest = Schema.fromJsonString(
	Schema.Struct({
		dependencies: Dependencies,
		devDependencies: Dependencies,
		peerDependencies: Dependencies,
		optionalDependencies: Dependencies
	})
)

const decodePackageManifest = Schema.decodeUnknownEffect(PackageManifest)

/** The packages one dependency field names. */
const namedIn = (field: Readonly<Record<string, string>> | undefined): ReadonlyArray<string> =>
	field === undefined ? [] : Record.keys(field)

/**
 * The Effect packages an Effect-free package's manifest names where its code would load them at run time: in its
 * dependencies or optional dependencies, or in its dev dependencies without the peer they serve in its own workspace.
 * A peer is the one place Effect may stand: an Effect-free package that names Effect's types (`import type`) declares
 * the peer its declarations need, and the linters hold every Effect import of its sources to `import type`.
 */
const loadedEffectOf = (manifest: typeof PackageManifest.Type): ReadonlyArray<string> => {
	const peers = namedIn(manifest.peerDependencies)
	return Arr.filter(
		Arr.dedupe([
			...namedIn(manifest.dependencies),
			...namedIn(manifest.optionalDependencies),
			...Arr.filter(namedIn(manifest.devDependencies), (name) => !Arr.contains(peers, name))
		]),
		isEffectPackage
	)
}

/** Where a tsconfig's plugins come from: the config that declares them, nearest first along its extends chain (its own
 * declaration, else its extends from last to first, as TypeScript lets a later one override an earlier), and the
 * plugins' names; none when no config of the chain declares any. */
type PluginBlock = Option.Option<Readonly<{ file: string; names: ReadonlyArray<string> }>>

/** A tsconfig a config extends, found as TypeScript finds it: a path relative to the config, or a package's file looked
 * up in the node_modules above it; a name without `.json` is tried with it, and a package with its tsconfig.json. */
const extendedFile = (from: string, specifier: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const directory = path.dirname(from)
		const candidatesAt = (target: string): ReadonlyArray<string> =>
			Str.endsWith(".json")(target) ? [target] : [`${target}.json`, `${target}/tsconfig.json`]
		const candidates =
			Str.startsWith(".")(specifier) || Str.startsWith("/")(specifier)
				? candidatesAt(path.resolve(directory, specifier))
				: Arr.flatMap(
						Arr.map(directoriesUp(directory), (above) => `${above}/node_modules/${specifier}`),
						candidatesAt
					)
		const found = yield* Effect.filter(candidates, (candidate) =>
			fs.exists(candidate).pipe(Effect.mapError(inspectionFailure(candidate)))
		)
		return Arr.head(found)
	})

/** A directory and each one above it, nearest first. */
const directoriesUp = (directory: string): ReadonlyArray<string> => {
	const segments = Str.split("/")(directory)
	return Arr.map(Arr.take(segments, segments.length - 1), (_, index) =>
		Arr.join(Arr.take(segments, segments.length - index), "/")
	)
}

/** A tsconfig's plugin block, resolved through its extends chain; an extends that names no file, or a chain that comes
 * back to a config it holds, is reported where it is written. */
const pluginBlockOf = (
	config: string,
	held: ReadonlyArray<string>
): Effect.Effect<
	Result.Result<PluginBlock, Readonly<{ file: string; message: string }>>,
	DevtoolFailure,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		if (Arr.contains(held, config)) {
			return Result.fail({
				file: config,
				message: `${config} extends itself, through ${Arr.join(held, ", ")}.`
			})
		}
		const decoded = yield* readTsconfig(config)
		const plugins = decoded.compilerOptions?.plugins
		if (plugins !== undefined) {
			return Result.succeed(
				Option.some({ file: config, names: Arr.map(plugins, (plugin) => plugin.name) })
			)
		}
		const extended = Arr.reverse(extendedOf(decoded))
		const resolved = yield* Effect.forEach(
			extended,
			(specifier) => Effect.map(extendedFile(config, specifier), (file) => ({ specifier, file })),
			{ concurrency: 1 }
		)
		const unresolved = Arr.findFirst(resolved, ({ file }) => Option.isNone(file))
		if (Option.isSome(unresolved)) {
			return Result.fail({
				file: config,
				message: `${config} extends ${unresolved.value.specifier}, which names no tsconfig the gate finds.`
			})
		}
		for (const { file } of resolved) {
			if (Option.isSome(file)) {
				const block = yield* pluginBlockOf(file.value, [...held, config])
				if (Result.isFailure(block) || Option.isSome(block.success)) {
					return block
				}
			}
		}
		return Result.succeed(Option.none())
	})

/** Effect itself, or a package of its `@effect` scope. */
const isEffectPackage = (name: string): boolean =>
	name === "effect" || Str.startsWith("@effect/")(name)

/** A workspace as the gate reads it: its root, its packages' roots, and the package directories, relative to the
 * root, that the toolchain's effectFree lists. */
type Workspace = Readonly<{
	root: string
	packages: ReadonlyArray<string>
	effectFree: ReadonlyArray<string>
}>

/** A finding the workspace gate reports at the top of a file. */
const workspaceFinding = (
	input: Readonly<{ file: string; rule: string; message: string; suggestion: string }>
): Finding => ({ ...input, line: 1, column: 1 })

/** The root tsconfig declares the Effect plugin exactly once: it is the one plugin block every package inherits. */
const rootBlockFindings = (workspace: Workspace) =>
	Effect.gen(function* () {
		const config = `${workspace.root}/tsconfig.json`
		const decoded = yield* readTsconfig(config)
		const declared = severitiesIn(decoded).length
		if (declared === 1) {
			return []
		}
		return [
			workspaceFinding({
				file: config,
				rule: "effect-plugin-block",
				message: `The root tsconfig.json declares the Effect plugin ${String(declared)} times; it declares it exactly once, for every package to inherit.`,
				suggestion:
					"Declare the plugin once in the root tsconfig.json, its per-file overrides as root-relative includes."
			})
		]
	})

/** Every directory the toolchain's effectFree lists is a workspace package. */
const listedFindings = (workspace: Workspace): ReadonlyArray<Finding> =>
	Arr.filterMap(workspace.effectFree, (directory) =>
		Arr.contains(workspace.packages, `${workspace.root}/${directory}`)
			? Result.failVoid
			: Result.succeed(
					workspaceFinding({
						file: `${workspace.root}/package.json`,
						rule: "effect-free-packages",
						message: `toolchain.config.ts's effectFree lists ${directory}, which is no workspace package.`,
						suggestion:
							"List workspace package directories, relative to the root and without a trailing /."
					})
				)
	)

/** A tsconfig an Effect-free package may extend: the dev tools' base with no plugin. A repository's own base that sets no
 * plugin serves as well, as the gate judges what a tsconfig resolves to, never which file it names. */
const EFFECT_FREE_BASE = "@bjornpagen/devtools/tsconfig.effect-free.json"

/**
 * One package's tsconfig and manifest against the one plugin block and the Effect-free list. Every package has a
 * tsconfig.json that declares no plugin of its own. The gate follows its extends chain to the plugin block it resolves
 * to: a listed package's carries no Effect plugin, and any other package's is the root tsconfig.json's, which holds the
 * Effect plugin. A listed package's package.json names Effect only as a peer (with the dev copy that serves it in the
 * repository's workspace), the one form a package that is Effect-free at run time and names Effect's types needs.
 */
const packageFindings = (workspace: Workspace, leaf: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const shown = relativeTo(workspace.root)(leaf)
		const listed = Arr.contains(workspace.effectFree, shown)
		const config = `${leaf}/tsconfig.json`
		const rootConfig = `${workspace.root}/tsconfig.json`
		const present = yield* fs.exists(config).pipe(Effect.mapError(inspectionFailure(config)))
		if (!present) {
			return [
				workspaceFinding({
					file: `${leaf}/package.json`,
					rule: "effect-plugin-block",
					message: `${shown} has no tsconfig.json, so nothing type-checks it.`,
					suggestion: listed
						? `Give it a tsconfig.json that extends one with no Effect plugin, such as ${EFFECT_FREE_BASE}.`
						: "Give it a tsconfig.json that extends the root tsconfig.json."
				})
			]
		}
		const decoded = yield* readTsconfig(config)
		const plugins =
			decoded.compilerOptions?.plugins === undefined
				? []
				: [
						workspaceFinding({
							file: config,
							rule: "effect-plugin-block",
							message: `${shown}/tsconfig.json declares compiler plugins; the root tsconfig.json holds the one Effect plugin block.`,
							suggestion: listed
								? "Drop the plugins: an Effect-free package carries none."
								: "Drop the plugins and move any per-file override into the root tsconfig.json, its include relative to the root."
						})
					]
		const resolved = yield* pluginBlockOf(config, [])
		const shownFile = relativeTo(workspace.root)
		const block = Result.match(resolved, {
			onFailure: (unread) => [
				workspaceFinding({
					file: unread.file,
					rule: "effect-plugin-block",
					message: unread.message,
					suggestion:
						"Extend a tsconfig that exists: a path relative to this one, or a package's file."
				})
			],
			onSuccess: (found) => {
				const carriesEffect = Option.exists(found, ({ names }) =>
					Arr.contains(names, EFFECT_PLUGIN)
				)
				if (listed) {
					return carriesEffect
						? [
								workspaceFinding({
									file: config,
									rule: "effect-free-packages",
									message: `${shown} is Effect-free, but its tsconfig.json carries the Effect plugin, from ${Option.match(found, { onNone: () => "nowhere", onSome: ({ file }) => shownFile(file) })}.`,
									suggestion: `Extend a tsconfig that sets no Effect plugin, such as ${EFFECT_FREE_BASE} or a base of the repository's own, or take it off toolchain.config.ts's effectFree if it uses Effect.`
								})
							]
						: []
				}
				return Option.exists(found, ({ file }) => file === rootConfig)
					? []
					: [
							workspaceFinding({
								file: config,
								rule: "effect-free-packages",
								message: `${shown}/tsconfig.json does not take its plugins from the root tsconfig.json, so it does not carry the Effect plugin block.`,
								suggestion:
									"Extend the root tsconfig.json, or list the package in toolchain.config.ts's effectFree if it uses no Effect."
							})
						]
			}
		})
		if (!listed) {
			return [...plugins, ...block]
		}
		const manifestFile = `${leaf}/package.json`
		const text = yield* fs
			.readFileString(manifestFile)
			.pipe(Effect.mapError(inspectionFailure(manifestFile)))
		const manifest = yield* decodePackageManifest(text).pipe(
			Effect.mapError((cause) =>
				DevtoolFailure.make({
					detail: `${manifestFile} is not a package.json this lint reads`,
					cause
				})
			)
		)
		const loaded = loadedEffectOf(manifest)
		const dependencies = Arr.isReadonlyArrayNonEmpty(loaded)
			? [
					workspaceFinding({
						file: manifestFile,
						rule: "effect-free-packages",
						message: `${shown} is Effect-free, but its package.json names ${Arr.join(loaded, ", ")} where its code would load it at run time.`,
						suggestion:
							"Drop the dependency, or state it as a peer (with the dev copy that serves it) if the package names its types alone, or take the package off toolchain.config.ts's effectFree."
					})
				]
			: []
		return [...plugins, ...block, ...dependencies]
	})

/** Every finding of the one plugin block and the Effect-free list over a workspace. */
const workspaceFindings = (workspace: Workspace) =>
	Effect.gen(function* () {
		const root = yield* rootBlockFindings(workspace)
		const packages = yield* Effect.forEach(
			workspace.packages,
			(leaf) => packageFindings(workspace, leaf),
			{ concurrency: 1 }
		)
		return [...root, ...listedFindings(workspace), ...Arr.flatten(packages)]
	})

/** Every finding of the tsconfig gate over the repository: the base and the tree held to the roster and the
 * repository's rejected diagnostics, and its own packages to the one plugin block and its Effect-free list. */
export const tsconfigFindings = (
	input: Readonly<{ effectFree: ReadonlyArray<string>; rejectedDiagnostics: ReadonlyArray<string> }>
) =>
	Effect.gen(function* () {
		const { root, packages } = yield* Repository
		const standard = yield* standardFindings(input.rejectedDiagnostics)
		const roster = yield* rosterFindings
		const workspace = yield* workspaceFindings({
			root,
			packages: ownPackagesOf(root, packages),
			effectFree: input.effectFree
		})
		return [...standard, ...roster, ...workspace]
	})

/** The workspaces that prove the workspace gate: in each `violating-*` one the root and every package draw a finding,
 * and in each `clean-*` one nothing does. */
const WORKSPACE_FIXTURES = `${import.meta.dirname}/fixtures`

/** A fixture workspace's root package.json: the Effect-free list, as the repository's names it. */
const FixtureManifest = Schema.fromJsonString(
	Schema.Struct({
		toolchain: Schema.Struct({ effectFree: EffectFree })
	})
)

const decodeFixtureManifest = Schema.decodeUnknownEffect(FixtureManifest)

/** How one fixture workspace disagrees with the gate: the directories that should draw a finding and drew none, and
 * those that drew one and should not. */
type WorkspaceMismatch = Readonly<{
	workspace: string
	missing: ReadonlyArray<string>
	unexpected: ReadonlyArray<string>
}>

/** One fixture workspace's roots, read as the gate reads the repository: its packages are the directories under its
 * `packages/` that hold a package.json. */
const fixtureWorkspaceOf = (root: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const manifestFile = `${root}/package.json`
		const text = yield* fs
			.readFileString(manifestFile)
			.pipe(Effect.mapError(inspectionFailure(manifestFile)))
		const manifest = yield* decodeFixtureManifest(text).pipe(
			Effect.mapError((cause) =>
				DevtoolFailure.make({ detail: `${manifestFile} needs a toolchain.effectFree list`, cause })
			)
		)
		const directory = `${root}/packages`
		const holdsPackages = yield* fs
			.exists(directory)
			.pipe(Effect.mapError(inspectionFailure(directory)))
		const names = holdsPackages
			? yield* fs.readDirectory(directory).pipe(Effect.mapError(inspectionFailure(directory)))
			: []
		const packages = yield* Effect.filter(
			Arr.map(Arr.sort(names, Str.Order), (name) => `${directory}/${name}`),
			(leaf) => fs.exists(`${leaf}/package.json`).pipe(Effect.mapError(inspectionFailure(leaf)))
		)
		return { root, packages, effectFree: manifest.toolchain.effectFree }
	})

/** Every fixture workspace against the gate, directory for directory. No fixture workspace of either kind is a
 * mismatch too: the gate is never proven by nothing. */
export const workspaceFixtureMismatches = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const names = yield* fs
		.readDirectory(WORKSPACE_FIXTURES)
		.pipe(Effect.mapError(inspectionFailure(WORKSPACE_FIXTURES)))
	const sorted = Arr.sort(names, Str.Order)
	const violating = Arr.filter(sorted, Str.startsWith("violating-"))
	const clean = Arr.filter(sorted, Str.startsWith("clean-"))
	if (!Arr.isReadonlyArrayNonEmpty(violating) || !Arr.isReadonlyArrayNonEmpty(clean)) {
		return yield* DevtoolFailure.make({
			detail: `${WORKSPACE_FIXTURES} needs a violating-* and a clean-* workspace`
		})
	}
	const mismatches = yield* Effect.forEach(
		[...violating, ...clean],
		(name) =>
			Effect.gen(function* () {
				const workspace = yield* fixtureWorkspaceOf(`${WORKSPACE_FIXTURES}/${name}`)
				const findings = yield* workspaceFindings(workspace)
				const reported = Arr.dedupe(Arr.map(findings, (finding) => path.dirname(finding.file)))
				const expected = Str.startsWith("violating-")(name)
					? [workspace.root, ...workspace.packages]
					: []
				const missing = Arr.difference(expected, reported)
				const unexpected = Arr.difference(reported, expected)
				return Arr.isReadonlyArrayNonEmpty(missing) || Arr.isReadonlyArrayNonEmpty(unexpected)
					? Option.some({ workspace: workspace.root, missing, unexpected })
					: Option.none<WorkspaceMismatch>()
			}),
		{ concurrency: 1 }
	)
	return { workspaces: violating.length + clean.length, mismatches: Arr.getSomes(mismatches) }
})
