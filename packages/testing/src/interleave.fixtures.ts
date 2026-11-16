import { Array as Arr, Deferred, Effect, Formatter, Option, Order, Schema, Struct } from "effect"
import type { Case } from "#explore.ts"
import { awaitFact } from "#fact.ts"
import { array, element, type Gen, int } from "#gen.ts"
import {
	AfterCycle,
	type Choice,
	type Driver,
	type Ending,
	type Interleave,
	type Interleaving,
	interleave,
	type Nature,
	type Read,
	type Reduction,
	type Scheduling,
	type Sessions
} from "#interleave.ts"
import { fnv1a32 } from "#random.ts"
import { type Chooser, type Recording } from "#source.ts"

/** The resources the lock manager's sessions write. */
const RESOURCES = ["x", "y", "z"] as const

export type Resource = (typeof RESOURCES)[number]

/** A write of a resource, or a commit, which releases every lock its session holds. */
export type Move =
	| Readonly<{ kind: "write"; resource: Resource; value: number }>
	| Readonly<{ kind: "commit" }>

export type Outcome = "ok" | "deadlock"

/** The lock manager's committed values, by resource. */
export type Snapshot = ReadonlyArray<readonly [Resource, number]>

/** A run on the lock manager, as a judge reads it. */
export type LockRun<S extends string> = Interleaving<S, Move, Outcome, "state", Snapshot, Resource>

/** The three sessions most properties here name. */
export type Named = "a" | "b" | "c"

/**
 * A lock manager, the system under test: a write takes its resource's lock, waiting while another session holds it,
 * and a commit releases every lock the session holds. Its deadlock detector runs when the engine asks it to quiesce,
 * and aborts the cycle's member that began waiting first, as PostgreSQL's does. Releasing a session drops its locks
 * and its wait; a reset that meets a lock still held or a wait still open dies, as PostgreSQL's reset would wait on it
 * forever, so every run of every property here checks that the engine released each session its run started.
 */
export const lockManager = <S extends string>(): Driver<
	S,
	Move,
	Outcome,
	"state",
	Snapshot,
	Resource,
	never,
	never
> => {
	const values = new Map<Resource, number>()
	const holders = new Map<Resource, S>()
	const waiting = new Map<
		S,
		Readonly<{ resource: Resource; since: number; wake: Deferred.Deferred<"granted" | "victim"> }>
	>()
	let waits = 0
	const releaseLocks = (session: S) => {
		for (const [resource, holder] of holders) {
			if (holder === session) {
				holders.delete(resource)
			}
		}
		for (const [, wait] of waiting) {
			if (!holders.has(wait.resource)) {
				Deferred.doneUnsafe(wait.wake, Effect.succeed("granted"))
			}
		}
	}
	const holderOf = (session: S) =>
		Option.flatMap(Option.fromNullishOr(waiting.get(session)), (wait) =>
			Option.fromNullishOr(holders.get(wait.resource))
		)
	const write = (session: S, resource: Resource, value: number): Effect.Effect<Outcome> =>
		Effect.gen(function* () {
			const holder = holders.get(resource)
			if (holder === undefined || holder === session) {
				holders.set(resource, session)
				values.set(resource, value)
				return "ok"
			}
			const wake = yield* Deferred.make<"granted" | "victim">()
			waits += 1
			waiting.set(session, { resource, since: waits, wake })
			const signal = yield* Deferred.await(wake)
			waiting.delete(session)
			if (signal === "victim") {
				releaseLocks(session)
				return "deadlock"
			}
			return yield* write(session, resource, value)
		})
	return {
		reset: Effect.suspend(() =>
			holders.size > 0 || waiting.size > 0
				? Effect.die(
						`a reset met ${Arr.join([...holders.values(), ...waiting.keys()], ", ")} still holding a lock or waiting`
					)
				: Effect.sync(() => {
						values.clear()
						waits = 0
					})
		),
		run: (session, move) =>
			move.kind === "write"
				? write(session, move.resource, move.value)
				: Effect.sync(() => {
						releaseLocks(session)
						return "ok"
					}),
		waitOf: (session) =>
			Effect.sync(() =>
				Option.flatMap(holderOf(session), (holder) =>
					Option.map(Option.fromNullishOr(waiting.get(session)), (wait) => ({
						on: [holder] as const,
						detail: wait.resource
					}))
				)
			),
		quiesce: (inFlight) =>
			Effect.gen(function* () {
				const waitsFor = new Map(
					Arr.flatMap(inFlight, (session) =>
						Option.toArray(Option.map(holderOf(session), (holder) => [session, holder] as const))
					)
				)
				for (const start of waitsFor.keys()) {
					const cycle: Array<S> = []
					let current: S | undefined = start
					while (current !== undefined && !Arr.contains(cycle, current)) {
						cycle.push(current)
						current = waitsFor.get(current)
					}
					if (current === start) {
						const victim = Arr.reduce(cycle, start, (first, session) =>
							(waiting.get(session)?.since ?? 0) < (waiting.get(first)?.since ?? 0)
								? session
								: first
						)
						const wait = waiting.get(victim)
						if (wait !== undefined) {
							Deferred.doneUnsafe(wait.wake, Effect.succeed("victim"))
							yield* awaitFact(
								Effect.sync(() => (waiting.has(victim) ? Option.none() : Option.some(victim)))
							)
						}
						return
					}
				}
			}),
		outcome: (_move, ended) =>
			ended.kind === "cancelled"
				? { key: "cancelled", session: "continues" }
				: { key: ended.outcome, session: ended.outcome === "deadlock" ? "ends" : "continues" },
		release: (session) =>
			Effect.sync(() => {
				waiting.delete(session)
				releaseLocks(session)
			}),
		commute: (first, second) =>
			first.kind === "write" && second.kind === "write" && first.resource !== second.resource,
		onWait: () => "wait",
		read: () =>
			Effect.sync(() =>
				Arr.sort(
					[...values],
					Order.mapInput(Order.String, ([resource]: readonly [Resource, number]) => resource)
				)
			)
	}
}

/** The interleaving of `sessions` on the lock manager, its state read at the end. */
export const onLocks = <S extends string>(
	sessions: Sessions<S, Move>
): Interleave<S, Move, "state"> => ({
	sessions,
	exclusive: [],
	state: Option.some("state")
})

/** What a run decided, as the oracle compares runs: the final state and how each session ended. */
export const decidedBy = <S extends string>(run: LockRun<S>) =>
	Formatter.format({ state: run.state, sessions: [...run.sessions] })

/** Every distinct result `every` reaches over `sessions`, with or without sleep sets, and the engine's report. */
export const resultsOf = <S extends string>(sessions: Sessions<S, Move>, reduction: Reduction) =>
	Effect.gen(function* () {
		const results = new Set<string>()
		const report = yield* interleave(
			lockManager<S>(),
			onLocks(sessions),
			{ kind: "every", reduction },
			(run) => Effect.sync(() => results.add(decidedBy(run)))
		)
		return { results, report }
	})

/** A write of a resource, or a commit. */
const writeOf: Gen<Move> = (source) => ({
	kind: "write",
	resource: source.draw(element(RESOURCES)),
	value: source.draw(int(1, 2))
})

/** Two or three sessions, each one or two writes and a commit. */
export const sessionSets: Gen<Sessions<Named, Move>> = (source) => {
	const movesOf = () => {
		const writes = source.draw(array(writeOf, { min: 1, max: 2 }))
		const [first = { kind: "commit" }, ...rest] = writes
		return [first, ...rest, { kind: "commit" }] as const
	}
	const third = source.draw(int(0, 1)) === 1
	return {
		a: { moves: movesOf(), after: Option.none() },
		b: { moves: movesOf(), after: Option.none() },
		c: { moves: third ? movesOf() : [{ kind: "commit" }], after: Option.none() }
	}
}

/** Every ordered pair of distinct resources. */
const PAIRS = [
	["x", "y"],
	["x", "z"],
	["y", "x"],
	["y", "z"],
	["z", "x"],
	["z", "y"]
] as const

/** A write of `resource` at a drawn value. */
const writing =
	(resource: Resource): Gen<Move> =>
	(source) => ({ kind: "write", resource, value: source.draw(int(1, 2)) })

/**
 * Two sessions that each write the same two resources, the second in the first's order or the opposite one, beside a
 * third that writes one resource or only commits.
 */
export const lockingSessions: Gen<Sessions<Named, Move>> = (source) => {
	const [p, q] = source.draw(element(PAIRS))
	const crossed = source.draw(int(0, 1)) === 1
	const third = source.draw(int(0, 1)) === 1
	return {
		a: {
			moves: [source.draw(writing(p)), source.draw(writing(q)), { kind: "commit" }],
			after: Option.none()
		},
		b: {
			moves: crossed
				? [source.draw(writing(q)), source.draw(writing(p)), { kind: "commit" }]
				: [source.draw(writing(p)), source.draw(writing(q)), { kind: "commit" }],
			after: Option.none()
		},
		c: {
			moves: third
				? [source.draw(writing(source.draw(element(RESOURCES)))), { kind: "commit" }]
				: [{ kind: "commit" }],
			after: Option.none()
		}
	}
}

/** Two sessions that write two distinct resources in opposite orders, each at a drawn value, then commit. */
export const crossingSessions: Gen<Sessions<"a" | "b", Move>> = (source) => {
	const [p, q] = source.draw(element(PAIRS))
	return {
		a: {
			moves: [source.draw(writing(p)), source.draw(writing(q)), { kind: "commit" }],
			after: Option.none()
		},
		b: {
			moves: [source.draw(writing(q)), source.draw(writing(p)), { kind: "commit" }],
			after: Option.none()
		}
	}
}

/**
 * Sessions that each write their own resource, once or twice: every move of one commutes with every other's, as the
 * lock manager's commute says of two writes of different resources. A commit commutes with nothing there, so none is
 * drawn; the engine releases each session's locks when its run ends.
 */
export const disjointSessions: Gen<Sessions<Named, Move>> = (source) => {
	const own = (resource: Resource): Arr.NonEmptyReadonlyArray<Move> => {
		const first: Move = { kind: "write", resource, value: source.draw(int(1, 2)) }
		return source.draw(int(0, 1)) === 1 ? [first, { kind: "write", resource, value: 2 }] : [first]
	}
	return {
		a: { moves: own("x"), after: Option.none() },
		b: { moves: own("y"), after: Option.none() },
		c: { moves: own("z"), after: Option.none() }
	}
}

/** How many orders interleave sessions of these lengths, each keeping its own order: (Σ n)! / Π n!. */
export const multinomialOf = (lengths: ReadonlyArray<number>): number => {
	const factorial = (n: number): number => (n <= 1 ? 1 : n * factorial(n - 1))
	return Arr.reduce(
		lengths,
		factorial(Arr.reduce(lengths, 0, (sum, n) => sum + n)),
		(orders, n) => orders / factorial(n)
	)
}

/** Each session's after: none, or one of the sessions, itself included. */
export type Afters = Readonly<Record<Named, Option.Option<Named>>>

/** A session's after: none, or one of the sessions, itself included. */
const afterGen: Gen<Option.Option<Named>> = element([
	Option.none(),
	Option.some("a"),
	Option.some("b"),
	Option.some("c")
])

/** An after for each of the three sessions. */
export const aftersGen: Gen<Afters> = (source) => ({
	a: source.draw(afterGen),
	b: source.draw(afterGen),
	c: source.draw(afterGen)
})

/** Whether two lists hold the same members, in any order. */
export const sameMembers = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
	a.length === b.length && Arr.every(a, (member) => Arr.contains(b, member))

/** The loops the afters form, each its sessions: following each session's after until a session repeats. */
export const loopsOf = (afters: Afters): ReadonlyArray<ReadonlyArray<Named>> => {
	const loops: Array<ReadonlyArray<Named>> = []
	for (const start of Struct.keys(afters)) {
		const path: Array<Named> = []
		let at: Option.Option<Named> = Option.some(start)
		while (Option.isSome(at) && !Arr.contains(path, at.value)) {
			path.push(at.value)
			at = afters[at.value]
		}
		if (Option.isSome(at)) {
			const loop = Arr.dropWhile(path, (name) => name !== at.value)
			if (!Arr.some(loops, (known) => sameMembers(known, loop))) {
				loops.push(loop)
			}
		}
	}
	return loops
}

/** Whether a failure is the refusal of sessions whose afters form a cycle. */
export const isAfterCycle = Schema.is(AfterCycle)

/** Sessions of one commit each, every one starting after its after. */
export const afterSessions = (afters: Afters): Sessions<Named, Move> => ({
	a: { moves: [{ kind: "commit" }], after: afters.a },
	b: { moves: [{ kind: "commit" }], after: afters.b },
	c: { moves: [{ kind: "commit" }], after: afters.c }
})

/** A script's case: two sessions that write one resource and commit, and the decisions the script lists. */
export type Scripted = Readonly<{
	sessions: Sessions<"a" | "b", Move>
	script: ReadonlyArray<Choice<"a" | "b", "state">>
}>

/** A session that writes x once or twice, each at a drawn value, then commits. */
const writesOfX: Gen<Arr.NonEmptyReadonlyArray<Move>> = (source) => {
	const first = source.draw(writing("x"))
	return source.draw(int(0, 1)) === 1
		? [first, source.draw(writing("x")), { kind: "commit" }]
		: [first, { kind: "commit" }]
}

/** A decision a script may list: a move or a join of either session, or a read of the state. */
const scriptChoice: Gen<Choice<"a" | "b", "state">> = element([
	{ kind: "move", session: "a" },
	{ kind: "move", session: "b" },
	{ kind: "join", session: "a" },
	{ kind: "join", session: "b" },
	{ kind: "read", query: "state" }
])

/**
 * Two sessions that write one resource and commit, so the second to write waits on the first until it commits, and a
 * script of up to eight decisions of any kind, possible or not.
 */
export const scriptedCases: Gen<Scripted> = (source) => ({
	sessions: {
		a: { moves: source.draw(writesOfX), after: Option.none() },
		b: { moves: source.draw(writesOfX), after: Option.none() }
	},
	script: source.draw(array(scriptChoice, { min: 0, max: 8 }))
})

/** What a script makes of a run, as the hand walk predicts it and as a run shows it. */
export type Followed = Readonly<{
	made: ReadonlyArray<Choice<"a" | "b", "state">>
	ending:
		| Readonly<{ kind: "finished" }>
		| Readonly<{ kind: "stopped"; at: number; choice: Choice<"a" | "b", "state"> }>
	reads: ReadonlyArray<Read<"state", Snapshot>>
}>

/** What a run shows of its script: the decisions it made, how it ended (without its prose) and its reads. */
export const followedOf = (run: LockRun<"a" | "b">): Followed => ({
	made: Arr.map(run.tape, (decision) => decision.choice),
	ending: endingOf(run.ending),
	reads: run.reads
})

const endingOf = (ending: Ending<"a" | "b", "state">): Followed["ending"] => {
	switch (ending.kind) {
		case "stopped":
			return { kind: "stopped", at: ending.at, choice: ending.choice }
		case "finished":
		case "pruned":
			return { kind: "finished" }
	}
}

/** Where a script's run ends: each must be reached. */
export type ScriptSituation =
	| "the script ran out"
	| "stopped at a move of a done session"
	| "stopped at a move of a session in flight"
	| "stopped at a join of a move in flight"

/** A script's run as the hand walk predicts it, and the situation it ends in. */
export type Walked = Readonly<{ followed: Followed; situation: ScriptSituation }>

/**
 * A script walked by hand over one lock, the second implementation the engine's script strategy is checked against:
 * a move issues its session's next move, which ends at once unless it is a write of x while the other session holds
 * it, when it waits until that session commits; a move of a session that is done, or whose move waits, and a join of a
 * session whose move waits, cannot be made, and stop the script there; a read reads the values written, at the run's
 * event clock (each issue and each ending counts one).
 */
export const walkScript = (scripted: Scripted): Walked => {
	const next = new Map<"a" | "b", number>()
	const done = new Set<"a" | "b">()
	const values = new Map<Resource, number>()
	const made: Array<Choice<"a" | "b", "state">> = []
	const reads: Array<Read<"state", Snapshot>> = []
	let holder: Option.Option<"a" | "b"> = Option.none()
	let waiting: Option.Option<"a" | "b"> = Option.none()
	let clock = 0
	const moveOf = (session: "a" | "b"): Move =>
		Arr.getUnsafe(scripted.sessions[session].moves, next.get(session) ?? 0)
	const ended = (session: "a" | "b") => {
		clock += 1
		const index = (next.get(session) ?? 0) + 1
		next.set(session, index)
		if (index === scripted.sessions[session].moves.length) {
			done.add(session)
		}
	}
	const wrote = (session: "a" | "b", value: number) => {
		holder = Option.some(session)
		values.set("x", value)
		ended(session)
	}
	const issue = (session: "a" | "b") => {
		const move = moveOf(session)
		clock += 1
		if (move.kind === "commit") {
			holder = Option.none()
			ended(session)
			const granted = waiting
			waiting = Option.none()
			Option.map(granted, (waiter) => {
				const write = moveOf(waiter)
				if (write.kind === "write") {
					wrote(waiter, write.value)
				}
			})
			return
		}
		if (Option.isNone(holder) || holder.value === session) {
			wrote(session, move.value)
			return
		}
		waiting = Option.some(session)
	}
	const stopped = (
		at: number,
		choice: Choice<"a" | "b", "state">,
		situation: ScriptSituation
	): Walked => ({
		followed: { made, ending: { kind: "stopped", at, choice }, reads },
		situation
	})
	for (const [at, choice] of scripted.script.entries()) {
		switch (choice.kind) {
			case "move":
				if (done.has(choice.session)) {
					return stopped(at, choice, "stopped at a move of a done session")
				}
				if (Option.contains(waiting, choice.session)) {
					return stopped(at, choice, "stopped at a move of a session in flight")
				}
				made.push(choice)
				issue(choice.session)
				break
			case "join":
				if (Option.contains(waiting, choice.session)) {
					return stopped(at, choice, "stopped at a join of a move in flight")
				}
				made.push(choice)
				break
			case "read":
				made.push(choice)
				reads.push({
					query: "state",
					value: Arr.sort(
						[...values],
						Order.mapInput(Order.String, ([resource]: readonly [Resource, number]) => resource)
					),
					at: clock
				})
				break
		}
	}
	return {
		followed: { made, ending: { kind: "finished" }, reads },
		situation: "the script ran out"
	}
}

/**
 * A chooser that makes each decision on the case's own tape, so a schedule drawn through it shrinks with the case.
 */
export const caseChooser = <F extends string>(c: Case<F>): Chooser => ({
	exhausted: () => false,
	draw: (lo, hi, _at, spread) =>
		c.draw((source) => (spread === "leaning" ? source.choose(lo, hi) : source.pick(lo, hi)))
})

/** The nature of a recording: what a run draws and what the system decided go on the recording's tape. */
export const natureOf = (recorded: Recording): Nature => ({
	draw: (generator) => recorded.source.draw(generator),
	observe: (decided) => recorded.source.observe(fnv1a32(decided))
})

/** One run of `sessions` whose decisions `nature` draws. */
export const oneDrawnRun = <S extends string>(sessions: Sessions<S, Move>, nature: Nature) =>
	Effect.gen(function* () {
		const runs: Array<LockRun<S>> = []
		yield* interleave(lockManager<S>(), onLocks(sessions), { kind: "drawn", nature }, (run) =>
			Effect.sync(() => runs.push(run))
		)
		return Option.getOrThrow(Arr.head(runs))
	})

/** How a run of the release property ends, as a case draws it. */
const ENDINGS = [
	"every order",
	"every order, the second refused",
	"a script",
	"drawn decisions"
] as const

export type ReleaseEnding = (typeof ENDINGS)[number]

/** A release case: a session set, the script a scripted run follows, and how the case ends its runs. */
export type ReleaseCase = Readonly<{
	sessions: Sessions<Named, Move>
	script: ReadonlyArray<Named>
	ending: ReleaseEnding
}>

/**
 * A session set, the script a scripted run follows (moves of any session, so it stops or runs out part-way), and how
 * the case ends its runs, `ending` when given and drawn otherwise.
 */
export const releaseCases =
	(ending: Option.Option<ReleaseEnding>): Gen<ReleaseCase> =>
	(source) => ({
		sessions: source.draw(sessionSets),
		script: source.draw(array(element(["a", "b", "c"] as const), { min: 0, max: 6 })),
		ending: Option.getOrElse(ending, () => source.draw(element(ENDINGS)))
	})

/** A schedule a case draws on its tape: each decision drawn, or a PCT schedule of one, two or three priority changes. */
export const drawnScheduling: Gen<Scheduling<Named, "state">> = element([
	{ kind: "drawn" },
	{ kind: "pct", depth: 1 },
	{ kind: "pct", depth: 2 },
	{ kind: "pct", depth: 3 }
])
