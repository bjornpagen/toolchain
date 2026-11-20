import { Array as Arr, Effect, Option, Schema, type Scope, Stream, String as Str } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { waitingFor } from "#live.ts"

/**
 * The kernel locks this library takes, a cluster's lifecycle lock (make.ts) and a run's lease on a cluster family (lease.ts),
 * each taken by the toolchain's one holder of kernel locks, scripts/hold.pl, which the gate's key and snapshot locks are
 * taken by too (packages/devtools/bin/gate.sh): one process for the enclosing scope, which says `held` once every lock
 * it was asked for is its, and holds them until its standard input ends, which the kernel ends with this process
 * however it ends.
 */

/** The holder, beside this package's other programs. */
const HOLDER = `${import.meta.dirname}/../../scripts/hold.pl`

/** A hold could not be taken: its holder ended before it held, saying why. */
class HoldFailed extends Schema.TaggedError<HoldFailed, { readonly brand: unique symbol }>()(
	"HoldFailed",
	{ message: Schema.String }
) {}

/**
 * The holder's claims (hold.pl's CLAIMs) on `files` held for the enclosing scope, and what the holder said after `held`
 * (a lease's members). The wait is declared to the runner's guards as a wait for those files' locks (live.ts
 * waitingFor), which they judge by the work of the processes that hold them: what it waits for is held by other
 * processes' scopes, which end with them, so the wait ends unless a holder has stopped or encloses the waiter.
 */
const holding = (
	claims: Arr.NonEmptyReadonlyArray<string>,
	files: Arr.NonEmptyReadonlyArray<string>
): Effect.Effect<
	ReadonlyArray<string>,
	HoldFailed,
	Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const failedWith = (error: { readonly message: string }) =>
			HoldFailed.make({ message: error.message })
		const holder = yield* Effect.mapError(
			spawner.spawn(ChildProcess.make("perl", [HOLDER, ...claims])),
			failedWith
		)
		const said = yield* waitingFor(files)(
			Effect.mapError(
				Stream.runHead(Stream.splitLines(Stream.decodeText(holder.stdout))),
				failedWith
			)
		)
		const words = Arr.filter(Str.split(" ")(Option.getOrElse(said, () => "")), Str.isNonEmpty)
		if (Option.contains(Arr.head(words), "held")) {
			return Arr.drop(words, 1)
		}
		const why = yield* Effect.mapError(
			Stream.mkString(Stream.decodeText(holder.stderr)),
			failedWith
		)
		return yield* HoldFailed.make({ message: `its holder ended before it held: ${why}` })
	})

/** The exclusive lock on `file`, waited for, for the enclosing scope. */
export const lockHeld = (file: string) =>
	Effect.asVoid(holding(["wait", "exclusive", "1", file], [file]))

/** A slot of a lease: its lock's file, and its door's, which the queue's holder holds while it waits for the slot. */
export type Slot = Readonly<{ slot: string; door: string }>

/**
 * A lease as hold.pl's `lease` claim takes it: `need` slots among the members' `members`, all or none, under the
 * family's `choose` lock and, for a lease that waits, its `queue`.
 */
export type Lease = Readonly<{
	need: number
	choose: string
	queue: string
	members: Arr.NonEmptyReadonlyArray<Arr.NonEmptyReadonlyArray<Slot>>
}>

/** `lease` as hold.pl's words: its need, choose lock and queue, then each member's slots and doors. */
export const leaseClaim = (lease: Lease): Arr.NonEmptyReadonlyArray<string> => [
	"lease",
	`${lease.need}`,
	lease.choose,
	lease.queue,
	...Arr.flatMap(lease.members, (slots) => [
		"member",
		...Arr.flatMap(slots, (slot) => [slot.slot, slot.door])
	])
]

/**
 * `lease` held for the enclosing scope (scripts/hold.pl's `lease`, which says how it is taken and why no wait closes a
 * cycle), its wait declared as one for `files`: the member, by its index among the lease's members, of each slot it
 * holds, in the order it took them, one for each of its `need`.
 */
export const leaseHeld = (
	lease: Lease,
	files: Arr.NonEmptyReadonlyArray<string>
): Effect.Effect<
	Arr.NonEmptyReadonlyArray<number>,
	HoldFailed,
	Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.flatMap(holding(leaseClaim(lease), files), (said) => {
		const members = Arr.map(said, Number)
		return Arr.isReadonlyArrayNonEmpty(members) &&
			members.length === lease.need &&
			Arr.every(
				members,
				(member) => Number.isInteger(member) && member >= 0 && member < lease.members.length
			)
			? Effect.succeed(members)
			: Effect.fail(
					HoldFailed.make({
						message: `its holder said it holds ${Arr.join(said, " ")}, not ${lease.need} slots of its members`
					})
				)
	})
