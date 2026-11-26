import { isBuiltin } from "node:module"
import { regex } from "arkregex"
import {
	Array as Arr,
	Brand,
	Context,
	Effect,
	FileSystem,
	Inspectable,
	Layer,
	Option,
	Order,
	Predicate,
	Record,
	Result,
	Schema,
	String as Str
} from "effect"
import { Digest } from "effect/crypto"
import { Yaml } from "effect/encoding"
import * as ts from "typescript/ast"
import type { ClosureHash } from "#runner/closure-hash.ts"
import { type SyntaxUnread, syntaxOf } from "#syntax.ts"

/**
 * A module's import closure as one content hash: the module's own bytes, and those of every module it loads, as Node
 * loads them for these repositories, so two closures hash alike exactly when they hold the same files with the same
 * bytes, wired alike (each module's links in order, to the same files), the same external packages at the same
 * lockfile entries giving the same files for the same subpaths, the same built-ins, under the same runtime. Conditions
 * count only through what they resolve: two condition sets that resolve every specifier alike give one closure (a
 * template's identity, resources/template.ts, is one template for a [react-server] runner and a plain one where
 * nothing they load differs: metis, 2026-11-25, rebuilt its template at every switch), and two that resolve one
 * specifier differently give two. A cached verdict keyed by it is a known answer for as long as nothing the module can
 * load has changed.
 *
 * What a module loads is read from its syntax alone (the library's one door to TypeScript's syntax, syntax.ts, one
 * parse per file per process): every
 * static import and re-export, and every dynamic import of a literal, except `import type` and `export type`, which
 * Node's type stripping erases (`import { type A }` keeps its module, as Node does). A specifier resolves as Node
 * resolves it: relative paths exactly (no extension or index probing), a package's `imports` map for `#` specifiers, a
 * package's `exports` map with Node's own conditions and the runner config's, workspace packages by name, and external
 * packages as the lockfile declares them for the importing package. An external package is hashed by its lockfile
 * entry and those of every package it depends on, and by the file its installed manifest's exports map (or main) gives
 * for the subpath imported under the active conditions, never by its files' bytes. A module that names a file that is not there, a
 * package its package does not declare, or a package the lockfile lacks fails the closure: nothing about it is guessed.
 *
 * Import cycles are one unit: every module of a strongly connected component reaches every other, so they share one
 * closure, hashed once from its members' bytes and the closures they reach.
 */

/** A file of the repository by its path from the repository root: "/"-separated, with no "." or ".." segment. */
export type RepoPath = string & Brand.Brand<"RepoPath">

const RepoPath = Brand.nominal<RepoPath>()

/** The hex SHA-256 of one file's bytes. */
export type ContentHash = string & Brand.Brand<"ContentHash">

const ContentHash = Brand.nominal<ContentHash>()

/** A closure hash as closure.ts makes it, from the SHA-256 it computed: its one trusted mint. */
const closureHash = Brand.nominal<ClosureHash>()

/** A package as the lockfile names it, `name@version` with its peers' versions in parentheses after. */
export type PackageKey = string & Brand.Brand<"PackageKey">

const PackageKey = Brand.nominal<PackageKey>()

/** A module the closure was asked for is no file of the tree. */
class ModuleMissing extends Schema.TaggedError<ModuleMissing, { readonly brand: unique symbol }>()(
	"ModuleMissing",
	{ module: Schema.String }
) {}

/** A module names a specifier Node would refuse to load: `why` says what is missing. */
class ImportUnresolved extends Schema.TaggedError<
	ImportUnresolved,
	{ readonly brand: unique symbol }
>()("ImportUnresolved", { module: Schema.String, specifier: Schema.String, why: Schema.String }) {}

/** A module imports an external package its own package does not declare, so the lockfile states no version for it. */
class PackageUndeclared extends Schema.TaggedError<
	PackageUndeclared,
	{ readonly brand: unique symbol }
>()("PackageUndeclared", { module: Schema.String, dependency: Schema.String }) {}

/** The lockfile names a package it holds no entry for. */
class PackageUnlocked extends Schema.TaggedError<
	PackageUnlocked,
	{ readonly brand: unique symbol }
>()("PackageUnlocked", { key: Schema.String }) {}

/** A package.json or the lockfile is not what Node or pnpm would read: `detail` says how. */
class ManifestMalformed extends Schema.TaggedError<
	ManifestMalformed,
	{ readonly brand: unique symbol }
>()("ManifestMalformed", { path: Schema.String, detail: Schema.String }) {}

/** A file of the tree could not be read for a reason other than its absence. */
class TreeUnreadable extends Schema.TaggedError<
	TreeUnreadable,
	{ readonly brand: unique symbol }
>()("TreeUnreadable", { path: Schema.String, cause: Schema.Defect() }) {}

/** Why a closure could not be hashed. */
export type ClosureFailure =
	| ModuleMissing
	| ImportUnresolved
	| PackageUndeclared
	| PackageUnlocked
	| ManifestMalformed
	| TreeUnreadable
	| SyntaxUnread

/**
 * The repository's files at one moment, by path: `read` answers the file's bytes, or none when no file is there (a
 * directory included, which Node will not load either).
 */
export type Files = Readonly<{
	read: (path: RepoPath) => Effect.Effect<Option.Option<Uint8Array>, TreeUnreadable>
}>

/**
 * The path a repository-relative text names, normalized: none when it is absolute, empty, or climbs above the
 * repository root.
 */
export const repoPathOf = (text: string): Option.Option<RepoPath> =>
	Str.startsWith("/")(text)
		? Option.none()
		: Option.map(Option.filter(segmentsOf("", text), Arr.isReadonlyArrayNonEmpty), (segments) =>
				RepoPath(Arr.join(segments, "/"))
			)

/** The segments of `relative` read from the directory `directory` ("" for the root), or none above the root. */
const segmentsOf = (directory: string, relative: string): Option.Option<ReadonlyArray<string>> =>
	Arr.reduce(
		[...(directory === "" ? [] : Str.split("/")(directory)), ...Str.split("/")(relative)],
		Option.some<ReadonlyArray<string>>([]),
		(kept, segment) =>
			Option.flatMap(kept, (prefix): Option.Option<ReadonlyArray<string>> => {
				if (segment === "" || segment === ".") {
					return Option.some(prefix)
				}
				if (segment === "..") {
					return Arr.isReadonlyArrayNonEmpty(prefix)
						? Option.some(Arr.initNonEmpty(prefix))
						: Option.none()
				}
				return Option.some(Arr.append(prefix, segment))
			})
	)

/** The file `relative` names from `directory`, or none when it is absolute or leaves the repository. */
const fileUnder = (directory: string, relative: string): Option.Option<RepoPath> =>
	Str.startsWith("/")(relative)
		? Option.none()
		: Option.map(
				Option.filter(segmentsOf(directory, relative), Arr.isReadonlyArrayNonEmpty),
				(segments) => RepoPath(Arr.join(segments, "/"))
			)

/** The directory `relative` names from `directory`, or none when it is absolute or leaves the repository. */
const directoryUnder = (directory: string, relative: string): Option.Option<string> =>
	Str.startsWith("/")(relative)
		? Option.none()
		: Option.map(segmentsOf(directory, relative), (segments) => Arr.join(segments, "/"))

/** The directory holding a file. */
const directoryOf = (path: RepoPath): string =>
	Arr.join(Arr.initNonEmpty(Str.split("/")(path)), "/")

/** The directory above a directory other than the root. */
const parentOf = (directory: string): string =>
	Arr.join(Arr.initNonEmpty(Str.split("/")(directory)), "/")

/** The working tree under `root` (an absolute directory) as Files. */
export const workingTree = (root: string): Effect.Effect<Files, never, FileSystem.FileSystem> =>
	Effect.map(FileSystem.FileSystem, (fs): Files => ({
		read: (path) =>
			fs.readFile(`${root}/${path}`).pipe(
				Effect.asSome,
				Effect.catchReasons(
					"PlatformError",
					{
						NotFound: () => Effect.succeedNone,
						BadResource: () => Effect.succeedNone
					},
					(_, cause) => Effect.fail(TreeUnreadable.make({ path, cause }))
				)
			)
	}))

/**
 * How a module's text names the modules it loads at run time: its static imports and re-exports and its dynamic
 * imports of a literal, never a type-only import or re-export.
 */
export class ModuleSyntax extends Context.Service<
	ModuleSyntax,
	Readonly<{
		runtimeSpecifiers: (
			module: RepoPath,
			content: ContentHash,
			text: string
		) => Effect.Effect<ReadonlyArray<string>, SyntaxUnread>
	}>
>()("@bjornpagen/testing/runner/closure/ModuleSyntax") {}

/** The specifier a module-name literal gives at run time, or none when only the type system reads it. */
const runtimeSpecifierOf = (node: ts.Node): Option.Option<string> => {
	if (!ts.isStringLiteralLikeNode(node)) {
		return Option.none()
	}
	const parent = node.parent
	if (ts.isImportDeclaration(parent)) {
		return parent.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
			? Option.none()
			: Option.some(node.text)
	}
	if (ts.isExportDeclaration(parent)) {
		return parent.isTypeOnly ? Option.none() : Option.some(node.text)
	}
	if (ts.isCallExpression(parent)) {
		return Option.some(node.text)
	}
	if (ts.isExternalModuleReference(parent) && ts.isImportEqualsDeclaration(parent.parent)) {
		return parent.parent.isTypeOnly ? Option.none() : Option.some(node.text)
	}
	return Option.none()
}

/**
 * What each module's text loads, read through the library's syntax door (syntax.ts) from the text the closure hashed,
 * so its bytes and its imports are read from the same text, and each read kept by the module's path and content for
 * the process's life, so a text is parsed once however many closures read it.
 */
const specifiersRead = (): Context.Service.Shape<typeof ModuleSyntax> => {
	const parsed = new Map<RepoPath, Map<ContentHash, ReadonlyArray<string>>>()
	return ModuleSyntax.of({
		runtimeSpecifiers: (module, content, text) =>
			Effect.suspend(() => {
				const texts = parsed.get(module) ?? new Map<ContentHash, ReadonlyArray<string>>()
				parsed.set(module, texts)
				const held = texts.get(content)
				if (held !== undefined) {
					return Effect.succeed(held)
				}
				return Effect.map(
					syntaxOf(`/${module}`, text, (tree) =>
						Arr.getSomes(Arr.map(tree.imports, runtimeSpecifierOf))
					),
					(specifiers) => {
						texts.set(content, specifiers)
						return specifiers
					}
				)
			})
	})
}

declare global {
	var bjornpagenTestingSyntax: Context.Service.Shape<typeof ModuleSyntax> | undefined
}

/**
 * ModuleSyntax for this process (`specifiersRead`), made at the first closure the process hashes, so every pool of a
 * run, each kill trial's included, parses a module's text once (runner/module-closure.ts), where each pool's own
 * parser parsed its whole closure again, the parent's one thread blocked in each parse.
 */
export const moduleSyntax: Layer.Layer<ModuleSyntax> = Layer.sync(ModuleSyntax, () => {
	globalThis.bjornpagenTestingSyntax ??= specifiersRead()
	return globalThis.bjornpagenTestingSyntax
})

/** What an `imports` or `exports` key maps to, as Node reads it. */
type Target =
	| Readonly<{ kind: "path"; path: string }>
	| Readonly<{ kind: "excluded" }>
	| Readonly<{
			kind: "conditions"
			arms: ReadonlyArray<readonly [condition: string, target: Target]>
	  }>
	| Readonly<{ kind: "fallbacks"; targets: ReadonlyArray<Target> }>

/** One key of an `imports` or `exports` map and its target, in the map's order. */
type Entry = readonly [key: string, target: Target]

/** A target as package.json writes it, or why Node would refuse it. */
const targetOf = (json: unknown): Result.Result<Target, string> => {
	if (Predicate.isString(json)) {
		return Result.succeed({ kind: "path", path: json })
	}
	if (Predicate.isNull(json)) {
		return Result.succeed({ kind: "excluded" })
	}
	if (Arr.isArray(json)) {
		return Result.map(Result.all(Arr.map(json, targetOf)), (targets) => ({
			kind: "fallbacks",
			targets
		}))
	}
	if (Predicate.isObject(json)) {
		return Result.map(
			Result.all(
				Arr.map(Record.toEntries(json), ([condition, value]) =>
					Result.map(targetOf(value), (target) => [condition, target] as const)
				)
			),
			(arms) => ({ kind: "conditions", arms })
		)
	}
	return Result.fail(`a target must be a string, null, an array or an object of conditions`)
}

/** A package's `exports`: one target for "." when it states no subpaths, else its subpath keys in order. */
const exportsOf = (json: unknown): Result.Result<ReadonlyArray<Entry>, string> => {
	if (!Predicate.isObject(json) || Arr.isArray(json)) {
		return Result.map(targetOf(json), (target) => [[".", target] as const])
	}
	const keys = Record.keys(json)
	const subpaths = Arr.filter(keys, Str.startsWith("."))
	if (subpaths.length === 0) {
		return Result.map(targetOf(json), (target) => [[".", target] as const])
	}
	if (subpaths.length !== keys.length) {
		return Result.fail(`"exports" mixes subpath keys with condition keys`)
	}
	return entriesOf(json)
}

/** A package's `imports`: every key a `#` specifier. */
const importsOf = (json: unknown): Result.Result<ReadonlyArray<Entry>, string> =>
	Predicate.isObject(json) && !Arr.isArray(json)
		? Arr.every(Record.keys(json), Str.startsWith("#"))
			? entriesOf(json)
			: Result.fail(`every "imports" key starts with "#"`)
		: Result.fail(`"imports" is an object`)

/** An object's keys and their targets, in order. */
const entriesOf = (json: object): Result.Result<ReadonlyArray<Entry>, string> =>
	Result.all(
		Arr.map(Record.toEntries(json), ([key, value]) =>
			Result.map(targetOf(value), (target) => [key, target] as const)
		)
	)

/** What a package.json says that resolution reads. */
const ManifestJson = Schema.fromJsonString(
	Schema.Struct({
		name: Schema.optionalKey(Schema.String),
		main: Schema.optionalKey(Schema.String),
		imports: Schema.optionalKey(Schema.Unknown),
		exports: Schema.optionalKey(Schema.Unknown)
	})
)

const decodeManifestJson = Schema.decodeUnknownEffect(ManifestJson)

/** A package.json, read: its name, legacy main, imports map, and exports map when it states one. */
type Manifest = Readonly<{
	name: Option.Option<string>
	main: Option.Option<string>
	imports: ReadonlyArray<Entry>
	exports: Option.Option<ReadonlyArray<Entry>>
}>

/** The package.json at `path`, read and checked. */
const manifestOf = (
	path: RepoPath,
	bytes: Uint8Array
): Effect.Effect<Manifest, ManifestMalformed> =>
	Effect.flatMap(
		Effect.mapError(decodeManifestJson(new TextDecoder().decode(bytes)), (issue) =>
			ManifestMalformed.make({ path, detail: issue.message })
		),
		(json) =>
			Effect.fromResult(
				Result.mapBoth(
					Result.all({
						imports: json.imports === undefined ? Result.succeed([]) : importsOf(json.imports),
						exports:
							json.exports === undefined
								? Result.succeed(Option.none())
								: Result.map(exportsOf(json.exports), Option.some)
					}),
					{
						onFailure: (detail) => ManifestMalformed.make({ path, detail }),
						onSuccess: ({ imports, exports }): Manifest => ({
							name: Option.fromUndefinedOr(json.name),
							main: Option.fromUndefinedOr(json.main),
							imports,
							exports
						})
					}
				)
			)
	)

/** How a key matched an `imports` or `exports` map: its target, and what a pattern's `*` stood for. */
type Match = Readonly<{ target: Target; star: Option.Option<string> }>

/** A pattern key that matched, with what its `*` stood for and the lengths Node ranks matches by. */
type PatternMatch = Match & Readonly<{ prefix: number; key: number }>

/** Node's PATTERN_KEY_COMPARE: the longer prefix before `*` first, then the longer key. */
const BEST_PATTERN_FIRST = Order.combine(
	Order.mapInput(Order.flip(Order.Number), (match: PatternMatch) => match.prefix),
	Order.mapInput(Order.flip(Order.Number), (match: PatternMatch) => match.key)
)

/**
 * The entry `wanted` matches, by Node's PACKAGE_IMPORTS_EXPORTS_RESOLVE: the exact key when one has no `*`, else the
 * best pattern key of one `*` whose prefix and suffix surround it.
 */
const matchOf = (entries: ReadonlyArray<Entry>, wanted: string): Option.Option<Match> =>
	Option.orElse(
		Option.map(
			Arr.findFirst(entries, ([key]) => key === wanted && !Str.includes("*")(key)),
			([, target]): Match => ({ target, star: Option.none() })
		),
		() =>
			Arr.head(
				Arr.sort(
					Arr.filterMap(entries, ([key, target]) => {
						const parts = Str.split("*")(key)
						const [prefix, suffix, ...more] = parts
						if (
							suffix === undefined ||
							Arr.isReadonlyArrayNonEmpty(more) ||
							!Str.startsWith(prefix)(wanted) ||
							wanted === prefix ||
							(suffix !== "" && (!Str.endsWith(suffix)(wanted) || wanted.length < key.length))
						) {
							return Result.failVoid
						}
						return Result.succeed({
							target,
							star: Option.some(Str.slice(prefix.length, wanted.length - suffix.length)(wanted)),
							prefix: prefix.length,
							key: key.length
						})
					}),
					BEST_PATTERN_FIRST
				)
			)
	)

/** What a target gives under the active conditions: a path, an exclusion (null), or nothing that matched. */
type Resolution =
	| Readonly<{ kind: "path"; path: string }>
	| Readonly<{ kind: "excluded" }>
	| Readonly<{ kind: "unmatched" }>

/**
 * A target under the active conditions, its `*` replaced: a conditions object takes its first arm whose condition is
 * active and that matches, in the object's order; a fallback array its first target that matches.
 */
const resolvedTarget = (
	target: Target,
	star: Option.Option<string>,
	active: ReadonlySet<string>
): Resolution => {
	switch (target.kind) {
		case "path":
			return {
				kind: "path",
				path: Option.match(star, {
					onNone: () => target.path,
					onSome: (stood) => Str.replaceAll("*", stood)(target.path)
				})
			}
		case "excluded":
			return target
		case "conditions":
			return firstMatching(
				Arr.filterMap(target.arms, ([condition, arm]) =>
					active.has(condition) ? Result.succeed(arm) : Result.failVoid
				),
				star,
				active
			)
		case "fallbacks":
			return firstMatching(target.targets, star, active)
	}
}

/** The first of `targets` that matches under the active conditions, or unmatched. */
const firstMatching = (
	targets: ReadonlyArray<Target>,
	star: Option.Option<string>,
	active: ReadonlySet<string>
): Resolution =>
	Arr.reduce(targets, { kind: "unmatched" }, (found: Resolution, target): Resolution =>
		found.kind === "unmatched" ? resolvedTarget(target, star, active) : found
	)

/** The conditions Node itself sets on an ESM import: the runner config's are added to these. */
const NODE_CONDITIONS = ["node", "import", "module-sync", "default"] as const

/** A specifier with a URL scheme, `node:` and `file:` among them. */
const SCHEME = regex("^[a-zA-Z][a-zA-Z0-9+.-]*:")

/** The name and subpath of a bare specifier: `@scope/name/sub` is `@scope/name` and `./sub`. */
const packageOf = (
	specifier: string
): Option.Option<Readonly<{ dependency: string; subpath: string }>> => {
	const segments = Str.split("/")(specifier)
	const length = Str.startsWith("@")(specifier) ? 2 : 1
	const name = Arr.take(segments, length)
	const rest = Arr.drop(segments, length)
	if (name.length < length || Arr.some(name, (segment) => segment === "")) {
		return Option.none()
	}
	return Option.some({
		dependency: Arr.join(name, "/"),
		subpath: Arr.isReadonlyArrayNonEmpty(rest) ? `./${Arr.join(rest, "/")}` : "."
	})
}

/** The key of a dependency the lockfile records at `version`, an alias's version naming its own package. */
const lockKeyOf = (dependency: string, version: string): PackageKey =>
	PackageKey(
		Str.includes("@")(Arr.headNonEmpty(Str.split("(")(version)))
			? version
			: `${dependency}@${version}`
	)

/** The `packages` key of a snapshot key: its name and version, without its peers. */
const baseKeyOf = (key: PackageKey): string => Arr.headNonEmpty(Str.split("(")(key))

const LockDependencies = Schema.Record(Schema.String, Schema.Struct({ version: Schema.String }))

const SnapshotDependencies = Schema.Record(Schema.String, Schema.String)

/** What one document of pnpm-lock.yaml says that a closure reads. */
const LockDocument = Schema.Struct({
	importers: Schema.optionalKey(
		Schema.Record(
			Schema.String,
			Schema.Struct({
				dependencies: Schema.optionalKey(LockDependencies),
				devDependencies: Schema.optionalKey(LockDependencies),
				optionalDependencies: Schema.optionalKey(LockDependencies)
			})
		)
	),
	packages: Schema.optionalKey(
		Schema.Record(
			Schema.String,
			Schema.Struct({ resolution: Schema.Record(Schema.String, Schema.String) })
		)
	),
	snapshots: Schema.optionalKey(
		Schema.Record(
			Schema.String,
			Schema.Struct({
				dependencies: Schema.optionalKey(SnapshotDependencies),
				optionalDependencies: Schema.optionalKey(SnapshotDependencies)
			})
		)
	)
})

const decodeLockDocument = Schema.decodeUnknownEffect(LockDocument)

/** A workspace package as the lockfile records it: its directory and the version of each dependency it declares. */
type Importer = Readonly<{ directory: string; dependencies: ReadonlyMap<string, string> }>

/** The lockfile, read: its importers, deepest directory first, each snapshot's dependencies and each resolution. */
type Lock = Readonly<{
	importers: ReadonlyArray<Importer>
	snapshots: ReadonlyMap<string, ReadonlyArray<PackageKey>>
	resolutions: ReadonlyMap<string, string>
}>

const LOCKFILE = RepoPath("pnpm-lock.yaml")

/** The lockfile's documents (pnpm writes its own install's lock as a first document), merged. */
const lockOf = (text: string): Effect.Effect<Lock, ManifestMalformed> =>
	Effect.map(
		Effect.forEach(
			Arr.filter(Str.split(regex("^---$", "m"))(text), (document) =>
				Str.isNonEmpty(Str.trim(document))
			),
			(document) =>
				Effect.try({
					try: () => Yaml.parse(document),
					catch: (cause) =>
						ManifestMalformed.make({
							path: LOCKFILE,
							detail: `it is not YAML: ${Inspectable.toStringUnknown(cause)}`
						})
				}).pipe(
					Effect.flatMap(decodeLockDocument),
					Effect.mapError((issue) =>
						ManifestMalformed.make({ path: LOCKFILE, detail: issue.message })
					)
				)
		),
		(documents): Lock => {
			const importers = new Map<string, Map<string, string>>()
			const snapshots = new Map<string, ReadonlyArray<PackageKey>>()
			const resolutions = new Map<string, string>()
			for (const document of documents) {
				for (const [directory, importer] of Record.toEntries(document.importers ?? {})) {
					const at = directory === "." ? "" : directory
					const declared = importers.get(at) ?? new Map<string, string>()
					for (const group of [
						importer.dependencies,
						importer.devDependencies,
						importer.optionalDependencies
					]) {
						for (const [dependency, { version }] of Record.toEntries(group ?? {})) {
							declared.set(dependency, version)
						}
					}
					importers.set(at, declared)
				}
				for (const [key, entry] of Record.toEntries(document.packages ?? {})) {
					resolutions.set(
						key,
						Arr.join(
							Arr.map(
								Arr.sort(
									Record.toEntries(entry.resolution),
									Order.mapInput(Str.Order, (field: readonly [string, string]) => field[0])
								),
								([field, value]) => `${field}=${value}`
							),
							","
						)
					)
				}
				for (const [key, entry] of Record.toEntries(document.snapshots ?? {})) {
					snapshots.set(
						key,
						Arr.map(
							[
								...Record.toEntries(entry.dependencies ?? {}),
								...Record.toEntries(entry.optionalDependencies ?? {})
							],
							([dependency, version]) => lockKeyOf(dependency, version)
						)
					)
				}
			}
			return {
				importers: Arr.sort(
					Arr.map(Arr.fromIterable(importers), ([directory, dependencies]) => ({
						directory,
						dependencies
					})),
					Order.mapInput(
						Order.flip(Order.Number),
						(importer: Importer) => importer.directory.length
					)
				),
				snapshots,
				resolutions
			}
		}
	)

/**
 * Every package a package's lockfile entry reaches through its snapshots' dependencies, itself among them: what its
 * files load is decided by these entries alone. A key the lockfile holds no snapshot for fails, naming the key.
 */
const lockClosureOf = (
	lock: Lock,
	key: PackageKey
): Result.Result<ReadonlyArray<PackageKey>, PackageKey> => {
	const reached = new Set<PackageKey>()
	const pending: Array<PackageKey> = [key]
	for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
		if (reached.has(next)) {
			continue
		}
		const dependencies = lock.snapshots.get(next)
		if (dependencies === undefined) {
			return Result.fail(next)
		}
		reached.add(next)
		for (const dependency of dependencies) {
			pending.push(dependency)
		}
	}
	return Result.succeed(Arr.fromIterable(reached))
}

/** One module of the walk: its content, and what each of its runtime specifiers resolved to. */
type Walked = Readonly<{
	path: RepoPath
	content: ContentHash
	/** The specifiers it loads at run time (`specifiersOf`), each once, in its text's order. */
	specifiers: ReadonlyArray<string>
	links: ReadonlyArray<Link>
}>

/** What a specifier resolved to: another module of the walk (by its place in the walk), or a leaf. */
type Link = Readonly<{ kind: "module"; index: number }> | Readonly<{ kind: "leaf"; leaf: Leaf }>

/** A dependency a closure holds by name, not by bytes: an external package, a built-in, or a hooked specifier. */
type Leaf =
	| Readonly<{
			kind: "package"
			key: PackageKey
			identity: string
			subpath: string
			target: string
	  }>
	| Readonly<{ kind: "builtin"; specifier: string }>
	| Readonly<{ kind: "hooked"; specifier: string }>

/** What a specifier resolves to before the walk places it. */
type Resolved = Readonly<{ kind: "file"; path: RepoPath }> | Readonly<{ kind: "leaf"; leaf: Leaf }>

/** A module's closure: its hash, and what it holds, each list sorted. */
export type Closure = Readonly<{
	hash: ClosureHash
	files: ReadonlyArray<RepoPath>
	packages: ReadonlyArray<PackageKey>
	builtins: ReadonlyArray<string>
	hooked: ReadonlyArray<string>
}>

/** What a closure is computed from. */
export type ClosureInput = Readonly<{
	tree: Files
	/** The conditions the runner config adds to Node's own (node, import, module-sync, default). */
	conditions: ReadonlyArray<string>
	/** The runtime the modules run on, by its version: a closure, like a verdict, holds for one runtime. */
	runtime: string
	/** The modules whose closures are wanted. */
	roots: ReadonlyArray<RepoPath>
}>

/** The files a module is parsed for: JavaScript and TypeScript. Any other file is content alone, loading nothing. */
const CODE = regex("\\.(ts|mts|cts|tsx|js|mjs|cjs|jsx)$")

/** The SHA-256 of `bytes`, in hex. */
export const contentHashOf = Effect.fn("contentHashOf")(function* (bytes: Uint8Array) {
	const digest = yield* Digest.Digest
	const hex = yield* digest.digestHex(Digest.sha256, bytes)
	return ContentHash(hex)
})

/** The SHA-256 of lines of text, sorted and deduplicated, in hex. */
const linesHashOf = Effect.fn("linesHashOf")(function* (lines: ReadonlyArray<string>) {
	const digest = yield* Digest.Digest
	return yield* digest.digestHex(
		Digest.sha256,
		new TextEncoder().encode(Arr.join(Arr.dedupe(Arr.sort(lines, Str.Order)), "\n"))
	)
})

/** A leaf as its closure's hash reads it: a package by its key and the identity of its lockfile entries. */
const leafLine = (leaf: Leaf): string => {
	switch (leaf.kind) {
		case "package":
			return `package ${leaf.key} ${leaf.identity} ${leaf.subpath} -> ${leaf.target}`
		case "builtin":
			return `builtin ${leaf.specifier}`
		case "hooked":
			return `hooked ${leaf.specifier}`
	}
}

/**
 * The strongly connected components of the walk's module graph reachable from `roots`, by Tarjan's algorithm with an
 * explicit stack, in the order Tarjan completes them: every component after each component it reaches.
 */
const componentsOf = (
	walked: ReadonlyArray<Walked>,
	roots: ReadonlyArray<number>
): ReadonlyArray<ReadonlyArray<number>> => {
	const index: Array<number> = Array.from({ length: walked.length }, () => -1)
	const low: Array<number> = Array.from({ length: walked.length }, () => 0)
	const onStack: Array<boolean> = Array.from({ length: walked.length }, () => false)
	const stack: Array<number> = []
	const components: Array<ReadonlyArray<number>> = []
	let visited = 0
	for (const root of roots) {
		if (Arr.getUnsafe(index, root) !== -1) {
			continue
		}
		const frames: Array<{ node: number; successors: ReadonlyArray<number>; at: number }> = []
		const enter = (node: number) => {
			index[node] = visited
			low[node] = visited
			visited += 1
			stack.push(node)
			onStack[node] = true
			frames.push({
				node,
				successors: Arr.filterMap(Arr.getUnsafe(walked, node).links, (link) =>
					link.kind === "module" ? Result.succeed(link.index) : Result.failVoid
				),
				at: 0
			})
		}
		enter(root)
		for (let top = Arr.last(frames); Option.isSome(top); top = Arr.last(frames)) {
			const frame = top.value
			const next = Arr.get(frame.successors, frame.at)
			if (Option.isSome(next)) {
				frame.at += 1
				if (Arr.getUnsafe(index, next.value) === -1) {
					enter(next.value)
				} else if (Arr.getUnsafe(onStack, next.value)) {
					low[frame.node] = Math.min(
						Arr.getUnsafe(low, frame.node),
						Arr.getUnsafe(index, next.value)
					)
				}
				continue
			}
			frames.pop()
			const parent = Arr.last(frames)
			if (Option.isSome(parent)) {
				low[parent.value.node] = Math.min(
					Arr.getUnsafe(low, parent.value.node),
					Arr.getUnsafe(low, frame.node)
				)
			}
			if (Arr.getUnsafe(low, frame.node) === Arr.getUnsafe(index, frame.node)) {
				const component: Array<number> = []
				for (let member = stack.pop(); member !== undefined; member = stack.pop()) {
					onStack[member] = false
					component.push(member)
					if (member === frame.node) {
						break
					}
				}
				components.push(component)
			}
		}
	}
	return components
}

/**
 * A closure input's walk: every module its roots load, transitively, in the order the walk placed them (`Walked`), the
 * roots' places among them, the input's conditions and runtime, and every file the walk read with its bytes' hash, or
 * none where it found no file there: a manifest's absence decides a package scope as its presence does. A walk is a
 * function of those reads, its conditions and runtime, and each module's syntax, which is a function of its text, and
 * of nothing else (`walkHolds`).
 */
export type Walk = Readonly<{
	walked: ReadonlyArray<Walked>
	roots: ReadonlyArray<number>
	conditions: ReadonlyArray<string>
	runtime: string
	read: ReadonlyMap<RepoPath, Option.Option<ContentHash>>
}>

/** The specifiers a module of `path` with these bytes loads at run time, each once, in its text's order: a code file's
 * runtime specifiers, and none for any other file, which is content alone. */
export const specifiersOf = (
	path: RepoPath,
	content: ContentHash,
	bytes: Uint8Array
): Effect.Effect<ReadonlyArray<string>, SyntaxUnread, ModuleSyntax> =>
	CODE.test(path)
		? Effect.flatMap(ModuleSyntax, (syntax) =>
				Effect.map(
					syntax.runtimeSpecifiers(path, content, new TextDecoder().decode(bytes)),
					Arr.dedupe
				)
			)
		: Effect.succeed([])

/**
 * The closure of each root: every module the root loads, transitively, walked once for all roots, each file read and
 * parsed once (`walkOf`), and hashed (`closuresOfWalk`).
 */
export const closuresOf = (input: ClosureInput) => Effect.flatMap(walkOf(input), closuresOfWalk)

/** The walk of a closure input (`Walk`): each file read once, each module parsed once. */
export const walkOf = Effect.fn("walkOf")(function* (input: ClosureInput) {
	const active: ReadonlySet<string> = new Set([...NODE_CONDITIONS, ...input.conditions])
	const files = new Map<RepoPath, Option.Option<Uint8Array>>()
	const read = (path: RepoPath) =>
		Option.match(Option.fromUndefinedOr(files.get(path)), {
			onSome: Effect.succeed,
			onNone: () =>
				Effect.tap(input.tree.read(path), (bytes) =>
					Effect.sync(() => {
						files.set(path, bytes)
					})
				)
		})
	const lockText = yield* read(LOCKFILE)
	const lock = yield* Option.match(lockText, {
		onNone: () =>
			Effect.fail(
				ManifestMalformed.make({ path: LOCKFILE, detail: "the repository has no lockfile" })
			),
		onSome: (bytes) => lockOf(new TextDecoder().decode(bytes))
	})
	const manifests = new Map<string, Option.Option<Manifest>>()
	const manifestAt = (directory: string) =>
		Option.match(Option.fromUndefinedOr(manifests.get(directory)), {
			onSome: Effect.succeed,
			onNone: () => {
				const path = RepoPath(directory === "" ? "package.json" : `${directory}/package.json`)
				return Effect.flatMap(read(path), (bytes) =>
					Effect.tap(
						Effect.transposeOption(Option.map(bytes, (found) => manifestOf(path, found))),
						(manifest) =>
							Effect.sync(() => {
								manifests.set(directory, manifest)
							})
					)
				)
			}
		})
	const workspace = new Map<string, string>()
	for (const importer of lock.importers) {
		const manifest = yield* manifestAt(importer.directory)
		Option.map(
			Option.flatMap(manifest, (found) => found.name),
			(name) => {
				workspace.set(name, importer.directory)
			}
		)
	}
	const identities = new Map<PackageKey, string>()
	const identityOf = (key: PackageKey): Effect.Effect<string, PackageUnlocked, Digest.Digest> =>
		Option.match(Option.fromUndefinedOr(identities.get(key)), {
			onSome: Effect.succeed,
			onNone: () =>
				Effect.flatMap(
					Effect.flatMap(
						Effect.mapError(Effect.fromResult(lockClosureOf(lock, key)), (missing) =>
							PackageUnlocked.make({ key: missing })
						),
						(closure) =>
							Effect.forEach(closure, (reached) =>
								Option.match(Option.fromUndefinedOr(lock.resolutions.get(baseKeyOf(reached))), {
									onNone: () => Effect.fail(PackageUnlocked.make({ key: reached })),
									onSome: (resolution) => Effect.succeed(`${reached} ${resolution}`)
								})
							)
					),
					(lines) =>
						Effect.tap(linesHashOf(lines), (identity) =>
							Effect.sync(() => {
								identities.set(key, identity)
							})
						)
				)
		})
	const scopeOf = (
		directory: string
	): Effect.Effect<
		Option.Option<Readonly<{ directory: string; manifest: Manifest }>>,
		ManifestMalformed | TreeUnreadable
	> =>
		Effect.flatMap(manifestAt(directory), (manifest) =>
			Option.match(manifest, {
				onSome: (found) => Effect.succeedSome({ directory, manifest: found }),
				onNone: () => (directory === "" ? Effect.succeedNone : scopeOf(parentOf(directory)))
			})
		)
	const unresolved = (module: RepoPath, specifier: string, why: string) =>
		Effect.fail(ImportUnresolved.make({ module, specifier, why }))
	const existing = (module: RepoPath, specifier: string, path: Option.Option<RepoPath>) =>
		Option.match(path, {
			onNone: () => unresolved(module, specifier, "it names a path outside the repository"),
			onSome: (file) =>
				Effect.flatMap(read(file), (bytes) =>
					Option.isSome(bytes)
						? Effect.succeed<Resolved>({ kind: "file", path: file })
						: unresolved(module, specifier, `no file is at ${file}`)
				)
		})
	const throughPackage = (
		module: RepoPath,
		specifier: string,
		directory: string,
		subpath: string
	): Effect.Effect<Resolved, ClosureFailure, Digest.Digest> =>
		Effect.flatMap(manifestAt(directory), (manifest) =>
			Option.match(manifest, {
				onNone: () => unresolved(module, specifier, `no package.json is in ${directory}`),
				onSome: (found) =>
					Option.match(found.exports, {
						onNone: () =>
							existing(
								module,
								specifier,
								fileUnder(
									directory,
									subpath === "." ? Option.getOrElse(found.main, () => "index.js") : subpath
								)
							),
						onSome: (entries) =>
							Option.match(matchOf(entries, subpath), {
								onNone: () =>
									unresolved(module, specifier, `${directory}/package.json exports no ${subpath}`),
								onSome: ({ target, star }) => {
									const resolution = resolvedTarget(target, star, active)
									return resolution.kind === "path" && Str.startsWith("./")(resolution.path)
										? existing(module, specifier, fileUnder(directory, resolution.path))
										: unresolved(
												module,
												specifier,
												`${directory}/package.json maps ${subpath} to no file under these conditions`
											)
								}
							})
					})
			})
		)
	/**
	 * What an installed package at `directory` gives for `subpath` under the active conditions, as its manifest's exports
	 * map (or its main) states it: the target path, `excluded`, `unexported`, or why its manifest gives none. A closure
	 * holds an installed package by its lockfile entry and this target, so two condition sets that choose the same file
	 * of it hold it alike, and two that choose different files do not (template.ts's identity, a verdict's key).
	 */
	const packageTarget = (
		directory: string,
		subpath: string
	): Effect.Effect<string, never, Digest.Digest> =>
		Effect.match(manifestAt(directory), {
			onFailure: (failure) => `an unreadable package.json: ${failure._tag}`,
			onSuccess: (manifest) =>
				Option.match(manifest, {
					onNone: () => "no package.json",
					onSome: (found) =>
						Option.match(found.exports, {
							onNone: () =>
								subpath === "." ? Option.getOrElse(found.main, () => "index.js") : subpath,
							onSome: (entries) =>
								Option.match(matchOf(entries, subpath), {
									onNone: () => "unexported",
									onSome: ({ target, star }) => {
										const resolution = resolvedTarget(target, star, active)
										return resolution.kind === "path" ? resolution.path : resolution.kind
									}
								})
						})
				})
		})
	const bare = (
		module: RepoPath,
		specifier: string,
		from: string
	): Effect.Effect<Resolved, ClosureFailure, Digest.Digest> =>
		Option.match(packageOf(specifier), {
			onNone: () => unresolved(module, specifier, "it is no package name"),
			onSome: ({ dependency, subpath }) =>
				Effect.flatMap(scopeOf(from), (scope) => {
					const self = Option.filter(
						scope,
						({ manifest }) =>
							Option.contains(manifest.name, dependency) && Option.isSome(manifest.exports)
					)
					if (Option.isSome(self)) {
						return throughPackage(module, specifier, self.value.directory, subpath)
					}
					const declared = Option.flatMap(
						Arr.findFirst(
							lock.importers,
							(importer) =>
								importer.directory === "" ||
								from === importer.directory ||
								Str.startsWith(`${importer.directory}/`)(from)
						),
						(importer) =>
							Option.map(
								Option.fromUndefinedOr(importer.dependencies.get(dependency)),
								(version) => ({
									directory: importer.directory,
									version
								})
							)
					)
					if (Option.isNone(declared)) {
						return Option.match(Option.fromUndefinedOr(workspace.get(dependency)), {
							onNone: () => Effect.fail(PackageUndeclared.make({ module, dependency })),
							onSome: (directory) => throughPackage(module, specifier, directory, subpath)
						})
					}
					const { directory: importerDirectory, version } = declared.value
					if (Str.startsWith("link:")(version)) {
						return Option.match(
							directoryUnder(importerDirectory, Str.slice("link:".length)(version)),
							{
								onNone: () => unresolved(module, specifier, "its link leaves the repository"),
								onSome: (directory) => throughPackage(module, specifier, directory, subpath)
							}
						)
					}
					const key = lockKeyOf(dependency, version)
					return Effect.zipWith(
						identityOf(key),
						packageTarget(
							importerDirectory === ""
								? `node_modules/${dependency}`
								: `${importerDirectory}/node_modules/${dependency}`,
							subpath
						),
						(identity, target): Resolved => ({
							kind: "leaf",
							leaf: { kind: "package", key, identity, subpath, target }
						})
					)
				})
		})
	const resolve = (
		module: RepoPath,
		specifier: string
	): Effect.Effect<Resolved, ClosureFailure, Digest.Digest> => {
		const directory = directoryOf(module)
		if (Str.startsWith("node:")(specifier) || isBuiltin(specifier)) {
			return Effect.succeed({
				kind: "leaf",
				leaf: {
					kind: "builtin",
					specifier: Str.startsWith("node:")(specifier) ? specifier : `node:${specifier}`
				}
			})
		}
		if (Str.startsWith("file:")(specifier)) {
			return unresolved(module, specifier, "a file: URL names no path of the repository's tree")
		}
		if (SCHEME.test(specifier)) {
			return Effect.succeed({ kind: "leaf", leaf: { kind: "hooked", specifier } })
		}
		if (
			specifier === "." ||
			specifier === ".." ||
			Str.startsWith("./")(specifier) ||
			Str.startsWith("../")(specifier)
		) {
			return existing(module, specifier, fileUnder(directory, specifier))
		}
		if (Str.startsWith("/")(specifier)) {
			return unresolved(
				module,
				specifier,
				"an absolute path names no file of the repository's tree"
			)
		}
		if (Str.startsWith("#")(specifier)) {
			return Effect.flatMap(scopeOf(directory), (scope) =>
				Option.match(
					Option.flatMap(scope, ({ directory: at, manifest }) =>
						Option.map(matchOf(manifest.imports, specifier), (match) => ({ at, match }))
					),
					{
						onNone: () => unresolved(module, specifier, "its package's imports map no such key"),
						onSome: ({ at, match }) => {
							const resolution = resolvedTarget(match.target, match.star, active)
							if (resolution.kind !== "path") {
								return unresolved(module, specifier, "its package's imports map it to nothing here")
							}
							if (Str.startsWith("./")(resolution.path)) {
								return existing(module, specifier, fileUnder(at, resolution.path))
							}
							if (Str.startsWith("../")(resolution.path) || Str.startsWith("/")(resolution.path)) {
								return unresolved(module, specifier, "its imports target leaves its package")
							}
							return bare(module, resolution.path, at)
						}
					}
				)
			)
		}
		return bare(module, specifier, directory)
	}
	const places = new Map<RepoPath, number>()
	const order: Array<RepoPath> = []
	const placeOf = (path: RepoPath): number => {
		const known = places.get(path)
		if (known !== undefined) {
			return known
		}
		places.set(path, order.length)
		order.push(path)
		return order.length - 1
	}
	const roots = Arr.map(input.roots, placeOf)
	const walked: Array<Walked> = []
	for (let at = 0; at < order.length; at += 1) {
		const path = Arr.getUnsafe(order, at)
		const bytes = yield* read(path)
		if (Option.isNone(bytes)) {
			return yield* ModuleMissing.make({ module: path })
		}
		const content = yield* contentHashOf(bytes.value)
		const specifiers = yield* specifiersOf(path, content, bytes.value)
		const links = yield* Effect.forEach(specifiers, (specifier) =>
			Effect.map(resolve(path, specifier), (resolved): Link =>
				resolved.kind === "file"
					? { kind: "module", index: placeOf(resolved.path) }
					: { kind: "leaf", leaf: resolved.leaf }
			)
		)
		walked.push({ path, content, specifiers, links })
	}
	const readings = new Map<RepoPath, Option.Option<ContentHash>>()
	for (const [path, bytes] of files) {
		const reading = yield* readingOf(bytes)
		readings.set(path, reading)
	}
	const walk: Walk = {
		walked,
		roots,
		conditions: input.conditions,
		runtime: input.runtime,
		read: readings
	}
	return walk
})

/**
 * The closure of each root of a walk. The hash of a root is that of its component under the walk's runtime, and a
 * component's hash is that of its members' paths and bytes and each member's links, every one by its member and its
 * place among the member's imports (a line set is hashed sorted, so a link names where it is from and its place, or
 * two wirings of the same files would hash alike), to a member of its own component by its path, to a leaf by what it
 * is, to another component by its hash and the member it enters it at. The walk's conditions are no line of it:
 * they count through what they resolved, which the links and leaves state.
 */
export const closuresOfWalk = Effect.fn("closuresOfWalk")(function* (walk: Walk) {
	const { walked, roots } = walk
	const order = Arr.map(walked, (node) => node.path)
	const components = componentsOf(walked, roots)
	const componentOf: Array<number> = Array.from({ length: walked.length }, () => 0)
	const componentHashes: Array<string> = []
	for (const [place, members] of components.entries()) {
		for (const member of members) {
			componentOf[member] = place
		}
		const lines = Arr.flatMap(members, (member) => {
			const node = Arr.getUnsafe(walked, member)
			return [
				`module ${node.path} ${node.content}`,
				...Arr.map(node.links, (link, at) => {
					const to =
						link.kind === "leaf"
							? leafLine(link.leaf)
							: Arr.getUnsafe(componentOf, link.index) === place
								? `module ${Arr.getUnsafe(order, link.index)}`
								: `closure ${Arr.getUnsafe(componentHashes, Arr.getUnsafe(componentOf, link.index))} ${Arr.getUnsafe(order, link.index)}`
					return `link ${node.path} ${at} ${to}`
				})
			]
		})
		const hash = yield* linesHashOf(lines)
		componentHashes.push(hash)
	}
	const context = `runtime ${walk.runtime}`
	const closures = new Map<RepoPath, Closure>()
	for (const root of roots) {
		const path = Arr.getUnsafe(order, root)
		if (closures.has(path)) {
			continue
		}
		const component = Arr.getUnsafe(componentHashes, Arr.getUnsafe(componentOf, root))
		const hash = yield* linesHashOf([context, component])
		closures.set(path, { hash: closureHash(hash), ...membersOf(walked, root) })
	}
	return closures
})

/** A file's reading: its bytes' hash, or none where no file is there. */
const readingOf = (
	bytes: Option.Option<Uint8Array>
): Effect.Effect<Option.Option<ContentHash>, never, Digest.Digest> =>
	Option.match(bytes, {
		onNone: () => Effect.succeedNone,
		onSome: (found) => Effect.asSome(contentHashOf(found))
	})

/** Whether two reads of a file found alike: no file both times, or bytes of one hash. */
const readAlike = (a: Option.Option<ContentHash>, b: Option.Option<ContentHash>): boolean =>
	Option.isSome(a) ? Option.isSome(b) && a.value === b.value : Option.isNone(b)

/** Whether two modules' texts load the same specifiers, in the same order. */
const loadAlike = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
	a.length === b.length && Arr.every(a, (specifier, at) => specifier === b[at])

/**
 * `walk` as it holds over `tree`, which a walk of `tree` would find (`Walk`): the walk itself where every file it read
 * reads alike; where only modules' bytes differ, each still a file whose text loads the specifiers it did, the walk with
 * those modules' bytes, its links and every other file's reading unchanged; and none where a file it read appeared,
 * vanished or changed and is no module of it, or a module's text now loads other specifiers, whose links only a walk of
 * `tree` resolves.
 */
export const walkHolds = Effect.fn("walkHolds")(function* (walk: Walk, tree: Files) {
	const places = new Map(Arr.map(walk.walked, (node, at) => [node.path, at] as const))
	const contents = new Map<number, ContentHash>()
	const read = new Map(walk.read)
	for (const [path, was] of walk.read) {
		const bytes = yield* tree.read(path)
		const now = yield* readingOf(bytes)
		if (readAlike(was, now)) {
			continue
		}
		const at = places.get(path)
		if (at === undefined || Option.isNone(bytes) || Option.isNone(now)) {
			return Option.none<Walk>()
		}
		const specifiers = yield* specifiersOf(path, now.value, bytes.value)
		if (!loadAlike(specifiers, Arr.getUnsafe(walk.walked, at).specifiers)) {
			return Option.none<Walk>()
		}
		contents.set(at, now.value)
		read.set(path, now)
	}
	const held: Walk = {
		...walk,
		walked: Arr.map(walk.walked, (node, at) =>
			Option.match(Option.fromUndefinedOr(contents.get(at)), {
				onNone: () => node,
				onSome: (content) => ({ ...node, content })
			})
		),
		read
	}
	return Option.some(held)
})

/** What a root's closure holds: every file it reaches and every leaf they load, each list sorted. */
const membersOf = (walked: ReadonlyArray<Walked>, root: number): Omit<Closure, "hash"> => {
	const seen: Array<boolean> = Array.from({ length: walked.length }, () => false)
	const pending: Array<number> = [root]
	const files: Array<RepoPath> = []
	const packages = new Set<PackageKey>()
	const builtins = new Set<string>()
	const hooked = new Set<string>()
	for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
		if (Arr.getUnsafe(seen, node)) {
			continue
		}
		seen[node] = true
		const module = Arr.getUnsafe(walked, node)
		files.push(module.path)
		for (const link of module.links) {
			if (link.kind === "module") {
				pending.push(link.index)
				continue
			}
			switch (link.leaf.kind) {
				case "package":
					packages.add(link.leaf.key)
					break
				case "builtin":
					builtins.add(link.leaf.specifier)
					break
				case "hooked":
					hooked.add(link.leaf.specifier)
					break
			}
		}
	}
	return {
		files: Arr.sort(files, Str.Order),
		packages: Arr.sort(packages, Str.Order),
		builtins: Arr.sort(builtins, Str.Order),
		hooked: Arr.sort(hooked, Str.Order)
	}
}

/**
 * The closure of several modules together, as one verdict depends on them all (a property's module, its runner
 * config, the runner itself): its hash is that of their hashes, so it changes when any of theirs does, and it holds
 * what any of them holds.
 */
export const jointClosureOf = Effect.fn("jointClosureOf")(function* (
	closures: Arr.NonEmptyReadonlyArray<Closure>
) {
	const hash = yield* linesHashOf(Arr.map(closures, (closure) => `closure ${closure.hash}`))
	const union = <A extends string>(pick: (closure: Closure) => ReadonlyArray<A>) =>
		Arr.sort(Arr.dedupe(Arr.flatMap(closures, pick)), Str.Order)
	return {
		hash: closureHash(hash),
		files: union((closure) => closure.files),
		packages: union((closure) => closure.packages),
		builtins: union((closure) => closure.builtins),
		hooked: union((closure) => closure.hooked)
	}
})
