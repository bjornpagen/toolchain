import { Array as Arr, Option } from "effect"
import { array, type Gen, int } from "#gen.ts"
import {
	afterFinished,
	type Apply,
	feedAll,
	forksOf,
	type Scheduled,
	schedulerOf,
	type View
} from "#runner/schedule.ts"

/**
 * What the meta-tests of the pool's scheduling (runner/schedule.ts) share: a drawn workload of modules, each with what
 * a worker spends readying it and its properties, each with its case time and its searches' windows; and a run of it
 * in virtual time, the pool's loop over the scheduler as runner/pool.ts drives it, with what the run did.
 */

/**
 * A property of a drawn workload: its case time, its search's windows, each its count of cases, run in turn, and what a
 * worker spends opening its needs, once, before its first case there.
 */
export type DrawnProperty = Readonly<{
	caseMillis: number
	windows: ReadonlyArray<number>
	opening: number
}>

/** A module of a drawn workload: what a worker spends importing it, once, and its properties. */
export type DrawnModule = Readonly<{ importing: number; properties: ReadonlyArray<DrawnProperty> }>

/**
 * A drawn workload: the pool's width at most, how long a worker takes to start, how long each unit holds its worker
 * beyond its case (its round trip), and its modules.
 */
export type Workload = Readonly<{
	workers: number
	starting: number
	trip: number
	modules: ReadonlyArray<DrawnModule>
}>

const properties: Gen<DrawnProperty> = (source) => ({
	caseMillis: source.draw(int(1, 20)),
	windows: source.draw(array(int(1, 16), { min: 1, max: 6 })),
	opening: source.draw(int(0, 30))
})

const modules: Gen<DrawnModule> = (source) => ({
	importing: source.draw(int(1, 60)),
	properties: source.draw(array(properties, { min: 1, max: 3 }))
})

/** Workloads of one to eight workers and one to five modules. */
export const workloads: Gen<Workload> = (source) => ({
	workers: source.draw(int(1, 8)),
	starting: source.draw(int(1, 30)),
	trip: source.draw(int(0, 5)),
	modules: source.draw(array(modules, { min: 1, max: 5 }))
})

/** A drawn property's work: every case of every window of it at its case time. */
const workOfProperty = (drawn: DrawnProperty): number =>
	Arr.reduce(drawn.windows, 0, (sum, cases) => sum + cases * drawn.caseMillis)

/** A drawn module's work: every case of every window of its properties at its property's case time. */
const workOfModule = (module: DrawnModule): number =>
	Arr.reduce(module.properties, 0, (sum, drawn) => sum + workOfProperty(drawn))

/** Workloads of one module whose import takes at least as long as its every case together: a cheap module. */
export const cheap: Gen<Workload> = (source) => {
	const module = source.draw(modules)
	return {
		workers: source.draw(int(1, 8)),
		starting: source.draw(int(1, 30)),
		trip: 0,
		modules: [{ ...module, importing: workOfModule(module) + source.draw(int(0, 60)) }]
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
		starting: source.draw(int(1, 10)),
		trip: 0,
		workers,
		modules: [
			{
				importing: readying,
				properties: [
					{
						caseMillis: source.draw(int(readying, 3 * readying)),
						windows: [source.draw(int(4 * workers, 8 * workers))],
						opening: 0
					}
				]
			}
		]
	}
}

/**
 * Workloads of one module whose cases cost almost nothing but whose units each hold their worker for a round trip at
 * least as long as readying the module, four or more cases a worker in one window: a module bound by its round trips,
 * which only its units' occupancy, never its cases' time, shows outgrowing one worker.
 */
export const tripBound: Gen<Workload> = (source) => {
	const workers = source.draw(int(2, 8))
	const readying = source.draw(int(1, 20))
	return {
		starting: source.draw(int(1, 10)),
		trip: source.draw(int(readying, 3 * readying)),
		workers,
		modules: [
			{
				importing: readying,
				properties: [
					{ caseMillis: 1, windows: [source.draw(int(4 * workers, 8 * workers))], opening: 0 }
				]
			}
		]
	}
}

/** A unit of the simulated pool: one case of a property of a module. */
type SimUnit = Scheduled & Readonly<{ caseMillis: number; importing: number; opening: number }>

/**
 * A simulated worker: what it was sent, which modules it imported and which properties it opened, and when its running
 * unit ends.
 */
type SimWorker = {
	readonly index: number
	ready: boolean
	sent: Array<SimUnit>
	imported: Set<string>
	opened: Set<string>
	busyUntil: Option.Option<number>
}

/**
 * What a simulated run did: each module's workers that imported it and each property's that opened it, each case's runs
 * by unit id, and its end.
 */
export type Ran = Readonly<{
	readiedBy: ReadonlyMap<string, ReadonlySet<number>>
	openedBy: ReadonlyMap<string, ReadonlySet<number>>
	runs: ReadonlyMap<number, number>
	units: number
	forked: number
	finished: boolean
	end: number
}>

/**
 * Runs a workload on a simulated pool in virtual time, as runner/pool.ts drives the scheduler: the pool starts with one
 * worker and forks more as the queue wants them (forksOf), each starting for the workload's start time; every
 * property's search queues its first window at once and each next window when the last's every case has finished; an
 * idle worker is given what the scheduler chooses (a steal's tail handed to it at once), as the pool's events decide
 * (feedAll, afterFinished); a worker runs its units in order, readying a module the first time it runs a unit of it
 * (the module's readying, reported to the scheduler), then the case. The run ends when every window has run, or, with
 * work left and no worker running, stalled.
 */
/**
 * How a simulated pool gets its workers: lazily, as runner/pool.ts forks them (one to start, more as the queue wants
 * them), or whole, every worker ready at the start, which isolates the scheduler's choices from the forking.
 */
export const FORKINGS = ["lazily", "whole"] as const

export type Forking = (typeof FORKINGS)[number]

export const simulate = (workload: Workload, forking: Forking): Ran => {
	const scheduler = schedulerOf<SimUnit>(workload.workers)
	const workers: Array<SimWorker> = []
	let started = false
	const readiedBy = new Map<string, Set<number>>()
	const openedBy = new Map<string, Set<number>>()
	const runs = new Map<number, number>()
	const searches = Arr.flatMap(workload.modules, (module, moduleAt) =>
		Arr.map(module.properties, (drawn, propertyAt) => ({
			module: `m${moduleAt}`,
			property: `m${moduleAt}#p${propertyAt}`,
			importing: module.importing,
			opening: drawn.opening,
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
					importing: search.importing,
					opening: search.opening
				})
			}
		})
	}

	const view: View<SimUnit> = {
		get workers() {
			return workers.length
		},
		sentOf: (index) => workers[index]?.sent ?? [],
		unstartedOf: (index) => Arr.drop(workers[index]?.sent ?? [], 1),
		stealable: () => true,
		idle: (index) =>
			Option.exists(
				Option.fromUndefinedOr(workers[index]),
				(worker) => worker.ready && worker.sent.length === 0
			)
	}

	const start = (worker: SimWorker) => {
		Option.map(Arr.head(worker.sent), (unit) => {
			if (worker.opened.has(unit.property)) {
				worker.busyUntil = Option.some(now + unit.caseMillis + workload.trip)
				return
			}
			const importing = worker.imported.has(unit.module) ? 0 : unit.importing
			worker.busyUntil = Option.some(
				now + importing + unit.opening + unit.caseMillis + workload.trip
			)
			worker.imported.add(unit.module)
			worker.opened.add(unit.property)
			readiedBy.set(unit.module, (readiedBy.get(unit.module) ?? new Set()).add(worker.index))
			openedBy.set(unit.property, (openedBy.get(unit.property) ?? new Set()).add(worker.index))
			scheduler.readied(worker.index, unit.module, unit.property, {
				importing,
				opening: unit.opening
			})
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

	/** Forks the workers the queue wants, as the pool does: each starts, busy, for the workload's start time. */
	const grow = () => {
		const forks = forksOf(scheduler, view, {
			idling: Arr.filter(workers, (worker) => worker.ready && worker.sent.length === 0).length,
			starting: Arr.filter(workers, (worker) => !worker.ready).length,
			most: workload.workers,
			started: started ? Option.some(workload.starting) : Option.none()
		})
		for (let more = forks; more > 0; more -= 1) {
			workers.push({
				index: workers.length,
				ready: false,
				sent: [],
				imported: new Set(),
				opened: new Set(),
				busyUntil: Option.some(now + workload.starting)
			})
		}
	}

	/** Feeds every idle worker and forks what the queue still wants. */
	const feedEvery = () => {
		feedAll(scheduler, view, apply)
		grow()
	}

	for (const search of searches) {
		queueNext(search)
	}
	const first = forking === "lazily" ? 1 : workload.workers
	for (let index = 0; index < first; index += 1) {
		workers.push({
			index,
			ready: forking === "whole",
			sent: [],
			imported: new Set(),
			opened: new Set(),
			busyUntil: forking === "whole" ? Option.none() : Option.some(workload.starting)
		})
	}
	started = forking === "whole"
	feedEvery()
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
		if (!worker.ready) {
			worker.ready = true
			started = true
			feedEvery()
			continue
		}
		Option.map(Arr.head(worker.sent), (unit) => {
			worker.sent = Arr.drop(worker.sent, 1)
			runs.set(unit.id, (runs.get(unit.id) ?? 0) + 1)
			scheduler.finished(unit.property, 1, unit.caseMillis)
			scheduler.occupied(unit.property, 1, unit.caseMillis + workload.trip)
			start(worker)
			Option.map(
				Arr.findFirst(searches, (search) => search.property === unit.property),
				(search) => {
					search.outstanding -= 1
					if (search.outstanding === 0) {
						queueNext(search)
						feedEvery()
					}
				}
			)
			afterFinished(scheduler, view, apply, worker.index, unit.module)
			grow()
		})
	}
	return {
		readiedBy,
		openedBy,
		runs,
		units,
		forked: workers.length,
		finished: Arr.every(
			searches,
			(search) => search.next === search.windows.length && search.outstanding === 0
		),
		end: now
	}
}

/**
 * A module's state as a spread decision reads it: what importing it took, and for each of its properties what opening
 * its needs took, its occupancy a case, how many of its units are queued and how many its one holder was sent.
 */
export type SpreadState = Readonly<{
	importing: number
	properties: ReadonlyArray<
		Readonly<{ opening: number; caseMillis: number; queued: number; sent: number }>
	>
}>

/** A measured property of a spread state, with up to six units queued and `sent` sent to the holder. */
const spreadProperty =
	(sent: Gen<number>): Gen<SpreadState["properties"][number]> =>
	(source) => ({
		opening: source.draw(int(0, 40)),
		caseMillis: source.draw(int(1, 20)),
		queued: source.draw(int(0, 6)),
		sent: source.draw(sent)
	})

/**
 * Modules of one to four properties, each measured, with up to six units of each queued and up to six sent to the
 * holder, one at least (the holder is busy with its first property's), as a holder is that a spread is decided beside.
 */
export const spreadStates: Gen<SpreadState> = (source) => ({
	importing: source.draw(int(0, 40)),
	properties: [
		source.draw(spreadProperty(int(1, 6))),
		...source.draw(array(spreadProperty(int(0, 6)), { min: 0, max: 3 }))
	]
})

/**
 * What the scheduler judges of the module of `state`, beside its one holder (worker 0, which readied every property of
 * it and was sent its units) and a second worker idle: whether it outgrows its holder, and how many new workers it
 * wants when a worker takes `starting` milliseconds to start; the scheduler as the pool feeds it, every number
 * measured.
 */
export const spreadIn = (
	state: SpreadState,
	starting: number
): Readonly<{ outgrows: boolean; wanted: number }> => {
	const scheduler = schedulerOf<Scheduled>(2)
	let ids = 0
	const sent: Array<Scheduled> = []
	for (const [at, drawn] of state.properties.entries()) {
		const property = `m#p${at}`
		scheduler.readied(0, "m", property, {
			importing: at === 0 ? state.importing : 0,
			opening: drawn.opening
		})
		scheduler.occupied(property, 1, drawn.caseMillis)
		for (let unit = 0; unit < drawn.sent; unit += 1) {
			ids += 1
			sent.push({ id: ids, property, module: "m", cases: 1 })
		}
		for (let unit = 0; unit < drawn.queued; unit += 1) {
			ids += 1
			scheduler.enqueue({ id: ids, property, module: "m", cases: 1 })
		}
	}
	scheduler.hand(0, sent)
	const view: View<Scheduled> = {
		workers: 2,
		sentOf: (worker) => (worker === 0 ? sent : []),
		unstartedOf: (worker) => (worker === 0 ? Arr.drop(sent, 1) : []),
		stealable: () => true,
		idle: (worker) => worker === 1
	}
	return {
		outgrows: scheduler.outgrows("m", view),
		wanted: scheduler.wanted(view, Option.some(starting))
	}
}
