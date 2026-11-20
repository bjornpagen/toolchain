/**
 * A cluster's lease (pg/lease.ts, scripts/hold.pl's `lease`): runs that reserve more of a family's slots together than
 * it has wait in its queue in the kernel and all finish, never holding more slots at once than the members admit, each
 * run's reservation held by one holder process for the run's life, the toolchain's holder of kernel locks
 * (scripts/hold.pl), started from the checkout (Checkout.dir, so a mutant of the holder reaches it on disk); runs that
 * fit start at once beside a run that waits, spread evenly over the members; and the queue's holder is handed each slot
 * it waits for when that slot is let go, however late the kernel wakes it. Each run holds its reservation until every
 * run holds or waits in the kernel (lease.fixtures.ts blockedOn), so the runs overlap as far as the lease lets them.
 * Oracle: the specification, stated in the check.
 */
import { Array as Arr, Deferred, Effect, FileSystem, Option, Ref } from "effect"
import { assert } from "#assert.ts"
import { awaitFact } from "#fact.ts"
import { int } from "#gen.ts"
import { Checkout } from "#mutate/checkout.ts"
import {
	blockedOn,
	familyIn,
	heldUntil,
	holderOf,
	SPREAD_MEMBERS,
	shieldIn,
	signalled,
	spreadFamily,
	stopped
} from "#pg/lease.fixtures.ts"
import { type Placement, reservationOf, reserved } from "#pg/lease.ts"
import { spawnedBy } from "#pg/make.fixtures.ts"
import { property } from "#property.ts"
import { Scratch } from "#resources/scratch.ts"
import { runWorkers } from "#workers.ts"

export const runsWaitInLine = property.explore(
	(source) => {
		const slots = source.draw(int(1, 3))
		return { slots, need: source.draw(int(1, slots)), runs: source.draw(int(2, 4)) }
	},
	{
		needs: { dir: Scratch.dir, checkout: Checkout.dir },
		situations: ["more runs than fit at once, queued behind each other", "runs that fit at once"],
		check:
			({ dir }, c) =>
			({ slots, need, runs }) =>
				Effect.gen(function* () {
					c.note(
						runs * need > slots
							? "more runs than fit at once, queued behind each other"
							: "runs that fit at once"
					)
					const fs = yield* FileSystem.FileSystem
					const lease = yield* dir
					yield* fs.writeFileString(`${lease}/capacity`, `${slots}\n`)
					const reservation = yield* reservationOf(
						1,
						[{ port: 1, lease }],
						{ perLessee: 1, outside: 0 },
						need
					)
					const holding = yield* Ref.make(0)
					const held = yield* Ref.make(0)
					const most = yield* Ref.make(0)
					const finished = yield* Ref.make(0)
					const spawned = yield* spawnedBy(
						Effect.forEach(
							Array.from({ length: runs }, (_, at) => at),
							() =>
								Effect.scoped(
									Effect.gen(function* () {
										yield* reserved(reservation)
										const now = yield* Ref.updateAndGet(held, (n) => n + need)
										yield* Ref.update(most, (m) => Math.max(m, now))
										yield* Ref.update(holding, (n) => n + 1)
										yield* awaitFact(
											Effect.map(
												Effect.all([Ref.get(holding), Ref.get(finished), blockedOn(lease)]),
												([holders, done, waiters]) =>
													holders + done + waiters >= runs ? Option.some(true) : Option.none()
											)
										)
										yield* Ref.update(held, (n) => n - need)
										yield* Ref.update(holding, (n) => n - 1)
										yield* Ref.update(finished, (n) => n + 1)
									})
								),
							{ concurrency: "unbounded", discard: true }
						)
					)
					assert.deepEqual(
						{
							finished: yield* Ref.get(finished),
							withinTheSlots: (yield* Ref.get(most)) <= slots,
							holders: Arr.filter(spawned, (program) => program === "perl").length
						},
						{ finished: runs, withinTheSlots: true, holders: runs }
					)
				}),
		oracle: {
			kind: "specification",
			name: "runs that reserve more of a member's slots than it has wait in its queue and all finish, never holding more than it admits, one holder each"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/scripts/hold.pl",
				original: "\treturn 1 if flock($file, LOCK_EX | LOCK_NB);\n",
				replacement: "\treturn 1;\n",
				why: "A lease takes slots without locking them, so runs together hold more than the member admits, as two gates at once exhausted 5441; the property fails."
			},
			{
				file: "packages/testing/scripts/hold.pl",
				original: '\t\tflock($lease->{queue}, LOCK_EX) or fail("flock: $!");\n',
				replacement: "",
				why: "Runs that cannot have their slots at once do not queue: two of them each hold slots while they wait, so they wait on each other's or shield one slot together, and not every run finishes; the property fails."
			}
		]
	}
)

export const runsLeaseTheirWork = property.explore(
	(source) => ({
		runs: source.draw(int(2, 4)),
		properties: source.draw(int(1, 12))
	}),
	{
		needs: { dir: Scratch.dir, checkout: Checkout.dir },
		situations: [
			"runs of one worker, each on a member of its own",
			"runs fewer than the family's members",
			"runs more than the family's members"
		],
		check:
			({ dir }, c) =>
			({ runs, properties }) =>
				Effect.gen(function* () {
					const workers = runWorkers(properties)
					c.note(
						workers === 1
							? "runs of one worker, each on a member of its own"
							: workers < SPREAD_MEMBERS
								? "runs fewer than the family's members"
								: "runs more than the family's members"
					)
					const scratch = yield* dir
					const family = yield* spreadFamily(scratch)
					const reservation = yield* reservationOf(1, family, { perLessee: 1, outside: 0 }, workers)
					const holding = yield* Ref.make(0)
					const most = yield* Ref.make(0)
					const finished = yield* Ref.make(0)
					const placed = yield* Ref.make<ReadonlyArray<Placement>>([])
					const blocked = Effect.map(
						Effect.forEach(family, (member) => blockedOn(member.lease)),
						Arr.reduce(0, (sum, waiters: number) => sum + waiters)
					)
					yield* Effect.forEach(
						Array.from({ length: runs }, (_, at) => at),
						() =>
							Effect.scoped(
								Effect.gen(function* () {
									const placement = yield* reserved(reservation)
									yield* Ref.update(placed, Arr.append(placement))
									const now = yield* Ref.updateAndGet(holding, (n) => n + 1)
									yield* Ref.update(most, (m) => Math.max(m, now))
									yield* awaitFact(
										Effect.map(
											Effect.all([Ref.get(holding), Ref.get(finished), blocked]),
											([holders, done, waiters]) =>
												holders + done + waiters >= runs ? Option.some(true) : Option.none()
										)
									)
									yield* Ref.update(holding, (n) => n - 1)
									yield* Ref.update(finished, (n) => n + 1)
								})
							),
						{ concurrency: "unbounded", discard: true }
					)
					const placements = yield* Ref.get(placed)
					const perMember = Arr.map(
						family,
						(_, member) =>
							Arr.filter(Arr.flatten(placements), (placedOn) => placedOn === member).length
					)
					assert.deepEqual(
						{
							leased: Arr.map(placements, (placement) => placement.length),
							reached: Arr.map(placements, (placement) => Arr.dedupe(placement).length),
							even: Arr.every(perMember, (held) =>
								Arr.every(perMember, (other) => held - other <= 1)
							),
							atOnce: yield* Ref.get(most)
						},
						{
							leased: Array.from({ length: runs }, () => Math.min(workers, properties)),
							reached: Array.from({ length: runs }, () => Math.min(workers, SPREAD_MEMBERS)),
							even: true,
							atOnce: runs
						}
					)
				}),
		oracle: {
			kind: "specification",
			name: "a run of k properties leases a slot for each of its workers, never more than k, spread over as many of the family's members as it has workers, and runs that fit the family hold it all at once, its members evenly: runs of one worker each on a member of its own"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/workers.ts",
				original: "\tMath.max(1, Math.min(testWorkers, properties))",
				replacement: "\tMath.max(1, testWorkers)",
				why: "A run holds testWorkers whatever its work, as it did: a lane's run of four properties leased 32 slots of a shared family, so twelve such runs queued two at a time on 5491; the property fails."
			},
			{
				file: "packages/testing/scripts/hold.pl",
				original:
					"\t\t\t$best = $member if $here < $there || ($here == $there && @{ $found[$member] } > @{ $found[$best] });\n",
				replacement: "",
				why: "A lease takes the first member with a slot free, as a worker was bound to member i mod the family's size: every run of one worker lands on the first member and a run's workers fill one member before the next (main, 2026-11-20: the member-0 pileup), so the members are not evenly held; the property fails."
			}
		]
	}
)

export const fitsBesideTheQueue = property.explore(
	(source) => {
		const slots = source.draw(int(1, 3))
		const family = 2 * slots
		const held = source.draw(int(1, family - 1))
		const free = family - held
		return {
			slots,
			held,
			large: source.draw(int(free + 1, family)),
			small: source.draw(int(1, free))
		}
	},
	{
		needs: { dir: Scratch.dir, checkout: Checkout.dir },
		situations: ["a large run waiting for some of the family", "a large run waiting for all of it"],
		check:
			({ dir }, c) =>
			({ slots, held, large, small }) =>
				Effect.scoped(
					Effect.gen(function* () {
						c.note(
							large === 2 * slots
								? "a large run waiting for all of it"
								: "a large run waiting for some of the family"
						)
						const scratch = yield* dir
						const family = yield* familyIn(scratch, 2, slots)
						const of = (workers: number) =>
							reservationOf(1, family, { perLessee: 1, outside: 0 }, workers)
						const blocked = Effect.map(
							Effect.forEach(family, (member) => blockedOn(member.lease)),
							Arr.reduce(0, (sum, waiters: number) => sum + waiters)
						)
						const release = yield* Deferred.make<void>()
						const holding = yield* of(held)
						const holder = yield* heldUntil(holding, release)
						yield* Deferred.await(holder)
						const never = yield* Deferred.make<void>()
						const waiting = yield* of(large)
						const queued = yield* heldUntil(waiting, never)
						yield* awaitFact(
							Effect.map(blocked, (waiters) => (waiters >= 1 ? Option.some(true) : Option.none()))
						)
						const one = yield* of(1)
						const beside = yield* Effect.forEach(
							Array.from({ length: small }, (_, at) => at),
							() => heldUntil(one, release)
						)
						const started = Effect.map(
							Effect.forEach(beside, Deferred.isDone),
							Arr.filter((done: boolean) => done)
						)
						const atOnce = yield* awaitFact(
							Effect.map(Effect.all([started, blocked]), ([done, waiters]) =>
								done.length + waiters - 1 >= small ? Option.some(done.length) : Option.none()
							)
						)
						const queuedMeanwhile = !(yield* Deferred.isDone(queued))
						yield* Deferred.succeed(release, undefined)
						const placement = yield* Deferred.await(queued)
						assert.deepEqual(
							{ atOnce, queuedMeanwhile, queuedHolds: placement.length },
							{ atOnce: small, queuedMeanwhile: true, queuedHolds: large }
						)
					})
				),
		oracle: {
			kind: "specification",
			name: "runs of one worker that fit the free slots all start at once beside a larger run waiting in the family's queue, which holds once the slots it waits for are let go"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/scripts/hold.pl",
				original: "\tmy $fit = fits();\n",
				replacement: "\tmy $fit = 0;\n",
				why: "Every lease takes the family's queue first, which the run that waits holds while it waits, as a run held the cluster's gate (PERFIO-push held 5491's gate and slot 0 for 17 minutes with 3 slots free, every run of one worker behind it): the runs that fit wait behind it; the property fails."
			}
		]
	}
)

export const queueTakesItsShield = property.explore(
	(source) => ({ slots: source.draw(int(1, 3)) }),
	{
		needs: { dir: Scratch.dir, checkout: Checkout.dir },
		situations: [
			"a queue's holder waiting for one slot",
			"a queue's holder waiting for slots in turn"
		],
		check:
			({ dir }, c) =>
			({ slots }) =>
				Effect.scoped(
					Effect.gen(function* () {
						c.note(
							slots === 1
								? "a queue's holder waiting for one slot"
								: "a queue's holder waiting for slots in turn"
						)
						const scratch = yield* dir
						const family = yield* familyIn(scratch, 1, slots)
						const lease = Arr.headNonEmpty(family).lease
						const of = (workers: number) =>
							reservationOf(1, family, { perLessee: 1, outside: 0 }, workers)
						const never = yield* Deferred.make<void>()
						const one = yield* of(1)
						const holders = yield* Effect.forEach(
							Array.from({ length: slots }, (_, at) => at),
							() => heldUntil(one, never)
						)
						yield* Effect.forEach(holders, Deferred.await, { discard: true })
						const whole = yield* of(slots)
						const queued = yield* heldUntil(whole, never)
						const handed = yield* Effect.forEach(
							Array.from({ length: slots }, (_, at) => at),
							(step) =>
								Effect.gen(function* () {
									const shield = yield* awaitFact(shieldIn(lease))
									yield* Effect.acquireRelease(signalled(shield.holder, "SIGSTOP"), () =>
										signalled(shield.holder, "SIGCONT")
									)
									yield* awaitFact(stopped(shield.holder))
									const previous = yield* awaitFact(holderOf(lease, shield.slot))
									yield* signalled(previous, "SIGKILL")
									yield* awaitFact(
										Effect.map(holderOf(lease, shield.slot), (holder) =>
											Option.isNone(holder) ? Option.some(true) : Option.none()
										)
									)
									const prober = yield* heldUntil(one, never)
									yield* awaitFact(
										Effect.map(
											Effect.all([Deferred.isDone(prober), blockedOn(lease)]),
											([done, waiters]) =>
												done || waiters > step ? Option.some(true) : Option.none()
										)
									)
									yield* signalled(shield.holder, "SIGCONT")
									const taker = yield* awaitFact(holderOf(lease, shield.slot))
									return taker === shield.holder
								})
						)
						assert.deepEqual(
							handed,
							Array.from({ length: slots }, () => true)
						)
						const placement = yield* Deferred.await(queued)
						assert.deepEqual(
							{ held: placement.length, on: Arr.dedupe(placement) },
							{ held: slots, on: [0] }
						)
					})
				),
		oracle: {
			kind: "specification",
			name: "the run that holds the family's queue is handed each slot it waits for when that slot is let go, though it is stopped then and another run looks for a free slot before it wakes, and holds once it has them all"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/scripts/hold.pl",
				original: "\t\t\tnext unless taken_now($slots[$at]{door});\n",
				replacement: "",
				why: "A lease takes a free slot whatever its door, so a run that looks for one in the instant between a slot's release and the queue's holder's waking takes the slot it waits for, and the queue's holder may wait for ever while runs that fit keep coming; the property fails."
			}
		]
	}
)
