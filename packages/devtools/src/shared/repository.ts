import {
	Array as Arr,
	Context,
	Effect,
	FileSystem,
	Layer,
	Option,
	Order,
	Path,
	Record,
	Result,
	Schema,
	String as Str
} from "effect"
import { Yaml } from "effect/encoding"
import { DevtoolFailure } from "#shared/devtool.ts"
import { ownPackagesUnder } from "#shared/git.ts"

/**
 * The repository the dev tools run in, derived from the tree rather than named. The dev tools assume POSIX paths:
 * every path they build joins segments with "/".
 */

/** A Tailwind app: a workspace package holding shadcn's components.json. */
export type TailwindApp = Readonly<{
	/** The app's package root. */
	root: string
	/** The stylesheet components.json names in tailwind.css, which the design system compiles from. */
	stylesheet: string
	/** The directory components.json's aliases.ui resolves to: shadcn's vendored components. */
	vendored: string
	/** The module components.json's aliases.utils resolves to: the app's class helper. */
	classHelper: string
}>

export class Repository extends Context.Service<
	Repository,
	Readonly<{
		/** The workspace root: the nearest directory above the dev tools holding pnpm-workspace.yaml. */
		root: string
		/**
		 * The repository's own workspace packages' roots, in the order pnpm-workspace.yaml lists their globs: every package
		 * it selects but those at or under a submodule (git.ts ownPackagesUnder), another repository's, which no check
		 * judges.
		 */
		packages: ReadonlyArray<string>
		/**
		 * The workspace packages pnpm-workspace.yaml selects at or under a submodule, another repository's (a vendored
		 * toolchain's, edullm's qti-pie and what it vendors), which no check of the repository's own code judges, but which
		 * the workspace gate's check of what the repository runs reads: each one's oxlint configuration (core-lint).
		 */
		vendored: ReadonlyArray<string>
		/** Every Tailwind app: each workspace package holding components.json. */
		apps: ReadonlyArray<TailwindApp>
	}>
>()("@bjornpagen/devtools/shared/repository") {}

/** Files under these directory segments are generated or installed, never maintained source. */
const GENERATED_SEGMENTS: ReadonlyArray<string> = ["node_modules", ".next", ".git", ".turbo"]

/** A path relative to `root`, its `.` segments dropped (a root package's files are `package.json`, the root itself
 * `.`); a file outside it keeps its absolute path. */
export const relativeTo =
	(root: string) =>
	(file: string): string => {
		const normal = Arr.join(
			Arr.filter(Str.split("/")(file), (segment) => segment !== "."),
			"/"
		)
		return normal === root
			? "."
			: Str.startsWith(`${root}/`)(normal)
				? Str.slice(root.length + 1)(normal)
				: normal
	}

/** True when the file lies under a directory that holds generated or installed code. */
export const isGeneratedPath = (file: string): boolean =>
	Arr.some(Str.split("/")(file), (segment) => Arr.contains(GENERATED_SEGMENTS, segment))

/** A selected path covers a file when the file is that path or lies under it. */
export const covers = (input: Readonly<{ selected: string; file: string }>): boolean => {
	if (input.file === input.selected) {
		return true
	}
	return Str.startsWith(`${input.selected}/`)(input.file)
}

/** Vendored code (shadcn's components, under each app's aliases.ui) is reinstalled from upstream, never edited, so the
 * linters leave it alone. */
export const isVendoredPath =
	(apps: ReadonlyArray<TailwindApp>) =>
	(file: string): boolean =>
		Arr.some(apps, (app) => covers({ selected: app.vendored, file }))

const inspectionFailure = (subject: string) => (cause: unknown) =>
	DevtoolFailure.make({ detail: `${subject} could not be read`, cause })

/** The workspace root: the nearest directory at or above `directory` holding pnpm-workspace.yaml. */
const workspaceRootFrom = (
	directory: string
): Effect.Effect<string, DevtoolFailure, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const marker = path.join(directory, "pnpm-workspace.yaml")
		if (yield* fs.exists(marker).pipe(Effect.mapError(inspectionFailure(marker)))) {
			return directory
		}
		const parent = path.dirname(directory)
		if (parent === directory) {
			return yield* DevtoolFailure.make({
				detail:
					"No pnpm-workspace.yaml at or above the working directory: the dev tools run inside a pnpm workspace"
			})
		}
		return yield* workspaceRootFrom(parent)
	})

/** What pnpm-workspace.yaml says about the workspace's packages: the globs that select them. */
const WorkspaceManifest = Schema.Struct({ packages: Schema.Array(Schema.String) })

const decodeWorkspaceManifest = Schema.decodeUnknownEffect(WorkspaceManifest)

/** The package globs of pnpm-workspace.yaml. */
const workspaceGlobsOf = (
	manifest: string,
	text: string
): Effect.Effect<ReadonlyArray<string>, DevtoolFailure> =>
	Effect.try({
		try: () => Yaml.parse(text),
		catch: (cause) => DevtoolFailure.make({ detail: `${manifest} is not YAML`, cause })
	}).pipe(
		Effect.flatMap(decodeWorkspaceManifest),
		Effect.mapBoth({
			onSuccess: (decoded) => decoded.packages,
			onFailure: (cause) =>
				DevtoolFailure.make({
					detail: `${manifest} must list the workspace's package globs`,
					cause
				})
		})
	)

/** The package roots one workspace glob selects: `dir/*` the directories under dir holding a package.json, any other
 * glob the directory it names. pnpm's other glob forms appear in no workspace here, so they are refused. */
const packagesOf = (
	root: string,
	glob: string
): Effect.Effect<ReadonlyArray<string>, DevtoolFailure, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		if (Str.includes("**")(glob) || Str.startsWith("!")(glob)) {
			return yield* DevtoolFailure.make({
				detail: `pnpm-workspace.yaml lists ${glob}; the dev tools read only dir/* and plain directory globs`
			})
		}
		const candidates = Str.endsWith("/*")(glob)
			? yield* fs.readDirectory(`${root}/${Str.slice(0, -2)(glob)}`).pipe(
					Effect.mapBoth({
						onFailure: inspectionFailure(`${root}/${glob}`),
						onSuccess: (names) =>
							Arr.map(
								Arr.sort(names, Str.Order),
								(name) => `${root}/${Str.slice(0, -2)(glob)}/${name}`
							)
					})
				)
			: [`${root}/${glob}`]
		return yield* Effect.filter(candidates, (candidate) =>
			fs
				.exists(`${candidate}/package.json`)
				.pipe(Effect.mapError(inspectionFailure(`${candidate}/package.json`)))
		)
	})

const ComponentsConfig = Schema.fromJsonString(
	Schema.Struct({
		tailwind: Schema.Struct({ css: Schema.NonEmptyString }),
		aliases: Schema.Struct({ ui: Schema.NonEmptyString, utils: Schema.NonEmptyString })
	})
)

const decodeComponentsConfig = Schema.decodeUnknownEffect(ComponentsConfig)

const PackageImports = Schema.fromJsonString(
	Schema.Struct({ imports: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)) })
)

const decodePackageImports = Schema.decodeUnknownEffect(PackageImports)

const LONGEST_PREFIX_FIRST = Order.mapInput(
	Order.flip(Order.Number),
	(pattern: Readonly<{ prefix: string }>) => pattern.prefix.length
)

/** A subpath import's target, by Node's rule: the exact key, else the `*` pattern with the longest prefix that
 * matches, its `*` replaced in the target by what it matched. Only string targets resolve. */
const importTargetOf = (
	imports: Readonly<Record<string, unknown>>,
	specifier: string
): Option.Option<string> => {
	const exact = Record.get(imports, specifier)
	if (Option.isSome(exact)) {
		return typeof exact.value === "string" ? Option.some(exact.value) : Option.none()
	}
	const patterns = Arr.filterMap(Record.toEntries(imports), ([key, target]) => {
		const [prefix, ...rest] = Str.split("*")(key)
		const [suffix, ...more] = rest
		if (
			suffix === undefined ||
			Arr.isReadonlyArrayNonEmpty(more) ||
			typeof target !== "string" ||
			!Str.startsWith(prefix)(specifier) ||
			!Str.endsWith(suffix)(specifier) ||
			specifier.length < prefix.length + suffix.length
		) {
			return Result.failVoid
		}
		const matched = Str.slice(prefix.length, specifier.length - suffix.length)(specifier)
		return Result.succeed({ prefix, target: Str.replaceAll("*", matched)(target) })
	})
	return Option.map(Arr.head(Arr.sort(patterns, LONGEST_PREFIX_FIRST)), (pattern) => pattern.target)
}

/** The file or directory an alias of components.json names, through the app's package.json imports. */
const aliasPath = (
	input: Readonly<{ app: string; imports: Readonly<Record<string, unknown>>; alias: string }>
): Effect.Effect<string, DevtoolFailure, Path.Path> =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		return yield* Option.match(importTargetOf(input.imports, input.alias), {
			onNone: () =>
				Effect.fail(
					DevtoolFailure.make({
						detail: `components.json's alias ${input.alias} resolves through no subpath import of ${input.app}/package.json`
					})
				),
			onSome: (target) => Effect.succeed(path.resolve(input.app, target))
		})
	})

/** The Tailwind app a package is, when it holds components.json. */
const tailwindAppOf = (
	root: string
): Effect.Effect<Option.Option<TailwindApp>, DevtoolFailure, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const componentsFile = `${root}/components.json`
		if (
			!(yield* fs.exists(componentsFile).pipe(Effect.mapError(inspectionFailure(componentsFile))))
		) {
			return Option.none()
		}
		const components = yield* fs.readFileString(componentsFile).pipe(
			Effect.mapError(inspectionFailure(componentsFile)),
			Effect.flatMap((text) =>
				decodeComponentsConfig(text).pipe(
					Effect.mapError((cause) =>
						DevtoolFailure.make({
							detail: `${componentsFile} must name tailwind.css, aliases.ui and aliases.utils`,
							cause
						})
					)
				)
			)
		)
		const manifestFile = `${root}/package.json`
		const manifest = yield* fs.readFileString(manifestFile).pipe(
			Effect.mapError(inspectionFailure(manifestFile)),
			Effect.flatMap((text) =>
				decodePackageImports(text).pipe(
					Effect.mapError((cause) =>
						DevtoolFailure.make({ detail: `${manifestFile} has malformed imports`, cause })
					)
				)
			)
		)
		const imports = manifest.imports ?? {}
		return Option.some({
			root,
			stylesheet: path.resolve(root, components.tailwind.css),
			vendored: yield* aliasPath({ app: root, imports, alias: components.aliases.ui }),
			classHelper: yield* aliasPath({ app: root, imports, alias: components.aliases.utils })
		})
	})

/** The repository, derived: its root from the working directory, never from where the dev tools sit, since a
 * repository vendors them (its vendor/toolchain is a workspace of its own); its own packages from pnpm-workspace.yaml,
 * a submodule's left out; its Tailwind apps from the packages holding components.json. */
const derive = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const workingDirectory = yield* Effect.sync(() => process.cwd())
	const root = yield* workspaceRootFrom(workingDirectory)
	const manifest = `${root}/pnpm-workspace.yaml`
	const text = yield* fs.readFileString(manifest).pipe(Effect.mapError(inspectionFailure(manifest)))
	const globs = yield* workspaceGlobsOf(manifest, text)
	const packagesPerGlob = yield* Effect.forEach(globs, (glob) => packagesOf(root, glob))
	const selected = Arr.flatten(packagesPerGlob)
	const packages = yield* ownPackagesUnder(root, selected)
	const vendored = Arr.filter(selected, (directory) => !Arr.contains(packages, directory))
	const packageApps = yield* Effect.forEach(packages, tailwindAppOf)
	return { root, packages, vendored, apps: Arr.getSomes(packageApps) }
})

/**
 * The repository service, derived through Effect's FileSystem and Path, which are unstable, and so is it.
 *
 * @stability unstable
 */
export const RepositoryLive = Layer.effect(Repository, derive)
