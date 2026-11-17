/**
 * The workspace gate's root-tasks rule (src/workspace/root-tasks.ts), searched over repositories drawn from a grammar
 * of its contract: for each of a handful of task names, one a prefix of another, turbo.json defines the generic task,
 * the root task (`//#<name>`) and a package's own task (`@scope/a#<name>`) of that name or not, and the root's script
 * of that name runs nothing, a command of its own (one whose words only look like turbo among them) or turbo (as a
 * word, a path's last segment, or one command of several), with the tasks written before or after the root's and the
 * package's. The rule must report exactly the root scripts of their own whose generic task is defined and whose root
 * task is not, each at its generic task's key in turbo.json, and nothing else.
 *
 * Oracle: the specification, the rule's JSDoc read over the names its module exports (ROOT_TASK, TURBO,
 * TURBO_CONFIG). Features: an unregistered root script, a registered one, a root script that runs turbo, a root
 * script with no generic task, a generic task with no root script, a package's own task.
 */
import { deepStrictEqual } from "@bjornpagen/testing/assert"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import { expectedOf, featuresOf, outcomeOf, repositories } from "#workspace/root-tasks.fixtures.ts"

/** Give each repository exactly the findings its tasks and scripts draw, each where its generic task is written. */
export const rootTaskFindingsOf = property.explore(repositories, {
	needs: {},
	situations: [
		"an unregistered root script",
		"a registered root script",
		"a root script that runs turbo",
		"a root script with no generic task",
		"a generic task with no root script",
		"a package's own task"
	],
	check: (_resources, c) => (repository) =>
		Effect.gen(function* () {
			c.noteAll(featuresOf(repository))
			const outcome = yield* outcomeOf(repository)
			deepStrictEqual(outcome, expectedOf(repository))
		}),
	oracle: {
		kind: "specification",
		name: "the rule's stated contract over the names its module exports"
	},
	kept: [],
	kills: []
})
