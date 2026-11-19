/**
 * Agreement (oracle.ts agree): it passes exactly when every side agrees with the first under its comparison (in
 * order, as sets, through a projection, within a tolerance), and names the first side that does not. Oracle: each
 * comparison's definition, side by side against the first.
 */
import { Array as Arr, Effect, Exit, Option } from "effect"
import { agreements, agreesOf, type Answer, COMPARISONS, equivalenceOf } from "#agree.fixtures.ts"
import { assert } from "#assert.ts"
import { agree, type Side } from "#oracle.ts"
import { property } from "#property.ts"

export const agreesBySide = property.explore(agreements, {
	needs: {},
	situations: [...COMPARISONS, "agreed", "disagreed", "a later side disagreed"],
	check:
		(_resources, c) =>
		({ comparison, first, rest }) =>
			Effect.gen(function* () {
				c.note(comparison)
				const head: Side<Answer> = ["side 0", first]
				const sides = Arr.prepend(
					Arr.map(rest, (answer, at): Side<Answer> => [`side ${at + 1}`, answer]),
					head
				)
				const dissenting = Arr.findFirstIndex(
					rest,
					(answer) => !agreesOf(comparison, first, answer)
				)
				c.note(Option.isSome(dissenting) ? "disagreed" : "agreed")
				if (Option.exists(dissenting, (at) => at > 0)) {
					c.note("a later side disagreed")
				}
				const judged = yield* Effect.exit(agree(sides, equivalenceOf(comparison)))
				assert.deepEqual(
					Option.map(Exit.findErrorOption(judged), (disagreement) => [
						disagreement.first,
						disagreement.second
					]),
					Option.map(dissenting, (at) => ["side 0", `side ${at + 1}`])
				)
			}),
	oracle: {
		kind: "second-implementation",
		name: "each comparison's definition, side by side against the first"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/oracle.ts",
			original: "\t\t\t([, values, groups]) => Option.isSome(repeatOf(item, values, groups, key))",
			replacement: "\t\t\t() => false",
			why: "A side repeating an item agrees as a set; the agree property fails."
		}
	]
})
