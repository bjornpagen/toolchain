import { regex } from "arkregex"
import { Array as Arr, Effect, FileSystem, Schema, type Scope, String as Str } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { reservationHeld } from "#pg/hold.ts"

/**
 * A cluster's lease: the one mechanism by which a run takes its share of each member's capacity, so however many runs
 * of however many checkouts share a local cluster, its backends never exceed what each member admits and no connection
 * is refused with "too many clients". A run leases all or nothing: before any of its workers opens a connection on the
 * cluster, the run holds, on every member its workers reach, a slot for each of them there, taken at once under the
 * cluster's gate; a run that cannot have them all waits holding none. So no run holds a slot while it waits for
 * another, and runs that wait on each other wait in a queue, never in a cycle: a run's slot holders wait for nothing,
 * and only the gate's holder waits for slots.
 *
 * A slot is a kernel lock, flock(2), taken by the toolchain's one holder (hold.ts), on a file of its member's lease
 * directory, beside the member's state, and the gate is one beside the first member's: every member is local, made by this library on this machine, so every process that
 * reaches it can take the lock. A run that waits waits in the kernel, not in the server: it holds no connection, no
 * transaction and no snapshot, so no waiter holds back the cluster's vacuum horizon or spends the capacity it waits for.
 */

/** A member as a lease reads it: its port, and its lease directory, which its maker keeps beside its state. */
export type Leased = Readonly<{ port: number; lease: string }>

/**
 * How many connections a worker opens on a member at most at once (`perLessee`), and how many the member's other
 * clients hold that no lease covers (`outside`: a run's collection, the doctor, an operator's psql): the spec's
 * connection sizing, which sized the member's max_connections for a run's workers.
 */
export type Demand = Readonly<{ perLessee: number; outside: number }>

/** A cluster's lease could not be taken: a capacity unrecorded, a run wider than a member admits, a holder unstarted. */
export class LeaseFailed extends Schema.TaggedError<
	LeaseFailed,
	{ readonly brand: unique symbol }
>()("LeaseFailed", { cluster: Schema.Int, message: Schema.String }) {}

/** The file a member's maker records its capacity in, in its lease directory (make.ts recordCapacity). */
export const capacityFile = (member: Leased): string => `${member.lease}/capacity`

/** A cluster's gate, beside its first member's slots: the lock a run that reserves holds while it takes them. */
const gateFile = (first: Leased): string => `${first.lease}/gate.lock`

/**
 * The slots a member of `capacity` connections admits for workers of `demand`: as many as fit beside the connections no
 * lease covers, and one at least.
 */
const leaseSlots = (capacity: number, demand: Demand): number =>
	Math.max(1, Math.floor((capacity - demand.outside) / demand.perLessee))

/**
 * A run's reservation on a cluster: its gate, and on each member the run's workers reach, the member's slots and how
 * many of them the run holds there, one for each of its workers on that member.
 */
export const Reservation = Schema.Struct({
	cluster: Schema.Int,
	gate: Schema.String,
	members: Schema.NonEmptyArray(
		Schema.Struct({ port: Schema.Int, lease: Schema.String, slots: Schema.Int, need: Schema.Int })
	)
})

export type Reservation = typeof Reservation.Type

/** A capacity as its file holds it: a whole number of connections, written once the member started. */
const capacityText = regex("^[0-9]{1,6}$")

/**
 * The connections `member` admits beside those its server reserves (max_connections less
 * superuser_reserved_connections and reserved_connections), as its maker read them from the server it started and
 * recorded them (make.ts recordCapacity).
 */
const capacityOf = (
	cluster: number,
	member: Leased
): Effect.Effect<number, LeaseFailed, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const file = capacityFile(member)
		const written = yield* Effect.mapError(fs.readFileString(file), (error) =>
			LeaseFailed.make({ cluster, message: `${file}: ${error.message}` })
		)
		const text = Str.trim(written)
		return capacityText.test(text)
			? Number(text)
			: yield* LeaseFailed.make({ cluster, message: `${file} holds no capacity: ${text}` })
	})

/**
 * The reservation of a run of `workers` workers on the cluster named `cluster` whose members are `members`, in member
 * order: worker i reaches member i mod their count, so each member's need is its share of the workers, rounded up, out
 * of the slots its capacity admits for `demand`. A member that admits fewer than its share is refused, never leased
 * narrower: a run keeps its width, and `toolchain-pg init --adopt` sizes the member for it.
 */
export const reservationOf = (
	cluster: number,
	members: Arr.NonEmptyReadonlyArray<Leased>,
	demand: Demand,
	workers: number
): Effect.Effect<Reservation, LeaseFailed, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const need = Math.ceil(workers / members.length)
		const reserved = yield* Effect.forEach(members, (member) =>
			Effect.flatMap(capacityOf(cluster, member), (capacity) => {
				const slots = leaseSlots(capacity, demand)
				return need > slots
					? Effect.fail(
							LeaseFailed.make({
								cluster,
								message: `member ${member.port} admits ${slots} workers of ${demand.perLessee} connections, and the run starts ${need} on it: toolchain-pg init --adopt sizes it`
							})
						)
					: Effect.succeed({ port: member.port, lease: member.lease, slots, need })
			})
		)
		return {
			cluster,
			gate: gateFile(Arr.headNonEmpty(members)),
			members: [Arr.headNonEmpty(reserved), ...Arr.tailNonEmpty(reserved)]
		}
	})

/** The slots of a member's lease, each a file of its lease directory. */
const slotFiles = (member: Reservation["members"][number]): Arr.NonEmptyReadonlyArray<string> => [
	`${member.lease}/0.lock`,
	...Array.from({ length: member.slots - 1 }, (_, at) => `${member.lease}/${at + 1}.lock`)
]

/**
 * `reservation` held for the enclosing scope, a run's (hold.ts reservationHeld): its gate, then on each member the run's
 * workers reach their need of its slots, those free now first and the rest waited for in order, the gate let go once
 * they all hold, so only the gate's holder ever waits on a slot and a slot's holder waits on nothing. Once this returns,
 * the run holds a slot for each of its workers on every member it reaches, until its scope closes.
 */
export const reserved = (
	reservation: Reservation
): Effect.Effect<
	void,
	LeaseFailed,
	Scope.Scope | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const failedWith = (error: { readonly message: string }) =>
			LeaseFailed.make({
				cluster: reservation.cluster,
				message: `${reservation.gate}: ${error.message}`
			})
		yield* Effect.forEach(
			reservation.members,
			(member) => Effect.mapError(fs.makeDirectory(member.lease, { recursive: true }), failedWith),
			{ discard: true }
		)
		yield* Effect.mapError(
			reservationHeld(
				reservation.gate,
				Arr.map(reservation.members, (member) => ({ need: member.need, files: slotFiles(member) }))
			),
			failedWith
		)
	})
