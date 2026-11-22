/**
 * The claim checks' monitor connection (pg/session.ts monitorOf), against a member that takes every connection and
 * never answers (monitor.fixtures.ts silentMember): a check ends within its bound, answering as a member that cannot be
 * asked does, and the monitor is dropped, so a dead member wedges neither the check nor the ones after it. Oracle:
 * stated in the property.
 */
import { Duration, Effect } from "effect"
import { assert } from "#assert.ts"
import { boolean, finite } from "#gen.ts"
import { liveSleep } from "#live.ts"
import { monitored, silentMember } from "#pg/monitor.fixtures.ts"
import { backendWorkingWithin } from "#pg/session.ts"
import { property } from "#property.ts"

export const deadMemberWedgesNoCheck = property.exhaust(finite(boolean), {
	box: "one check of a member that never answers, and one check after it",
	needs: {},
	situations: [],
	check: () => (again) =>
		Effect.scoped(
			Effect.gen(function* () {
				const member = yield* silentMember
				const ask = Effect.map(backendWorkingWithin(member, 1, 200), (working) => ({
					working,
					monitored: monitored(member)
				}))
				const asked = again ? Effect.andThen(ask, ask) : ask
				const answered = yield* Effect.raceFirst(
					asked,
					Effect.as(liveSleep(Duration.seconds(30)), { working: false, monitored: true })
				)
				assert.deepEqual(answered, { working: true, monitored: false })
			})
		),
	oracle: {
		kind: "specification",
		name: "a check of a member that takes the connection and never answers ends within its bound as one that cannot be asked (the claim holds) and drops the monitor, and so does a check after it (grizzle, 2026-11-22)"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/pg/session.ts",
			original: "\t\tconnectionTimeoutMillis: bound,\n",
			replacement: "",
			why: "The monitor's open is unbounded, as backendWorking's connect was: a member that takes the connection and never answers holds the check, and every check after it, for good (a kill trial's guard waited 69 minutes so at e8b7ecec, 2026-11-22); the property fails, the check never ending."
		},
		{
			file: "packages/testing/src/pg/session.ts",
			original: "\t\t\tmonitors.delete(key)\n",
			replacement: "",
			why: "A failed monitor is kept, so every check after a dead member's first asks the same dead connection; the property fails, the monitor still held."
		}
	]
})
