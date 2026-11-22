/**
 * A cluster's families at checkouts (pg/family.ts), in homes of the case's own (a scratch directory: never the
 * account's families' state, data or port claims, which a mutant of collection would otherwise remove), with no server
 * started:
 * checkouts apart are families apart, which claim ports apart even when they claim at once, each family's own ports
 * read back as it claimed them and claimed again as they are; and the collection of families removes every family
 * whose checkout is gone, its folder deleted or a workspace forgotten whose folder lingers (a `.git` file naming a git
 * directory that is gone), its data, port claims and state with it, and keeps every family of a checkout that is one
 * (a clone's `.git` directory, a worktree's `.git` file naming its git directory, a folder under no `.git`) and every
 * family that records no checkout whole, every state of another cluster's family whole whatever it records, and every
 * family in homes it was not given whole (a second scratch home standing in for the account's). Each
 * case's families are of a case cluster's unit. Oracle: the specification, stated in the checks.
 */
import { Array as Arr, Effect, Order } from "effect"
import { assert } from "#assert.ts"
import { element, finite, int } from "#gen.ts"
import {
	type CheckoutKind,
	familyOfKind,
	kinds,
	leftOf,
	scratchCheckout,
	scratchHomes,
	step
} from "#pg/family.fixtures.ts"
import {
	checkoutRecorded,
	familiesCollected,
	familyOf,
	portsClaimed,
	portsHeld
} from "#pg/family.ts"
import { clusterOf, removedAtEnd } from "#pg/settle.fixtures.ts"
import { property } from "#property.ts"

/** How many families claim at once, and how many members' ports each claims. */
type Claiming = Readonly<{ families: number; members: number }>

export const familiesClaimApart = property.explore(
	(source): Claiming => ({
		families: source.draw(int(1, 4)),
		members: source.draw(int(1, 3))
	}),
	{
		needs: {},
		situations: ["several families claiming at once", "a family of several members"],
		check:
			(_resources, c) =>
			({ families, members }) =>
				Effect.scoped(
					Effect.gen(function* () {
						if (families > 1) {
							c.note("several families claiming at once")
						}
						if (members > 1) {
							c.note("a family of several members")
						}
						const cluster = yield* clusterOf({ tls: true, spread: false, room: true })
						yield* removedAtEnd(cluster)
						const from = cluster.network.kind === "tls" ? cluster.network.from : 0
						const homes = yield* scratchHomes
						const checkouts = yield* Effect.forEach(
							Array.from({ length: families }),
							() => scratchCheckout
						)
						const drawn = Arr.map(checkouts, (checkout) => familyOf(cluster, checkout, homes))
						const again = Arr.map(checkouts, (checkout) => familyOf(cluster, checkout, homes))
						yield* Effect.forEach(drawn, (family) => checkoutRecorded(family, step(family)), {
							discard: true
						})
						const claimed = yield* Effect.forEach(
							drawn,
							(family) => portsClaimed(family, members, from, step(family)),
							{ concurrency: "unbounded" }
						)
						const held = yield* Effect.forEach(drawn, portsHeld)
						const reclaimed = yield* Effect.forEach(drawn, (family) =>
							portsClaimed(family, members, from, step(family))
						)
						const all = Arr.flatten(claimed)
						assert.deepEqual(
							{
								names: new Set(Arr.map(drawn, (family) => family.name)).size,
								sameCheckoutSameName: Arr.map(again, (family) => family.name),
								distinctPorts: new Set(all).size,
								fromTheFirst: Arr.every(all, (port) => port >= from),
								held,
								reclaimed
							},
							{
								names: families,
								sameCheckoutSameName: Arr.map(drawn, (family) => family.name),
								distinctPorts: families * members,
								fromTheFirst: true,
								held: Arr.map(claimed, (ports) => Arr.sort(ports, Order.Number)),
								reclaimed: Arr.map(claimed, (ports) => Arr.sort(ports, Order.Number))
							}
						)
					})
				),
		oracle: {
			kind: "specification",
			name: "two checkouts of one cluster are two families, one checkout one; families claiming at once hold distinct ports, each from the spec's first; a family reads back the ports it claimed and claims the same again"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/pg/family.ts",
				original: `\t\t\t\tfs.writeFileString(\`\${directory}/\${port}\`, \`\${name}\\n\`, { flag: "wx" })\n`,
				replacement: `\t\t\t\tfs.writeFileString(\`\${directory}/\${port}\`, \`\${name}\\n\`, { flag: "w" })\n`,
				why: "A claim overwrites one another family made between its look and its write, so two families claiming at once take one port, and the second member's server cannot bind it; the property fails."
			},
			{
				file: "packages/testing/src/pg/family.ts",
				original:
					"\t\t\t\t(text) => (Str.trim(text) === name ? Option.some(Number(file)) : Option.none<number>())\n",
				replacement: "\t\t\t\t(text) => Option.some(Number(file))\n",
				why: "A family reads every family's claims as its own, so its members take another family's ports and two families' members bind one; the property fails."
			},
			{
				file: "packages/testing/src/pg/family.ts",
				original: `\t\tname: UnitName(\`\${cluster.unit}-\${Str.slice(0, keyDigits)(digest)}\`),\n`,
				replacement: `\t\tname: UnitName(\`\${cluster.unit}-\${Str.slice(0, 0)(digest)}\`),\n`,
				why: "A family is named by its cluster alone, so every checkout reaches one family, trunk's and every lane's runs on one cluster's SSI LWLocks (2026-11-22: 54 to 75% of its busy backends waiting on them); the property fails."
			}
		]
	}
)

export const goneFamiliesCollected = property.exhaust(
	finite((source): CheckoutKind => source.draw(element(kinds))),
	{
		box: "a family of each kind of checkout: deleted, forgotten, a worktree, a clone, a plain folder, unrecorded",
		needs: {},
		situations: [],
		check: () => (kind) =>
			Effect.scoped(
				Effect.gen(function* () {
					const cluster = yield* clusterOf({ tls: true, spread: false, room: true })
					yield* removedAtEnd(cluster)
					const from = cluster.network.kind === "tls" ? cluster.network.from : 0
					const homes = yield* scratchHomes
					const live = yield* familyOfKind(cluster, homes, "worktree", from)
					const family = yield* familyOfKind(cluster, homes, kind, from)
					const other = yield* clusterOf({ tls: true, spread: false, room: true })
					yield* removedAtEnd(other)
					const another = yield* familyOfKind(other, homes, "deleted", from)
					const account = yield* scratchHomes
					const elsewhere = yield* familyOfKind(cluster, account, "deleted", from)
					const collected = yield* familiesCollected(homes, cluster.unit)
					const left = yield* leftOf(family)
					const liveLeft = yield* leftOf(live)
					const anotherLeft = yield* leftOf(another)
					const elsewhereLeft = yield* leftOf(elsewhere)
					const gone = kind === "deleted" || kind === "forgotten"
					assert.deepEqual(
						{
							collected: Arr.contains(collected, family.name),
							left,
							liveCollected: Arr.contains(collected, live.name),
							liveLeft,
							anotherLeft,
							elsewhereLeft
						},
						{
							collected: gone,
							left: gone
								? { state: false, data: false, claims: 0 }
								: { state: true, data: true, claims: 1 },
							liveCollected: false,
							liveLeft: { state: true, data: true, claims: 1 },
							anotherLeft: { state: true, data: true, claims: 1 },
							elsewhereLeft: { state: true, data: true, claims: 1 }
						}
					)
				})
			),
		oracle: {
			kind: "specification",
			name: "a family whose checkout's folder is deleted, or whose .git file names a git directory that is gone, is removed whole, state, data and claims; a family of a clone, a live worktree, a plain folder or of no recorded checkout is kept whole, and so is another live family's every claim, and another cluster's family whatever its checkout, and a family of its own cluster whose checkout is gone in homes it was not given (the account's, in production) whole"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/pg/family.ts",
				original:
					"\t\t\t\treturn Str.isNonEmpty(named) && (yield* exists(paths.resolve(at, named)))\n",
				replacement: "\t\t\t\treturn true\n",
				why: "A checkout with a .git file is live whatever its git directory, so a forgotten workspace whose folder lingers keeps its family's members running, their shared memory held, until a person deletes the folder; the property fails."
			},
			{
				file: "packages/testing/src/pg/family.ts",
				original:
					"\t\tyield* Effect.forEach(gone, (name) => familyRemoved(homes, name), { discard: true })\n",
				replacement: "",
				why: "Collection removes nothing, so every lane's family outlives its workspace with its members running; the property fails."
			},
			{
				file: "packages/testing/src/pg/family.ts",
				original: "\t\t\t\t\tonNone: () => Effect.succeed(false),\n",
				replacement: "\t\t\t\t\tonNone: () => Effect.succeed(true),\n",
				why: "A family that records no checkout, a cluster of before families still in use, is removed by any settle; the property fails."
			},
			{
				file: "packages/testing/src/pg/family.ts",
				original: "\t\tconst ports = yield* claimsOf(homes, name)\n",
				replacement: "\t\tconst ports: ReadonlyArray<number> = []\n",
				why: "A removed family's port claims are left, so its ports stay claimed by no family forever; the property fails."
			},
			{
				file: "packages/testing/src/pg/family.ts",
				original: `\t\t\t(name) => Str.startsWith(\`\${unit}-\`)(name) && familyKey.test(Str.slice(unit.length + 1)(name))\n`,
				replacement: "\t\t\t(name) => name !== claimsDirectory\n",
				why: "A settle collects every cluster's families, so one repository's settle stops and removes another's (PGFAMILY's own kill trial, 2026-11-22, run against the account's homes, removed den's, five lanes' and trunk's clusters); the property fails."
			}
		]
	}
)
