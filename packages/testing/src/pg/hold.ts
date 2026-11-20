import { Array as Arr, Effect, Option, Schema, type Scope, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { waitingFor } from "#live.ts"

/**
 * The kernel locks this library takes, a cluster's lifecycle lock (make.ts) and a run's lease on a cluster (lease.ts),
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

/** `need` of `files`, each exclusive: those free now, then the rest waited for in order. */
export type Claim = Readonly<{ need: number; files: Arr.NonEmptyReadonlyArray<string> }>

/**
 * The holder's claims (hold.pl's CLAIMs) on `files` held for the enclosing scope. The wait is declared to the runner's
 * guards as a wait for those files' locks (live.ts waitingFor), which they judge by the work of the processes that hold
 * them: what it waits for is held by other processes' scopes, which end with them, so the wait ends unless a holder has
 * stopped or encloses the waiter.
 */
const holding = (
	claims: Arr.NonEmptyReadonlyArray<string>,
	files: Arr.NonEmptyReadonlyArray<string>
): Effect.Effect<void, HoldFailed, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner> =>
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
		if (Option.contains(said, "held")) {
			return
		}
		const why = yield* Effect.mapError(
			Stream.mkString(Stream.decodeText(holder.stderr)),
			failedWith
		)
		return yield* HoldFailed.make({ message: `its holder ended before it held: ${why}` })
	})

/** The exclusive lock on `file`, waited for, for the enclosing scope. */
export const lockHeld = (file: string) => holding(["wait", "exclusive", "1", file], [file])

/**
 * Every claim of `claims`, taken in order under `gate`, which is held only while they are taken, for the enclosing
 * scope: so only the gate's holder ever waits for a lock while it holds others, and no wait closes a cycle.
 */
export const reservationHeld = (gate: string, claims: Arr.NonEmptyReadonlyArray<Claim>) =>
	holding(
		[
			"gate",
			gate,
			...Arr.flatMap(claims, (claim) => ["wait", "exclusive", `${claim.need}`, ...claim.files])
		],
		[gate, ...Arr.flatMap(claims, (claim) => claim.files)]
	)
