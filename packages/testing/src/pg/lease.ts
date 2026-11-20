import { regex } from "arkregex"
import { Array as Arr, Effect, FileSystem, Schema, type Scope, String as Str } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import { type Lease, leaseClaim, leaseHeld, type Slot } from "#pg/hold.ts"

/**
 * A cluster's lease: the one mechanism by which a run takes its share of each member's capacity, so however many runs
 * of however many checkouts share a local cluster, its backends never exceed what each member admits and no connection
 * is refused with "too many clients". A run leases all or nothing: before any of its workers opens a connection on the
 * cluster, the run holds a slot for each of its workers among the family's members, each worker on the member of its
 * slot (Placement). Every run waits for nothing while it holds, so no wait closes a cycle: a run that cannot have them
 * all holds none, or is the one run of the family's queue, which holds what it has taken while it waits for slots that
 * runs holding all theirs let go.
 *
 * A slot is a kernel lock, flock(2), taken by the toolchain's one holder (hold.ts, scripts/hold.pl's `lease`, which
 * says how a lease is taken), on a file of its member's lease directory, beside the member's state, each with its door,
 * and the family's choose lock and queue beside the first member's: every member is local, made by this library on this
 * machine, so every process that reaches it can take the lock. A run that fits takes its slots at once, on the members
 * with the most free slots, whatever waits; a run that does not waits in the family's queue, and the queue's holder
 * waits for one slot at a time, shielded by its door, so it is handed each slot it waits for when that slot is let go.
 * A run that waits waits in the kernel, not in the server: it holds no connection, no transaction and no snapshot, so
 * no waiter holds back the cluster's vacuum horizon or spends the capacity it waits for.
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

/**
 * A family's queue, beside its first member's slots: the lock a run that cannot have its slots at once waits for,
 * holding none, and holds while it waits for them. Its file is the one a run of an older toolchain held as its gate while
 * it waited for slots, so the two never both hold slots while they wait.
 */
const queueFile = (first: Leased): string => `${first.lease}/gate.lock`

/** A family's choose lock, beside its first member's slots: held only while a run looks at the slots, never in a wait. */
const chooseFile = (first: Leased): string => `${first.lease}/choose.lock`

/**
 * The slots a member of `capacity` connections admits for workers of `demand`: as many as fit beside the connections no
 * lease covers, and one at least.
 */
const leaseSlots = (capacity: number, demand: Demand): number =>
	Math.max(1, Math.floor((capacity - demand.outside) / demand.perLessee))

/**
 * A run's reservation on a cluster: how many workers the run leases a slot for, and the family's members in order, each
 * with how many slots its capacity admits.
 */
export const Reservation = Schema.Struct({
	cluster: Schema.Int,
	workers: Schema.Int,
	members: Schema.NonEmptyArray(
		Schema.Struct({ port: Schema.Int, lease: Schema.String, slots: Schema.Int })
	)
})

export type Reservation = typeof Reservation.Type

/**
 * Where a held reservation put the run's workers: for worker i, the member of its slot, by its index among the
 * reservation's members, at the i-th place.
 */
export const Placement = Schema.NonEmptyArray(Schema.Int)

export type Placement = typeof Placement.Type

/** The key of a reservation's family, its queue: one lease a family for a run, however many of its workers ask. */
export const familyOf = (reservation: Reservation): string =>
	queueFile(Arr.headNonEmpty(reservation.members))

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
 * order, each admitting the slots its capacity admits for `demand`: a slot for each of the run's workers, on whichever
 * members have them free when it holds (reserved). A run wider than the family's slots is refused, never leased
 * narrower: it would wait for ever for slots that are never all free, and `toolchain-pg init --adopt` sizes the members
 * for it.
 */
export const reservationOf = (
	cluster: number,
	members: Arr.NonEmptyReadonlyArray<Leased>,
	demand: Demand,
	workers: number
): Effect.Effect<Reservation, LeaseFailed, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const sized = yield* Effect.forEach(members, (member) =>
			Effect.map(capacityOf(cluster, member), (capacity) => ({
				port: member.port,
				lease: member.lease,
				slots: leaseSlots(capacity, demand)
			}))
		)
		const slots = Arr.reduce(sized, 0, (sum, member) => sum + member.slots)
		return workers > slots
			? yield* LeaseFailed.make({
					cluster,
					message: `the family's ${sized.length} members admit ${slots} workers of ${demand.perLessee} connections, and the run starts ${workers}: toolchain-pg init --adopt sizes them`
				})
			: { cluster, workers, members: sized }
	})

/** The slot of a lease directory at `at`, and its door. */
const slotOf = (lease: string, at: number): Slot => ({
	slot: `${lease}/${at}.lock`,
	door: `${lease}/${at}.door`
})

/** A member's slots, each a file of its lease directory with its door beside it. */
const slotsOf = (member: Reservation["members"][number]): Arr.NonEmptyReadonlyArray<Slot> =>
	Arr.prepend(
		Array.from({ length: member.slots - 1 }, (_, at) => slotOf(member.lease, at + 1)),
		slotOf(member.lease, 0)
	)

/** The holder's lease of `reservation` (hold.ts Lease): a slot for each of its workers among its members' slots. */
const leaseOf = (reservation: Reservation): Lease => {
	const first = Arr.headNonEmpty(reservation.members)
	return {
		need: reservation.workers,
		choose: chooseFile(first),
		queue: queueFile(first),
		members: Arr.map(reservation.members, slotsOf)
	}
}

/** The files a reservation locks: its family's queue and choose lock, then each member's slots and doors. */
export const reservationFiles = (reservation: Reservation): Arr.NonEmptyReadonlyArray<string> => {
	const lease = leaseOf(reservation)
	return [
		lease.queue,
		lease.choose,
		...Arr.flatMap(
			lease.members,
			Arr.flatMap((slot) => [slot.slot, slot.door])
		)
	]
}

/** The holder's claim of `reservation`'s lease, as hold.pl reads it (hold.ts leaseClaim). */
export const reservationClaim = (reservation: Reservation) => leaseClaim(leaseOf(reservation))

/**
 * `reservation` held for the enclosing scope, a run's (hold.ts leaseHeld): a slot for each of the run's workers, taken
 * at once when they are free, or after the runs ahead of it in the family's queue (scripts/hold.pl's `lease`). Once
 * this returns, the run holds them until its scope closes, each worker on the member its Placement names.
 */
export const reserved = (
	reservation: Reservation
): Effect.Effect<
	Placement,
	LeaseFailed,
	Scope.Scope | FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const failedWith = (error: { readonly message: string }) =>
			LeaseFailed.make({
				cluster: reservation.cluster,
				message: `${familyOf(reservation)}: ${error.message}`
			})
		yield* Effect.forEach(
			reservation.members,
			(member) => Effect.mapError(fs.makeDirectory(member.lease, { recursive: true }), failedWith),
			{ discard: true }
		)
		return yield* Effect.mapError(
			leaseHeld(leaseOf(reservation), reservationFiles(reservation)),
			failedWith
		)
	})
