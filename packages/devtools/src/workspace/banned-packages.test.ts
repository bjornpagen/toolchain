/**
 * The workspace gate's banned-packages law (src/workspace/banned-packages.ts), searched over repositories drawn from a
 * grammar of its contract: the root's and two packages' manifests, each of the four edge fields present or not;
 * pnpm-workspace.yaml's catalog and a named catalog; the lockfile's importers, and a third party in its packages and
 * snapshots sections whose own peer and dependency is zod; and a package the repository bans of its own, or none. Each
 * edge is zod by version, by catalog or under an alias, the project's own banned package, or a harmless one, a name
 * that only begins like zod and an alias of another package among them. The law must report exactly the edges that
 * install a banned package, each where it is written, and never a third party's own edge to zod.
 *
 * Oracle: the specification, the law's JSDoc read over the names its module exports and the preset's BANNED_PACKAGES.
 */
import { assert } from "@bjornpagen/testing/assert"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	expectedOf,
	featuresOf,
	outcomeOf,
	repositories
} from "#workspace/banned-packages.fixtures.ts"

/** Give each repository exactly the findings its edges draw, each where the edge is written. */
export const bannedPackageFindingsOf = property.explore(repositories, {
	needs: {},
	situations: [
		"a manifest's dependency on zod",
		"a manifest's devDependency on zod",
		"a manifest's peerDependency on zod",
		"a manifest's optionalDependency on zod",
		"an alias that installs zod",
		"a catalog entry for zod",
		"a named catalog's entry for zod",
		"a lockfile importer's edge to zod",
		"a third party's own zod peer in the lockfile",
		"a project's own banned package",
		"a name that only begins like zod"
	],
	check: (_resources, c) => (repository) =>
		Effect.gen(function* () {
			c.noteAll(featuresOf(repository))
			const outcome = yield* outcomeOf(repository)
			assert.deepEqual(outcome, expectedOf(repository))
		}),
	oracle: {
		kind: "specification",
		name: "the law's stated contract over the names its module exports and the preset's banned packages"
	},
	kept: [],
	kills: [
		{
			file: "packages/devtools/src/workspace/banned-packages.ts",
			original: "\t\treturn [...Arr.flatten(manifests), ...catalogs, ...importers]",
			replacement: "\t\treturn []",
			why: "The law is gone: a zod devDependency, catalog entry or lockfile importer edge passes the gate, as alphatest-novus's zod 4.6.7 devDependency did; every repository with a banned edge fails."
		},
		{
			file: "packages/devtools/src/workspace/banned-packages.ts",
			original: 'const LOCKFILE_SECTIONS = ["importers"] as const',
			replacement: 'const LOCKFILE_SECTIONS = ["importers", "snapshots"] as const',
			why: "The law judges a third party's own edges too: zod as a transitive peer of the AI SDK in the lockfile's snapshots is refused, which would refuse edullm's lockfile; the repositories with a third party's zod peer fail."
		},
		{
			file: "packages/devtools/src/workspace/banned-packages.ts",
			original: "\t\t\t(entry) => entry.name === name || Option.contains(aliased, entry.name)",
			replacement: "\t\t\t(entry) => entry.name === name",
			why: 'An alias installs zod unseen (`"schema": "npm:zod@^3.25.0"`); the repositories with an alias of zod fail.'
		}
	]
})
