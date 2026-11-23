import { Effect } from "effect"
/**
 * `toolchain-test verified <ref>` (runner/affected.ts) refuses exactly the properties a landing touched that carry no
 * green verdict at the closure it lands: a landing touches a property when it changes a file of the property's closure
 * (or the submodule whose gitlink holds the file) or the lockfile where its closure holds a package; a touched property
 * whose verdict key holds a pass carries its verdict, and an untouched one is never weighed. A verdict is its search's:
 * a file only a kill of the property edits is no part of it. Oracle: the specification, stated in touched.fixtures.ts refusedOf.
 */
import { assert } from "#assert.ts"
import { property } from "#property.ts"
import { unverifiedOf } from "#runner/affected.ts"
import { landingGen, landingSituationsOf, refusedOf } from "#runner/touched.fixtures.ts"

export const landingsCarryTheirVerdicts = property.explore(landingGen, {
	needs: {},
	situations: [
		"a touched property refused",
		"a touched property carrying its verdict",
		"touched through the lockfile alone",
		"touched below a gitlink",
		"an untouched property"
	],
	check: (_resources, c) => (landing) =>
		Effect.sync(() => {
			c.noteAll(landingSituationsOf(landing))
			assert.deepEqual(
				[...unverifiedOf(new Set(landing.changed), landing.properties)],
				[...refusedOf(landing)]
			)
		}),
	oracle: {
		kind: "specification",
		name: "a property is refused exactly when the landing changed a file of its closure or the lockfile its closure reads, and its key holds no pass"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/affected.ts",
			original: '\t(one.packages && changed.has("pnpm-lock.yaml"))\n',
			replacement: "\tfalse\n",
			why: "A lockfile change is taken as touching nothing, so a package a property loads moves with no verdict at its new version."
		},
		{
			file: "packages/testing/src/runner/affected.ts",
			original: "(touchedBy(changed, one) && !one.passed ? [one.id] : [])",
			replacement: "(touchedBy(changed, one) ? [one.id] : [])",
			why: "A touched property is refused though its key holds a pass, so no landing that touches a property can ever land."
		},
		{
			file: "packages/testing/src/runner/affected.ts",
			original: "return { prefix, found: state.found || changed.has(prefix) }",
			replacement: "return { prefix, found: changed.has(file) }",
			why: "A file inside a submodule is taken as unchanged when its gitlink moves, so a toolchain bump lands with every property it touches unverified."
		}
	]
})
