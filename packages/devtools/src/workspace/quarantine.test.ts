/**
 * The quarantine (src/workspace/quarantine.ts), searched over a package's history of one commit and its parent, drawn
 * from a grammar of its contract: the legacy test modules the parent held, the quarantine the parent kept or none (or
 * no parent commit), and a quarantine whose entries are each a legacy module the parent allowed, a module added since
 * (the list grew), a name no tracked file holds, or a glob, written in a list of string literals, with a line comment
 * among them or not; beside a quarantine at no package's root, a list that cannot be read, and exemptions from a test
 * module's shape that name a quarantined module or another. Every part carries the findings the contract gives it, and
 * the quarantine's findings over the commit must be exactly that many. Its list is read back as written whatever its
 * entries hold, a list's punctuation among them.
 *
 * Oracle: the specification, the quarantine's JSDoc: a package's legacy test modules wait in one list at its root that
 * names each outright and only falls. Features: an entry allowed, an entry that grew, an untracked entry, a glob entry,
 * a quarantine at no package's root, an unreadable list, an exemption of a quarantined module, an exemption of another,
 * a root commit; and, for the list, an empty one, several entries, a comment, an entry holding a list's punctuation.
 */
import { assert } from "@bjornpagen/testing/assert"
import { property } from "@bjornpagen/testing/property"
import { Effect, Result } from "effect"
import {
	commits,
	expectedOf,
	featuresOf,
	findingsOf,
	lists,
	textOf,
	writtenOf
} from "#workspace/quarantine.fixtures.ts"
import { includedOf } from "#workspace/quarantine.ts"

/** Gives each commit exactly the findings its quarantine and exemptions draw. */
export const commitFindings = property.explore(commits, {
	needs: {},
	situations: [
		"an entry allowed",
		"an entry that grew",
		"an untracked entry",
		"a glob entry",
		"a quarantine at no package's root",
		"an unreadable list",
		"an exemption of a quarantined module",
		"an exemption of another",
		"a root commit"
	],
	check: (_resources, c) => (commit) =>
		Effect.sync(() => {
			c.noteAll(featuresOf(commit))
			assert.deepEqual(findingsOf(commit), expectedOf(commit))
		}),
	oracle: {
		kind: "specification",
		name: "the quarantine's stated contract: one list at a package's root, naming each legacy module outright, only falling"
	},
	kept: [],
	kills: []
})

/** Reads back every list it is written as. */
export const listReadBack = property.explore(lists, {
	needs: {},
	situations: [
		"an empty list",
		"a list of several entries",
		"a commented list",
		"an entry that holds a list's punctuation"
	],
	check: (_resources, c) => (list) =>
		Effect.sync(() => {
			c.noteAll(writtenOf(list))
			assert.deepEqual(
				includedOf(textOf(list.entries, list.commented)),
				Result.succeed(list.entries)
			)
		}),
	oracle: {
		kind: "specification",
		name: "a quarantine's include list, as written, read back"
	},
	kept: [],
	kills: []
})
