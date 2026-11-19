import { Config, Effect, FileSystem, Schema } from "effect"
import { element, finite, int } from "#gen.ts"
import { type Reservation, Reservation as ReservationSchema, reservationOf } from "#pg/lease.ts"
import { type Property, property } from "#property.ts"
import { NeedFailed, RunLease } from "#runner/services.ts"

/**
 * What the nested-run property (nested.test.ts) draws and the property its nested run searches: a run a case starts, a
 * pool or an inline search, whose one property's need takes the lease of a cluster the enclosing run already holds
 * whole, its one member admitting one worker.
 */

/** How a case starts its nested run: a pool of its own workers, or an inline search in its own process. */
export type Nested = "a pool a case starts" | "an inline search a case runs"

/** Both kinds of nested run, one case each. */
export const nestedRuns = finite((source): Nested =>
	source.draw(element(["a pool a case starts", "an inline search a case runs"] as const))
)

/** The variable a nested pool's workers read the reservation their need takes from, as JSON. */
export const NESTED_RESERVATION = "TOOLCHAIN_TEST_NESTED_RESERVATION"

/** A reservation as JSON, the text the variable holds. */
const ReservationJson = Schema.fromJsonString(ReservationSchema)

/** `reservation` as the text a nested pool's workers read it from. */
export const reservationText = Schema.encodeEffect(ReservationJson)

/**
 * The reservation of a run of one worker on a cluster of one member under `directory` whose recorded capacity admits one
 * worker of two connections and nothing outside it: its one slot, which the enclosing run takes first.
 */
export const oneSlotReservation = (directory: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const lease = `${directory}/lease`
		yield* fs.makeDirectory(lease, { recursive: true })
		yield* fs.writeFileString(`${lease}/capacity`, "2\n")
		return yield* reservationOf(1, [{ port: 1, lease }], { perLessee: 2, outside: 0 }, 1)
	})

/**
 * A property whose need takes the run's lease on `reservation`'s cluster (RunLease.reserve) before its one case, which
 * passes: so its search completes exactly when the lease is answered.
 */
export const reservesOn = (reservation: Effect.Effect<Reservation, NeedFailed>): Property =>
	property.exhaust(finite(int(0, 1)), {
		box: "two values",
		needs: {
			leased: {
				key: "runner/nested.fixtures.ts the cluster's lease",
				open: Effect.as(
					Effect.flatMap(
						Effect.all([Effect.service(RunLease), reservation]),
						([lease, reserving]) => lease.reserve(reserving)
					),
					Effect.void
				)
			}
		},
		situations: [],
		check: () => () => Effect.void,
		oracle: {
			kind: "specification",
			name: "a property planted to pass once its cluster's lease is answered"
		},
		kept: [],
		kills: []
	})

/** The planted property a nested pool's workers search: its reservation from NESTED_RESERVATION. */
export const reservesItsCluster = reservesOn(
	Effect.mapError(
		Effect.gen(function* () {
			const text = yield* Config.String(NESTED_RESERVATION)
			return yield* Schema.decodeEffect(ReservationJson)(text)
		}),
		(error) => NeedFailed.make({ need: "the nested reservation", message: error.message })
	)
)

/** The identity of the planted property a nested pool's workers search. */
export const RESERVES = "src/runner/nested.fixtures.ts#reservesItsCluster"
