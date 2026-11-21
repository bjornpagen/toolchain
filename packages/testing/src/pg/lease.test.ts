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
import { Array as Arr, Deferred, Effect, Exit, FileSystem, Option, Ref, Scope } from "effect"
import { assert } from "#assert.ts"
import { awaitFact } from "#fact.ts"
import { int } from "#gen.ts"
import { Checkout } from "#mutate/checkout.ts"
import {
	blockedOn,
	familyIn,
	heldUntil,
	holderOf,
	queuedIn,
	leasedKept,
	SPREAD_MEMBERS,
	shieldIn,
	shieldsIn,
	signalled,
	spreadFamily,
	stopped,
	turnWaits
} from "#pg/lease.fixtures.ts"
import {
	familyOf,
	type LeaseFailed,
	leasedRun,
	type Placement,
	reservationOf,
	reserved
} from "#pg/lease.ts"
import { spawnedBy } from "#pg/make.fixtures.ts"
import { property } from "#property.ts"
import { Scratch } from "#resources/scratch.ts"
import { askedLeasesOf } from "#runner/leases.ts"
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
						const first = Arr.headNonEmpty(family).lease
						const lineOf = Effect.map(queuedIn(first), (line) => line.length)
						const shielding = Effect.map(
							Effect.forEach(family, (member) => shieldsIn(member.lease)),
							Arr.some((shields) => shields.length > 0)
						)
						const release = yield* Deferred.make<void>()
						const holding = yield* of(held)
						const holder = yield* heldUntil(holding, release)
						yield* Deferred.await(holder)
						const never = yield* Deferred.make<void>()
						const waiting = yield* of(large)
						const queued = yield* heldUntil(waiting, never)
						yield* awaitFact(
							Effect.map(shielding, (shields) => (shields ? Option.some(true) : Option.none()))
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
							Effect.map(Effect.all([started, lineOf]), ([done, waiters]) =>
								done.length + waiters >= small ? Option.some(done.length) : Option.none()
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
				original: '\tflock($lease->{choose}, LOCK_EX) or fail("flock: $!");\n\tmy $fit = fits();\n',
				replacement:
					'\tflock($lease->{queue}, LOCK_EX) or fail("flock: $!");\n\tmy $fit = fits();\n',
				why: "Every lease takes the family's queue before it looks, which the run that waits holds while it waits, as a run held the cluster's gate (PERFIO-push held 5491's gate and slot 0 for 17 minutes with 3 slots free, every run of one worker behind it): the runs that fit wait behind it; the property fails."
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
							() =>
								Effect.gen(function* () {
									const shield = yield* awaitFact(shieldIn(lease))
									yield* Effect.acquireRelease(signalled(shield.waiter, "SIGSTOP"), () =>
										signalled(shield.waiter, "SIGCONT")
									)
									yield* awaitFact(stopped(shield.waiter))
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
												done || waiters >= slots ? Option.some(true) : Option.none()
										)
									)
									yield* signalled(shield.waiter, "SIGCONT")
									const taker = yield* awaitFact(holderOf(lease, shield.slot))
									return taker === shield.waiter
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
			name: "the run that holds the family's queue is handed each slot it waits for when that slot is let go, though the child that waits for it is stopped then and another run looks for a free slot before it wakes, and holds once it has them all"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/scripts/hold.pl",
				original: "\t\t\tnext unless taken_now($slots[$at]{door});\n",
				replacement: "",
				why: "A lease takes a free slot whatever its door, so a run that looks for one in the instant between a slot's release and the queue's holder's child waking takes the slot it waits for, and the queue's holder may wait for ever while runs that fit keep coming; the property fails."
			}
		]
	}
)

export const waitersInOrder = property.explore(
	(source) => {
		const slots = source.draw(int(3, 4))
		const medium = source.draw(int(1, slots - 2))
		return {
			slots,
			medium,
			later: Array.from({ length: medium }, (_, at) => (at === 0 ? 1 : source.draw(int(1, 2))))
		}
	},
	{
		needs: { dir: Scratch.dir, checkout: Checkout.dir },
		situations: [],
		check:
			({ dir }) =>
			({ slots, medium, later }) =>
				Effect.scoped(
					Effect.gen(function* () {
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
						const order = yield* Ref.make<ReadonlyArray<string>>([])
						const finishing = (name: string, held: Deferred.Deferred<Placement, LeaseFailed>) =>
							Effect.forkScoped(
								Effect.andThen(Deferred.await(held), Ref.update(order, Arr.append(name)))
							)
						const releaseMedium = yield* Deferred.make<void>()
						const mediumRun = yield* of(medium)
						const mediumHeld = yield* heldUntil(mediumRun, releaseMedium)
						yield* finishing("the medium run", mediumHeld)
						yield* awaitFact(
							Effect.map(shieldsIn(lease), (shields) =>
								shields.length > 0 ? Option.some(true) : Option.none()
							)
						)
						const queued = queuedIn(lease)
						const largeRun = yield* of(slots - 1)
						const largeHeld = yield* heldUntil(largeRun, never)
						yield* finishing("the large run", largeHeld)
						yield* awaitFact(
							Effect.map(queued, (waiting) =>
								waiting.length > 0 ? Option.some(true) : Option.none()
							)
						)
						const churned = Array.from({ length: slots - 1 }, (_, at) => `${at + 1}.lock`)
						const kill = (slot: string) =>
							Effect.flatMap(awaitFact(holderOf(lease, slot)), (pid) => signalled(pid, "SIGKILL"))
						const newcomers = yield* Effect.forEach(
							Arr.zip(Arr.take(churned, medium), later),
							([freed, need]) =>
								Effect.gen(function* () {
									yield* kill(freed)
									const before = yield* queued
									const newcomerRun = yield* of(need)
									const newcomer = yield* heldUntil(newcomerRun, never)
									yield* finishing("a newcomer", newcomer)
									yield* awaitFact(
										Effect.map(Effect.all([Deferred.isDone(newcomer), queued]), ([done, waiting]) =>
											done || Arr.some(waiting, (pid) => !Arr.contains(before, pid))
												? Option.some(true)
												: Option.none()
										)
									)
									return newcomer
								})
						)
						const first = yield* awaitFact(
							Effect.map(
								Effect.all([Ref.get(order), Effect.forEach(newcomers, Deferred.isDone)]),
								([finished, arrived]) =>
									Arr.isReadonlyArrayNonEmpty(finished) || Arr.some(arrived, (held) => held)
										? Option.some(finished)
										: Option.none()
							)
						)
						assert.deepEqual(first, ["the medium run"])
						yield* Deferred.succeed(releaseMedium, undefined)
						yield* Effect.forEach(Arr.drop(churned, medium), kill, { discard: true })
						const finished = yield* awaitFact(
							Effect.map(Ref.get(order), (done) =>
								Arr.contains(done, "the large run") ? Option.some(done) : Option.none()
							)
						)
						assert.deepEqual(finished, ["the medium run", "the large run"])
					})
				),
		oracle: {
			kind: "specification",
			name: "runs waiting for a family complete in the order they came, the older first (a medium run of one or two slots, then a large one), while later runs of one and two slots keep coming and one slot stays held: each slot let go while the queue's holder waits is its own until it holds its need, never a newer run's, and the queue serves its waiters in the order they came, never a newer one first"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/scripts/hold.pl",
				original: "\t\t\tcollector([$member, $at]);\n",
				replacement: "\t\t\tcollector([$member, $at]);\n\t\t\treturn;\n",
				why: "The queue's holder shields one slot at a time, as it did, bound to that slot's holder however long it holds, while every other slot let go goes to a newer run of one slot (CLOSEDBITS' fin/fold, 10 slots, behind a stream of small runs on 5491): the newer runs start and the older waits; the property fails."
			}
		]
	}
)

export const headHoldsItsNeed = property.explore(
	(source) => {
		const slots = source.draw(int(3, 4))
		return { slots, need: source.draw(int(1, slots - 2)) }
	},
	{
		needs: { dir: Scratch.dir, checkout: Checkout.dir },
		situations: [],
		check:
			({ dir }) =>
			({ slots, need }) =>
				Effect.scoped(
					Effect.gen(function* () {
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
						const run = yield* of(need)
						const queued = yield* heldUntil(run, never)
						const shields = yield* awaitFact(
							Effect.map(shieldsIn(lease), (found) =>
								Arr.isReadonlyArrayNonEmpty(found) && found.length === slots
									? Option.some(found)
									: Option.none()
							)
						)
						const head = Arr.headNonEmpty(shields).holder
						yield* Effect.acquireRelease(signalled(head, "SIGSTOP"), () =>
							signalled(head, "SIGCONT")
						)
						yield* awaitFact(stopped(head))
						const freed = Array.from({ length: need + 1 }, (_, at) => `${at + 1}.lock`)
						yield* Effect.forEach(
							freed,
							(slot) =>
								Effect.gen(function* () {
									const previous = yield* awaitFact(holderOf(lease, slot))
									yield* signalled(previous, "SIGKILL")
									yield* awaitFact(
										Effect.map(holderOf(lease, slot), (holder) =>
											Option.exists(holder, (pid) => pid !== previous)
												? Option.some(true)
												: Option.none()
										)
									)
								}),
							{ discard: true }
						)
						yield* signalled(head, "SIGCONT")
						const placement = yield* Deferred.await(queued)
						const free = yield* Effect.forEach(freed, (slot) =>
							Effect.map(holderOf(lease, slot), Option.isNone)
						)
						assert.deepEqual(
							{ held: placement.length, free: Arr.filter(free, (isFree) => isFree).length },
							{ held: need, free: 1 }
						)
					})
				),
		oracle: {
			kind: "specification",
			name: "the queue's holder holds exactly its need when it starts, letting go at once of every slot its children took past it, which runs of one slot then take"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/scripts/hold.pl",
				original: "\tif (@mine >= $lease->{need}) {\n",
				replacement: "\tif (0) {\n",
				why: "The queue's holder keeps every slot its children took, past its need, and sits on slots it will not use while runs of one slot wait for them; the property fails."
			}
		]
	}
)

export const nestedNeverQueues = property.explore(
	(source) => {
		const slots = source.draw(int(1, 3))
		return { slots, head: source.draw(int(1, slots)), more: source.draw(int(1, slots)) }
	},
	{
		needs: { dir: Scratch.dir, checkout: Checkout.dir },
		situations: [],
		check:
			({ dir }) =>
			({ slots, head, more }) =>
				Effect.scoped(
					Effect.gen(function* () {
						const scratch = yield* dir
						const family = yield* familyIn(scratch, 1, slots)
						const lease = Arr.headNonEmpty(family).lease
						const of = (workers: number) =>
							reservationOf(1, family, { perLessee: 1, outside: 0 }, workers)
						const whole = yield* of(slots)
						const holding = yield* Scope.make()
						const enclosing = yield* Scope.provide(leasedRun(whole), holding)
						const never = yield* Deferred.make<void>()
						const headRun = yield* of(head)
						const headHeld = yield* heldUntil(headRun, never)
						yield* awaitFact(
							Effect.map(shieldsIn(lease), (shields) =>
								shields.length > 0 ? Option.some(true) : Option.none()
							)
						)
						const before = yield* queuedIn(lease)
						const nested = yield* of(more)
						const asked = yield* Deferred.make<Placement, LeaseFailed>()
						yield* Effect.forkScoped(Deferred.into(Effect.scoped(leasedRun(nested)), asked))
						const answer = yield* awaitFact(
							Effect.map(Effect.all([Deferred.isDone(asked), queuedIn(lease)]), ([done, queued]) =>
								done
									? Option.some("answered")
									: Arr.some(queued, (pid) => !Arr.contains(before, pid))
										? Option.some("queued behind the head")
										: Option.none()
							)
						)
						const drawn =
							answer === "answered" ? yield* Effect.asSome(Deferred.await(asked)) : Option.none()
						yield* Scope.close(holding, Exit.void)
						const placement = yield* Deferred.await(headHeld)
						assert.deepEqual(
							{ answer, drawn, headHolds: placement.length },
							{ answer: "answered", drawn: Option.some(enclosing), headHolds: head }
						)
					})
				),
		oracle: {
			kind: "specification",
			name: "a run of its own inside one that holds its family's lease, while the family's queue's head waits for that lease's slots, is answered at once with where the enclosing lease put its workers, never queued behind the head, and the head holds once the enclosing run lets go"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/pg/lease.ts",
				original: "\t\tconst enclosing = Rec.get(leases, family)\n",
				replacement: "\t\tconst enclosing = Option.none<Placement>()\n",
				why: "A run inside a run that holds the family's lease asks for more of its slots and queues behind the family's head, which waits for the enclosing run's own slots: neither moves (metis's 5451, 2026-11-20: a land train's gate held 56 slots and the queue, whose head waited for a hand run's last 8, whose worker waited behind it); the property fails, the ask queued behind the head."
			}
		]
	}
)

export const nestedSameUnderLoad = property.explore(
	(source) => {
		const slots = source.draw(int(1, 3))
		const first = source.draw(int(0, 1))
		const rest = Array.from({ length: source.draw(int(0, 2 * slots - 1)) }, () =>
			source.draw(int(0, 1))
		)
		return { slots, answered: [first, ...rest] as const, workers: source.draw(int(1, 2 * slots)) }
	},
	{
		needs: { dir: Scratch.dir, checkout: Checkout.dir },
		situations: [],
		check:
			({ dir }) =>
			({ slots, answered, workers }) =>
				Effect.scoped(
					Effect.gen(function* () {
						const scratch = yield* dir
						yield* leasedKept
						const family = yield* familyIn(scratch, 2, slots)
						const of = (count: number) =>
							reservationOf(1, family, { perLessee: 1, outside: 0 }, count)
						const asking = askedLeasesOf((reservation): Effect.Effect<void> =>
							asking.answered(familyOf(reservation), { kind: "leased", members: answered })
						)
						const run = yield* of(answered.length)
						yield* asking.service.reserve(run)
						const nested = yield* of(workers)
						const idle = yield* Effect.scoped(leasedRun(nested))
						const whole = yield* of(2 * slots)
						const never = yield* Deferred.make<void>()
						const wholeHeld = yield* heldUntil(whole, never)
						yield* Deferred.await(wholeHeld)
						const asked = yield* Deferred.make<Placement, LeaseFailed>()
						yield* Effect.forkScoped(Deferred.into(Effect.scoped(leasedRun(nested)), asked))
						const waiting = Effect.map(
							Effect.forEach(family, (member) => blockedOn(member.lease)),
							(blocked): Option.Option<Placement | "waits"> =>
								Arr.some(blocked, (count) => count > 0) ? Option.some("waits") : Option.none()
						)
						const saturated = yield* awaitFact(
							Effect.flatMap(
								Deferred.isDone(asked),
								(
									done
								): Effect.Effect<
									Option.Option<Placement | "waits">,
									LeaseFailed,
									FileSystem.FileSystem
								> => (done ? Effect.asSome(Deferred.await(asked)) : waiting)
							)
						)
						assert.deepEqual(
							{ idle, saturated },
							{ idle: answered, saturated: answered },
							"a run inside one whose lease is answered is answered alike on an idle family and on one whose every slot another run holds"
						)
					})
				),
		oracle: {
			kind: "specification",
			name: "a run of its own inside a worker whose run's lease is answered is answered with where that lease put the run's workers, whatever its width, alike when the family's slots are free and when another run holds every one"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/runner/leases.ts",
				original: "\t\t\t\t\t\t\tmarkedLeased(family, answer.members),\n",
				replacement: "\t\t\t\t\t\t\tEffect.void,\n",
				why: "A worker whose run's lease is answered says nothing of it to the processes it starts, so a run one of its cases starts reserves the family's slots again: on an idle family it holds slots of its own, wherever they fall, and on a saturated one it waits for slots another run holds; the property fails, the two answers unlike."
			}
		]
	}
)

export const queueServesInArrival = property.explore(
	(source) => {
		const slots = source.draw(int(1, 3))
		return { slots, later: source.draw(int(1, slots)) }
	},
	{
		needs: { dir: Scratch.dir, checkout: Checkout.dir },
		situations: [],
		check:
			({ dir }) =>
			({ slots, later }) =>
				Effect.scoped(
					Effect.gen(function* () {
						const scratch = yield* dir
						const family = yield* familyIn(scratch, 1, slots)
						const lease = Arr.headNonEmpty(family).lease
						const of = (workers: number) =>
							reservationOf(1, family, { perLessee: 1, outside: 0 }, workers)
						const never = yield* Deferred.make<void>()
						const release = yield* Deferred.make<void>()
						const one = yield* of(1)
						const holders = yield* Effect.forEach(
							Array.from({ length: slots }, (_, at) => at),
							() => heldUntil(one, release)
						)
						yield* Effect.forEach(holders, Deferred.await, { discard: true })
						const whole = yield* of(slots)
						const head = yield* heldUntil(whole, never)
						yield* awaitFact(
							Effect.map(shieldsIn(lease), (shields) =>
								shields.length > 0 ? Option.some(true) : Option.none()
							)
						)
						const queuing = (workers: number) =>
							Effect.gen(function* () {
								const before = yield* queuedIn(lease)
								const run = yield* of(workers)
								yield* heldUntil(run, never)
								return yield* awaitFact(
									Effect.map(queuedIn(lease), (queued) =>
										Arr.findFirst(queued, (pid) => !Arr.contains(before, pid))
									)
								)
							})
						const older = yield* queuing(later)
						const newer = yield* queuing(later)
						yield* Effect.acquireRelease(signalled(older, "SIGSTOP"), () =>
							signalled(older, "SIGCONT")
						)
						yield* awaitFact(stopped(older))
						yield* Deferred.succeed(release, undefined)
						yield* Deferred.await(head)
						const waits = yield* turnWaits(lease)
						const queueHolder = yield* holderOf(lease, "gate.lock")
						assert.deepEqual(
							{
								newerBehindOlder: Arr.some(
									waits,
									(wait) => wait.holder === older && wait.waiter === newer
								),
								queueHolder
							},
							{ newerBehindOlder: true, queueHolder: Option.none() }
						)
					})
				),
		oracle: {
			kind: "specification",
			name: "the family's queue serves its waiters in the order they came: once its holder holds its need, a newer waiter waits behind the older one, though that older one is stopped and the queue is free, never taking the queue first"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/scripts/hold.pl",
				original: "\tmy ($turn, $ahead) = $fit ? () : ticket();\n",
				replacement: "\tmy ($turn, $ahead) = ();\n",
				why: "Leases that wait all block on the queue, as they did, and flock(2) serves whichever wakes first, so a newer one takes the queue before an older one, and a stream of newer leases keeps an older one waiting for ever; the property fails, the newer waiter on the queue."
			}
		]
	}
)
