/**
 * A cluster's lease (pg/lease.ts): runs that reserve more of a member's slots together than it has wait in a queue in
 * the kernel and all finish, never holding more slots at once than the member admits, each run's reservation held by
 * one holder process for the run's life, the toolchain's holder of kernel locks (scripts/hold.pl), started from the
 * checkout (Checkout.dir, so a mutant of the holder reaches it on disk). Each run holds its reservation until every run
 * holds or waits in the kernel (lease.fixtures.ts blockedOn), so the runs overlap as far as the lease lets them. Oracle:
 * the specification, stated in the check.
 */
import { Array as Arr, Effect, FileSystem, Option, Ref } from "effect"
import { assert } from "#assert.ts"
import { awaitFact } from "#fact.ts"
import { int } from "#gen.ts"
import { Checkout } from "#mutate/checkout.ts"
import { blockedOn, SPREAD_MEMBERS, spreadFamily } from "#pg/lease.fixtures.ts"
import { reservationOf, reserved } from "#pg/lease.ts"
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
		situations: ["more runs than fit at once", "runs that fit at once"],
		check:
			({ dir }, c) =>
			({ slots, need, runs }) =>
				Effect.gen(function* () {
					c.note(runs * need > slots ? "more runs than fit at once" : "runs that fit at once")
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
			name: "runs that reserve more of a member's slots than it has wait in line and all finish, never holding more than it admits, one holder each"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/scripts/hold.pl",
				original: "if (flock($files[$at], $claim->{lock} | LOCK_NB)) {",
				replacement: "if (1) {",
				why: "A reservation takes slots without locking them, so runs together hold more than the member admits, as two gates at once exhausted 5441; the property fails."
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
		situations: ["runs fewer than the family's members", "runs more than the family's members"],
		check:
			({ dir }, c) =>
			({ runs, properties }) =>
				Effect.gen(function* () {
					const workers = runWorkers(properties)
					c.note(
						workers < SPREAD_MEMBERS
							? "runs fewer than the family's members"
							: "runs more than the family's members"
					)
					const scratch = yield* dir
					const family = yield* spreadFamily(scratch)
					const reservation = yield* reservationOf(1, family, { perLessee: 1, outside: 0 }, workers)
					const holding = yield* Ref.make(0)
					const most = yield* Ref.make(0)
					const finished = yield* Ref.make(0)
					const blocked = Effect.map(
						Effect.forEach(family, (member) => blockedOn(member.lease)),
						Arr.reduce(0, (sum, waiters: number) => sum + waiters)
					)
					yield* Effect.forEach(
						Array.from({ length: runs }, (_, at) => at),
						() =>
							Effect.scoped(
								Effect.gen(function* () {
									yield* reserved(reservation)
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
					assert.deepEqual(
						{
							leased: Arr.reduce(reservation.members, 0, (sum, member) => sum + member.need),
							reached: reservation.members.length,
							atOnce: yield* Ref.get(most)
						},
						{
							leased: Math.min(workers, properties),
							reached: Math.min(workers, SPREAD_MEMBERS),
							atOnce: runs
						}
					)
				}),
		oracle: {
			kind: "specification",
			name: "a run of k properties leases a slot for each of its workers, never more than k, spread over the family's members, so runs whose workers fit the family hold it all at once"
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
				file: "packages/testing/src/pg/lease.ts",
				original: "\tMath.floor(workers / members) + (at < workers % members ? 1 : 0)",
				replacement: "\tMath.ceil(workers / members)",
				why: "Every member is leased the run's share rounded up, as it was, whether a worker reaches it or not: a run of one worker took a slot on each of four members; the property fails."
			}
		]
	}
)
