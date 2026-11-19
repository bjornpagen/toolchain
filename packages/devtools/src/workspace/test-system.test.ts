/**
 * The test system's workspace gates (src/workspace/test-system.ts), searched over repositories drawn from a grammar of
 * their contract: files of every kind a gate reads (a plant's patch at any depth, a file under test/plants/, a
 * numbered shard of a test module, a Vitest configuration, a Vite configuration with a test block, a package manifest
 * whose scripts carry a worker flag or run plants, lefthook's configuration and a shell script whose commands carry
 * one) beside their neighbours the contract leaves alone (pnpm's dependency patches, a patch outside a plants
 * directory, a test module whose name ends in a word, a Vite configuration without a test block, a near flag, a flag in
 * a comment, a script of another name), in a repository that runs the properties pack and in one that does not. Every
 * file carries the findings the contract gives it, by rule, the properties pack's only where the repository runs it,
 * and the gates' findings over the repository must be exactly those.
 *
 * Oracle: the specification, the gates' JSDoc read over the flags, directories and scripts the module exports
 * (WORKER_FLAGS, WORKER_FLAG_PREFIXES, PLANTS_DIRECTORY, TEST_PLANTS, PLANT_SCRIPT). Features: a plant, a shard, a
 * Vitest configuration, a worker flag, a file the gates leave alone, a repository with the properties pack, a
 * repository without it.
 */
import { assert } from "@bjornpagen/testing/assert"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { countsOf, expectedOf, featuresOf, repositories } from "#workspace/test-system.fixtures.ts"

/** Give each repository exactly the findings its files draw. */
export const repositoryFindings = property.explore(repositories, {
	needs: {},
	situations: [
		"a plant",
		"a shard",
		"a Vitest configuration",
		"a worker flag",
		"a file the gates leave alone",
		"a repository with the properties pack",
		"a repository without it"
	],
	check: (_resources, c) => (repository) =>
		Effect.sync(() => {
			c.noteAll(featuresOf(repository))
			assert.deepEqual(countsOf(repository), expectedOf(repository))
		}),
	oracle: {
		kind: "specification",
		name: "the gates' stated contract over the flags, directories and scripts their module exports"
	},
	kept: [],
	kills: []
})
