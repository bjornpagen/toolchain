import { boolean, element, finite, subset } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, FileSystem, Order, String as Str } from "effect"
import { ownPackagesUnder, submoduleInputsUnder } from "#shared/git.ts"

/**
 * The repositories the submodule-inputs property draws (git.test.ts): a root holding up to two submodules, which
 * .gitmodules names, each with the files a submodule's checkout holds or lacks, files of the root's own beside them,
 * and the repository-relative paths a style option names among all of these: a submodule's file that is there, one
 * that is not, a submodule's directory, and a file of the root's own. And the inputs the contract reads off one.
 */

/** A path a repository may hold, by whose it is: a submodule's (in one of SUBMODULES) or the root's own. */
type Place = Readonly<{ path: string; owner: "submodule" | "root" }>

/** The submodules a root may hold, by their paths. */
const SUBMODULES = ["packages/qti-pie", "vendor/toolchain"] as const

/** The paths a repository's files and a style option's names are drawn from. */
const PLACES: ReadonlyArray<Place> = [
	{ path: "packages/qti-pie/packages/plate/src/vocabulary.ts", owner: "submodule" },
	{ path: "packages/qti-pie/README.md", owner: "submodule" },
	{ path: "vendor/toolchain/packages/devtools/src/style/engine.ts", owner: "submodule" },
	{ path: "packages/qti-pie-notes/vocabulary.ts", owner: "root" },
	{ path: "packages/qti-app/src/web.ts", owner: "root" },
	{ path: "vendor/toolchain.md", owner: "root" }
]

/** A repository: the submodules .gitmodules names, the places it holds a file at, and the paths its options name. */
export type Repository = Readonly<{
	submodules: ReadonlyArray<string>
	held: ReadonlyArray<string>
	named: ReadonlyArray<string>
}>

export const repositories = finite((source): Repository => ({
	submodules: source.draw(subset(SUBMODULES, { min: 0, max: 2 })),
	held: source.draw(
		subset(
			Arr.map(PLACES, (place) => place.path),
			{ min: 0, max: PLACES.length }
		)
	),
	named: [
		...source.draw(
			subset(
				Arr.map(PLACES, (place) => place.path),
				{ min: 0, max: PLACES.length }
			)
		),
		...(source.draw(boolean)
			? [source.draw(element(["packages/qti-pie/", "vendor/toolchain/packages/"]))]
			: [])
	]
}))

/** What a repository's named paths are, as the property names its situations. */
export type Feature =
	| "a submodule's file named"
	| "a submodule's missing file named"
	| "a submodule's directory named"
	| "a root file named"
	| "a submodule's file not named"

/** Whether a path lies in one of the repository's submodules. */
const inSubmodules =
	(repository: Repository) =>
	(path: string): boolean =>
		Arr.some(
			repository.submodules,
			(submodule) => path === submodule || Str.startsWith(`${submodule}/`)(path)
		)

export const featuresOf = (repository: Repository): ReadonlyArray<Feature> => {
	const inside = inSubmodules(repository)
	return [
		...(Arr.some(
			repository.named,
			(path) => inside(path) && !Str.endsWith("/")(path) && Arr.contains(repository.held, path)
		)
			? ["a submodule's file named" as const]
			: []),
		...(Arr.some(
			repository.named,
			(path) => inside(path) && !Str.endsWith("/")(path) && !Arr.contains(repository.held, path)
		)
			? ["a submodule's missing file named" as const]
			: []),
		...(Arr.some(repository.named, (path) => Str.endsWith("/")(path) && inside(path))
			? ["a submodule's directory named" as const]
			: []),
		...(Arr.some(repository.named, (path) => !inside(path)) ? ["a root file named" as const] : []),
		...(Arr.some(repository.held, (path) => inside(path) && !Arr.contains(repository.named, path))
			? ["a submodule's file not named" as const]
			: [])
	]
}

/**
 * The inputs the contract reads off a repository at `root`: every named path that is a file (no trailing `/`), lies in a
 * submodule .gitmodules names, and is held, as an absolute path, once each, in path order.
 */
export const expectedOf = (root: string, repository: Repository): ReadonlyArray<string> =>
	Arr.sort(
		Arr.dedupe(
			Arr.map(
				Arr.filter(
					repository.named,
					(path) =>
						!Str.endsWith("/")(path) &&
						inSubmodules(repository)(path) &&
						Arr.contains(repository.held, path)
				),
				(path) => `${root}/${path}`
			)
		),
		Order.String
	)

/** The repository written under a fresh directory, and what submoduleInputsUnder reads off it there. */
export const inputsOf = (repository: Repository) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const root = yield* fs.makeTempDirectoryScoped({ prefix: "submodule-inputs-" })
		yield* fs.writeFileString(
			`${root}/.gitmodules`,
			Arr.join(
				Arr.map(
					repository.submodules,
					(path) =>
						`[submodule "${path}"]\n\tpath = ${path}\n\turl = https://example.invalid/${path}.git\n`
				),
				""
			)
		)
		yield* Effect.forEach(
			repository.held,
			(path) =>
				Effect.andThen(
					fs.makeDirectory(`${root}/${Arr.join(Arr.dropRight(Str.split("/")(path), 1), "/")}`, {
						recursive: true
					}),
					fs.writeFileString(`${root}/${path}`, `// ${path}\n`)
				),
			{ discard: true }
		)
		const inputs = yield* submoduleInputsUnder(root, repository.named)
		return { root, inputs }
	})

/** The submodules a workspace may hold, a vendored toolchain among them, as edullm and every consumer vendor. */
const WORKSPACE_SUBMODULES = ["vendor/toolchain", "packages/qti-pie"] as const

/**
 * The workspace packages a root may list, by where they lie: a submodule's (and a package of the repository that
 * submodule vendors in turn, under it), and the root's own, one of whose names a submodule's is a prefix of.
 */
const WORKSPACE_PACKAGES = [
	"vendor/toolchain/packages/testing",
	"packages/qti-pie",
	"packages/qti-pie/packages/plate",
	"packages/qti-pie/vendor/grizzle/packages/engine",
	"packages/qti-pie-notes",
	"packages/qti-app",
	"vendor/toolchain-notes"
] as const

/** A workspace: the submodules .gitmodules names and the packages pnpm-workspace.yaml selects. */
export type Workspace = Readonly<{
	submodules: ReadonlyArray<string>
	packages: ReadonlyArray<string>
}>

export const workspaces = finite((source): Workspace => ({
	submodules: source.draw(subset(WORKSPACE_SUBMODULES, { min: 0, max: 2 })),
	packages: source.draw(subset(WORKSPACE_PACKAGES, { min: 1, max: WORKSPACE_PACKAGES.length }))
}))

/** What a workspace's packages are, as the own-packages property names its situations. */
export type PackageFeature =
	| "a submodule's own package"
	| "a package under a submodule"
	| "a nested repository's package"
	| "an own package a submodule's name prefixes"
	| "a submodule not listed in .gitmodules"

export const packageFeaturesOf = (workspace: Workspace): ReadonlyArray<PackageFeature> => {
	const listed = (path: string) => Arr.contains(workspace.submodules, path)
	const holds = (path: string) => Arr.contains(workspace.packages, path)
	return [
		...(listed("packages/qti-pie") && holds("packages/qti-pie")
			? ["a submodule's own package" as const]
			: []),
		...((listed("packages/qti-pie") && holds("packages/qti-pie/packages/plate")) ||
		(listed("vendor/toolchain") && holds("vendor/toolchain/packages/testing"))
			? ["a package under a submodule" as const]
			: []),
		...(listed("packages/qti-pie") && holds("packages/qti-pie/vendor/grizzle/packages/engine")
			? ["a nested repository's package" as const]
			: []),
		...((listed("packages/qti-pie") && holds("packages/qti-pie-notes")) ||
		(listed("vendor/toolchain") && holds("vendor/toolchain-notes"))
			? ["an own package a submodule's name prefixes" as const]
			: []),
		...(Arr.some(
			WORKSPACE_SUBMODULES,
			(path) => !listed(path) && Arr.some(workspace.packages, Str.startsWith(path))
		)
			? ["a submodule not listed in .gitmodules" as const]
			: [])
	]
}

/** The packages the contract calls the root's own: every listed one not at or under a submodule .gitmodules names. */
export const ownExpectedOf = (root: string, workspace: Workspace): ReadonlyArray<string> =>
	Arr.map(
		Arr.filter(
			workspace.packages,
			(path) =>
				!Arr.some(
					workspace.submodules,
					(submodule) => path === submodule || Str.startsWith(`${submodule}/`)(path)
				)
		),
		(path) => `${root}/${path}`
	)

/** The workspace's .gitmodules written under a fresh directory, and the packages ownPackagesUnder keeps there. */
export const ownPackagesOf = (workspace: Workspace) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const root = yield* fs.makeTempDirectoryScoped({ prefix: "own-packages-" })
		yield* fs.writeFileString(
			`${root}/.gitmodules`,
			Arr.join(
				Arr.map(
					workspace.submodules,
					(path) =>
						`[submodule "${path}"]\n\tpath = ${path}\n\turl = https://example.invalid/${path}.git\n`
				),
				""
			)
		)
		const own = yield* ownPackagesUnder(
			root,
			Arr.map(workspace.packages, (path) => `${root}/${path}`)
		)
		return { root, own }
	})
