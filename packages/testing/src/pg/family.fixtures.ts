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

/** Homes of the case's own: a states and a data directory in a scratch directory. */
export const scratchHomes = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem
	const root = yield* scratch
	const homes: Homes = { states: `${root}/state`, data: `${root}/data` }
	yield* Effect.orDie(fs.makeDirectory(homes.states))
	yield* Effect.orDie(fs.makeDirectory(homes.data))
	return homes
})

/**
 * What a family's checkout is: `deleted`, its folder gone; `forgotten`, a folder whose `.git` file names a git
 * directory that is gone (`jj workspace forget`, `git worktree prune`); `worktree`, a `.git` file naming a git directory
 * there; `clone`, a `.git` directory; `plain`, a folder under no `.git`; and `unrecorded`, a family whose state records
 * no checkout (a cluster of before families).
 */
export type CheckoutKind = "deleted" | "forgotten" | "worktree" | "clone" | "plain" | "unrecorded"

export const kinds: ReadonlyArray<CheckoutKind> & Readonly<{ 0: CheckoutKind }> = [
	"deleted",
	"forgotten",
	"worktree",
	"clone",
	"plain",
	"unrecorded"
]

/**
 * A family of `cluster` at a checkout of `kind` in `homes`, made as settle leaves one, with no server: its state's
 * checkout record (but an unrecorded one's), a member's data directory, and a port claim from `from`.
 */
export const familyOfKind = (
	cluster: Parameters<typeof familyOf>[0],
	homes: Homes,
	kind: CheckoutKind,
	from: number
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const checkout = yield* scratchCheckout
		const family = familyOf(cluster, checkout, homes)
		yield* Effect.orDie(fs.makeDirectory(stateOf(family), { recursive: true }))
		if (kind !== "unrecorded") {
			yield* checkoutRecorded(family, step(family))
		}
		yield* Effect.orDie(fs.makeDirectory(`${homes.data}/${family.name}-0`, { recursive: true }))
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
			case "plain":
			case "unrecorded":
				break
		}
		return family
	})

/** What is left of `family`: its state, its member's data directory, and its claims. */
export const leftOf = (family: CheckoutFamily) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const exists = (path: string) => Effect.orElseSucceed(fs.exists(path), () => false)
		const state = yield* exists(stateOf(family))
		const member = yield* exists(`${family.homes.data}/${family.name}-0`)
		const claims = yield* portsHeld(family)
		return { state, data: member, claims: claims.length }
	})
