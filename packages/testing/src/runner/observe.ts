import { registerHooks, syncBuiltinESMExports } from "node:module"
import type { WorkerOptions } from "node:worker_threads"
import { regex } from "arkregex"

/**
 * What a property observes past its verdict's key, watched in the process that runs it (runner/worker.ts, and the
 * runner's own process while it opens run needs, runner/runs.ts). A verdict is keyed by what the property can load (its
 * joint closure, runner/affected.ts), the toolchain that runs it, the runtime, the environment its workers are given and
 * its seeds (runner/cache.ts VerdictKey); a property that reads a file at run time, starts a child process, opens a
 * connection or starts a thread observes something no such key holds, so its verdict is never answered from the cache
 * (runner/cli.ts `run`). The guard sees every such act of the process: node:fs's calls that read the file system (a
 * file's bytes, a directory's entries, a path's existence or status, a link's target), each module of node:child_process
 * that starts a process, node:net's and node:tls's connections, fetch, and worker_threads' Worker, wrapped once as the
 * process starts (guardInstalled) and given to every ES module importing them (syncBuiltinESMExports).
 *
 * An act is an observation when the process is in a property's window (a unit of it, from its readying to its last
 * case: Guard.window), outside Node's module loader, whose reads are the closure's, which the closure hash keys; and
 * none when it reads the process's own data: a path under a directory the process made (mkdtemp, mkdir) or a file it
 * wrote, whatever made it. The guard is installed as a worker's first act (runner/worker-entry.ts), before any other
 * module loads, so every module of the process takes the wrapped functions, whenever it reads them; the runner's own
 * acts in a window are no property's: its modules use Node's functions as they were before the guard (unwatched:
 * live.ts's watchdog thread, runner/work.ts's reads of /proc), and the toolchain digest keys them. This module loads
 * only Node's own and arkregex, so it is in place before any other loads. A database need's cluster, reached through child processes and
 * connections, is a property's observation for now: a property that declares one is never cached until the cluster's
 * acts are the runner's.
 *
 * A process that observed once is unclean for the rest of its life, so every property it runs a unit of after is
 * unclean too: a module may keep what it read for a later property (a memo, a module-level value), which that property
 * then observes without reading anything itself. So a property's verdict is answered from the cache only when every
 * worker that ran it had observed nothing up to its last unit there (runner/pool.ts Pool's observed).
 *
 * What no act shows is out of reach of the guard, and of any key: the clock, a random number not drawn from the case's
 * tape, the machine's live state read through node:os or process (load, memory, a process's id), and a value one
 * property leaves in a module's state for another without reading anything. Properties draw their randomness from their
 * tapes, and their verdicts do not depend on the clock, the machine's load or which properties shared their worker:
 * the runner already schedules any unit on any worker.
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
	spawn: process.getBuiltinModule("node:child_process").spawn,
	Worker: process.getBuiltinModule("node:worker_threads").Worker
})

/** The window a process is in: a unit's of a property, by its id, or none. */
type Window = Readonly<{ kind: "open"; unit: number }> | Readonly<{ kind: "closed" }>

/** A file's path as node:fs takes one: a string, a Buffer or a file: URL, made absolute; none for a file descriptor. */
const pathOf = (given: unknown): string | undefined => {
	const path = process.getBuiltinModule("node:path")
	if (typeof given === "string") {
		return path.resolve(given)
	}
	if (given instanceof URL) {
		return given.protocol === "file:"
			? process.getBuiltinModule("node:url").fileURLToPath(given)
			: undefined
	}
	if (given instanceof Uint8Array) {
		return path.resolve(new TextDecoder().decode(given))
	}
	return undefined
}

/** A text of open's flags that writes: one holding w, a or +. */
const WRITING = regex("[wa+]")

/** Whether open's flags write: a numeric flag with any of O_WRONLY, O_RDWR, O_CREAT, or a text with w, a or +. */
const writes = (flags: unknown): boolean => {
	const { constants } = process.getBuiltinModule("node:fs")
	if (typeof flags === "number") {
		return (flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT)) !== 0
	}
	return typeof flags === "string" && WRITING.test(flags)
}

/**
 * What a call of node:fs does with its arguments: reads its path; opens it, reading or writing as its flags say; makes
 * a temporary directory, its returned path the process's own; makes a directory or a file at its path, the process's
 * own; moves its first path to its second, the second its own; or reads its first path and makes its second its own.
 */
type Act = "reads" | "opens" | "temporary" | "makesDirectory" | "makes" | "moves" | "copies"

/** node:fs's functions the guard wraps, by what each does with its arguments; each also under its Sync name. */
const FS_ACTS: ReadonlyArray<readonly [name: string, act: Act]> = [
	["readFile", "reads"],
	["readdir", "reads"],
	["opendir", "reads"],
	["stat", "reads"],
	["lstat", "reads"],
	["statfs", "reads"],
	["exists", "reads"],
	["access", "reads"],
	["realpath", "reads"],
	["readlink", "reads"],
	["watch", "reads"],
	["watchFile", "reads"],
	["glob", "reads"],
	["createReadStream", "reads"],
	["open", "opens"],
	["mkdtemp", "temporary"],
	["mkdir", "makesDirectory"],
	["writeFile", "makes"],
	["appendFile", "makes"],
	["createWriteStream", "makes"],
	["symlink", "makes"],
	["link", "makes"],
	["copyFile", "copies"],
	["cp", "copies"],
	["rename", "moves"]
]

/** node:fs/promises' functions the guard wraps, by what each does with its arguments. */
const PROMISE_ACTS: ReadonlyArray<readonly [name: string, act: Act]> = [
	["readFile", "reads"],
	["readdir", "reads"],
	["opendir", "reads"],
	["stat", "reads"],
	["lstat", "reads"],
	["statfs", "reads"],
	["access", "reads"],
	["realpath", "reads"],
	["readlink", "reads"],
	["watch", "reads"],
	["glob", "reads"],
	["open", "opens"],
	["mkdtemp", "temporary"],
	["mkdir", "makesDirectory"],
	["writeFile", "makes"],
	["appendFile", "makes"],
	["symlink", "makes"],
	["link", "makes"],
	["copyFile", "copies"],
	["cp", "copies"],
	["rename", "moves"]
]

/** node:child_process's functions that start a process. */
const CHILD_CALLS = [
	"spawn",
	"spawnSync",
	"exec",
	"execSync",
	"execFile",
	"execFileSync",
	"fork"
] as const

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

/** A callable, as the guard wraps one. */
type Callable = (...args: Array<unknown>) => unknown

/** Whether a value is callable. */
const isCallable = (value: unknown): value is Callable => typeof value === "function"

/** What a wrapped call does after the original returns, given what it returned, if anything. */
type After = ((returned: unknown) => void) | undefined

/**
 * Replaces `host[name]` by a function that calls `before` with the call's arguments, then the original, then what
 * `before` gave with what the original returned, keeping the original's own properties (util.promisify's custom form
 * among them); nothing where the host has no such function.
 */
const wrapped = (
	host: Record<string, unknown>,
	name: string,
	before: (args: Array<unknown>) => After
): void => {
	const original = host[name]
	if (!isCallable(original)) {
		return
	}
	const wrapper = function (this: unknown, ...args: Array<unknown>): unknown {
		const after = before(args)
		const returned = Reflect.apply(original, this, args)
		if (after !== undefined) {
			after(returned)
		}
		return returned
	}
	Object.defineProperties(wrapper, Object.getOwnPropertyDescriptors(original))
	host[name] = wrapper
}

/** The process's guard: its window, whether the window has observed, and how deep in Node's module loader it is. */
const guard: { window: Window; seen: boolean; loading: number } = {
	window: { kind: "closed" },
	seen: false,
	loading: 0
}

/** Opens a unit's window (its id) or closes the window (none): each window's first observation is told. */
export const guardWindow = (window: Window): void => {
	guard.window = window
	guard.seen = false
}

/**
 * Installs this process's guard (the module's doc): wraps node:fs's reading and making calls, node:fs/promises',
 * node:child_process's, node:net's and node:tls's connections, fetch and worker_threads' Worker, and brackets Node's
 * module loader so its reads are no observation; `observed` is told each window's first observation and the unit whose
 * window it is. Called once, as a worker's first act (runner/worker-entry.ts).
 */
export const guardInstalled = (
	observed: (observation: Observation, unit: number) => void
): void => {
	const ownDirectories = new Set<string>()
	const ownFiles = new Set<string>()
	const path = process.getBuiltinModule("node:path")
	const isOwn = (file: string): boolean => {
		let at = file
		for (;;) {
			if (ownFiles.has(at) || ownDirectories.has(at)) {
				return true
			}
			const up = path.dirname(at)
			if (up === at) {
				return false
			}
			at = up
		}
	}
	const saw = (observation: Observation): void => {
		if (guard.window.kind === "open" && guard.loading === 0 && !guard.seen) {
			guard.seen = true
			observed(observation, guard.window.unit)
		}
	}
	const made = (file: string | undefined, directory: boolean): void => {
		if (file !== undefined) {
			;(directory ? ownDirectories : ownFiles).add(file)
		}
	}
	const readOf = (call: string, given: unknown): After => {
		if (guard.window.kind === "open" && guard.loading === 0 && !guard.seen) {
			const read = pathOf(given)
			if (read !== undefined && !isOwn(read)) {
				saw({ kind: "read", call, path: read })
			}
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
					return readOf(call, args[0])
				case "opens":
					if (writes(args[1])) {
						made(pathOf(args[0]), false)
						return undefined
					}
					return readOf(call, args[0])
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
				case "moves":
					made(pathOf(args[1]), false)
					return undefined
				case "copies":
					readOf(call, args[0])
					made(pathOf(args[1]), call === "cp" || call === "cpSync" || call === "promises.cp")
					return undefined
			}
		}
	const fs = process.getBuiltinModule("node:fs")
	const fsHost: Record<string, unknown> = fs
	for (const [name, act] of FS_ACTS) {
		wrapped(fsHost, name, actOf(name, act))
		wrapped(fsHost, `${name}Sync`, actOf(`${name}Sync`, act))
	}
	const promisesHost: Record<string, unknown> = fs.promises
	for (const [name, act] of PROMISE_ACTS) {
		wrapped(promisesHost, name, actOf(`promises.${name}`, act))
	}
	const childHost: Record<string, unknown> = process.getBuiltinModule("node:child_process")
	for (const name of CHILD_CALLS) {
		wrapped(childHost, name, (args) => {
			saw({ kind: "child", call: name, command: typeof args[0] === "string" ? args[0] : "?" })
			return undefined
		})
	}
	for (const [module, names] of [
		["node:net", ["connect", "createConnection"]],
		["node:tls", ["connect"]]
	] as const) {
		const host: Record<string, unknown> = process.getBuiltinModule(module)
		for (const name of names) {
			wrapped(host, name, (args) => {
				saw({ kind: "network", call: `${module} ${name}`, target: targetOf(args[0]) })
				return undefined
			})
		}
	}
	const globalHost: Record<string, unknown> = globalThis
	wrapped(globalHost, "fetch", (args) => {
		saw({ kind: "network", call: "fetch", target: targetOf(args[0]) })
		return undefined
	})
	const threads = process.getBuiltinModule("node:worker_threads")
	const Original = threads.Worker
	const threadsHost: Record<string, unknown> = threads
	threadsHost["Worker"] = class extends Original {
		constructor(filename: string | URL, options: WorkerOptions | undefined) {
			saw({ kind: "thread", entry: String(filename) })
			super(filename, options)
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
