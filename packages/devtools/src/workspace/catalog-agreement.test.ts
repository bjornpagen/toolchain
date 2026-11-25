/**
 * The workspace gate's catalog agreement (src/workspace/catalog-agreement.ts), searched over repositories drawn from a
 * grammar of its contract (catalog-agreement.fixtures.ts): a root's pnpm workspace, or none, and one to three other
 * workspaces of its tree, one vendored inside another, each stating a roster of packages in a catalog, a named catalog,
 * both, under an override or an override deferring to the catalog, or not at all, with release-age exclusions by name,
 * by glob and by versions. The agreement must report exactly the disagreements of each workspace with the root's over
 * the entries they share, each where its file states it: a version the root does not state, an exclusion one of them
 * alone states, and a versioned exclusion that names a version the root does not install; and nothing where the root
 * holds no workspace or a workspace agrees.
 *
 * Oracle: the specification, the agreement's JSDoc read over the names its module exports.
 */
import { assert } from "@bjornpagen/testing/assert"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	expectedOutcomeOf,
	featuresOf,
	outcomeOf,
	repositories
} from "#workspace/catalog-agreement.fixtures.ts"

/** Give each repository exactly the disagreements its workspaces draw, each where its file states it. */
export const catalogAgreementOf = property.explore(repositories, {
	needs: {},
	situations: [
		"a workspace that agrees with the root's",
		"a version mismatch",
		"an entry one side alone states",
		"an override in a catalog's place",
		"an override deferring to the catalog",
		"a named catalog's entry",
		"an exclusion both state",
		"an exclusion the root alone states",
		"an exclusion the workspace alone states",
		"a versioned exclusion naming the root's version",
		"a versioned exclusion naming another version",
		"a glob exclusion",
		"a root with no workspace",
		"a workspace vendored inside another"
	],
	check: (_resources, c) => (repository) =>
		Effect.gen(function* () {
			c.noteAll(featuresOf(repository))
			const outcome = yield* outcomeOf(repository)
			assert.deepEqual(outcome, expectedOutcomeOf(repository))
		}),
	oracle: {
		kind: "specification",
		name: "the agreement's stated contract over the names its module exports"
	},
	kept: [],
	kills: [
		{
			file: "packages/devtools/src/workspace/catalog-agreement.ts",
			original:
				"\t\t\t\t...(Arr.makeEquivalence(Str.Equivalence)(stated.versions, rootVersions(entry))\n",
			replacement:
				"\t\t\t\t...(Arr.makeEquivalence(Str.Equivalence)(stated.versions, stated.versions)\n",
			why: "The version rule is gone: a vendored workspace that states oxfmt at 0.79.0 where the root states 0.78.0 passes, as edullm's vendored toolchain did; every repository with a version mismatch fails."
		},
		{
			file: "packages/devtools/src/workspace/catalog-agreement.ts",
			original: "\t\t\t\t...Arr.map(Arr.difference(ours, theirs), (exclusion) => ({\n",
			replacement: "\t\t\t\t...Arr.map(Arr.difference(ours, ours), (exclusion) => ({\n",
			why: "An exclusion the root alone states passes: the root exempts effect from the release-age wait and a vendored grizzle, sharing effect, does not; the repositories with an exclusion the root alone states fail."
		},
		{
			file: "packages/devtools/src/workspace/catalog-agreement.ts",
			original: "\t\t\t\t...Arr.map(Arr.difference(theirs, ours), (exclusion) => ({\n",
			replacement: "\t\t\t\t...Arr.map(Arr.difference(theirs, theirs), (exclusion) => ({\n",
			why: "An exclusion a vendored workspace alone states passes: the tree trusts a fresh release by two policies; the repositories with an exclusion the workspace alone states fail."
		},
		{
			file: "packages/devtools/src/workspace/catalog-agreement.ts",
			original:
				"\t\t\t\tArr.every(versions, (version) => Arr.contains(rootVersions(entry), version))\n",
			replacement: "\t\t\t\tArr.every(versions, (version) => Str.isNonEmpty(version))\n",
			why: "A versioned exclusion that names a version the tree does not install passes, as metis's @ui-sdk/core@0.1.0-beta.2 did where the tree installs beta.10; the repositories with an exclusion naming another version fail."
		},
		{
			file: "packages/devtools/src/workspace/catalog-agreement.ts",
			original:
				'\t\t\t\tentries.set(entry, { versions: [String(version)], section: ["overrides:"] })\n',
			replacement:
				'\t\t\t\tentries.set(entry, { versions: [...(entries.get(entry)?.versions ?? []), String(version)], section: ["overrides:"] })\n',
			why: "An override joins the catalog's version instead of replacing it, though pnpm installs the override alone: a workspace whose override agrees with the root reads as disagreeing, and one whose catalog alone agrees reads as agreeing."
		},
		{
			file: "packages/devtools/src/workspace/catalog-agreement.ts",
			original:
				"\t\t\t\t\t? Option.some(Str.slice(CATALOG_PROTOCOL.length)(written) || DEFAULT_CATALOG)\n",
			replacement: "\t\t\t\t\t? Option.none()\n",
			why: "An override of `catalog:` reads as the version `catalog:` instead of the catalog's: a workspace that defers to its catalog disagrees with a root that states the same version."
		},
		{
			file: "packages/devtools/src/workspace/catalog-agreement.ts",
			original: "\tif (!Arr.isReadonlyArrayNonEmpty(rest)) {\n",
			replacement: "\tif (true) {\n",
			why: "A glob names no entry: `@effect/*` exempts no @effect package, so a root's `@effect/*` a vendored workspace lacks passes."
		}
	]
})
