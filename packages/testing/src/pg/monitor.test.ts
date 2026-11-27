/**
 * The carrier asks' monitor connection (pg/session.ts monitorOf), against a member that takes every connection and
 * never answers (monitor.fixtures.ts silentMember): an ask ends within its bound, answering as a member that cannot be
 * asked does, carrying nothing, and the monitor is dropped, so a dead member wedges neither the ask nor the ones after
 * it. Oracle: stated in the property.
 */
import { Effect } from "effect"
import { assert } from "#assert.ts"
import { boolean, finite } from "#gen.ts"
import { monitored, silentMember } from "#pg/monitor.fixtures.ts"
import { carriersWithin } from "#pg/session.ts"
import { property } from "#property.ts"

export const deadMemberWedgesNoCheck = property.exhaust(finite(boolean), {
	box: "one ask of a member that never answers, and one ask after it",
	needs: {},
	situations: [],
	check: () => (again) =>
		Effect.scoped(
			Effect.gen(function* () {
				const member = yield* silentMember
				const ask = Effect.map(carriersWithin(member, ["1"], 200), (carried) => ({
					carried: carried.size,
					monitored: monitored(member)
				}))
				const asked = again ? Effect.andThen(ask, ask) : ask
				const answered = yield* asked
				assert.deepEqual(answered, { carried: 0, monitored: false })
			})
		),
	oracle: {
		kind: "specification",
		name: "an ask of a member that takes the connection and never answers ends within its bound as one that cannot be asked (nothing carried) and drops the monitor, and so does an ask after it (grizzle, 2026-11-22)"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/pg/session.ts",
			original: "\t\tconnectionTimeoutMillis: bound,\n",
			replacement: "",
			why: "The monitor's open is unbounded, as the claim check's connect was: a member that takes the connection and never answers holds the ask, and every ask after it, for good (a kill trial's guard waited 69 minutes so at e8b7ecec, 2026-11-22); the property fails, the ask never ending."
		},
		{
			file: "packages/testing/src/pg/session.ts",
			original: "\t\t\tmonitors.delete(key)\n",
			replacement: "",
			why: "A failed monitor is kept, so every ask after a dead member's first asks the same dead connection; the property fails, the monitor still held."
		}
	]
})
