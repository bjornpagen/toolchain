/**
 * The workspace gate's root-files rule (src/workspace/root-files.ts), searched over repositories drawn from a grammar
 * of its contract: workspace packages, one nested; root files at the root, under root directories, beside a package's
 * directory by a name that only begins like it, beside an include entry the same way, and declarations; a package's
 * files and files of other kinds; each root file named by the include through its own path, its directory, a
 * directory above it, `./` or a trailing `/`, or not at all; include entries that name nothing, and globs; and the
 * root's oxlint script as the root lint, the root lint with arguments, another command, or none. The rule must report
 * exactly each root file no entry names, each glob at its line, and the manifest when the root holds a file and its
 * oxlint script is not the root lint, and nothing else.
 *
 * Oracle: the specification, the rule's JSDoc read over the names its module exports (ROOT_LINT, LINT_SCRIPT,
 * ROOT_TSCONFIG). Features: a root file the include names, one it does not name, a
 * package's file, a file of another kind, a glob in the include, a root lint script, another lint script, no lint
 * script.
 */
import { assert } from "@bjornpagen/testing/assert"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { expectedOf, featuresOf, outcomeOf, repositories } from "#workspace/root-files.fixtures.ts"

/** Give each repository exactly the findings its files, its include and its oxlint script draw. */
export const rootFileFindingsOf = property.explore(repositories, {
	needs: {},
	situations: [
		"a root file the include names",
		"a root file it does not name",
		"a package's file",
		"a file of another kind",
		"a glob in the include",
		"a root lint script",
		"another lint script",
		"no lint script"
	],
	check: (_resources, c) => (repository) =>
		Effect.gen(function* () {
			c.noteAll(featuresOf(repository))
			const outcome = yield* outcomeOf(repository)
			assert.deepEqual(outcome, expectedOf(repository))
		}),
	oracle: {
		kind: "specification",
		name: "the rule's stated contract over the names its module exports"
	},
	kept: [],
	kills: []
})
