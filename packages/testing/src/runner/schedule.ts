import { Array as Arr, Option, Order, String as Str } from "effect"
import { runOfLabel } from "#runner/stack.ts"

/**
 * What the pool's scheduling knows and chooses: the queue, which modules each worker holds (it was sent a unit of a
 * property declared there, so it imported that module and readied that property), and what the workers measured: each
 * property's mean case time (what a message is sized by), its mean occupancy a case (how long a unit held its worker,
 * as the pool saw it, round trip included: what a unit's work is reckoned by), and what readying costs, in two parts a
 * worker measures apart: each module's import, the least any worker took to import it, and each property's opening of
 * its needs (a template's plan, a seat's clones), the least any worker took to open them. The least, since it is what a
 * further worker pays once whatever the needs share is in place (a template built once on the cluster, which only the
 * first worker waits for). What a further worker spends readying a module's queued work is its import and the opening
 * of every property queued there, each of which it readies in turn; a module with a queued property no worker has
 * readied yet has no measured readying. An idle worker takes queued units of a module it holds first; else of a module
 * no worker holds, which some worker must ready; else of a module whose queued work, past what its holders drain
 * within the time a further worker would spend readying it, covers that time, so a module spreads to another worker
 * only when the work that worker finds left once it is ready is at least what it spent getting ready. Stealing keeps the same order: half a busy worker's unstarted units of a module the thief
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
export const messageWorkMillis = 12

/**
 * A unit as scheduling sees it: its id, which orders the queue (a unit queued earlier has a smaller id, a unit put back
 * keeps its id), its property (a run label), the module that property is declared in, and how many cases it holds.
 */
export type Scheduled = Readonly<{ id: number; property: string; module: string; cases: number }>

/** What starting a worker takes, as the workers measured it: milliseconds of wall time, and of its CPU. */
export type Start = Readonly<{ millis: number; cpu: number }>

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
	/** Whether a module's queued work left undrained by its holders covers a further worker's readying, now. */
	outgrows: (module: string, view: View<U>) => boolean
	/**
	 * How many workers that hold nothing the queue would give work to now: one for each queued module no worker holds,
	 * and, for each module whose work left undrained by its holders within a new worker's start (`starting`, its
	 * measured milliseconds and CPU; none before one started) and its readying covers that wait, and whose queued
	 * cases' CPU covers that start's and readying's CPU, as many as the undrained work holds that wait whole, so each
	 * further worker's share of it pays for its start and readying. A pool sized to its work forks no more.
	 */
	wanted: (view: View<U>, starting: Option.Option<Start>) => number
	/** One message of the module's oldest queued property for `worker`, out of the queue, its module held from now on. */
	take: (worker: number, module: string) => Option.Option<Arr.NonEmptyReadonlyArray<U>>
	/** The steal of idle worker `thief` from `victim` alone: its unstarted tail, as far as the thief may take it. */
	stealFrom: (thief: number, victim: number, view: View<U>) => Choice<U>
	/** Worker `worker` was handed these units (a steal's), and holds their module from now on. */
	hand: (worker: number, units: ReadonlyArray<U>) => void
	/** Whether worker `worker` holds `module`. */
	holds: (worker: number, module: string) => boolean
	/** Whether some worker holds `module`. */
	holdsAny: (module: string) => boolean
	/**
	 * A property's cases finished: how many, their milliseconds, and the CPU their worker spent on them; a unit that ran
	 * none (a count) measures nothing.
	 */
	finished: (property: string, cases: number, millis: number, cpu: number) => void
	/**
	 * How long a unit of a property held its worker, as the pool saw it: from when it was sent (or the worker's last unit
	 * finished, if later) to its answer, its readying taken out; with how many cases it held. A unit's work is reckoned
	 * by this, a case's round trip and the worker's turn included, not by its cases' own time alone. A worker's first
	 * unit of a property (`worker` is its index) runs cold, its code not yet compiled, and measures nothing: judged by
	 * it, a cheap module looks dear and spreads to workers whose start and readying cost more than its whole work
	 * (SYNC-SS: superstarter's action-wire on four workers for under a second of cases). A unit that ran no case (a
	 * count) measures nothing either.
	 */
	occupied: (worker: number, property: string, cases: number, millis: number) => void
	/**
	 * Worker `worker` readied `property` of `module`: it took `importing` milliseconds to import the module (none when it
	 * had imported it before) and `opening` to open the property's needs, and `cpu` of its CPU for both.
	 */
	readied: (
		worker: number,
		module: string,
		property: string,
		readying: Readonly<{ importing: number; opening: number; cpu: number }>
	) => void
	/** Worker `worker` was replaced by a fresh process: it holds nothing and has readied nothing. */
	forget: (worker: number) => void
	/** How many modules each worker holds, by index. */
	held: () => ReadonlyArray<number>
}>

/** A running sum: how many, and their milliseconds. */
type Sum = { count: number; millis: number }

/**
 * What a module's spread is judged by: the queued work its holders leave undrained within a further worker's wait
 * before its first case, that wait, the CPU its queued cases take, the CPU a further worker spends getting ready, and
 * how many workers hold it.
 */
type Shortfall = Readonly<{
	short: number
	within: number
	caseCpu: number
	readyCpu: number
	holding: number
	work: number
	rest: number
}>

/**
 * How long each module with queued work would take on the workers it has, as a decision reads them: its remaining work
 * (queued, and sent to its holders) over its holders, one at least (a module no worker holds gets one); and the two
 * longest, whose difference says how far the longest leads the run.
 */
type Spans = Readonly<{
	of: ReadonlyMap<string, number>
	first: Option.Option<readonly [string, number]>
	second: number
}>

/** A running sum of cases: how many, their milliseconds, and their CPU. */
type CaseSum = { count: number; millis: number; cpu: number }

/** Units by id, oldest first. */
const byId = Order.mapInput(Order.Number, (unit: Scheduled) => unit.id)

/**
 * One module's queue: its units by property, each oldest first, its queued cases by property, its unit count, and its
 * oldest unit (`head`), kept as the queue changes, since every choice reads it for every module.
 */
type ModuleQueue<U> = {
	readonly byProperty: Map<string, Array<U>>
	readonly cases: Map<string, number>
	units: number
	head: Option.Option<U>
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
	const importedOn: Array<Set<string>> = Array.from({ length: workers }, () => new Set())
	const warmOn: Array<Set<string>> = Array.from({ length: workers }, () => new Set())
	const openedOn: Array<Set<string>> = Array.from({ length: workers }, () => new Set())
	const cases = new Map<string, CaseSum>()
	const readyingCpuOn: Array<Map<string, number>> = Array.from(
		{ length: workers },
		() => new Map<string, number>()
	)
	const occupancies = new Map<string, Sum>()
	const imports = new Map<string, number>()
	const openings = new Map<string, number>()
	let total = 0

	/**
	 * The expected work of `count` cases of a property: how long they hold a worker, at the property's measured mean
	 * occupancy a case (Scheduler.occupied); none counted before it is measured.
	 */
	const workOfCases = (property: string, count: number): number => {
		const sum = occupancies.get(property)
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
		const made: ModuleQueue<U> = {
			byProperty: new Map(),
			cases: new Map(),
			units: 0,
			head: Option.none()
		}
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
		if (Option.match(queued.head, { onNone: () => true, onSome: (head) => unit.id < head.id })) {
			queued.head = Option.some(unit)
		}
	}

	/** Takes a module's queue out of the scheduling once it holds no unit. */
	const settled = (module: string, queued: ModuleQueue<U>) => {
		if (queued.units === 0) {
			queue.delete(module)
		}
	}

	/** A module's oldest queued unit, found again after units were taken out of its queue. */
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
	 * Whether a further worker pays for itself on a module: the queued work its holders leave undrained within the time
	 * that worker spends before it runs a case of it (readying the module's queued work, and `before` that a new worker's
	 * start, or nothing), each holder draining what that time leaves after the work it was already sent, covers that
	 * time, so the work the worker finds left once ready is at least what it spent getting ready (main's rule, from
	 * grizzle's education: seven properties of about 50 one-second cases and 2 to 4 s of readying each, spread over up
	 * to 64 workers at 959 CPU-s against Vitest's 450). A module with a part of that readying unmeasured spreads to no
	 * further worker until it is measured.
	 */
	const outgrowsAfter = (module: string, view: View<U>, before: Start, spans: Spans): boolean =>
		Option.exists(shortfallOf(module, view, before, spans), covered)

	/**
	 * Whether undrained work covers the wait a further worker spends before it can take any of it, and the CPU the
	 * module's queued cases take, shared among its holders and that worker, covers what each spends getting ready (its
	 * start, if forked, and its readying of the module): a module whose units hold their workers for their round trips
	 * spreads by how long they hold them (Scheduler.occupied), but only while the cases left would pay in CPU for every
	 * worker that takes a share of them. A wait on another process (PostgreSQL's) is no reason to fork: the wall time it
	 * saves costs CPU every worker's start and readying spend (GZ-NETWORK: 30 network modules forked all 64 workers, 155
	 * CPU-s of starts, readying and parent for the runner's 841.8 CPU-s against Vitest's 533.7, PostgreSQL's included).
	 */
	const covered = ({ short, within, caseCpu, readyCpu, holding, work, rest }: Shortfall): boolean =>
		short > 0 &&
		short >= within &&
		caseCpu >= (holding + 1) * readyCpu &&
		work / Math.max(1, holding) - rest > within

	/**
	 * How many further workers a module's queued work pays for: as many as its undrained work holds the wait whole, and
	 * no more than leave every worker's share of its cases' CPU, its holders' among them, at least what it spends getting
	 * ready.
	 */
	const paidFor = (shortfall: Shortfall): number =>
		covered(shortfall)
			? Math.max(
					0,
					Math.min(
						Math.floor(shortfall.short / Math.max(shortfall.within, Number.MIN_VALUE)),
						Math.floor(shortfall.caseCpu / Math.max(shortfall.readyCpu, Number.MIN_VALUE)) -
							shortfall.holding,
						leadingFor(shortfall)
					)
				)
			: 0

	/**
	 * How many further workers keep a module the run's critical path by more than one further worker's wait each: the
	 * k-th is wanted while the module's remaining work over its holders and the k - 1 before it still outlasts every
	 * other module's span by more than that wait, so a module forks only down to the run's next longest, never past it.
	 */
	const leadingFor = ({ work, rest, within, holding }: Shortfall): number => {
		let further = 0
		while (work / Math.max(1, holding + further) - rest > within && further < workers) {
			further += 1
		}
		return further
	}

	/**
	 * How much of a module's queued work its holders leave undrained within a further worker's wait before its first case
	 * of it (`before` and readying the module's queued work), that wait, and the queued cases' own time; none before the
	 * module's import is measured.
	 * Both sides count the queued properties measured so far alone (each opened somewhere, its occupancy known): an
	 * unmeasured property's work counts nothing yet (workOfCases), so its opening does not either, and it never holds
	 * back the spread of work already measured (with a property's whole streams queued at once, one property's units
	 * could otherwise keep a module on its holder until it reached the last property's).
	 */
	/** A module's remaining work: its queued work, and the work of its units its holders were sent. */
	const remainingOf = (module: string, queued: ModuleQueue<U>, view: View<U>): number => {
		let work = queuedWorkOf(queued)
		for (const holder of holders.get(module) ?? []) {
			for (const unit of view.sentOf(holder)) {
				if (unit.module === module) {
					work += workOfCases(unit.property, unit.cases)
				}
			}
		}
		return work
	}

	/** Every queued module's span now (Spans), read once for a decision that weighs several modules. */
	const spansOf = (view: View<U>): Spans => {
		const of = new Map<string, number>()
		let first: Option.Option<readonly [string, number]> = Option.none()
		let second = 0
		for (const [module, queued] of queue) {
			const span = remainingOf(module, queued, view) / Math.max(1, holders.get(module)?.size ?? 0)
			of.set(module, span)
			if (Option.match(first, { onNone: () => true, onSome: ([, longest]) => span > longest })) {
				second = Option.match(first, { onNone: () => second, onSome: ([, longest]) => longest })
				first = Option.some([module, span])
			} else if (span > second) {
				second = span
			}
		}
		return { of, first, second }
	}

	/** How long the run takes beside a module: the longest span of every other module with queued work. */
	const restOf = (module: string, spans: Spans): number =>
		Option.match(spans.first, {
			onNone: () => 0,
			onSome: ([longest, span]) => (longest === module ? spans.second : span)
		})

	const shortfallOf = (
		module: string,
		view: View<U>,
		before: Start,
		spans: Spans
	): Option.Option<Shortfall> => {
		const queued = queue.get(module)
		if (queued === undefined) {
			return Option.none()
		}
		const measured = Arr.filter(
			Arr.fromIterable(queued.byProperty.keys()),
			(property) => occupancies.has(property) && openings.has(property)
		)
		return Option.flatMap(readyingOf(module, measured, Option.none()), (readying) =>
			Option.map(readyingCpuOf(module), (readyingCpu) => {
				const within = before.millis + readying
				let drained = 0
				for (const holder of holders.get(module) ?? []) {
					drained += Math.max(0, within - workOf(view.sentOf(holder)))
				}
				return {
					short: queuedWorkOf(queued) - drained,
					within,
					caseCpu: queuedCaseCpuOf(queued),
					readyCpu: before.cpu + readyingCpu,
					holding: holders.get(module)?.size ?? 0,
					work: remainingOf(module, queued, view),
					rest: restOf(module, spans)
				}
			})
		)
	}

	/**
	 * The CPU a module's queued cases take, at each property's mean case CPU (Scheduler.finished): what a further worker
	 * could spend running them; none counted of a property not yet measured.
	 */
	const queuedCaseCpuOf = (queued: ModuleQueue<U>): number => {
		let cpu = 0
		for (const [property, count] of queued.cases) {
			const sum = cases.get(property)
			cpu += sum === undefined ? 0 : (count * sum.cpu) / sum.count
		}
		return cpu
	}

	/**
	 * The CPU a further worker spends readying a module: the least any worker that readied it spent on every readying of
	 * it there (its import once, each property's opening); none before a worker readied it.
	 */
	const readyingCpuOf = (module: string): Option.Option<number> => {
		let least: Option.Option<number> = Option.none()
		for (const spent of readyingCpuOn) {
			const cpu = spent.get(module)
			if (
				cpu !== undefined &&
				Option.match(least, { onNone: () => true, onSome: (other) => cpu < other })
			) {
				least = Option.some(cpu)
			}
		}
		return least
	}

	/**
	 * What a worker spends readying `properties` of `module` before it runs their cases: the module's import unless the
	 * worker (`on`, when one is meant) has imported it, and the opening of each property it has not readied; none while
	 * one of those is unmeasured.
	 */
	const readyingOf = (
		module: string,
		properties: Iterable<string>,
		on: Option.Option<number>
	): Option.Option<number> => {
		const imported = Option.isSome(on) ? importedOn[on.value] : undefined
		const opened = Option.isSome(on) ? openedOn[on.value] : undefined
		let readying = 0
		if (!(imported?.has(module) ?? false)) {
			const importing = imports.get(module)
			if (importing === undefined) {
				return Option.none()
			}
			readying += importing
		}
		for (const property of properties) {
			if (opened?.has(property) ?? false) {
				continue
			}
			const opening = openings.get(property)
			if (opening === undefined) {
				return Option.none()
			}
			readying += opening
		}
		return Option.some(readying)
	}

	/**
	 * The queued module among `candidates` whose oldest queued unit is the oldest of those `admits`, asked only of a
	 * module older than the best so far.
	 */
	const oldestOf = (
		candidates: Iterable<string>,
		admits: (module: string) => boolean
	): Option.Option<string> => {
		let best: Option.Option<readonly [string, number]> = Option.none()
		for (const module of candidates) {
			const head = Option.flatMap(
				Option.fromUndefinedOr(queue.get(module)),
				(queued) => queued.head
			)
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
	 * How many of a property's queued `units`, from the oldest, one message carries: as many as fill the work a message
	 * aims for, each unit's cases at the property's mean case time (a series' or a batch's every case, not one); one
	 * while the property has no mean, and never more than its fair share of what is queued.
	 */
	const perMessage = (property: string, units: ReadonlyArray<U>): number => {
		const sum = cases.get(property)
		if (sum === undefined) {
			return 1
		}
		const mean = sum.millis / sum.count
		const fair = Math.max(1, Math.ceil(total / workers))
		let count = 0
		let work = 0
		for (const unit of units) {
			const next = work + unit.cases * mean
			if (count >= fair || (count > 0 && next > messageWorkMillis)) {
				break
			}
			work = next
			count += 1
		}
		return Math.max(1, count)
	}

	const take = (worker: number, module: string): Option.Option<Arr.NonEmptyReadonlyArray<U>> => {
		const queued = queue.get(module)
		if (queued === undefined) {
			return Option.none()
		}
		return Option.flatMap(queued.head, (head) => {
			const units = queued.byProperty.get(head.property) ?? []
			const taken = units.splice(0, perMessage(head.property, units))
			for (const unit of taken) {
				queued.cases.set(unit.property, (queued.cases.get(unit.property) ?? 0) - unit.cases)
				queued.units -= 1
				total -= 1
			}
			if (units.length === 0) {
				queued.byProperty.delete(head.property)
				queued.cases.delete(head.property)
			}
			queued.head = headOf(queued)
			settled(module, queued)
			hold(worker, module)
			return Arr.isReadonlyArrayNonEmpty(taken) ? Option.some(taken) : Option.none()
		})
	}

	/**
	 * How many of a busy worker's unstarted units, from its tail, a thief would take. Of a module the thief holds with
	 * every property of them readied, half of them. Otherwise the thief must ready what it lacks first (the module's
	 * import, the opening of each property it has not readied): the victim keeps the oldest units up to half of its
	 * unstarted work and that readying, and the thief takes the rest, when that leaves the victim more than the readying
	 * to do and the thief at least as much work as that readying, so the thief ends before the victim alone would and
	 * pays for its readying; an unmeasured readying admits no such steal.
	 */
	const tailOf = (thief: number, unstarted: ReadonlyArray<U>): number => {
		const first = unstarted[0]
		if (first === undefined) {
			return 0
		}
		const readying = readyingOf(
			first.module,
			new Set(Arr.map(unstarted, (unit) => unit.property)),
			Option.some(thief)
		)
		if (Option.isNone(readying)) {
			return 0
		}
		const within = readying.value
		if (within === 0) {
			return Math.floor(unstarted.length / 2)
		}
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
		return work > within && workOf(unstarted) - work >= within ? unstarted.length - kept : 0
	}

	/** The steal for an idle worker: the longest tail of a module it holds, else the longest of another module. */
	const stealFor = (thief: number, view: View<U>): Choice<U> => {
		let best: Option.Option<Readonly<{ victim: number; count: number; held: boolean }>> =
			Option.none()
		for (let victim = 0; victim < view.workers; victim += 1) {
			if (victim === thief || view.sentOf(victim).length === 0 || !view.stealable(victim)) {
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
				queued.head = headOf(queued)
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
					oldestOf(held ?? [], () => true),
					() => oldestOf(queue.keys(), (candidate) => (holders.get(candidate)?.size ?? 0) === 0)
				),
				() => {
					const spans = spansOf(view)
					return oldestOf(queue.keys(), (candidate) =>
						outgrowsAfter(candidate, view, { millis: 0, cpu: 0 }, spans)
					)
				}
			)
			return Option.match(
				Option.flatMap(module, (chosen) => take(worker, chosen)),
				{
					onNone: () => stealFor(worker, view),
					onSome: (units) => ({ kind: "take", units })
				}
			)
		},
		outgrows: (module, view) => outgrowsAfter(module, view, { millis: 0, cpu: 0 }, spansOf(view)),
		wanted: (view, starting) => {
			let wanted = 0
			const spans = spansOf(view)
			for (const module of queue.keys()) {
				if ((holders.get(module)?.size ?? 0) === 0) {
					wanted += 1
					continue
				}
				wanted += Option.match(
					Option.flatMap(starting, (start) => shortfallOf(module, view, start, spans)),
					{
						onNone: () => 0,
						onSome: paidFor
					}
				)
			}
			return wanted
		},
		take,
		stealFrom: (thief, victim, view) => {
			if (thief === victim || view.sentOf(victim).length === 0 || !view.stealable(victim)) {
				return { kind: "wait" }
			}
			const unstarted = view.unstartedOf(victim)
			const units = unstarted.slice(unstarted.length - tailOf(thief, unstarted))
			return Arr.isReadonlyArrayNonEmpty(units)
				? { kind: "steal", victim, units }
				: { kind: "wait" }
		},
		hand: (worker, units) => {
			for (const unit of units) {
				hold(worker, unit.module)
			}
		},
		holds: (worker, module) => holds[worker]?.has(module) ?? false,
		holdsAny: (module) => (holders.get(module)?.size ?? 0) > 0,
		finished: (property, count, millis, cpu) => {
			if (count === 0) {
				return
			}
			const sum = cases.get(property) ?? { count: 0, millis: 0, cpu: 0 }
			sum.count += count
			sum.millis += millis
			sum.cpu += cpu
			cases.set(property, sum)
		},
		occupied: (worker, property, count, millis) => {
			if (count === 0) {
				return
			}
			const warm = warmOn[worker]
			if (!(warm?.has(property) ?? false)) {
				warm?.add(property)
				return
			}
			const sum = occupancies.get(property) ?? { count: 0, millis: 0 }
			sum.count += count
			sum.millis += millis
			occupancies.set(property, sum)
		},
		readied: (worker, module, property, readying) => {
			const spent = readyingCpuOn[worker]
			spent?.set(module, (spent.get(module) ?? 0) + readying.cpu)
			if (!(importedOn[worker]?.has(module) ?? false)) {
				importedOn[worker]?.add(module)
				imports.set(module, Math.min(imports.get(module) ?? readying.importing, readying.importing))
			}
			if (!(openedOn[worker]?.has(property) ?? false)) {
				openedOn[worker]?.add(property)
				openings.set(
					property,
					Math.min(openings.get(property) ?? readying.opening, readying.opening)
				)
			}
		},
		forget: (worker) => {
			for (const module of holds[worker] ?? []) {
				holders.get(module)?.delete(worker)
			}
			holds[worker] = new Set()
			importedOn[worker] = new Set()
			openedOn[worker] = new Set()
			warmOn[worker] = new Set()
			readyingCpuOn[worker] = new Map<string, number>()
		},
		held: () => Arr.map(holds, (modules) => modules.size)
	}
}

/**
 * How many workers to fork now, for a pool sized to its work: the workers the queue wants (Scheduler.wanted) that no
 * worker idle or starting will take, never past `most` (testWorkers) in all; a pool already that wide asks the queue
 * nothing, since reckoning what it wants reads every queued module and runs after every unit a worker answers.
 */
export const forksOf = <U extends Scheduled>(
	scheduler: Scheduler<U>,
	view: View<U>,
	pool: Readonly<{ idling: number; starting: number; most: number; started: Option.Option<Start> }>
): number => {
	const room = pool.most - view.workers
	return room > 0
		? Math.max(
				0,
				Math.min(room, scheduler.wanted(view, pool.started) - pool.idling - pool.starting)
			)
		: 0
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
	const fed = fedBy(apply)
	if (view.idle(worker)) {
		const choice = scheduler.choose(worker, view)
		if (choice.kind !== "wait") {
			fed.give(worker, choice)
		}
	}
	for (let other = 0; other < view.workers; other += 1) {
		if (!view.idle(other)) {
			continue
		}
		if (!scheduler.outgrows(module, view)) {
			break
		}
		Option.map(scheduler.take(other, module), (units) => fed.give(other, { kind: "take", units }))
	}
	for (let other = 0; other < view.workers; other += 1) {
		if (other !== worker && view.idle(other) && scheduler.holds(other, module)) {
			const choice = scheduler.choose(other, view)
			if (choice.kind !== "wait") {
				fed.give(other, choice)
			}
		}
	}
	offerSteals(scheduler, view, apply, fed.taken)
}

/**
 * What units newly queued for `module` change, and only that: the module's idle holders are given work, their own
 * modules first; a module no worker holds goes to an idle worker; and idle workers take it while its work outgrows its
 * holders. A queue changes no steal (a steal takes units already sent), so no other idle worker is re-decided: every
 * idle worker was given what it could take when it last became idle or work was last queued.
 */
export const afterQueued = <U extends Scheduled>(
	scheduler: Scheduler<U>,
	view: View<U>,
	apply: Apply<U>,
	module: string
) => {
	const fed = fedBy(apply)
	for (let worker = 0; worker < view.workers; worker += 1) {
		if (view.idle(worker) && scheduler.holds(worker, module)) {
			const choice = scheduler.choose(worker, view)
			if (choice.kind !== "wait") {
				fed.give(worker, choice)
			}
		}
	}
	for (let worker = 0; worker < view.workers; worker += 1) {
		if (!view.idle(worker)) {
			continue
		}
		if (scheduler.holdsAny(module) && !scheduler.outgrows(module, view)) {
			break
		}
		const taken = scheduler.take(worker, module)
		if (Option.isNone(taken)) {
			break
		}
		fed.give(worker, { kind: "take", units: taken.value })
	}
	offerSteals(scheduler, view, apply, fed.taken)
}

/** `apply`, keeping the workers it gave queued units to: the workers whose tails a steal may now take from. */
const fedBy = <U extends Scheduled>(apply: Apply<U>) => {
	const taken = new Set<number>()
	return {
		taken,
		give: (worker: number, choice: Choice<U>) => {
			if (choice.kind === "take") {
				taken.add(worker)
			}
			apply(worker, choice)
		}
	}
}

/**
 * Offers the tails of workers just given queued units to idle workers, as a steal each may take of them: a take is
 * the one event that gives a worker a tail to steal from, so no other idle worker's steal changed.
 */
const offerSteals = <U extends Scheduled>(
	scheduler: Scheduler<U>,
	view: View<U>,
	apply: Apply<U>,
	victims: ReadonlySet<number>
) => {
	for (const victim of victims) {
		for (let thief = 0; thief < view.workers; thief += 1) {
			if (!view.idle(thief)) {
				continue
			}
			const choice = scheduler.stealFrom(thief, victim, view)
			if (choice.kind !== "wait") {
				apply(thief, choice)
			}
		}
	}
}
