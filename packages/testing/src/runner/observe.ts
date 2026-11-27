import { registerHooks, syncBuiltinESMExports } from "node:module"
import type { WorkerOptions } from "node:worker_threads"
import { regex } from "arkregex"
import type { ChildOutcome, ChildRecord } from "#runner/child-record.ts"
import {
	type Act,
	type After,
	asIs,
	cwdOf,
	FS_ACTS,
	isCallable,
	isList,
	isLive,
	lookedFor,
	pathOf,
	RECORD_FILE,
	recorded,
	restarted,
	type Runs,
	searchPathOf,
	STRACE,
	STRACE_PREFIX,
	startOf,
	throughShell,
	traceFileOf,
	wrapped,
	writes
} from "#runner/intercept.ts"
import { recorderArguments } from "#runner/recorder.ts"
import type { KeyedRead } from "#runner/strace.ts"

/**
 * What a property does past its verdict's key, watched in the process that runs it (runner/worker.ts). A verdict is
 * keyed by what the property can load (its joint closure, runner/affected.ts), the toolchain that runs it, the runtime,
 * the environment its workers are given and its seeds (runner/cache.ts VerdictKey). The guard sees every act of the
 * process past that: node:fs's calls that read the file system, node:child_process's starts, node:net's and node:tls's
 * connections, fetch, and worker_threads' Worker, wrapped once as the process starts (guardInstalled) and given to every
 * ES module importing them (syncBuiltinESMExports), and sorts them in two:
 *
 * - a keyable read (runner/strace.ts KeyedRead): a file's bytes read, a directory listed, a path's presence probed, a
 *   path resolved (realpath, whose own walk of the path with lstat, stat and readlink is its one act), a symbolic
 *   link's text read, by the process or by a child it starts, once the worker gives the guard its reader
 *   (guardChildren): a Node child records its own (runner/recorder.ts), any other runs under strace (runner/strace.ts).
 *   Each is drained with the unit it answers (guardDrain), and a pass keeps their digests beside its key
 *   (runner/traces.ts): it answers while they read alike;
 * - an observation past every key: a path's status or watch (a time, an inode), the machine's live state read as a
 *   file (/proc, /sys, /dev), a child the guard cannot watch (a shell, exec, fork, one not Node where strace is missing)
 *   or that outlives its unit, what a Node child's recorder cannot see into, a connection, a thread. A property that made one is never answered from the cache (runner/cli.ts `run`).
 *
 * An act counts when the process is outside Node's module loader, whose reads are the closure's, which the closure hash
 * keys; and none when it reads the process's own data: a path under a directory the process (or a child it traced)
 * made or a file it wrote, whatever made it; nor when it reads the substrate's state, a path one of the run's own
 * servers holds (guardServers: a member's socket directory, its password file, its CA), which the database it is
 * accounts for. In a property's window (a unit of it, from its readying to its last case:
 * guardWindow) an act is that unit's; outside any window (the worker's start, its runner config's modules evaluated, a
 * property's work that outlives its window) a keyable read joins the process's reads all the same, which every later
 * trace of the worker takes, and an observation is the next window's first, so its property and every later one of the
 * worker are unclean. The guard is installed as a worker's first act (runner/worker-entry.ts), before any other module
 * loads, so every module of the process takes the wrapped functions, whenever it reads them; the runner's own acts in a
 * window are no property's: its modules use Node's functions as they were before the guard (unwatched: live.ts's
 * watchdog thread, runner/work.ts's and usage.ts's reads of /proc, live.ts processWorkNow's of a child's tree among them, resources/scratch.ts's remover), and the toolchain
 * digest keys them, as are the acts of a fiber doing the runner's own work (runner/infrastructure.ts: a worker's
 * services built, a cluster's members held, brought up and settled, its sessions opened), which the worker tells the
 * guard of (guardRunnerOwn). A connection to one of the run's own servers (guardServers: its cluster's members) is a
 * keyable read of the PostgreSQL that serves it, the runner's or a property's alike, never an observation: the server's
 * state is the run's own, clones of templates its closures declare. This module loads only Node's own and arkregex, so
 * it is in place before any other loads.
 *
 * A process that observed once is unclean for the rest of its life, so every property it runs a unit of after is
 * unclean too, and every keyable read it made is in the trace of every property it runs a unit of after: a module may
 * keep what it read for a later property (a memo, a module-level value), which that property then reads through it
 * without reading anything itself (runner/pool.ts Observed). A child's stat is keyed by what it names (the path's
 * presence and kind, and its bytes where the child reads them), not by its times or inode, and its reads of the
 * machine's live state are none: tsgo, a compiler's tools and the libraries they load read no time to decide a verdict.
 *
 * A database property's server is keyed by what it is: its template by the template's identity, in its closure (the
 * declaring module's import closure, the template's name and content), and by what its build read, which the template
 * keeps and every opener that did not build it is given as its own reads (guardRecorded, resources/template.ts), a
 * build's acts collected apart beside its window (guardCollecting, runner/collected.ts); the PostgreSQL serving the run's own members by
 * the `postgres` read every connection to one makes, the digest of every byte of the installation (its version, its
 * extensions) and of the workbench's postgres@.service and the files its lines name; the members' settings by
 * pg.config.ts, in every closure, from which settle writes them. A clone starts with its template's database settings
 * and sequence states, which the template's build made.
 *
 * What no act shows is out of reach of the guard, and of any key (main's rulings, 2026-11-24 and 2026-11-25), and so is
 * assumed of every property: the clock, in-process or the server's (now(), a transaction's timestamps); a random
 * number not drawn from the case's tape, in-process or the server's (random()); the machine's live state read through
 * node:os or process (load, memory, a process's id); the cluster's identities (OIDs, transaction ids, backend pids, as
 * a file's inode); other sessions' activity on the cluster (autovacuum, statistics, the plans they lead to, other runs'
 * roles in its shared catalogs); a value one property leaves in a module's state for another without reading
 * anything; and the checkout's absolute path, which a key cannot hold without ending every reuse across checkouts. Properties draw their randomness from their tapes, results leave the database in canonical order, tests
 * move their clocks, and verdicts do not depend on the machine's load or which properties shared their worker: the
 * runner already schedules any unit on any worker.
 */

/** What a process observed past its verdict's key, the first time: what it did, and on what. */
export type Observation =
	| Readonly<{ kind: "read"; call: string; path: string }>
	| Readonly<{ kind: "child"; call: string; command: string }>
	| Readonly<{ kind: "network"; call: string; target: string }>
	| Readonly<{ kind: "thread"; entry: string }>

/** An observation as a line of a report. */
export const observationText = (observation: Observation): string => {
	switch (observation.kind) {
		case "read":
			return `it read ${observation.path} (${observation.call})`
		case "child":
			return `it started a child process, ${observation.command} (${observation.call})`
		case "network":
			return `it opened a connection to ${observation.target} (${observation.call})`
		case "thread":
			return `it started a thread, ${observation.entry}`
	}
}

/**
 * Node's functions the runner's own code acts with in a property's window, as they were when this module loaded, before
 * any guard wrapped them: its acts are the toolchain's, which its digest keys, never a property's observation.
 */
export const unwatched = Object.freeze({
	readFileSync: process.getBuiltinModule("node:fs").readFileSync,
	readdirSync: process.getBuiltinModule("node:fs").readdirSync,
	readlinkSync: process.getBuiltinModule("node:fs").readlinkSync,
	existsSync: process.getBuiltinModule("node:fs").existsSync,
	spawn: process.getBuiltinModule("node:child_process").spawn,
	Worker: process.getBuiltinModule("node:worker_threads").Worker
})

/** The window a process is in: a unit's of a property, by its id, or none. */
type Window = Readonly<{ kind: "open"; unit: number }> | Readonly<{ kind: "closed" }>

/**
 * The tracer of this process, as /proc/self/status states it: 0 for none. A process already traced (a child of a traced
 * property: a run a property starts) cannot trace its own children, since a process has one tracer, so its children are
 * observations.
 */
const TRACER = regex("^TracerPid:\\s*([0-9]+)$", "m")

/**
 * Where a socket's connection goes, as Socket.prototype.connect's arguments name it: a socket's path (`path`, or a text
 * alone), or `host:port` (an options object's, or a port and a host, `localhost` where none is named); net.connect hands
 * it its arguments normalized, as one list.
 */
const connectionTargetOf = (args: ReadonlyArray<unknown>): string => {
	const [given, also] = args
	if (isList(given)) {
		const normalized: Array<unknown> = []
		for (const one of given) {
			normalized.push(one)
		}
		return connectionTargetOf(normalized)
	}
	const first = given
	const second = also
	if (typeof first === "string") {
		return first
	}
	if (typeof first === "number") {
		return `${typeof second === "string" ? second : "localhost"}:${first}`
	}
	if (typeof first === "object" && first !== null) {
		const options: Record<string, unknown> = { ...first }
		const path = options["path"]
		if (typeof path === "string") {
			return path
		}
		const host = options["host"]
		const port = options["port"]
		return `${typeof host === "string" ? host : "localhost"}:${typeof port === "number" || typeof port === "string" ? `${port}` : ""}`
	}
	return String(first)
}

/** Where a connection goes, as its first argument names it: a path, a port, or an options object's path, host and port. */
const targetOf = (given: unknown): string => {
	if (typeof given === "object" && given !== null) {
		const options: Record<string, unknown> = { ...given }
		const part = (name: string): string => {
			const value = options[name]
			return typeof value === "string" || typeof value === "number" ? `${value}` : ""
		}
		return `${part("path")}:${part("host")}:${part("port")}`
	}
	return String(given)
}

/**
 * What reads a child's record directory once it has exited: the reader a worker gives the guard once its own modules
 * have loaded (runner/child-record.ts childOutcomeOf).
 */
type ChildReader = (record: ChildRecord) => ChildOutcome

/**
 * The process's guard: its window; whether the window has observed past every key; the observation made outside any
 * window, which the next window is told; how deep in Node's module loader it is; the keyable reads the process made,
 * each once, those not yet drained apart, and who made the windows' keyable reads since the last drain; the children
 * the window started watched (recorded or traced) that have not ended; and the reader of their record directories,
 * none until a worker gives it.
 */
const guard: {
	window: Window
	seen: boolean
	pending: Observation | undefined
	loading: number
	traced: Set<string>
	undrained: Array<KeyedRead>
	by: ReadBy
	running: Set<number>
	reader: ChildReader | undefined
	observed: (observation: Observation, unit: number) => void
	servers: Set<string>
	held: Set<string>
	runnersOwn: () => boolean
	collecting: () => CollectedActs | undefined
	recorded: (reads: ReadonlyArray<KeyedRead>, observation: Observation | undefined) => void
} = {
	window: { kind: "closed" },
	seen: false,
	pending: undefined,
	loading: 0,
	traced: new Set(),
	undrained: [],
	by: "none",
	running: new Set(),
	reader: undefined,
	observed: () => undefined,
	servers: new Set(),
	held: new Set(),
	runnersOwn: () => false,
	collecting: () => undefined,
	recorded: () => undefined
}

/**
 * Opens a unit's window (its id) or closes the window (none): each window's first observation is told, an observation
 * made outside any window since the last being the first of the window that opens next.
 */
export const guardWindow = (window: Window): void => {
	guard.window = window
	guard.seen = false
	guard.running.clear()
	if (window.kind === "closed" || guard.pending === undefined) {
		return
	}
	guard.seen = true
	guard.observed(guard.pending, window.unit)
	guard.pending = undefined
}

/**
 * Gives the guard what tells the runner's own work from a property's (runner/infrastructure.ts inInfrastructure): an act
 * of the runner's own (a cluster's holds, leases and settles, its sessions, a worker's services built) is no property's,
 * which the toolchain digest keys.
 */
export const guardRunnerOwn = (probe: () => boolean): void => {
	guard.runnersOwn = probe
}

/**
 * Tells the guard one of the run's own servers, a member of the run's cluster (resources/cluster.ts), whose state is
 * the run's own (clones of templates its closures declare) and whose software the PostgreSQL digest states: every
 * address a client reaches it at (a socket's path, `host:port`), so a connection to it, the runner's or a property's,
 * is a keyable read of the PostgreSQL that serves it (a KeyedRead of kind `postgres`), never an observation; and every
 * path it holds, as its cluster's spec declares them (its socket directory, its owner's password file, its CA), the
 * substrate's state, which the verdict accounts for as the database it is, so a read under one, the process's or a
 * child's, is neither a keyable read nor an observation (a child connecting over the socket stats its directory, which
 * changes whenever the member starts: grizzle's exitsOnceItsScopesClose was never kept, lane TRACE, 2026-11-26).
 */
export const guardServers = (
	server: Readonly<{ addresses: ReadonlyArray<string>; holds: ReadonlyArray<string> }>
): void => {
	for (const address of server.addresses) {
		guard.servers.add(address)
	}
	for (const held of server.holds) {
		guard.held.add(held)
	}
}

/**
 * Gives the guard the reader of its children's record directories (runner/child-record.ts childOutcomeOf): until then a
 * child is no keyable act.
 */
export const guardChildren = (reader: ChildReader): void => {
	guard.reader = reader
}

/**
 * What a piece of a property's work read and observed while it ran (runner/collected.ts collectedOf: a database
 * template's build, resources/template.ts): every keyable read its process made, or a child it started then made, each
 * as the guard keys it and whether or not the process had made it before; and its first observation past every key.
 */
export type CollectedActs = { readonly reads: Array<KeyedRead>; observed: Observation | undefined }

/**
 * Gives the guard what tells it the collection the running fiber's acts go to, beside its window (runner/collected.ts
 * collectingNow): none outside one. A child's acts go to the collection its start was made in.
 */
export const guardCollecting = (probe: () => CollectedActs | undefined): void => {
	guard.collecting = probe
}

/**
 * Makes `reads` and `observation` acts of the property now running, as if its process had made them: what a database
 * template's build read and observed, given to every opener of the template that did not build it
 * (resources/template.ts), so a verdict that rests on what the template holds rests on what its build read. Nothing
 * where no guard is installed, or where the runner's own work makes them.
 */
export const guardRecorded = (
	reads: ReadonlyArray<KeyedRead>,
	observation: Observation | undefined
): void => {
	guard.recorded(reads, observation)
}

/**
 * Who made a window's keyable reads, the widest reader first: a child the window started under strace (`children`),
 * the process itself (`process`), or no one (`none`). A property's windows' widest reader is its conduct (runner/run.ts
 * Conduct), which places it among workers of its kind.
 */
export type ReadBy = "none" | "process" | "children"

/** The wider of two readers (ReadBy). */
export const widerOf = (left: ReadBy, right: ReadBy): ReadBy =>
	left === "children" || right === "children"
		? "children"
		: left === "process" || right === "process"
			? "process"
			: "none"

/**
 * What a drain gives: the keyable reads (KeyedRead) the process made since the last drain, each read once over the
 * process's life, and who made the windows' keyable reads since then (ReadBy), each counted whether or not it read
 * anew.
 */
export type Drained = Readonly<{ reads: ReadonlyArray<KeyedRead>; by: ReadBy }>

/**
 * The process's reads since the last drain (Drained): what a worker sends its parent with each readying and unit it
 * answers (runner/worker.ts). A child the open window started under strace that has not ended is an observation of the
 * window first: its reads are not all known.
 */
export const guardDrain = (): Drained => {
	if (guard.window.kind === "open" && guard.running.size > 0 && !guard.seen) {
		guard.seen = true
		guard.observed(
			{ kind: "child", call: "a child still running as its unit ended", command: "?" },
			guard.window.unit
		)
	}
	const drained: Drained = { reads: guard.undrained, by: guard.by }
	guard.undrained = []
	guard.by = "none"
	return drained
}

/**
 * Installs this process's guard (the module's doc): wraps node:fs's reading and making calls, node:fs/promises',
 * node:child_process's, node:net's and node:tls's connections, fetch and worker_threads' Worker, and brackets Node's
 * module loader so its reads are no observation; `observed` is told each window's first observation past every key and
 * the unit whose window it is. A file's bytes read, a directory listed or a path probed in a window is a keyable read
 * (KeyedRead), drained by guardDrain; a child a window starts is watched when the guard has its reader (a Node child
 * under its own recorder, runner/recorder.ts, any other under strace, runner/strace.ts), its reads keyable as the
 * process's own, and is an observation otherwise. Called once, as a worker's first act (runner/worker-entry.ts).
 */
export const guardInstalled = (
	observed: (observation: Observation, unit: number) => void
): void => {
	guard.observed = observed
	const ownDirectories = new Set<string>()
	const ownFiles = new Set<string>()
	const path = process.getBuiltinModule("node:path")
	const fs = process.getBuiltinModule("node:fs")
	const original = {
		readFileSync: fs.readFileSync,
		readdirSync: fs.readdirSync,
		mkdtempSync: fs.mkdtempSync,
		rmSync: fs.rmSync,
		existsSync: fs.existsSync,
		statSync: fs.statSync,
		accessSync: fs.accessSync,
		realpathNative: fs.realpathSync.native
	}
	/** A call of the guard's own that may fail, its failure `failed`. */
	const failing = <A>(call: () => A): A | "failed" => {
		try {
			return call()
		} catch {
			return "failed"
		}
	}
	/**
	 * Whether this process can watch its children: no tracer traces it and no recorder records it (a process has one
	 * tracer, and a recorded process's recorder watches every child it starts itself, runner/recorder.ts).
	 */
	const tracer = TRACER.exec(original.readFileSync("/proc/self/status", "utf8"))
	const watches = (tracer === null || tracer[1] === "0") && !recorded()
	/** Whether a path is an executable regular file, as execvp(3) would run it. */
	const executable = (file: string): boolean => {
		const status = failing(() => original.statSync(file, { throwIfNoEntry: false }))
		return (
			status !== undefined &&
			status !== "failed" &&
			status.isFile() &&
			failing(() => original.accessSync(file, fs.constants.X_OK)) !== "failed"
		)
	}
	const strace = executable(STRACE) ? STRACE : undefined
	/** This process's own Node, by its real path: a child running it is a Node child, which records its own reads. */
	const node = failing(() => original.realpathNative(process.execPath))
	/** Whether a path is the process's own data (under what it made) or the substrate's (under what a server holds). */
	const isOwn = (file: string): boolean => {
		let at = file
		for (;;) {
			if (ownFiles.has(at) || ownDirectories.has(at) || guard.held.has(at)) {
				return true
			}
			const up = path.dirname(at)
			if (up === at) {
				return false
			}
			at = up
		}
	}
	/**
	 * The context of a call whose own implementation is one act, though it calls node:fs's wrapped functions again: the
	 * callback form of realpath, which walks its path with lstat, stat and readlink. Each of its inner calls is the act's,
	 * none of them a property's; the callback it answers runs outside it, so what the caller does there is watched.
	 */
	const within = new (process.getBuiltinModule("node:async_hooks").AsyncLocalStorage)<true>()
	/** Runs a call inside `within`: its inner calls are its own act's. */
	const inside: Runs = (apply) => within.run(true, apply)
	/** Whether an act now is a property's: outside Node's module loader, a composite call's inside and the runner's own work. */
	const acting = (): boolean =>
		guard.loading === 0 && within.getStore() !== true && !guard.runnersOwn()
	/** Whether an act now is a unit's: a property's (acting) in a unit's window. */
	const watching = (): boolean => guard.window.kind === "open" && acting()
	/**
	 * A property's act past every key: the window's first is told with its unit; one outside any window (a worker's
	 * start, a property's work that outlives its window) is told as the next window's first.
	 */
	const saw = (observation: Observation): void => {
		if (!acting()) {
			return
		}
		told(observation, guard.collecting())
	}
	/**
	 * An act past every key the property made, told to the collection `into` it goes to (if any) and to its window, as
	 * saw tells it: what a watched child's outcome observed, told once the child has ended.
	 */
	const told = (observation: Observation, into: CollectedActs | undefined): void => {
		if (into !== undefined && into.observed === undefined) {
			into.observed = observation
		}
		if (guard.window.kind === "closed") {
			guard.pending = guard.pending ?? observation
			return
		}
		if (!guard.seen) {
			guard.seen = true
			observed(observation, guard.window.unit)
		}
	}
	const made = (file: string | undefined, directory: boolean): void => {
		if (file !== undefined) {
			;(directory ? ownDirectories : ownFiles).add(file)
		}
	}
	/**
	 * An act on `file`: nothing where the file is the process's own or a run's server holds it (isOwn); an observation
	 * where no key holds what it reads (a status, a watch) or the file is the machine's live state; else a keyable read,
	 * kept once over the process's life.
	 */
	const traced = (
		kind: KeyedRead["kind"] | "unkeyable",
		file: string,
		call: string,
		into: CollectedActs | undefined
	): void => {
		if (kind !== "postgres" && isOwn(file)) {
			return
		}
		if (kind === "unkeyable" || (kind !== "postgres" && isLive(file))) {
			saw({ kind: "read", call, path: file })
			return
		}
		into?.reads.push({ kind, path: file })
		if (guard.window.kind === "open") {
			guard.by = widerOf(guard.by, "process")
		}
		const key = `${kind}\u0000${file}`
		if (!guard.traced.has(key)) {
			guard.traced.add(key)
			guard.undrained.push({ kind, path: file })
		}
	}
	const readOf =
		(kind: KeyedRead["kind"] | "unkeyable") =>
		(call: string, given: unknown): After => {
			const read = pathOf(given)
			if (acting() && read !== undefined) {
				traced(kind, read, call, guard.collecting())
			}
			return undefined
		}
	/** A temporary directory as mkdtemp returns it, a path or (node:fs/promises') a promise of one, the process's own. */
	const madeTemporary = (returned: unknown): void => {
		if (returned instanceof Promise) {
			returned.then(
				(directory: unknown) => made(pathOf(directory), true),
				() => undefined
			)
			return
		}
		made(pathOf(returned), true)
	}
	const actOf =
		(call: string, act: Act) =>
		(args: Array<unknown>): After => {
			switch (act) {
				case "reads":
					return readOf("file")(call, args[0])
				case "lists":
					return readOf("directory")(call, args[0])
				case "probes":
					return readOf("presence")(call, args[0])
				case "resolves": {
					const last = args.length - 1
					const callback = args[last]
					if (isCallable(callback)) {
						args[last] = function (this: unknown, ...answered: Array<unknown>): unknown {
							return within.exit(() => Reflect.apply(callback, this, answered))
						}
					}
					return readOf("resolution")(call, args[0])
				}
				case "readsLink":
					return readOf("link")(call, args[0])
				case "inspects":
				case "watches":
				case "globs":
					return readOf("unkeyable")(call, args[0])
				case "opens":
					if (writes(args[1])) {
						made(pathOf(args[0]), false)
						return undefined
					}
					return readOf("file")(call, args[0])
				case "temporary": {
					const last = args.length - 1
					const callback = args[last]
					if (isCallable(callback)) {
						args[last] = (failure: unknown, directory: unknown) => {
							made(pathOf(directory), true)
							return callback(failure, directory)
						}
					}
					return madeTemporary
				}
				case "makesDirectory":
					made(pathOf(args[0]), true)
					return undefined
				case "makes":
					made(pathOf(args[0]), false)
					return undefined
				case "links":
				case "moves":
					made(pathOf(args[1]), false)
					return undefined
				case "copies":
					readOf("file")(call, args[0])
					made(pathOf(args[1]), call === "cp" || call === "cpSync" || call === "promises.cp")
					return undefined
			}
		}
	const fsHost: Record<string, unknown> = fs
	const promisesHost: Record<string, unknown> = fs.promises
	for (const [name, act] of FS_ACTS) {
		const runs = act === "resolves" ? inside : asIs
		for (const call of [name, `${name}Sync`]) {
			wrapped(fsHost, call, actOf(call, act), runs)
			const host: unknown = fsHost[call]
			if (isCallable(host)) {
				wrapped(host, "native", actOf(`${call}.native`, act), runs)
			}
		}
		wrapped(promisesHost, name, actOf(`promises.${name}`, act), runs)
	}
	/**
	 * What a watched child is to its unit once it has ended: its record directory read and gone, its acts the process's
	 * own (its makings the process's own data, its reads keyable reads), or an observation of the unit's window where
	 * its outcome holds one.
	 */
	type Watch = Readonly<{ command: string; ended: () => void; dropped: () => void }>
	/**
	 * A child about to start for the open window, its call's arguments made over in place to watch it: a Node child
	 * (its command, found as execvp(3) finds it, is this process's own Node) under its own recorder, any other under
	 * strace, each writing to a record directory of its own; none where the guard does not watch it (no reader, no
	 * window, a process that cannot watch its children, a child run through a shell, or no strace for a child not Node),
	 * whose start is then an observation of the window.
	 */
	const watched = (call: string, args: Array<unknown>): Watch | undefined => {
		const start = startOf(args)
		if (!watching()) {
			saw({ kind: "child", call, command: start.command })
			return undefined
		}
		const reader = guard.reader
		if (!watches || reader === undefined || throughShell(start.options)) {
			saw({ kind: "child", call, command: start.command })
			return undefined
		}
		let runs: string | undefined
		for (const one of lookedFor(
			start.command,
			searchPathOf(start.options, process.env),
			cwdOf(start.options),
			executable
		)) {
			runs = one.found ? one.path : runs
		}
		const isNode =
			runs !== undefined &&
			node !== "failed" &&
			failing(() => original.realpathNative(runs)) === node
		if (!isNode && strace === undefined) {
			saw({ kind: "child", call, command: start.command })
			return undefined
		}
		const into = guard.collecting()
		const directory = original.mkdtempSync(
			path.join(process.getBuiltinModule("node:os").tmpdir(), "toolchain-child-")
		)
		restarted(
			args,
			isNode
				? { ...start, args: [...recorderArguments(directory), ...start.args] }
				: {
						command: STRACE,
						args: [
							...STRACE_PREFIX,
							path.join(directory, traceFileOf(process.pid, 0, 0)),
							"--",
							start.command,
							...start.args
						],
						options: start.options
					}
		)
		return {
			command: start.command,
			ended: () => {
				let record: string | undefined
				const traces: Array<string> = []
				for (const name of original.readdirSync(directory)) {
					const text = original.readFileSync(path.join(directory, name), "utf8")
					if (name === RECORD_FILE) {
						record = text
					} else {
						traces.push(text)
					}
				}
				const outcome = reader({ node: isNode, record, traces })
				original.rmSync(directory, { recursive: true, force: true })
				for (const one of outcome.acts.made) {
					made(one.path, one.directory)
				}
				if (isNode && runs !== undefined) {
					traced("file", runs, `${call} ${start.command}`, into)
				}
				for (const one of outcome.acts.reads) {
					traced(one.kind, one.path, `${call} ${start.command}`, into)
				}
				guard.by = "children"
				if (outcome.observation !== undefined) {
					told(outcome.observation, into)
				}
			},
			dropped: () => {
				original.rmSync(directory, { recursive: true, force: true })
			}
		}
	}
	const childHost: Record<string, unknown> = process.getBuiltinModule("node:child_process")
	/** Ends a watched child's watch once it exits, or makes it an observation of its window when the window closes first. */
	const followed = (child: unknown, watch: Watch, unit: number): void => {
		if (
			typeof child !== "object" ||
			child === null ||
			!("once" in child) ||
			!isCallable(child.once)
		) {
			watch.dropped()
			return
		}
		const pid = "pid" in child && typeof child.pid === "number" ? child.pid : -1
		guard.running.add(pid)
		child.once("exit", () => {
			const stillOpen =
				guard.window.kind === "open" && guard.window.unit === unit && guard.running.has(pid)
			guard.running.delete(pid)
			if (stillOpen) {
				watch.ended()
				return
			}
			watch.dropped()
			observed(
				{ kind: "child", call: "a child that outlived its unit's window", command: watch.command },
				unit
			)
		})
	}
	for (const call of ["spawn", "execFile"] as const) {
		wrapped(
			childHost,
			call,
			(args) => {
				const watch = watched(call, args)
				const unit = guard.window.kind === "open" ? guard.window.unit : -1
				return watch === undefined ? undefined : (child) => followed(child, watch, unit)
			},
			asIs
		)
	}
	for (const call of ["spawnSync", "execFileSync"] as const) {
		wrapped(
			childHost,
			call,
			(args) => {
				const watch = watched(call, args)
				return watch === undefined ? undefined : () => watch.ended()
			},
			asIs
		)
	}
	for (const call of ["exec", "execSync", "fork"] as const) {
		wrapped(
			childHost,
			call,
			(args) => {
				saw({ kind: "child", call, command: String(args[0]) })
				return undefined
			},
			asIs
		)
	}
	/**
	 * A socket's connection, however it is reached (net.connect, net.createConnection, tls.connect, a client's own
	 * Socket, fetch's), by its first arguments: to one of the run's own servers (guardServers), a keyable read of the
	 * PostgreSQL that serves it, the runner's or a property's alike; to anything else, an observation.
	 */
	const socketHost: object = process.getBuiltinModule("node:net").Socket.prototype
	wrapped(
		socketHost,
		"connect",
		(args) => {
			const target = connectionTargetOf(args)
			if (guard.loading === 0 && guard.servers.has(target)) {
				traced("postgres", "", "connect", guard.collecting())
				return undefined
			}
			saw({ kind: "network", call: "connect", target })
			return undefined
		},
		asIs
	)
	const globalHost: Record<string, unknown> = globalThis
	wrapped(
		globalHost,
		"fetch",
		(args) => {
			saw({ kind: "network", call: "fetch", target: targetOf(args[0]) })
			return undefined
		},
		asIs
	)
	const threads = process.getBuiltinModule("node:worker_threads")
	const Original = threads.Worker
	const threadsHost: Record<string, unknown> = threads
	threadsHost["Worker"] = class extends Original {
		constructor(filename: string | URL, options: WorkerOptions | undefined) {
			saw({ kind: "thread", entry: String(filename) })
			super(filename, options)
		}
	}
	guard.recorded = (reads, observation) => {
		if (!acting()) {
			return
		}
		for (const read of reads) {
			traced(read.kind, read.path, "a database template's build", guard.collecting())
		}
		if (observation !== undefined) {
			saw(observation)
		}
	}
	registerHooks({
		resolve: (specifier, context, nextResolve) => {
			guard.loading += 1
			try {
				return nextResolve(specifier, context)
			} finally {
				guard.loading -= 1
			}
		},
		load: (url, context, nextLoad) => {
			guard.loading += 1
			try {
				return nextLoad(url, context)
			} finally {
				guard.loading -= 1
			}
		}
	})
	syncBuiltinESMExports()
}
