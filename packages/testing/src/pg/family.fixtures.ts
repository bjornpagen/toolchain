import { Effect, FileSystem } from "effect"
import {
	type CheckoutFamily,
	checkoutAt,
	checkoutRecorded,
	familyOf,
	type Homes,
	portsClaimed,
	portsHeld,
	stateOf
} from "#pg/family.ts"

/**
 * What the family properties (family.test.ts) draw and make: homes and checkouts of a case's own, in scratch
 * directories for the case's scope, never the account's; a family of each kind of checkout, made as settle leaves one
 * with no server; and what is left of a family after a collection.
 */

/** A step's name for the properties' own reads. */
export const step = (family: CheckoutFamily) => ({ cluster: family.name, doing: "the property" })

/** A scratch directory for the enclosing scope, at its real path. */
const scratch = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const made = yield* Effect.orDie(fs.makeTempDirectoryScoped({ prefix: "toolchain-family-" }))
	return yield* Effect.orDie(fs.realPath(made))
})

/** A checkout of the case's own, a scratch directory, at its real path. */
export const scratchCheckout = Effect.map(scratch, checkoutAt)

/** Homes of the case's own: a states, a data and a memory directory in a scratch directory. */
export const scratchHomes = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const root = yield* scratch
	const homes: Homes = { states: `${root}/state`, data: `${root}/data`, memory: `${root}/memory` }
	yield* Effect.forEach([homes.states, homes.data, homes.memory], (home) =>
		Effect.orDie(fs.makeDirectory(home))
	)
	return homes
})

/**
 * What a family's checkout is: `deleted`, its folder gone; `forgotten`, a folder whose `.git` file names a git
 * directory that is gone (`jj workspace forget`, `git worktree prune`); `worktree`, a `.git` file naming a git directory
 * there; `package`, a package of a pnpm workspace, inside its checkout (a family made at a package root before checkouts
 * were workspaces); `clone`, a `.git` directory; `plain`, a folder under no `.git`; and `unrecorded`, a family whose
 * state records no checkout (a cluster of before families).
 */
export type CheckoutKind =
	| "deleted"
	| "forgotten"
	| "package"
	| "worktree"
	| "clone"
	| "plain"
	| "unrecorded"

export const kinds: ReadonlyArray<CheckoutKind> & Readonly<{ 0: CheckoutKind }> = [
	"deleted",
	"forgotten",
	"package",
	"worktree",
	"clone",
	"plain",
	"unrecorded"
]

/**
 * A family of `cluster` at a checkout of `kind` in `homes`, made as settle leaves one, with no server: its state's
 * checkout record (but an unrecorded one's), a member's data in memory and its data directory a link to it, as the
 * workbench makes a member its memory list names, and a port claim from `from`.
 */
export const familyOfKind = (
	cluster: Parameters<typeof familyOf>[0],
	homes: Homes,
	kind: CheckoutKind,
	from: number
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const folder = yield* scratchCheckout
		if (kind === "package") {
			yield* Effect.orDie(fs.makeDirectory(`${folder}/packages/p`, { recursive: true }))
			yield* Effect.orDie(
				fs.writeFileString(`${folder}/pnpm-workspace.yaml`, "packages:\n  - packages/*\n")
			)
		}
		const checkout = kind === "package" ? checkoutAt(`${folder}/packages/p`) : folder
		const family = familyOf(cluster, checkout, homes)
		yield* Effect.orDie(fs.makeDirectory(stateOf(family), { recursive: true }))
		if (kind !== "unrecorded") {
			yield* checkoutRecorded(family, step(family))
		}
		yield* Effect.orDie(fs.makeDirectory(`${homes.memory}/${family.name}-0`))
		yield* Effect.orDie(
			fs.symlink(`${homes.memory}/${family.name}-0`, `${homes.data}/${family.name}-0`)
		)
		yield* portsClaimed(family, 1, from, step(family))
		const gitdir = `${checkout}.gitdir`
		switch (kind) {
			case "deleted":
				yield* Effect.orDie(fs.remove(checkout, { recursive: true }))
				break
			case "forgotten":
				yield* Effect.orDie(fs.writeFileString(`${checkout}/.git`, `gitdir: ${gitdir}\n`))
				break
			case "worktree":
				yield* Effect.orDie(fs.makeDirectory(gitdir))
				yield* Effect.addFinalizer(() => Effect.ignore(fs.remove(gitdir, { recursive: true })))
				yield* Effect.orDie(fs.writeFileString(`${checkout}/.git`, `gitdir: ${gitdir}\n`))
				break
			case "clone":
				yield* Effect.orDie(fs.makeDirectory(`${checkout}/.git`))
				break
			case "package":
			case "plain":
			case "unrecorded":
				break
		}
		return family
	})

/**
 * What is left of `family`: its state, its member's data directory (the link itself, whatever it points at), its
 * member's data in memory, and its claims.
 */
export const leftOf = (family: CheckoutFamily) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const exists = (path: string) => Effect.orElseSucceed(fs.exists(path), () => false)
		const state = yield* exists(stateOf(family))
		const data = yield* Effect.isSuccess(fs.readLink(`${family.homes.data}/${family.name}-0`))
		const memory = yield* exists(`${family.homes.memory}/${family.name}-0`)
		const claims = yield* portsHeld(family)
		return { state, data, memory, claims: claims.length }
	})

/**
 * The layout of checkouts the checkout property (family.test.ts checkoutsAreWorkspaces) resolves, in a scratch
 * directory for the enclosing scope, at its real path: two pnpm workspaces of packages (one nested a level deeper), a
 * repository with no workspace file, and a plain folder.
 */
export const checkoutLayout = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const root = yield* scratch
	const directories = [
		"ws1/packages/a/deep",
		"ws1/packages/b",
		"ws2/packages/a",
		"repo/.git",
		"repo/packages/x",
		"plain/pkg"
	]
	yield* Effect.forEach(
		directories,
		(directory) => Effect.orDie(fs.makeDirectory(`${root}/${directory}`, { recursive: true })),
		{ discard: true }
	)
	yield* Effect.forEach(
		["ws1", "ws2"],
		(workspace) =>
			Effect.orDie(
				fs.writeFileString(
					`${root}/${workspace}/pnpm-workspace.yaml`,
					"packages:\n  - packages/*\n"
				)
			),
		{ discard: true }
	)
	return root
})

/** Each place the checkout property resolves from, and the checkout it is in, both relative to the layout's root. */
export const checkoutPlaces = [
	["ws1/packages/a", "ws1"],
	["ws1/packages/a/deep", "ws1"],
	["ws1/packages/b", "ws1"],
	["ws1", "ws1"],
	["ws2/packages/a", "ws2"],
	["repo/packages/x", "repo"],
	["plain/pkg", "plain/pkg"]
] as const
