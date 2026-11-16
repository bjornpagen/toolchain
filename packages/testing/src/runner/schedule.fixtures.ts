import { Array as Arr, Option } from "effect"
import { array, type Gen, int } from "#gen.ts"
import {
	afterFinished,
	type Apply,
	feedAll,
	type Scheduled,
	schedulerOf,
	type View
} from "#runner/schedule.ts"

/**
 * What the meta-tests of the pool's scheduling (runner/schedule.ts) share: a drawn workload of modules, each with what
 * a worker spends readying it and its properties, each with its case time and its searches' windows; and a run of it
 * in virtual time, the pool's loop over the scheduler as runner/pool.ts drives it, with what the run did.
 */

/** A property of a drawn workload: its case time and its search's windows, each its count of cases, run in turn. */
export type DrawnProperty = Readonly<{ caseMillis: number; windows: ReadonlyArray<number> }>

/** A module of a drawn workload: what a worker spends readying it, once, and its properties. */
export type DrawnModule = Readonly<{ readying: number; properties: ReadonlyArray<DrawnProperty> }>

/** A drawn workload: the pool's width and its modules. */
export type Workload = Readonly<{ workers: number; modules: ReadonlyArray<DrawnModule> }>

const properties: Gen<DrawnProperty> = (source) => ({
	caseMillis: source.draw(int(1, 20)),
	windows: source.draw(array(int(1, 16), { min: 1, max: 6 }))
})

const modules: Gen<DrawnModule> = (source) => ({
	readying: source.draw(int(1, 60)),
	properties: source.draw(array(properties, { min: 1, max: 3 }))
})

/** Workloads of one to eight workers and one to five modules. */
export const workloads: Gen<Workload> = (source) => ({
	workers: source.draw(int(1, 8)),
	modules: source.draw(array(modules, { min: 1, max: 5 }))
})

/** A drawn module's work: every case of every window of its properties at its property's case time. */
const workOfModule = (module: DrawnModule): number =>
	Arr.reduce(module.properties, 0, (sum, drawn) =>
		Arr.reduce(drawn.windows, sum, (inner, cases) => inner + cases * drawn.caseMillis)
	)

/** Workloads of one module whose readying takes at least as long as its every case together: a cheap module. */
export const cheap: Gen<Workload> = (source) => {
	const module = source.draw(modules)
	return {
		workers: source.draw(int(1, 8)),
		modules: [{ ...module, readying: workOfModule(module) + source.draw(int(0, 60)) }]
	}
}

/**
 * Workloads of one module whose single property's one window holds at least four cases a worker and whose cases take
 * at least what readying the module takes: a module that outgrows any one worker.
 */
export const outgrowing: Gen<Workload> = (source) => {
	const workers = source.draw(int(2, 8))
	const readying = source.draw(int(1, 20))
	return {
		workers,
		modules: [
			{
				readying,
				properties: [
					{
						caseMillis: source.draw(int(readying, 3 * readying)),
						windows: [source.draw(int(4 * workers, 8 * workers))]
					}
				]
			}
		]
	}
}

/** A unit of the simulated pool: one case of a property of a module. */
type SimUnit = Scheduled & Readonly<{ caseMillis: number; readying: number }>

/** A simulated worker: what it was sent, which modules it readied, and when its running unit ends. */
type SimWorker = {
	readonly index: number
	sent: Array<SimUnit>
	readied: Set<string>
	busyUntil: Option.Option<number>
}

/** What a simulated run did: each module's workers that readied it, each case's runs by unit id, and its end. */
export type Ran = Readonly<{
	readiedBy: ReadonlyMap<string, ReadonlySet<number>>
	runs: ReadonlyMap<number, number>
	units: number
	finished: boolean
	end: number
}>

/**
 * Runs a workload on a simulated pool in virtual time, as runner/pool.ts drives the scheduler: every property's search
 * queues its first window at once and each next window when the last's every case has finished; whenever a worker is
 * idle it is given what the scheduler chooses (a steal's tail handed to it at once); a worker runs its units in order,
 * readying a module the first time it runs a unit of it (the module's readying, reported to the scheduler), then the
 * case. The run ends when every window has run, or, with work left and no worker running, stalled.
 */
export const simulate = (workload: Workload): Ran => {
	const scheduler = schedulerOf<SimUnit>(workload.workers)
	const workers: Array<SimWorker> = Array.from({ length: workload.workers }, (_, index) => ({
		index,
		sent: [],
		readied: new Set(),
		busyUntil: Option.none()
	}))
	const readiedBy = new Map<string, Set<number>>()
	const runs = new Map<number, number>()
	const searches = Arr.flatMap(workload.modules, (module, moduleAt) =>
		Arr.map(module.properties, (drawn, propertyAt) => ({
			module: `m${moduleAt}`,
			property: `m${moduleAt}#p${propertyAt}`,
			readying: module.readying,
			caseMillis: drawn.caseMillis,
			windows: drawn.windows,
			next: 0,
			outstanding: 0
		}))
	)
	let ids = 0
	let now = 0
	let units = 0

	const queueNext = (search: (typeof searches)[number]) => {
		Option.map(Arr.get(search.windows, search.next), (cases) => {
			search.next += 1
			search.outstanding = cases
			for (let at = 0; at < cases; at += 1) {
				ids += 1
				units += 1
				scheduler.enqueue({
					id: ids,
					property: search.property,
					module: search.module,
					cases: 1,
					caseMillis: search.caseMillis,
					readying: search.readying
				})
			}
		})
	}

	const view: View<SimUnit> = {
		workers: workload.workers,
		sentOf: (index) => workers[index]?.sent ?? [],
		unstartedOf: (index) => Arr.drop(workers[index]?.sent ?? [], 1),
		stealable: () => true,
		idle: (index) =>
			Option.exists(Option.fromUndefinedOr(workers[index]), (worker) => worker.sent.length === 0)
	}

	const start = (worker: SimWorker) => {
		Option.map(Arr.head(worker.sent), (unit) => {
			const readying = worker.readied.has(unit.module) ? 0 : unit.readying
			worker.busyUntil = Option.some(now + readying + unit.caseMillis)
			if (readying === 0) {
				return
			}
			worker.readied.add(unit.module)
			readiedBy.set(unit.module, (readiedBy.get(unit.module) ?? new Set()).add(worker.index))
			scheduler.readied(worker.index, unit.module, readying)
			afterFinished(scheduler, view, apply, worker.index, unit.module)
		})
	}

	const apply: Apply<SimUnit> = (index, choice) => {
		Option.map(Option.fromUndefinedOr(workers[index]), (worker) => {
			switch (choice.kind) {
				case "wait":
					return
				case "take":
					worker.sent = [...choice.units]
					start(worker)
					return
				case "steal": {
					const taken = new Set(Arr.map(choice.units, (unit) => unit.id))
					Option.map(Option.fromUndefinedOr(workers[choice.victim]), (victim) => {
						victim.sent = Arr.filter(victim.sent, (unit) => !taken.has(unit.id))
					})
					scheduler.hand(worker.index, choice.units)
					worker.sent = [...choice.units]
					start(worker)
					return
				}
			}
		})
	}

	for (const search of searches) {
		queueNext(search)
	}
	feedAll(scheduler, view, apply)
	for (;;) {
		const next = Arr.reduce(workers, Option.none<SimWorker>(), (soonest, worker) =>
			Option.isSome(worker.busyUntil) &&
			Option.match(soonest, {
				onNone: () => true,
				onSome: (other) =>
					Option.getOrElse(worker.busyUntil, () => 0) < Option.getOrElse(other.busyUntil, () => 0)
			})
				? Option.some(worker)
				: soonest
		)
		if (Option.isNone(next)) {
			break
		}
		const worker = next.value
		now = Option.getOrElse(worker.busyUntil, () => now)
		worker.busyUntil = Option.none()
		Option.map(Arr.head(worker.sent), (unit) => {
			worker.sent = Arr.drop(worker.sent, 1)
			runs.set(unit.id, (runs.get(unit.id) ?? 0) + 1)
			scheduler.finished(unit.property, 1, unit.caseMillis)
			start(worker)
			Option.map(
				Arr.findFirst(searches, (search) => search.property === unit.property),
				(search) => {
					search.outstanding -= 1
					if (search.outstanding === 0) {
						queueNext(search)
						feedAll(scheduler, view, apply)
					}
				}
			)
			afterFinished(scheduler, view, apply, worker.index, unit.module)
		})
	}
	return {
		readiedBy,
		runs,
		units,
		finished: Arr.every(
			searches,
			(search) => search.next === search.windows.length && search.outstanding === 0
		),
		end: now
	}
}
