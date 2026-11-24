import { fileURLToPath, pathToFileURL } from "node:url"
import { layerDigest } from "@effect/platform-node/NodeCrypto"
import {
	Array as Arr,
	Context,
	Effect,
	FileSystem,
	Layer,
	Option,
	Schema,
	Stream,
	String as Str
} from "effect"
import { Digest } from "effect/crypto"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { aimed, array, boolean, element, type Gen, oneOf } from "#gen.ts"
import { plantedBudget } from "#planted.fixtures.ts"
import { type Need, NeedFailed } from "#property.ts"
import {
	type Closure,
	type ClosureFailure,
	closuresOf,
	ModuleSyntax,
	moduleSyntax,
	type RepoPath,
	repoPathOf,
	type Files,
	workingTree
} from "#runner/closure.ts"

/**
 * Generated pnpm workspaces for closure.test.ts: a root package and one library package (`@ws/lib`), a few modules in
 * each, two external packages under node_modules with their lockfile entries, and imports between them by every route
 * the closure resolves (a relative path, the package's `#own/*` subpath imports, the library's `./m*` export pattern,
 * the root's `#lib/*` import of a bare package target, conditional exports and imports, externals, built-ins, a JSON
 * module) in every form (named, namespace, bare, re-export, star, inline type, dynamic; and the type-only forms Node
 * erases). The model states what each import reaches, so the oracle reads reachability off the model, and a workspace
 * written to disk lets Node itself load it.
 */

/** A condition a conditional map is keyed by: the runner config's own, one Node sets on every import, one it never sets. */
const CONDITIONS = ["custom", "import", "require"] as const

export type Condition = (typeof CONDITIONS)[number]

/** The external packages, each with a lockfile entry; `ext-a` may depend on `ext-b`. */
const EXTERNALS = ["ext-a", "ext-b"] as const

export type External = (typeof EXTERNALS)[number]

/** Built-ins by specifier, each with a value it exports, `fs` named bare. */
const BUILTINS = ["node:path", "fs", "node:url"] as const

export type Builtin = (typeof BUILTINS)[number]

/** The forms an import or re-export takes: the runtime ones load their module, the type-only ones Node erases. */
const RUNTIME_FORMS = [
	"named",
	"namespace",
	"bare",
	"reexport",
	"star",
	"inline-type",
	"dynamic"
] as const

const TYPE_FORMS = ["type", "type-reexport", "type-star"] as const

export type Form = (typeof RUNTIME_FORMS)[number] | (typeof TYPE_FORMS)[number]

/** How an import names its target. A conditional route carries the modules its map chooses between. */
export type Route =
	| Readonly<{ kind: "relative" | "own" | "export" | "alias"; module: number }>
	| Readonly<{
			kind: "pick" | "choose"
			condition: Condition
			active: number
			otherwise: number
	  }>
	| Readonly<{ kind: "external"; external: External }>
	| Readonly<{ kind: "builtin"; builtin: Builtin }>

/** One import statement: code by a route in a form, or the package's JSON module, by a relative path or `#own/*`. */
export type Import =
	| Readonly<{ kind: "code"; route: Route; form: Form }>
	| Readonly<{ kind: "data"; via: "relative" | "own" }>

/** A module: in the library package or the root's, and its imports in order. */
export type Module = Readonly<{ library: boolean; imports: ReadonlyArray<Import> }>

/** A generated workspace: its modules, whether the runner config sets `custom`, and whether ext-a depends on ext-b. */
export type Workspace = Readonly<{
	modules: Arr.NonEmptyReadonlyArray<Module>
	configured: boolean
	chain: boolean
}>

/** What one module reaches by a runtime import, as the model resolves it. */
type Target =
	| Readonly<{ kind: "module"; module: number }>
	| Readonly<{ kind: "data"; library: boolean }>
	| Readonly<{ kind: "external"; external: External }>
	| Readonly<{ kind: "builtin"; builtin: Builtin }>

/** Whether a condition is active: Node's own `import` always, `custom` when the config sets it, `require` never. */
const isActive = (condition: Condition, configured: boolean): boolean => {
	switch (condition) {
		case "custom":
			return configured
		case "import":
			return true
		case "require":
			return false
	}
}

/** What an import reaches under the workspace's conditions. */
const targetOf = (workspace: Workspace, from: Module, imported: Import): Target => {
	if (imported.kind === "data") {
		return { kind: "data", library: from.library }
	}
	const route = imported.route
	switch (route.kind) {
		case "relative":
		case "own":
		case "export":
		case "alias":
			return { kind: "module", module: route.module }
		case "pick":
		case "choose":
			return {
				kind: "module",
				module: isActive(route.condition, workspace.configured) ? route.active : route.otherwise
			}
		case "external":
			return { kind: "external", external: route.external }
		case "builtin":
			return { kind: "builtin", builtin: route.builtin }
	}
}

/** Whether an import loads its target at run time: a JSON module and every runtime form do, the type-only forms not. */
const isRuntime = (imported: Import): boolean => {
	if (imported.kind === "data") {
		return true
	}
	switch (imported.form) {
		case "named":
		case "namespace":
		case "bare":
		case "reexport":
		case "star":
		case "inline-type":
		case "dynamic":
			return true
		case "type":
		case "type-reexport":
		case "type-star":
			return false
	}
}

/** What a module reaches, as the model says: modules, data files, externals and built-ins, through runtime imports. */
type Reach = Readonly<{
	modules: ReadonlySet<number>
	data: ReadonlySet<boolean>
	externals: ReadonlySet<External>
	builtins: ReadonlySet<Builtin>
}>

/** Every module, data file, external and built-in `root` reaches through imports `follows` admits. */
const reachOf = (
	workspace: Workspace,
	root: number,
	follows: (imported: Import) => boolean
): Reach => {
	const modules = new Set<number>()
	const data = new Set<boolean>()
	const externals = new Set<External>()
	const builtins = new Set<Builtin>()
	const pending: Array<number> = [root]
	for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
		if (modules.has(next)) {
			continue
		}
		modules.add(next)
		const module = Arr.getUnsafe(workspace.modules, next)
		for (const imported of module.imports) {
			if (!follows(imported)) {
				continue
			}
			const target = targetOf(workspace, module, imported)
			switch (target.kind) {
				case "module":
					pending.push(target.module)
					break
				case "data":
					data.add(target.library)
					break
				case "external":
					externals.add(target.external)
					break
				case "builtin":
					builtins.add(target.builtin)
					break
			}
		}
	}
	return { modules, data, externals, builtins }
}

/** The externals whose lockfile entries a reach holds: those it loads, and ext-b behind ext-a when ext-a depends on it. */
const lockedOf = (workspace: Workspace, reach: Reach): ReadonlySet<External> =>
	new Set([
		...reach.externals,
		...(workspace.chain && reach.externals.has("ext-a") ? ["ext-b" as const] : [])
	])

/** Module `index` first, then every other module `admits`, in index order: a non-empty pick, shrinking to itself. */
const withSelf = (
	placed: Arr.NonEmptyReadonlyArray<boolean>,
	index: number,
	admits: (library: boolean) => boolean
): Arr.NonEmptyReadonlyArray<number> => [
	index,
	...Arr.filter(
		Arr.map(placed, (_, at) => at),
		(at) => at !== index && admits(Arr.getUnsafe(placed, at))
	)
]

/** Every import the module at `index` can state in this workspace, as a generator of one import. */
const importsFor = (placed: Arr.NonEmptyReadonlyArray<boolean>, index: number): Gen<Import> => {
	const library = Arr.getUnsafe(placed, index)
	const everyModule = withSelf(placed, index, () => true)
	const own = withSelf(placed, index, (inLibrary) => inLibrary === library)
	const libraryModules = Arr.filter(
		Arr.map(placed, (_, at) => at),
		(at) => Arr.getUnsafe(placed, at)
	)
	const moduleRoute =
		(
			kind: "relative" | "own" | "export" | "alias",
			among: Arr.NonEmptyReadonlyArray<number>
		): Gen<Route> =>
		(source) => ({ kind, module: source.draw(element(among)) })
	const conditional =
		(kind: "pick" | "choose", among: Arr.NonEmptyReadonlyArray<number>): Gen<Route> =>
		(source) => ({
			kind,
			condition: source.draw(element(CONDITIONS)),
			active: source.draw(element(among)),
			otherwise: source.draw(element(among))
		})
	const routes: Arr.NonEmptyArray<Gen<Route>> = [
		moduleRoute("relative", everyModule),
		moduleRoute("own", own),
		conditional("choose", own),
		(source) => ({ kind: "external", external: source.draw(element(EXTERNALS)) }),
		(source) => ({ kind: "builtin", builtin: source.draw(element(BUILTINS)) })
	]
	if (Arr.isReadonlyArrayNonEmpty(libraryModules)) {
		routes.push(
			moduleRoute("export", libraryModules),
			moduleRoute("alias", libraryModules),
			conditional("pick", libraryModules)
		)
	}
	return oneOf<Import>([
		(source) => ({
			kind: "code",
			route: source.draw(oneOf(routes)),
			form: source.draw(element([...RUNTIME_FORMS, ...TYPE_FORMS]))
		}),
		(source) => ({ kind: "data", via: source.draw(element(["relative", "own"])) })
	])
}

/** A workspace of one to six modules, each with up to four imports. */
export const workspaces: Gen<Workspace> = (source) => {
	const placed: Arr.NonEmptyReadonlyArray<boolean> = [
		source.draw(boolean),
		...source.draw(array(boolean, { min: 0, max: 5 }))
	]
	return {
		modules: Arr.map(placed, (library, index) => ({
			library,
			imports: source.draw(array(importsFor(placed, index), { min: 0, max: 4 }))
		})),
		configured: source.draw(boolean),
		chain: source.draw(boolean)
	}
}

/** What a closure test touches between two hashings: nothing, one module, one data file, or one lockfile entry. */
export type Touch =
	| Readonly<{ kind: "nothing" }>
	| Readonly<{ kind: "module"; module: number }>
	| Readonly<{ kind: "data"; library: boolean }>
	| Readonly<{ kind: "lock"; external: External }>

/** A workspace and one touch of it. */
export type TouchedWorkspace = Readonly<{ workspace: Workspace; touch: Touch }>

/** A workspace and a touch drawn for it. */
export const touchedWorkspaces: Gen<TouchedWorkspace> = (source) => {
	const workspace = source.draw(workspaces)
	const touch = source.draw(
		oneOf<Touch>([
			() => ({ kind: "nothing" }),
			(inner) => ({
				kind: "module",
				module: inner.draw(element(Arr.map(workspace.modules, (_, at) => at)))
			}),
			(inner) => ({ kind: "data", library: inner.draw(boolean) }),
			(inner) => ({ kind: "lock", external: inner.draw(element(EXTERNALS)) })
		])
	)
	return { workspace, touch }
}

/**
 * What changes between two hashings of a workspace's module closures as a pool reads them (runner/module-closure.ts): a
 * touch (`Touch`), whose module edit keeps the module's imports, or a module whose imports are drawn again.
 */
export type Change = Touch | Readonly<{ kind: "imports"; module: number; workspace: Workspace }>

/** A workspace and one change of it. */
export type Changed = Readonly<{ workspace: Workspace; change: Change }>

/** A workspace and a change drawn for it: a touch, or one module's imports drawn again. */
export const changedWorkspaces: Gen<Changed> = (source) => {
	const { workspace, touch } = source.draw(touchedWorkspaces)
	const placed = Arr.map(workspace.modules, (module) => module.library)
	const change = source.draw(
		oneOf<Change>([
			() => touch,
			(inner) => {
				const module = inner.draw(element(Arr.map(workspace.modules, (_, at) => at)))
				const imports = inner.draw(array(importsFor(placed, module), { min: 0, max: 4 }))
				return {
					kind: "imports",
					module,
					workspace: {
						...workspace,
						modules: Arr.map(workspace.modules, (held, at) =>
							at === module ? { ...held, imports } : held
						)
					}
				}
			}
		])
	)
	return { workspace, change }
}

/** A changed workspace's files: the touched files, or the files of the workspace whose module's imports changed. */
export const changedFilesOf = (
	changed: Changed
): ReadonlyArray<readonly [path: string, text: string]> =>
	changed.change.kind === "imports"
		? filesOf(changed.change.workspace, { kind: "nothing" })
		: filesOf(changed.workspace, changed.change)

/**
 * The one file a change gives another text, with its path and new text, where it is a module, as a pool serving it as a
 * mutant loads it: a module touch's, or an imports change's whose new imports leave every other file as it was (one
 * through the library's export pattern also changes its package.json, which no mutant of one file serves).
 */
export const changedModuleOf = (
	changed: Changed
): Option.Option<Readonly<{ path: string; text: string }>> => {
	const change = changed.change
	if (change.kind !== "module" && change.kind !== "imports") {
		return Option.none()
	}
	const before = new Map(filesOf(changed.workspace, { kind: "nothing" }))
	const differing = Arr.filter(changedFilesOf(changed), ([path, text]) => before.get(path) !== text)
	return Option.flatMap(Arr.head(differing), ([path, text]) =>
		differing.length === 1 && path === modulePathOf(changed.workspace, change.module)
			? Option.some({ path, text })
			: Option.none()
	)
}

/** What a change is, as a situation of the module closures a pool reads. */
export type ChangeSituation =
	| "nothing changed"
	| "a module's text, its imports kept"
	| "a module's imports"
	| "a data file"
	| "a lockfile entry"

/** The situation a change is. */
export const changeSituationOf = (change: Change): ChangeSituation => {
	switch (change.kind) {
		case "nothing":
			return "nothing changed"
		case "module":
			return "a module's text, its imports kept"
		case "imports":
			return "a module's imports"
		case "data":
			return "a data file"
		case "lock":
			return "a lockfile entry"
	}
}

/** The path of module `index`. */
const modulePathOf = (workspace: Workspace, index: number): string =>
	`${Arr.getUnsafe(workspace.modules, index).library ? "packages/lib/" : ""}src/m${index}.ts`

/** The path of a package's JSON module. */
const dataPathOf = (library: boolean): string => `${library ? "packages/lib/" : ""}data.json`

/** A relative specifier from the file `from` to the file `to`, both repository paths. */
const relativeOf = (from: string, to: string): string => {
	const fromDirectory = Arr.initNonEmpty(Str.split("/")(from))
	const toSegments = Str.split("/")(to)
	const shared = Arr.reduce(fromDirectory, { count: 0, open: true }, (state, segment, at) =>
		state.open && Arr.get(toSegments, at).pipe(Option.contains(segment))
			? { count: state.count + 1, open: true }
			: { count: state.count, open: false }
	).count
	const up = fromDirectory.length - shared
	const down = Arr.join(Arr.drop(toSegments, shared), "/")
	return up === 0
		? `./${down}`
		: `${Arr.join(
				Array.from({ length: up }, () => ".."),
				"/"
			)}/${down}`
}

/** The name a named import or re-export takes from an import's target. */
const exportedOf = (route: Route): string => {
	switch (route.kind) {
		case "external":
			return "e"
		case "builtin":
			return BUILTIN_EXPORTS[route.builtin]
		case "relative":
		case "own":
		case "export":
		case "alias":
		case "pick":
		case "choose":
			return "common"
	}
}

/** A value each built-in exports. */
const BUILTIN_EXPORTS: Readonly<Record<Builtin, string>> = {
	"node:path": "sep",
	fs: "existsSync",
	"node:url": "URL"
}

/** The key a conditional route's map entry has, unique to its statement. */
const conditionalKeyOf = (
	route: Route & Readonly<{ kind: "pick" | "choose" }>,
	statement: string
) => (route.kind === "pick" ? `./pick${statement}` : `#choose${statement}`)

/** The specifier an import of module `from` writes, its statement named `statement`. */
const specifierOf = (
	workspace: Workspace,
	from: number,
	imported: Import,
	statement: string
): string => {
	if (imported.kind === "data") {
		return imported.via === "own" ? "#own/data.json" : "../data.json"
	}
	const route = imported.route
	switch (route.kind) {
		case "relative":
			return relativeOf(modulePathOf(workspace, from), modulePathOf(workspace, route.module))
		case "own":
			return `#own/src/m${route.module}.ts`
		case "export":
			return `@ws/lib/m${route.module}`
		case "alias":
			return `#lib/m${route.module}`
		case "pick":
			return `@ws/lib/${Str.slice(2)(conditionalKeyOf(route, statement))}`
		case "choose":
			return conditionalKeyOf(route, statement)
		case "external":
			return route.external
		case "builtin":
			return route.builtin
	}
}

/** One import statement's text. */
const statementOf = (
	workspace: Workspace,
	from: number,
	imported: Import,
	statement: string
): string => {
	const specifier = specifierOf(workspace, from, imported, statement)
	if (imported.kind === "data") {
		return `import d${statement} from "${specifier}" with { type: "json" }`
	}
	const exported = exportedOf(imported.route)
	switch (imported.form) {
		case "named":
			return `import { ${exported} as a${statement} } from "${specifier}"`
		case "namespace":
			return `import * as a${statement} from "${specifier}"`
		case "bare":
			return `import "${specifier}"`
		case "reexport":
			return `export { ${exported} as x${statement} } from "${specifier}"`
		case "star":
			return `export * from "${specifier}"`
		case "inline-type":
			return `import { type Shape as t${statement} } from "${specifier}"`
		case "dynamic":
			return `void import("${specifier}")`
		case "type":
			return `import type { Shape as t${statement} } from "${specifier}"`
		case "type-reexport":
			return `export type { Shape as y${statement} } from "${specifier}"`
		case "type-star":
			return `export type * from "${specifier}"`
	}
}

/** A JSON object's text from its entries, each value a string or an object of the same kind. */
type JsonObject = ReadonlyArray<readonly [string, string | JsonObject]>

const jsonOf = (entries: JsonObject): string =>
	`{${Arr.join(
		Arr.map(
			entries,
			([key, value]) => `"${key}": ${typeof value === "string" ? `"${value}"` : jsonOf(value)}`
		),
		", "
	)}}`

/**
 * The conditional map entries the imports of one kind state: every `pick` in the library's exports, and each `choose`
 * in the imports of its own module's package (`library`).
 */
const conditionalsOf = (
	workspace: Workspace,
	kind: "pick" | "choose",
	library: boolean
): JsonObject =>
	Arr.flatMap(workspace.modules, (module, from) =>
		Arr.flatMap(module.imports, (imported, at) => {
			if (imported.kind !== "code" || (kind === "choose" && module.library !== library)) {
				return []
			}
			const route = imported.route
			if (route.kind !== kind) {
				return []
			}
			return [
				[
					conditionalKeyOf(route, `${from}_${at}`),
					[
						[route.condition, `./src/m${route.active}.ts`],
						["default", `./src/m${route.otherwise}.ts`]
					]
				] as const
			]
		})
	)

/** The integrity an external's lockfile entry states: touching it changes it. */
const integrityOf = (external: External, touched: boolean): string =>
	`sha512-${external}${touched ? "-touched" : ""}`

/** The workspace's files, touched as `touch` says: every module, both package.json files, both data files, the lockfile. */
export const filesOf = (
	workspace: Workspace,
	touch: Touch
): ReadonlyArray<readonly [path: string, text: string]> => {
	const dependencies: JsonObject = [
		["ext-a", "1.0.0"],
		["ext-b", "2.0.0"]
	]
	const modules = Arr.map(workspace.modules, (module, index) => {
		const statements = Arr.map(module.imports, (imported, at) =>
			statementOf(workspace, index, imported, `${index}_${at}`)
		)
		const edited = touch.kind === "module" && touch.module === index ? ["// edited"] : []
		return [
			modulePathOf(workspace, index),
			Arr.join(
				[
					...statements,
					...edited,
					`export const common = ${index}`,
					"export type Shape = number",
					""
				],
				"\n"
			)
		] as const
	})
	const lockEntry = (external: External, version: string) =>
		`  ${external}@${version}:\n    resolution: {integrity: ${integrityOf(external, touch.kind === "lock" && touch.external === external)}}\n`
	return [
		...modules,
		[
			"package.json",
			jsonOf([
				["name", "ws"],
				["type", "module"],
				[
					"imports",
					[
						["#own/*", "./*"],
						["#lib/*", "@ws/lib/*"],
						...conditionalsOf(workspace, "choose", false)
					]
				],
				["dependencies", [["@ws/lib", "workspace:*"], ...dependencies]]
			])
		],
		[
			"packages/lib/package.json",
			jsonOf([
				["name", "@ws/lib"],
				["type", "module"],
				[
					"imports",
					[["#own/*", "./*"], ["#lib/*", "@ws/lib/*"], ...conditionalsOf(workspace, "choose", true)]
				],
				["exports", [["./m*", "./src/m*.ts"], ...conditionalsOf(workspace, "pick", true)]],
				["dependencies", dependencies]
			])
		],
		...Arr.map(
			[false, true],
			(library) =>
				[
					dataPathOf(library),
					touch.kind === "data" && touch.library === library ? `{"edited": true}\n` : "{}\n"
				] as const
		),
		[
			"pnpm-lock.yaml",
			Arr.join(
				[
					"lockfileVersion: '9.0'",
					"",
					"importers:",
					"",
					"  .:",
					"    dependencies:",
					"      '@ws/lib':",
					"        specifier: workspace:*",
					"        version: link:packages/lib",
					"      ext-a:",
					"        specifier: 1.0.0",
					"        version: 1.0.0",
					"      ext-b:",
					"        specifier: 2.0.0",
					"        version: 2.0.0",
					"",
					"  packages/lib:",
					"    dependencies:",
					"      ext-a:",
					"        specifier: 1.0.0",
					"        version: 1.0.0",
					"      ext-b:",
					"        specifier: 2.0.0",
					"        version: 2.0.0",
					"",
					"packages:",
					"",
					lockEntry("ext-a", "1.0.0"),
					lockEntry("ext-b", "2.0.0"),
					"snapshots:",
					"",
					workspace.chain
						? "  ext-a@1.0.0:\n    dependencies:\n      ext-b: 2.0.0\n"
						: "  ext-a@1.0.0: {}\n",
					"  ext-b@2.0.0: {}",
					""
				],
				"\n"
			)
		]
	]
}

/** Every module of a workspace as a closure root, in index order; none if a generated path were not normal. */
export const rootsOf = (workspace: Workspace): Option.Option<Arr.NonEmptyReadonlyArray<RepoPath>> =>
	Option.all(Arr.map(workspace.modules, (_, index) => repoPathOf(modulePathOf(workspace, index))))

/** The files as Files held in memory. */
export const treeOf = (files: ReadonlyArray<readonly [path: string, text: string]>): Files => {
	const held = new Map(
		Arr.map(files, ([path, text]) => [path, new TextEncoder().encode(text)] as const)
	)
	return { read: (path) => Effect.succeed(Option.fromUndefinedOr(held.get(path))) }
}

/** The runner config's conditions for a workspace. */
const conditionsOf = (workspace: Workspace): ReadonlyArray<string> =>
	workspace.configured ? ["custom"] : []

/** The runtime a generated workspace's closures are hashed for. */
const RUNTIME = "node test"

/** What hashing a closure runs on: the native parser and SHA-256 from Node's crypto. */
export type Hashing = Readonly<{
	syntax: Context.Service.Shape<typeof ModuleSyntax>
	digest: Context.Service.Shape<typeof Digest.Digest>
}>

/** The closures of the roots of a workspace held in a tree, under the workspace's conditions. */
export const closuresIn = (
	workspace: Workspace,
	tree: Files,
	roots: ReadonlyArray<RepoPath>,
	hashing: Hashing
): Effect.Effect<ReadonlyMap<RepoPath, Closure>, ClosureFailure> =>
	closuresOf({ tree, conditions: conditionsOf(workspace), runtime: RUNTIME, roots }).pipe(
		Effect.provideService(ModuleSyntax, hashing.syntax),
		Effect.provideService(Digest.Digest, hashing.digest)
	)

/** The native parser and Node's SHA-256, opened once per evaluating process. */
export const hashing: Need<Hashing> = {
	key: "@bjornpagen/testing/runner/closure.fixtures/hashing",
	budget: plantedBudget,
	runNeeds: [],
	open: Effect.map(Layer.build(Layer.merge(moduleSyntax, layerDigest)), (built) =>
		Effect.succeed({
			syntax: Context.get(built, ModuleSyntax),
			digest: Context.get(built, Digest.Digest)
		})
	)
}

/** A directory of the case's own, removed when the case ends. */
export const scratch: Need<string> = {
	key: "@bjornpagen/testing/runner/closure.fixtures/scratch",
	budget: plantedBudget,
	runNeeds: [],
	open: Effect.map(FileSystem.FileSystem, (fs) =>
		Effect.flatMap(
			Effect.mapError(fs.makeTempDirectoryScoped({ prefix: "toolchain-closure-" }), (failure) =>
				NeedFailed.make({ need: "scratch", message: failure.message })
			),
			(directory) =>
				Effect.mapError(fs.realPath(directory), (failure) =>
					NeedFailed.make({ need: "scratch", message: failure.message })
				)
		)
	)
}

/** What Node loaded when it ran an entry module: each resolution's importer and the URL it resolved to. */
const Loaded = Schema.fromJsonString(Schema.Array(Schema.Tuple([Schema.String, Schema.String])))

const decodeLoaded = Schema.decodeUnknownEffect(Loaded)

/** The module hook that records every resolution Node makes, printed when the process exits. */
const HOOK = `import { registerHooks } from "node:module"
const seen = []
registerHooks({
	resolve(specifier, context, nextResolve) {
		const resolved = nextResolve(specifier, context)
		seen.push([context.parentURL ?? "", resolved.url])
		return resolved
	}
})
process.on("exit", () => {
	process.stdout.write(JSON.stringify(seen))
})
`

/** Writes each file under `directory`, making the directories it lies in. */
export const writtenTo = Effect.fn("writtenTo")(function* (
	directory: string,
	files: ReadonlyArray<readonly [path: string, text: string]>
) {
	const fs = yield* FileSystem.FileSystem
	for (const [path, text] of files) {
		const file = `${directory}/${path}`
		yield* fs.makeDirectory(Arr.join(Arr.initNonEmpty(Str.split("/")(file)), "/"), {
			recursive: true
		})
		yield* fs.writeFileString(file, text)
	}
})

/** Module `index`'s file URL in a workspace written under `directory`. */
export const moduleUrlOf = (directory: string, workspace: Workspace, index: number): string =>
	pathToFileURL(`${directory}/${modulePathOf(workspace, index)}`).href

/** What a workspace exercises of the module closures a need reads. */
export type ModuleSituation = "a module of the library package" | "a module in an import cycle"

/** The situations a workspace's modules reach, by the model. */
export const moduleSituationsOf = (workspace: Workspace): ReadonlyArray<ModuleSituation> => [
	...(Arr.some(workspace.modules, (module) => module.library)
		? ["a module of the library package" as const]
		: []),
	...(Arr.some(workspace.modules, (module, index) =>
		Arr.some(module.imports, (imported) => {
			const target = targetOf(workspace, module, imported)
			return (
				isRuntime(imported) &&
				target.kind === "module" &&
				reachOf(workspace, target.module, isRuntime).modules.has(index)
			)
		})
	)
		? ["a module in an import cycle" as const]
		: [])
]

/** What Node loaded from the repository's own files when it ran one entry: files, external packages, built-ins. */
export type Loads = Readonly<{
	files: ReadonlyArray<string>
	packages: ReadonlyArray<string>
	builtins: ReadonlyArray<string>
}>

/**
 * Writes a workspace into `directory` as pnpm would install it (each external package under node_modules, the
 * library linked there), runs Node on module 0 with the workspace's conditions, and reads back what it loaded.
 */
export const nodeLoads = Effect.fn("nodeLoads")(function* (
	directory: string,
	workspace: Workspace,
	files: ReadonlyArray<readonly [path: string, text: string]>
) {
	const fs = yield* FileSystem.FileSystem
	const written: ReadonlyArray<readonly [string, string]> = [
		...files,
		["hook.mjs", HOOK],
		[
			"node_modules/ext-a/package.json",
			jsonOf([
				["name", "ext-a"],
				["version", "1.0.0"],
				["type", "module"],
				["exports", "./index.js"]
			])
		],
		[
			"node_modules/ext-a/index.js",
			`${workspace.chain ? `import "ext-b"\n` : ""}export const e = "a"\n`
		],
		[
			"node_modules/ext-b/package.json",
			jsonOf([
				["name", "ext-b"],
				["version", "2.0.0"],
				["type", "module"],
				["exports", "./index.js"]
			])
		],
		["node_modules/ext-b/index.js", `export const e = "b"\n`]
	]
	yield* writtenTo(directory, written)
	yield* fs.makeDirectory(`${directory}/node_modules/@ws`, { recursive: true })
	yield* fs.symlink("../../packages/lib", `${directory}/node_modules/@ws/lib`)
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const [stdout, stderr, exitCode] = yield* Effect.scoped(
		Effect.flatMap(
			spawner.spawn(
				ChildProcess.make(
					process.execPath,
					[
						"--import",
						"./hook.mjs",
						...(workspace.configured ? ["--conditions=custom"] : []),
						`./${modulePathOf(workspace, 0)}`
					],
					{ cwd: directory, stdin: "ignore" }
				)
			),
			(handle) =>
				Effect.all(
					[
						Stream.mkString(Stream.decodeText(handle.stdout)),
						Stream.mkString(Stream.decodeText(handle.stderr)),
						handle.exitCode
					],
					{ concurrency: "unbounded" }
				)
		)
	)
	if (exitCode !== 0) {
		return yield* Effect.die(`node exited ${exitCode} on the generated workspace: ${stderr}`)
	}
	const loaded = yield* decodeLoaded(stdout)
	const own = new Set<string>()
	const packages = new Set<string>()
	const builtins = new Set<string>()
	for (const [parent, url] of loaded) {
		const fromRepository = !Str.includes("/node_modules/")(parent)
		if (Str.startsWith("node:")(url)) {
			if (fromRepository) {
				builtins.add(url)
			}
			continue
		}
		const path = Str.slice(directory.length + 1)(fileURLToPath(url))
		if (Str.startsWith("node_modules/")(path)) {
			if (fromRepository) {
				packages.add(Arr.getUnsafe(Str.split("/")(path), 1))
			}
			continue
		}
		own.add(path)
	}
	return {
		files: Arr.sort(own, Str.Order),
		packages: Arr.sort(packages, Str.Order),
		builtins: Arr.sort(builtins, Str.Order)
	}
})

/** The working tree of a written workspace, read through the platform's file system. */
export const writtenTree = (directory: string) => workingTree(directory)

/**
 * Whether a conditional decides what module 0 loads: read with its condition's activity flipped, every conditional of
 * that kind and condition decides the other way, and module 0 reaches other files.
 */
const isDecisive = (
	workspace: Workspace,
	route: Route & Readonly<{ kind: "pick" | "choose" }>,
	runtime: Reach
): boolean => {
	const flipped: Condition = isActive(route.condition, workspace.configured) ? "require" : "import"
	const other: Workspace = {
		...workspace,
		modules: Arr.map(workspace.modules, (module) => ({
			...module,
			imports: Arr.map(module.imports, (imported): Import =>
				imported.kind === "code" &&
				imported.route.kind === route.kind &&
				imported.route.condition === route.condition
					? { ...imported, route: { ...imported.route, condition: flipped } }
					: imported
			)
		}))
	}
	const otherReach = reachOf(other, 0, isRuntime)
	return (
		otherReach.modules.size !== runtime.modules.size ||
		Arr.some(Arr.fromIterable(otherReach.modules), (module) => !runtime.modules.has(module))
	)
}

/**
 * A workspace whose module 0 (in the root package) loads module 1 through a conditional import under `condition`,
 * module 1 when the condition is active and itself otherwise, and loads nothing else: what it loads is decided by the
 * condition alone. Module 1's imports are drawn.
 */
const conditionalWorkspaces =
	(condition: Condition, configured: boolean): Gen<Workspace> =>
	(source) => ({
		modules: [
			{
				library: false,
				imports: [
					{
						kind: "code",
						route: { kind: "choose", condition, active: 1, otherwise: 0 },
						form: source.draw(element(RUNTIME_FORMS))
					}
				]
			},
			{
				library: false,
				imports: source.draw(array(importsFor([false, false], 1), { min: 0, max: 4 }))
			}
		],
		configured,
		chain: source.draw(boolean)
	})

/** Generated workspaces, aimed at the conditionals the floor rarely makes decisive. */
export const aimedWorkspaces = aimed<Workspace, LoadSituation>(workspaces, [
	["a conditional Node's own condition chooses", conditionalWorkspaces("import", false)],
	["a conditional the config's condition chooses", conditionalWorkspaces("custom", true)],
	["a conditional that falls to its default", conditionalWorkspaces("require", true)]
])

/** What a workspace exercises of what Node loads from its module 0, by the model. */
export type LoadSituation =
	| "a type-only import Node never loads"
	| "an inline type import that loads its module"
	| "an import cycle"
	| "the library's export pattern by self-reference"
	| "an imports map naming a bare package"
	| "a conditional the config's condition chooses"
	| "a conditional Node's own condition chooses"
	| "a conditional that falls to its default"
	| "an external's own dependency Node loads beside it"
	| "a built-in named bare"
	| "a JSON module"
	| "a dynamic import"

/** The situations of what module 0 loads, read off the model. */
export const loadSituationsOf = (workspace: Workspace): ReadonlyArray<LoadSituation> => {
	const runtime = reachOf(workspace, 0, isRuntime)
	const every = reachOf(workspace, 0, () => true)
	const situations = new Set<LoadSituation>()
	if (Arr.some(Arr.fromIterable(every.modules), (module) => !runtime.modules.has(module))) {
		situations.add("a type-only import Node never loads")
	}
	if (workspace.chain && runtime.externals.has("ext-a")) {
		situations.add("an external's own dependency Node loads beside it")
	}
	if (runtime.builtins.has("fs")) {
		situations.add("a built-in named bare")
	}
	if (runtime.data.size > 0) {
		situations.add("a JSON module")
	}
	for (const reached of runtime.modules) {
		const module = Arr.getUnsafe(workspace.modules, reached)
		for (const imported of module.imports) {
			if (imported.kind !== "code" || !isRuntime(imported)) {
				continue
			}
			const route = imported.route
			if (imported.form === "inline-type") {
				situations.add("an inline type import that loads its module")
			}
			if (imported.form === "dynamic") {
				situations.add("a dynamic import")
			}
			if (route.kind === "export" && module.library) {
				situations.add("the library's export pattern by self-reference")
			}
			if (route.kind === "alias") {
				situations.add("an imports map naming a bare package")
			}
			if (
				(route.kind === "pick" || route.kind === "choose") &&
				isDecisive(workspace, route, runtime)
			) {
				situations.add(
					route.condition === "import"
						? "a conditional Node's own condition chooses"
						: isActive(route.condition, workspace.configured)
							? "a conditional the config's condition chooses"
							: "a conditional that falls to its default"
				)
			}
			const target = targetOf(workspace, module, imported)
			if (
				target.kind === "module" &&
				reachOf(workspace, target.module, isRuntime).modules.has(reached)
			) {
				situations.add("an import cycle")
			}
		}
	}
	return Arr.fromIterable(situations)
}

/** What a touch does to one root's closure, by the model. */
export type HashSituation =
	| "nothing touched"
	| "a module's own edit"
	| "an edit reached through another module"
	| "an edit behind a type-only import"
	| "an edit inside an import cycle"
	| "a data file edit it reaches"
	| "a lockfile entry it loads"
	| "a lockfile entry behind an external's dependency"
	| "an edit it does not reach"

/** Whether a touch is inside the closure of module `index`, and the situation it is, by the model. */
export const touchOf = (
	workspace: Workspace,
	touch: Touch,
	index: number
): Readonly<{ reaches: boolean; situation: HashSituation }> => {
	const runtime = reachOf(workspace, index, isRuntime)
	switch (touch.kind) {
		case "nothing":
			return { reaches: false, situation: "nothing touched" }
		case "module": {
			if (touch.module === index) {
				return { reaches: true, situation: "a module's own edit" }
			}
			if (runtime.modules.has(touch.module)) {
				return {
					reaches: true,
					situation: reachOf(workspace, touch.module, isRuntime).modules.has(index)
						? "an edit inside an import cycle"
						: "an edit reached through another module"
				}
			}
			return {
				reaches: false,
				situation: reachOf(workspace, index, () => true).modules.has(touch.module)
					? "an edit behind a type-only import"
					: "an edit it does not reach"
			}
		}
		case "data":
			return runtime.data.has(touch.library)
				? { reaches: true, situation: "a data file edit it reaches" }
				: { reaches: false, situation: "an edit it does not reach" }
		case "lock":
			if (runtime.externals.has(touch.external)) {
				return { reaches: true, situation: "a lockfile entry it loads" }
			}
			return lockedOf(workspace, runtime).has(touch.external)
				? { reaches: true, situation: "a lockfile entry behind an external's dependency" }
				: { reaches: false, situation: "an edit it does not reach" }
	}
}

/** What a closure says module 0 loads, in the terms Node's loads are read in: package names, not lockfile keys. */
export const loadsOf = (closure: Closure): Loads => ({
	files: closure.files,
	packages: Arr.map(closure.packages, (key) => Arr.headNonEmpty(Str.split("@")(key))),
	builtins: closure.builtins
})
