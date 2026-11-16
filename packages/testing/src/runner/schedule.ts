import { Array as Arr, Option, Order, String as Str } from "effect"
import { runOfLabel } from "#runner/stack.ts"

/**
 * What the pool's scheduling knows and chooses: the queue, which modules each worker holds (it was sent a unit of a
 * property declared there, so it imported that module and readied that property), and what the workers measured: each
 * property's mean case time and each module's readying time (its import and its properties' needs opened, per worker
 * that readied it). An idle worker takes queued units of a module it holds first; else of a module no worker holds,
 * which some worker must ready; else of a module whose queued work is more than its holders drain within the time a
 * further worker would spend readying it, so a module spreads to another worker only when that worker will find work
 * left once it is ready. Stealing keeps the same order: half a busy worker's unstarted units of a module the thief
 * holds; else, of another module, the share that balances the victim's end against the thief's, its readying
 * included, when the thief would end before the victim alone. Every number a choice reads is a measurement or a count;
 * which worker runs a case never reaches its result.
 *
 * A choice reads the pool's workers on demand (View), and an event re-decides only what it can change: a finished
 * unit gives its own worker its next units, spreads its module to idle workers while the module outgrows its holders,
 * and lets the module's idle holders steal from the worker it fed; units queued or put back, a worker ready or a
 * revocation answered re-decide every idle worker (feedAll, afterFinished).
 */

/**
 * How much work the runner's pool puts in one message to a worker: it fills each message with cases until their
 * expected run time reaches this, so the round trip that carries them stays a small part of the work they do. Below it,
 * the pool spends its time messaging; far above it, one slow message leaves the other workers idle at a run's end.
 *
 * @limitKind measured
 * @owner the choice-stream testing library's runner (its worker pool, the work per message)
 * @unit milliseconds of expected case run time
 * @scope one message the runner's pool sends one worker
 * @evidence packages/testing/out/message-target/rtt-20261116.txt in grizzle's TESTSYS lane CORE's toolchain clone, the
 *   uncommitted record of its round-trip probe: a one-case message from the pool to a worker and the worker's answer,
 *   timed on the pool's side
 * @observed 2026-11-16 07:32 UTC
 * @environment cassowary, Ubuntu 26.04.1 (Linux 7.0.0-1016-aws) on an AWS Graviton3 (Neoverse-V1, arm64) instance with
 *   64 logical CPUs and 247 GiB, Node 26.13.1; load average 22 to 49 from other sessions
 * @workload one-case messages round-tripped between the runner's pool and one worker, the runner at toolchain 995e385
 * @result every round trip took 0.41 to 0.55 ms
 * @decision the round trip stays under 5% of a message's work when the work is at least 20 times the slowest round
 *   trip: 0.55 ms / 0.05 is 11 ms, and 12 ms, the next whole millisecond, leaves 4.6%. Until this limit existed the
 *   pool sent each property a fair share of the queue per message, with no number
 * @revalidate a Node upgrade; a different machine; a change to the message's format or the worker transport; a run
 *   whose workers sit idle at its end while one message's cases finish
 */
const messageWorkMillis = 12

/**
 * A unit as scheduling sees it: its id, which orders the queue (a unit queued earlier has a smaller id, a unit put back
 * keeps its id), its property (a run label), the module that property is declared in, and how many cases it holds.
 */
export type Scheduled = Readonly<{ id: number; property: string; module: string; cases: number }>

/** The test module a run label's property is declared in: its identity before the `#`. */
export const moduleOfLabel = (label: string): string =>
	Arr.headNonEmpty(Str.split(runOfLabel(label).id, "#"))

/**
 * The pool's workers as a choice reads them, on demand: how many there are; the units each was sent and has not
 * finished (the one it runs among them); those it has not started; whether they may be stolen now (it is ready and no
 * revocation of them is under way); and whether it is idle (ready, sent nothing, waiting for no revocation).
 */
export type View<U> = Readonly<{
	workers: number
	sentOf: (worker: number) => ReadonlyArray<U>
	unstartedOf: (worker: number) => ReadonlyArray<U>
	stealable: (worker: number) => boolean
	idle: (worker: number) => boolean
}>

/**
 * What an idle worker is given: queued units of one property; the unstarted tail of a busy worker's units, which the
 * pool revokes from it and hands to this worker; or nothing yet.
 */
export type Choice<U> =
	| Readonly<{ kind: "take"; units: Arr.NonEmptyReadonlyArray<U> }>
	| Readonly<{ kind: "steal"; victim: number; units: Arr.NonEmptyReadonlyArray<U> }>
	| Readonly<{ kind: "wait" }>

/** What the pool does with a choice for a worker: sends the units, or revokes the tail for it. */
export type Apply<U> = (worker: number, choice: Choice<U>) => void

/** The pool's scheduling state and its choices, for a pool of `workers` workers. */
export type Scheduler<U extends Scheduled> = Readonly<{
	/** Queues a new unit, after every unit queued so far. */
	enqueue: (unit: U) => void
	/** Puts units back in the queue, each at its place by id: they were queued before the units queued after them. */
	requeue: (units: ReadonlyArray<U>) => void
	/** Takes these units out of the queue, unrun: their search no longer reads them. */
	drop: (ids: ReadonlySet<number>) => void
	/** How many units are queued. */
	queued: () => number
	/** Every queued unit, oldest first, taken out of the queue: what a pool that can run nothing gives back lost. */
	drain: () => ReadonlyArray<U>
	/**
	 * What idle worker `worker` is given: a take is out of the queue and its module held by the worker from now on; a
	 * steal names its victim, and the pool hands the worker the units it gets back (`hand`).
	 */
	choose: (worker: number, view: View<U>) => Choice<U>
	/** Whether a module's queued work outgrows what its holders drain within its measured readying, now. */
	outgrows: (module: string, view: View<U>) => boolean
	/** One message of the module's oldest queued property for `worker`, out of the queue, its module held from now on. */
	take: (worker: number, module: string) => Option.Option<Arr.NonEmptyReadonlyArray<U>>
	/** Worker `worker` was handed these units (a steal's), and holds their module from now on. */
	hand: (worker: number, units: ReadonlyArray<U>) => void
	/** Whether worker `worker` holds `module`. */
	holds: (worker: number, module: string) => boolean
	/** A property's cases finished: how many, and their milliseconds. */
	finished: (property: string, cases: number, millis: number) => void
	/** Worker `worker` readied a property of `module` in `millis`: the module's import when new there, and its needs. */
	readied: (worker: number, module: string, millis: number) => void
	/** Worker `worker` was replaced by a fresh process: it holds nothing and has readied nothing. */
	forget: (worker: number) => void
	/** How many modules each worker holds, by index. */
	held: () => ReadonlyArray<number>
}>

/** A running sum: how many, and their milliseconds. */
type Sum = { count: number; millis: number }

/** Units by id, oldest first. */
const byId = Order.mapInput(Order.Number, (unit: Scheduled) => unit.id)

/** One module's queue: its units by property, each oldest first, its queued cases by property, and its unit count. */
type ModuleQueue<U> = {
	readonly byProperty: Map<string, Array<U>>
	readonly cases: Map<string, number>
	units: number
}

/** Inserts a unit into units ordered by id, at its place. */
const insertById = <U extends Scheduled>(units: Array<U>, unit: U) => {
	let low = 0
	let high = units.length
	while (low < high) {
		const middle = (low + high) >>> 1
		if ((units[middle]?.id ?? 0) < unit.id) {
			low = middle + 1
		} else {
			high = middle
		}
	}
	units.splice(low, 0, unit)
}

/** The scheduler of a pool of `workers` workers, holding nothing and having measured nothing. */
export const schedulerOf = <U extends Scheduled>(workers: number): Scheduler<U> => {
	const queue = new Map<string, ModuleQueue<U>>()
	const holds: Array<Set<string>> = Array.from({ length: workers }, () => new Set())
	const holders = new Map<string, Set<number>>()
	const readiedOn: Array<Set<string>> = Array.from({ length: workers }, () => new Set())
	const cases = new Map<string, Sum>()
	const readyings = new Map<string, Sum>()
	let total = 0

	/** The expected work of `count` cases of a property at its mean case time; none counted before it is measured. */
	const workOfCases = (property: string, count: number): number => {
		const sum = cases.get(property)
		return sum === undefined ? 0 : (count * sum.millis) / sum.count
	}

	/** The expected work of units. */
	const workOf = (units: ReadonlyArray<U>): number => {
		let work = 0
		for (const unit of units) {
			work += workOfCases(unit.property, unit.cases)
		}
		return work
	}

	const moduleQueueOf = (module: string): ModuleQueue<U> => {
		const known = queue.get(module)
		if (known !== undefined) {
			return known
		}
		const made: ModuleQueue<U> = { byProperty: new Map(), cases: new Map(), units: 0 }
		queue.set(module, made)
		return made
	}

	const queueIn = (unit: U, place: (units: Array<U>, unit: U) => void) => {
		const queued = moduleQueueOf(unit.module)
		const units = queued.byProperty.get(unit.property) ?? []
		place(units, unit)
		queued.byProperty.set(unit.property, units)
		queued.cases.set(unit.property, (queued.cases.get(unit.property) ?? 0) + unit.cases)
		queued.units += 1
		total += 1
	}

	/** Takes a module's queue out of the scheduling once it holds no unit. */
	const settled = (module: string, queued: ModuleQueue<U>) => {
		if (queued.units === 0) {
			queue.delete(module)
		}
	}

	/** The oldest queued unit's id of a module, and its property. */
	const headOf = (queued: ModuleQueue<U>): Option.Option<U> => {
		let head: Option.Option<U> = Option.none()
		for (const units of queued.byProperty.values()) {
			const first = units[0]
			if (
				first !== undefined &&
				Option.match(head, { onNone: () => true, onSome: (other) => first.id < other.id })
			) {
				head = Option.some(first)
			}
		}
		return head
	}

	/** The expected work queued of a module. */
	const queuedWorkOf = (queued: ModuleQueue<U>): number => {
		let work = 0
		for (const [property, count] of queued.cases) {
			work += workOfCases(property, count)
		}
		return work
	}

	const hold = (worker: number, module: string) => {
		holds[worker]?.add(module)
		const holding = holders.get(module) ?? new Set<number>()
		holding.add(worker)
		holders.set(module, holding)
	}

	/**
	 * Whether a module's queued work is more than its holders drain within the time a further worker spends readying it
	 * (its measured readying): each holder drains what that time leaves after the work it was already sent. A module
	 * not yet readied anywhere has no measured readying, and spreads to no further worker until it has.
	 */
	const outgrows = (module: string, view: View<U>): boolean => {
		const readying = readyings.get(module)
		const queued = queue.get(module)
		if (readying === undefined || queued === undefined) {
			return false
		}
		const within = readying.millis / readying.count
		let drained = 0
		for (const holder of holders.get(module) ?? []) {
			drained += Math.max(0, within - workOf(view.sentOf(holder)))
		}
		return queuedWorkOf(queued) > drained
	}

	/** The module whose oldest queued unit is the oldest of those `admits`. */
	const oldestOf = (admits: (module: string) => boolean): Option.Option<string> => {
		let best: Option.Option<readonly [string, number]> = Option.none()
		for (const [module, queued] of queue) {
			const head = headOf(queued)
			if (
				Option.isSome(head) &&
				Option.match(best, { onNone: () => true, onSome: ([, id]) => head.value.id < id }) &&
				admits(module)
			) {
				best = Option.some([module, head.value.id])
			}
		}
		return Option.map(best, ([module]) => module)
	}

	/**
	 * How many units of `property` one message carries: as many as fill the work a message aims for at the property's
	 * mean case time, one while it has none, and never more than its fair share of what is queued.
	 */
	const perMessage = (property: string): number => {
		const sum = cases.get(property)
		if (sum === undefined) {
			return 1
		}
		const mean = sum.millis / sum.count
		const fair = Math.max(1, Math.ceil(total / workers))
		return Math.max(
			1,
			Math.min(fair, Math.floor(messageWorkMillis / Math.max(mean, Number.MIN_VALUE)))
		)
	}

	const take = (worker: number, module: string): Option.Option<Arr.NonEmptyReadonlyArray<U>> => {
		const queued = queue.get(module)
		if (queued === undefined) {
			return Option.none()
		}
		return Option.flatMap(headOf(queued), (head) => {
			const units = queued.byProperty.get(head.property) ?? []
			const taken = units.splice(0, perMessage(head.property))
			for (const unit of taken) {
				queued.cases.set(unit.property, (queued.cases.get(unit.property) ?? 0) - unit.cases)
				queued.units -= 1
				total -= 1
			}
			if (units.length === 0) {
				queued.byProperty.delete(head.property)
				queued.cases.delete(head.property)
			}
			settled(module, queued)
			hold(worker, module)
			return Arr.isReadonlyArrayNonEmpty(taken) ? Option.some(taken) : Option.none()
		})
	}

	/**
	 * How many of a busy worker's unstarted units, from its tail, a thief would take. Of a module the thief holds, half
	 * of them. Of another, which the thief must ready first: the victim keeps the oldest units up to half of its
	 * unstarted work and the module's readying, and the thief takes the rest, when that leaves the victim more than the
	 * readying to do, so the thief ends before the victim alone would; an unmeasured readying admits no such steal.
	 */
	const tailOf = (thief: number, unstarted: ReadonlyArray<U>): number => {
		const first = unstarted[0]
		if (first === undefined) {
			return 0
		}
		if (holds[thief]?.has(first.module) ?? false) {
			return Math.floor(unstarted.length / 2)
		}
		const readying = readyings.get(first.module)
		if (readying === undefined) {
			return 0
		}
		const within = readying.millis / readying.count
		const keep = (workOf(unstarted) + within) / 2
		let kept = 0
		let work = 0
		for (const unit of unstarted) {
			const next = work + workOfCases(unit.property, unit.cases)
			if (next > keep) {
				break
			}
			work = next
			kept += 1
		}
		return work > within ? unstarted.length - kept : 0
	}

	/** The steal for an idle worker: the longest tail of a module it holds, else the longest of another module. */
	const stealFor = (thief: number, view: View<U>): Choice<U> => {
		let best: Option.Option<Readonly<{ victim: number; count: number; held: boolean }>> =
			Option.none()
		for (let victim = 0; victim < view.workers; victim += 1) {
			if (victim === thief || !view.stealable(victim)) {
				continue
			}
			const unstarted = view.unstartedOf(victim)
			const count = tailOf(thief, unstarted)
			const first = unstarted[0]
			if (count === 0 || first === undefined) {
				continue
			}
			const held = holds[thief]?.has(first.module) ?? false
			if (
				Option.match(best, {
					onNone: () => true,
					onSome: (other) => (held && !other.held) || (held === other.held && count > other.count)
				})
			) {
				best = Option.some({ victim, count, held })
			}
		}
		return Option.match(best, {
			onNone: () => ({ kind: "wait" }),
			onSome: ({ victim, count }) => {
				const unstarted = view.unstartedOf(victim)
				const units = unstarted.slice(unstarted.length - count)
				return Arr.isReadonlyArrayNonEmpty(units)
					? { kind: "steal", victim, units }
					: { kind: "wait" }
			}
		})
	}

	return {
		enqueue: (unit) => queueIn(unit, (units, queued) => units.push(queued)),
		requeue: (units) => {
			for (const unit of units) {
				queueIn(unit, insertById)
			}
		},
		drop: (ids) => {
			for (const [module, queued] of queue) {
				for (const [property, units] of queued.byProperty) {
					const kept = Arr.filter(units, (unit) => !ids.has(unit.id))
					for (const unit of units) {
						if (!ids.has(unit.id)) {
							continue
						}
						queued.cases.set(property, (queued.cases.get(property) ?? 0) - unit.cases)
						queued.units -= 1
						total -= 1
					}
					if (kept.length === 0) {
						queued.byProperty.delete(property)
						queued.cases.delete(property)
					} else {
						queued.byProperty.set(property, kept)
					}
				}
				settled(module, queued)
			}
		},
		queued: () => total,
		drain: () => {
			const drained: Array<U> = []
			for (const queued of queue.values()) {
				for (const units of queued.byProperty.values()) {
					for (const unit of units) {
						drained.push(unit)
					}
				}
			}
			queue.clear()
			total = 0
			return Arr.sort(drained, byId)
		},
		choose: (worker, view) => {
			const held = holds[worker]
			const module = Option.orElse(
				Option.orElse(
					oldestOf((candidate) => held?.has(candidate) ?? false),
					() => oldestOf((candidate) => (holders.get(candidate)?.size ?? 0) === 0)
				),
				() => oldestOf((candidate) => outgrows(candidate, view))
			)
			return Option.match(
				Option.flatMap(module, (chosen) => take(worker, chosen)),
				{
					onNone: () => stealFor(worker, view),
					onSome: (units) => ({ kind: "take", units })
				}
			)
		},
		outgrows,
		take,
		hand: (worker, units) => {
			for (const unit of units) {
				hold(worker, unit.module)
			}
		},
		holds: (worker, module) => holds[worker]?.has(module) ?? false,
		finished: (property, count, millis) => {
			const sum = cases.get(property) ?? { count: 0, millis: 0 }
			sum.count += count
			sum.millis += millis
			cases.set(property, sum)
		},
		readied: (worker, module, millis) => {
			const sum = readyings.get(module) ?? { count: 0, millis: 0 }
			if (!(readiedOn[worker]?.has(module) ?? false)) {
				readiedOn[worker]?.add(module)
				sum.count += 1
			}
			sum.millis += millis
			readyings.set(module, sum)
		},
		forget: (worker) => {
			for (const module of holds[worker] ?? []) {
				holders.get(module)?.delete(worker)
			}
			holds[worker] = new Set()
			readiedOn[worker] = new Set()
		},
		held: () => Arr.map(holds, (modules) => modules.size)
	}
}

/** Gives every idle worker, in index order, what the scheduling chooses for it: after units queued or put back, a
 * worker ready, or a revocation answered, any worker's choice may have changed. */
export const feedAll = <U extends Scheduled>(
	scheduler: Scheduler<U>,
	view: View<U>,
	apply: Apply<U>
) => {
	for (let worker = 0; worker < view.workers; worker += 1) {
		if (view.idle(worker)) {
			const choice = scheduler.choose(worker, view)
			if (choice.kind !== "wait") {
				apply(worker, choice)
			}
		}
	}
}

/**
 * What a finished unit of `module` on `worker` changes, and only that: the worker, idle now, is given its next units;
 * the module, its measured case time moved, spreads to idle workers, one message each, while its queued work outgrows
 * its holders; and the module's idle holders may steal from the worker it fed.
 */
export const afterFinished = <U extends Scheduled>(
	scheduler: Scheduler<U>,
	view: View<U>,
	apply: Apply<U>,
	worker: number,
	module: string
) => {
	if (view.idle(worker)) {
		const choice = scheduler.choose(worker, view)
		if (choice.kind !== "wait") {
			apply(worker, choice)
		}
	}
	for (let other = 0; other < view.workers && scheduler.outgrows(module, view); other += 1) {
		if (view.idle(other)) {
			Option.map(scheduler.take(other, module), (units) => apply(other, { kind: "take", units }))
		}
	}
	for (let other = 0; other < view.workers; other += 1) {
		if (other !== worker && view.idle(other) && scheduler.holds(other, module)) {
			const choice = scheduler.choose(other, view)
			if (choice.kind !== "wait") {
				apply(other, choice)
			}
		}
	}
}
