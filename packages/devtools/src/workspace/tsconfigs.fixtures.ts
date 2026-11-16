import {
	array,
	boolean,
	constant,
	element,
	type Gen,
	map,
	oneOf,
	option
} from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, FileSystem, Option, Path, Result, Schema } from "effect"
import { Repository } from "#shared/repository.ts"
import { tsconfigFindings } from "#workspace/tsconfigs.ts"

/**
 * The workspaces the effect-plugin-block property draws (tsconfigs.test.ts), how a case writes one into its scratch
 * directory, and what the gate finds there: a root tsconfig.json and the packages under `packages/`, each tsconfig.json
 * one of the shapes the rule reads, so every directory carries the number of findings the rule's contract gives it.
 */

/** The plugins a drawn tsconfig.json may declare: the Effect language service, which the root declares once, or another. */
const PLUGINS = ["@effect/language-service", "a-plugin-of-its-own"] as const

type Plugin = (typeof PLUGINS)[number]

const EFFECT_PLUGIN: Plugin = "@effect/language-service"

/**
 * A package's tsconfig.json, as the rule reads it: none at all; one that extends the root and declares nothing; one that
 * extends a package's tsconfig (the dev tools' Effect-free base, found in the workspace's node_modules) and declares
 * nothing; one that declares plugins of its own (an empty list too, which drops the root's block as surely as any);
 * or one that extends a tsconfig that is not there.
 */
type PackageConfig =
	| Readonly<{ kind: "absent" }>
	| Readonly<{ kind: "inherits" }>
	| Readonly<{ kind: "based" }>
	| Readonly<{ kind: "declares"; plugins: ReadonlyArray<Plugin> }>
	| Readonly<{ kind: "dangling" }>

/** A package of a drawn workspace: its tsconfig.json, and whether the toolchain's effectFree lists it. */
type Package = Readonly<{ config: PackageConfig; listed: boolean }>

/**
 * A drawn workspace: the plugins its root tsconfig.json declares (none: no plugins key at all), and its packages, the
 * i-th at `packages/p<i>`.
 */
export type Workspace = Readonly<{
	root: Option.Option<ReadonlyArray<Plugin>>
	packages: ReadonlyArray<Package>
}>

/** What a directory of a drawn workspace is, as the property names its situations. */
export type Feature =
	| "a directory that holds the block as it should"
	| "a package that declares plugins"
	| "a package that declares an empty plugin list"
	| "a package with no tsconfig"
	| "a package that extends a tsconfig that is not there"
	| "a root that does not declare the plugin once"

/** A directory of a workspace (relative to its root, "" for the root), the effect-plugin-block findings the rule's
 * contract gives it, and what the directory is. */
export type Directory = Readonly<{ directory: string; findings: number; kind: Feature }>

const HELD: Feature = "a directory that holds the block as it should"

const pluginsGen = array(element(PLUGINS), { min: 0, max: 3 })

const configGen: Gen<PackageConfig> = oneOf<PackageConfig>([
	constant({ kind: "inherits" }),
	constant({ kind: "based" }),
	constant({ kind: "absent" }),
	map(pluginsGen, (plugins): PackageConfig => ({ kind: "declares", plugins })),
	constant({ kind: "dangling" })
])

const packageGen: Gen<Package> = (source) => ({
	config: source.draw(configGen),
	listed: source.draw(boolean)
})

/** A workspace of up to four packages, its root declaring any plugins or none. */
export const workspaces: Gen<Workspace> = (source) => ({
	root: source.draw(option(pluginsGen)),
	packages: source.draw(array(packageGen, { min: 0, max: 4 }))
})

/** The directory of the i-th package, relative to the root. */
const packageDirectory = (index: number): string => `packages/p${String(index)}`

/** What the rule's contract gives a package's directory: one finding for each way its tsconfig.json is not the root's
 * block, none for one that holds it. */
const packageDirectoryOf = (config: PackageConfig, directory: string): Directory => {
	switch (config.kind) {
		case "absent":
			return { directory, findings: 1, kind: "a package with no tsconfig" }
		case "inherits":
		case "based":
			return { directory, findings: 0, kind: HELD }
		case "declares":
			return {
				directory,
				findings: 1,
				kind: Arr.isReadonlyArrayNonEmpty(config.plugins)
					? "a package that declares plugins"
					: "a package that declares an empty plugin list"
			}
		case "dangling":
			return { directory, findings: 1, kind: "a package that extends a tsconfig that is not there" }
	}
}

/**
 * Every directory of a workspace with the findings the rule's contract gives it: the root holds the block when it
 * declares the Effect plugin exactly once, and each package as its tsconfig.json is.
 */
export const directoriesOf = (workspace: Workspace): ReadonlyArray<Directory> => {
	const effectPlugins = Option.match(workspace.root, {
		onNone: () => 0,
		onSome: (plugins) => Arr.filter(plugins, (plugin) => plugin === EFFECT_PLUGIN).length
	})
	const root: Directory =
		effectPlugins === 1
			? { directory: "", findings: 0, kind: HELD }
			: { directory: "", findings: 1, kind: "a root that does not declare the plugin once" }
	return [
		root,
		...Arr.map(workspace.packages, (one, index) =>
			packageDirectoryOf(one.config, packageDirectory(index))
		)
	]
}

/** A tsconfig.json as a case writes it: what it extends, and the plugins it declares, when it declares any. */
const WrittenTsconfig = Schema.fromJsonString(
	Schema.Struct({
		extends: Schema.optionalKey(Schema.String),
		compilerOptions: Schema.optionalKey(
			Schema.Struct({ plugins: Schema.Array(Schema.Struct({ name: Schema.String })) })
		)
	})
)

const encodeTsconfig = Schema.encodeEffect(WrittenTsconfig)

/** A tsconfig.json that extends `extended`, when it extends anything, and declares `plugins`, when it declares any. */
const tsconfigOf = (
	extended: Option.Option<string>,
	plugins: Option.Option<ReadonlyArray<Plugin>>
): typeof WrittenTsconfig.Type => ({
	...Option.match(extended, { onNone: () => ({}), onSome: (named) => ({ extends: named }) }),
	...Option.match(plugins, {
		onNone: () => ({}),
		onSome: (declared) => ({
			compilerOptions: { plugins: Arr.map(declared, (name) => ({ name })) }
		})
	})
})

/** A package's tsconfig.json, or none for a package that has none. */
const packageTsconfig = (config: PackageConfig): Option.Option<typeof WrittenTsconfig.Type> => {
	switch (config.kind) {
		case "absent":
			return Option.none()
		case "inherits":
			return Option.some(tsconfigOf(Option.some("../../tsconfig.json"), Option.none()))
		case "based":
			return Option.some(
				tsconfigOf(Option.some("@bjornpagen/devtools/tsconfig.effect-free.json"), Option.none())
			)
		case "declares":
			return Option.some(
				tsconfigOf(Option.some("../../tsconfig.json"), Option.some(config.plugins))
			)
		case "dangling":
			return Option.some(tsconfigOf(Option.some("./tsconfig.missing.json"), Option.none()))
	}
}

/** The dev tools' package root, which a drawn workspace's node_modules links as @bjornpagen/devtools. */
const DEVTOOLS = `${import.meta.dirname}/../..`

/**
 * Writes a workspace under `scratch` and answers its root: the root tsconfig.json, node_modules/@bjornpagen/devtools
 * linked to the dev tools, and each package's package.json and tsconfig.json, as drawn.
 */
export const written = Effect.fn("written")(function* (scratch: string, workspace: Workspace) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const root = path.join(scratch, "workspace")
	yield* fs.makeDirectory(path.join(root, "node_modules", "@bjornpagen"), { recursive: true })
	yield* fs.symlink(
		path.resolve(DEVTOOLS),
		path.join(root, "node_modules", "@bjornpagen", "devtools")
	)
	const rootText = yield* encodeTsconfig(tsconfigOf(Option.none(), workspace.root))
	yield* fs.writeFileString(path.join(root, "tsconfig.json"), rootText)
	yield* Effect.forEach(workspace.packages, (one, index) =>
		Effect.gen(function* () {
			const leaf = path.join(root, packageDirectory(index))
			yield* fs.makeDirectory(leaf, { recursive: true })
			yield* fs.writeFileString(
				path.join(leaf, "package.json"),
				`{"name":"p${String(index)}","private":true}\n`
			)
			yield* Option.match(packageTsconfig(one.config), {
				onNone: () => Effect.void,
				onSome: (config) =>
					Effect.flatMap(encodeTsconfig(config), (text) =>
						fs.writeFileString(path.join(leaf, "tsconfig.json"), text)
					)
			})
		})
	)
	return root
})

/**
 * The gate's effect-plugin-block findings over a written workspace, counted at each of its directories, and last the
 * count of those at no directory of the workspace (none, by the contract).
 */
export const pluginBlockCounts = Effect.fn("pluginBlockCounts")(function* (
	root: string,
	workspace: Workspace
) {
	const path = yield* Path.Path
	const leaves = Arr.map(workspace.packages, (_, index) => path.join(root, packageDirectory(index)))
	const effectFree = Arr.filterMap(workspace.packages, (one, index) =>
		one.listed ? Result.succeed(packageDirectory(index)) : Result.failVoid
	)
	const findings = yield* tsconfigFindings({ effectFree, rejectedDiagnostics: [] }).pipe(
		Effect.provideService(Repository, { root, packages: leaves, apps: [] })
	)
	const reported = Arr.map(
		Arr.filter(findings, (finding) => finding.rule === "effect-plugin-block"),
		(finding) => path.relative(root, path.dirname(finding.file))
	)
	const directories = Arr.map(directoriesOf(workspace), (one) => one.directory)
	return [
		...Arr.map(directories, (directory) => Arr.filter(reported, (at) => at === directory).length),
		Arr.filter(reported, (at) => !Arr.contains(directories, at)).length
	]
})
