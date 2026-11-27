import { createRequire } from "node:module"
import type { WorkerOptions } from "node:worker_threads"
import {
	type After,
	asIs,
	cwdOf,
	FS_ACTS,
	isCallable,
	isList,
	isLive,
	lookedFor,
	optionOf,
	partsOf,
	pathOf,
	RECORD_FILE,
	RECORDER_KEY,
	restarted,
	searchPathOf,
	shellQuoted,
	STRACE,
	STRACE_PREFIX,
	startOf,
	throughShell,
	traceFileOf,
	wordsJoined,
	wrapped,
	writes
} from "#runner/intercept.ts"

/**
 * A Node child's recorder: what the child reads of the file system, recorded in its own process, where strace(1) stopped
 * it at every call (lane TRACE, 2026-11-26: grizzle's substrate exit child ran 286-325 s traced against 65-80 s plain
 * at load 450-550, each of its 34,872 stops waiting its turn on a CPU). The guard (runner/observe.ts) starts a
 * property's Node child as
 *
 *   node --expose-internals --import <this module>?to=<record directory> <the child's own arguments>
 *
 * so this module runs before any module of the child's loads, in every thread the child starts (a worker takes its
 * process's arguments) and in every Node child it starts (each is started so again). It wraps node:fs's functions on
 * the module itself, before any module of the child's imports them by name, so the ES module Node makes of node:fs
 * when one first does takes the wrapped ones. It records, as strace's trace of
 * the child would read them (runner/strace.ts straceActsOf), every read the key depends on:
 *
 * - Node's module loader's own, at the one place the loader reaches the file system (internal/modules/helpers'
 *   loaderMethods, which the loader's overrides hook wraps; the loader's internals are exposed for this alone): a path's
 *   status (its presence), a package.json read (its bytes, or its presence where it is absent), the package.json files
 *   the native code walks up to find a module's scope (each absent one's presence, the found one's bytes), a package's
 *   legacy main candidates up to the one it runs, an extensionless file's first bytes;
 * - node:fs's, which the loader's own source reads and real-path walks go through too: a file's bytes, a directory's
 *   entries, a path's presence (a status, an access, an existence), a link's text, and a real-path walk's components
 *   as the walk reads them (realpath's JavaScript walk each component's presence and each link's text, the native one
 *   each component's link text), each as the call names its path;
 * - what the child makes (a file written, a directory made, a name renamed, linked or copied to), whose reads are the
 *   child's own and keyed by nothing;
 * - the children it starts: a Node child under this recorder again, any other (and a shell) under strace, its trace a
 *   file of the record directory, each with the places execvp(3) looks for its command.
 *
 * What it cannot see into it records as an observation, which no key holds: a native addon (its own reads), a glob's
 * walk, a recursive listing, a directory copied whole, a child started where strace is missing, and a module loaded
 * before it. The reads Node's runtime makes on its own (its executable's libraries, its ICU and OpenSSL configuration,
 * its time zone, its compile cache's entries) are the runtime's, keyed by Node's version in every key, as the worker's
 * own are; this module's own and the interception's bytes load before it records, and the toolchain digest keys them. A recorded process
 * is never traced (the guard records a child only where nothing traces it, and a recorded process records or traces
 * every child it starts), so it traces the children it cannot record itself.
 *
 * Each line is recorded once a thread, appended to the record directory's record file as it is made (RecordedLine), so
 * a child killed mid-run leaves what it read so far: O(1) work a read, one write(2) a distinct read, no stop. The guard
 * reads the record once the child has exited (runner/child-record.ts). This module loads only Node's own and the
 * interception it shares with the guard (runner/intercept.ts): a module of the child's it loaded would load before it
 * records, and that module's reads would never be the child's. Imported with no record directory in its URL (the
 * guard's import, for the arguments that start a child under it), it installs nothing.
 */

/** This module, as a Node child imports it, past the record directory its URL names. */
const RECORDER_MODULE = new URL(new URL(import.meta.url).pathname, "file://")

/** The interception this module imports (runner/intercept.ts), which the hook STRIPS_RECORDER strips too. */
const INTERCEPT_MODULE = new URL("./intercept.ts", import.meta.url)

/**
 * Where the library lies under a node_modules directory (a consumer that installs it as files there), the hook a Node
 * child imports before the recorder: Node strips no types from a file under node_modules, so it strips the recorder's
 * and the interception's, and no other module's (reading node:fs off its module, so no ES module of node:fs exists before
 * the recorder wraps it), with Node's own stripping in its internal form that warns of nothing (internal/modules/typescript's, the one its coverage uses).
 */
const STRIPS_RECORDER = `data:text/javascript,import { createRequire, registerHooks } from "node:module"; const { readFileSync } = process.getBuiltinModule("node:fs"); const { stripTypeScriptTypesForCoverage: strip } = createRequire("/")("node:internal/modules/typescript"); const own = new Set(["${RECORDER_MODULE.href}", "${INTERCEPT_MODULE.href}"]); registerHooks({ load: (url, context, nextLoad) => { const module = new URL(url); module.search = ""; return own.has(module.href) ? { format: "module", source: strip(readFileSync(module, "utf8")), shortCircuit: true } : nextLoad(url, context) } });`

/** Whether the library lies under a node_modules directory: a component of its path is one. */
const underNodeModules = (): boolean => {
	for (const part of partsOf(RECORDER_MODULE.pathname, "/")) {
		if (part === "node_modules") {
			return true
		}
	}
	return false
}

/**
 * Node's arguments that start a Node child under the recorder writing to the record directory `to`, before the child's
 * own: the loader's internals exposed, which the recorder reads (runner/recorder.ts), the hook that strips the
 * recorder's types where the library lies under node_modules (STRIPS_RECORDER), and the recorder imported before any
 * other module.
 */
export const recorderArguments = (to: string): ReadonlyArray<string> => {
	const module = new URL(RECORDER_MODULE)
	module.searchParams.set("to", to)
	return [
		"--expose-internals",
		...(underNodeModules() ? ["--import", STRIPS_RECORDER] : []),
		"--import",
		module.href
	]
}

/** Whether Node's arguments `args` already import the recorder, whatever record directory they name. */
const recordsAlready = (args: ReadonlyArray<string>): boolean => {
	let imports = false
	for (const one of args) {
		if (imports && URL.canParse(one)) {
			const module = new URL(one)
			if (
				module.protocol === RECORDER_MODULE.protocol &&
				module.pathname === RECORDER_MODULE.pathname
			) {
				return true
			}
		}
		imports = one === "--import"
	}
	return false
}

/** What a read reads (runner/strace.ts KeyedRead's file-system kinds but `resolution`, which strace never reads). */
export type RecordedKind = "file" | "directory" | "presence" | "link"

/**
 * A line of the record, its fields NUL-separated and NUL-ended (no path holds a NUL): the recorder installed in a
 * thread (`installed`, `first` where it loaded before every module of the child's, `late` where not); a read (its
 * kind, its path); a path made (`made`, its path, `file` or `directory`); an observation (`observed`, `read` or
 * `child`, its call, the path or command it was on).
 */
export type RecordedLine =
	| readonly ["installed", "first" | "late"]
	| readonly [RecordedKind, string]
	| readonly ["made", string, "file" | "directory"]
	| readonly ["observed", "read" | "child", string, string]

/** A record line's text: each field followed by a NUL. */
const lineText = (line: RecordedLine): string => {
	let text = ""
	for (const field of line) {
		text += `${field}\u0000`
	}
	return text
}

/** What a thread's recorder holds once installed: a record directory added to those it writes to. */
type Installed = Readonly<{ add: (to: string) => void }>

/** Whether a value is an installed recorder (Installed). */
const isInstalled = (value: unknown): value is Installed =>
	typeof value === "object" && value !== null && isCallable(Reflect.get(value, "add"))

/**
 * The loader's internals the recorder reads (internal/modules/helpers, exposed by --expose-internals): its
 * file-system methods (loaderMethods), the hook that overrides them, the sentinel an override returns for an answer of
 * none, and the legacy main candidates in the order the native code tries them, the last tried by `main`.
 */
type LoaderInternals = Readonly<{
	loaderMethods: object
	setLoaderOverrides: (overrides: object) => void
	noResult: unknown
	extensions: ReadonlyArray<string>
	lastByMain: number
}>

/** The loader's internals (LoaderInternals) of what `require("node:internal/modules/helpers")` gave, or none. */
const loaderInternalsOf = (exposed: unknown): LoaderInternals | undefined => {
	if (typeof exposed !== "object" || exposed === null) {
		return undefined
	}
	const loaderMethods: unknown = Reflect.get(exposed, "loaderMethods")
	const setLoaderOverrides: unknown = Reflect.get(exposed, "setLoaderOverrides")
	const given: unknown = Reflect.get(exposed, "legacyMainResolveExtensions")
	const indexes: unknown = Reflect.get(exposed, "legacyMainResolveExtensionsIndexes")
	const lastByMain: unknown =
		typeof indexes === "object" && indexes !== null
			? Reflect.get(indexes, "kResolvedByMainIndexNode")
			: undefined
	if (
		typeof loaderMethods !== "object" ||
		loaderMethods === null ||
		!isCallable(setLoaderOverrides) ||
		!isList(given) ||
		typeof lastByMain !== "number"
	) {
		return undefined
	}
	const extensions: Array<string> = []
	for (const one of given) {
		extensions.push(String(one))
	}
	return {
		loaderMethods,
		setLoaderOverrides: (overrides) => {
			setLoaderOverrides(overrides)
		},
		noResult: Reflect.get(exposed, "kLoaderOverrideNoResult"),
		extensions,
		lastByMain
	}
}

/** The loader methods that read the file system, which the recorder overrides to watch (loaderMethods' keys). */
const LOADER_READS = [
	"internalModuleStat",
	"readPackageJSON",
	"legacyMainResolve",
	"getFormatOfExtensionlessFile",
	"getNearestParentPackageJSON",
	"getNearestParentPackageJSONType",
	"getPackageScopeConfig",
	"getPackageType"
] as const

/** The sync realpath calls, whose walk the recorder reads from their answer (answered). */
const SYNC_REALPATHS: ReadonlySet<string> = new Set(["realpathSync", "realpathSync.native"])

/** The realpath calls that run the C library's realpath(3), whose walk reads each component's link text. */
const NATIVE_REALPATHS: ReadonlySet<string> = new Set([
	"realpathSync.native",
	"realpath.native",
	"promises.realpath"
])

/** A package.json path a native lookup found: a serialized package config's sixth field (its optional file path). */
const foundIn = (answer: unknown): string | undefined => {
	if (!isList(answer)) {
		return undefined
	}
	const found: unknown = Reflect.get(answer, 5)
	return typeof found === "string" ? found : undefined
}

/**
 * Installs this thread's recorder writing to the record directory `to` (the module's doc); a second record directory is
 * one more the installed recorder writes to.
 */
const install = (to: string): void => {
	const fs = process.getBuiltinModule("node:fs")
	const path = process.getBuiltinModule("node:path")
	const url = process.getBuiltinModule("node:url")
	const original = {
		openSync: fs.openSync,
		writeSync: fs.writeSync,
		lstatSync: fs.lstatSync,
		statSync: fs.statSync,
		readlinkSync: fs.readlinkSync,
		accessSync: fs.accessSync,
		realpathNative: fs.realpathSync.native
	}
	/** A call of the recorder's own that may fail, its failure `failed`. */
	const within = <A>(call: () => A): A | "failed" => {
		try {
			return call()
		} catch {
			return "failed"
		}
	}
	const sinks: Array<number> = []
	const seen = new Set<string>()
	/** A line's text appended to every record file. */
	const appended = (text: string): void => {
		for (const sink of sinks) {
			original.writeSync(sink, text)
		}
	}
	/** A line appended to every record file, once a thread. */
	const line = (entry: RecordedLine): void => {
		const text = lineText(entry)
		if (!seen.has(text)) {
			seen.add(text)
			appended(text)
		}
	}
	const require = createRequire(import.meta.url)
	const first = Reflect.ownKeys(require.cache).length === 0
	const add = (directory: string): void => {
		const sink = original.openSync(path.join(directory, RECORD_FILE), "a")
		sinks.push(sink)
		original.writeSync(sink, lineText(["installed", first ? "first" : "late"]))
	}
	add(to)
	Reflect.set(globalThis, RECORDER_KEY, { add } satisfies Installed)
	/** A read of `file`, once a thread; none of the machine's live state (/proc, /sys, /dev), which no key holds. */
	const read = (kind: RecordedKind, file: string | undefined): void => {
		if (file === undefined) {
			return
		}
		const text = lineText([kind, file])
		if (seen.has(text)) {
			return
		}
		seen.add(text)
		if (!isLive(file)) {
			appended(text)
		}
	}
	/**
	 * Whether a walk (a real path's, a package.json lookup's) with the key `key` is walked for the first time in this
	 * thread: a walk reads alike each time, so it is recorded once.
	 */
	const walks = new Set<string>()
	const firstWalk = (key: string): boolean => {
		if (walks.has(key)) {
			return false
		}
		walks.add(key)
		return true
	}
	const made = (file: string | undefined, directory: boolean): void => {
		if (file !== undefined) {
			line(["made", file, directory ? "directory" : "file"])
		}
	}
	/** An act the recorder cannot see into: an observation of what it read. */
	const observed = (call: string, what: string): void => {
		line(["observed", "read", call, what])
	}
	if (!first) {
		observed("a module loaded before the recorder", String(Reflect.ownKeys(require.cache)))
	}
	/** Each component of an absolute path, from the first below the root to the path itself. */
	const componentsOf = (file: string): Array<string> => {
		const prefixes: Array<string> = []
		for (let at = file; path.dirname(at) !== at; at = path.dirname(at)) {
			prefixes.unshift(at)
		}
		return prefixes
	}
	/** Each name of an absolute path's components, from the first below the root. */
	const namesOf = (file: string): Array<string> => {
		const names: Array<string> = []
		for (const component of componentsOf(file)) {
			names.push(path.basename(component))
		}
		return names
	}
	/** A path's own status (lstat), none where nothing is there; `failed` where a component is no directory. */
	const statusOf = (file: string) =>
		within(() => original.lstatSync(file, { throwIfNoEntry: false }))
	/**
	 * The reads of realpath's JavaScript walk of `file` (fs.realpathSync and fs.realpath): each component's presence as it
	 * lstats it, and each link's text, the walk going on from where the link points; a walk the recorder makes itself only
	 * where the answer `answer` shows a link on the way, or there is none (the call threw, or is async).
	 */
	const walked = (file: string, answer: unknown): void => {
		if (!firstWalk(`walked\u0000${file}\u0000${String(answer)}`)) {
			return
		}
		if (answer === file) {
			for (const component of componentsOf(file)) {
				read("presence", component)
			}
			return
		}
		let pending = namesOf(file)
		let resolved = "/"
		for (let links = 0; pending.length > 0 && links <= 40;) {
			const at = path.join(resolved, pending.shift() ?? "")
			read("presence", at)
			const status = statusOf(at)
			if (status === undefined || status === "failed") {
				return
			}
			if (!status.isSymbolicLink()) {
				resolved = at
				continue
			}
			read("link", at)
			links += 1
			const next = namesOf(path.resolve(resolved, original.readlinkSync(at)))
			for (const name of pending) {
				next.push(name)
			}
			pending = next
			resolved = "/"
		}
	}
	/**
	 * The reads of the native realpath's walk of `file` (the C library's realpath(3)): each component's link text as it
	 * reads it, the walk going on from where a link points; a walk the recorder makes itself only where the answer
	 * `answer` shows a link on the way, or there is none.
	 */
	const walkedNatively = (file: string, answer: unknown): void => {
		if (!firstWalk(`native\u0000${file}\u0000${String(answer)}`)) {
			return
		}
		if (answer === file) {
			for (const component of componentsOf(file)) {
				read("link", component)
			}
			return
		}
		let pending = namesOf(file)
		let resolved = "/"
		for (let links = 0; pending.length > 0 && links <= 40;) {
			const at = path.join(resolved, pending.shift() ?? "")
			read("link", at)
			const status = statusOf(at)
			if (status === undefined || status === "failed") {
				return
			}
			if (!status.isSymbolicLink()) {
				resolved = at
				continue
			}
			links += 1
			const target = original.readlinkSync(at)
			const next: Array<string> = []
			for (const part of partsOf(target, "/")) {
				if (part !== "") {
					next.push(part)
				}
			}
			for (const name of pending) {
				next.push(name)
			}
			pending = next
			resolved = path.isAbsolute(target) ? "/" : resolved
		}
	}
	/** Whether a path is an executable regular file, as execvp(3) would run it. */
	const executable = (file: string): boolean => {
		const status = within(() => original.statSync(file, { throwIfNoEntry: false }))
		return (
			status !== undefined &&
			status !== "failed" &&
			status.isFile() &&
			within(() => original.accessSync(file, fs.constants.X_OK)) !== "failed"
		)
	}
	const self = within(() => original.realpathNative(process.execPath))
	const canTrace = executable(STRACE)
	const thread = process.getBuiltinModule("node:worker_threads").threadId
	let traces = 0
	/**
	 * The trace file of a child the recorder cannot record, which runs under strace; none where strace is missing, and
	 * the child's start an observation.
	 */
	const traceFile = (call: string, command: string): string | undefined => {
		if (!canTrace) {
			line(["observed", "child", call, command])
			return undefined
		}
		traces += 1
		return path.join(to, traceFileOf(process.pid, thread, traces))
	}
	/**
	 * A child about to start, from a call's arguments made over in place (spawn, execFile and their Sync forms): a child
	 * run through a shell runs the shell under strace; any other's command is looked for as execvp(3) looks for it, each
	 * place a read (an absent one its presence, the file it runs its bytes), and a Node child starts under this recorder
	 * again, any other under strace.
	 */
	const starting = (call: string, args: Array<unknown>): void => {
		const start = startOf(args)
		const options = start.options
		if (throughShell(options)) {
			const shell = optionOf(options, "shell")
			const command = [
				typeof shell === "string" ? shell : "/bin/sh",
				"-c",
				wordsJoined([start.command, ...start.args])
			]
			const trace = traceFile(call, wordsJoined(command))
			if (trace !== undefined) {
				restarted(args, {
					command: STRACE,
					args: [...STRACE_PREFIX, trace, "--", ...command],
					options
				})
				args[2] = { ...(typeof options === "object" ? options : {}), shell: false }
			}
			return
		}
		let runs: string | undefined
		for (const one of lookedFor(
			start.command,
			searchPathOf(options, process.env),
			cwdOf(options),
			executable
		)) {
			read(one.found ? "file" : "presence", one.path)
			runs = one.found ? one.path : runs
		}
		if (
			runs !== undefined &&
			self !== "failed" &&
			within(() => original.realpathNative(runs)) === self
		) {
			if (!recordsAlready(start.args)) {
				restarted(args, { ...start, args: [...recorderArguments(to), ...start.args] })
			}
			return
		}
		const trace = traceFile(call, start.command)
		if (trace !== undefined) {
			restarted(args, {
				command: STRACE,
				args: [...STRACE_PREFIX, trace, "--", start.command, ...start.args],
				options
			})
		}
	}
	const childHost: Record<string, unknown> = process.getBuiltinModule("node:child_process")
	for (const call of ["spawn", "execFile", "spawnSync", "execFileSync"] as const) {
		wrapped(
			childHost,
			call,
			(args) => {
				starting(call, args)
				return undefined
			},
			asIs
		)
	}
	/**
	 * execSync's command, which a shell runs (spawnSync's own, past its wrapper): that shell runs strace, which runs the
	 * command's own shell. exec starts its command through execFile's wrapper, which runs the shell under strace itself.
	 */
	const shellTraced = (args: Array<unknown>): After => {
		const command = String(args[0])
		const shell = optionOf(isCallable(args[1]) ? undefined : args[1], "shell")
		const trace = traceFile("execSync", command)
		if (trace !== undefined) {
			const words: Array<string> = []
			for (const word of [
				STRACE,
				...STRACE_PREFIX,
				trace,
				"--",
				typeof shell === "string" ? shell : "/bin/sh",
				"-c",
				command
			]) {
				words.push(shellQuoted(word))
			}
			args[0] = wordsJoined(words)
		}
		return undefined
	}
	wrapped(childHost, "execSync", shellTraced, asIs)
	/** fork's child, a Node child of its own arguments (execArgv, this process's where it states none): under this recorder. */
	const forked = (args: Array<unknown>): After => {
		const at = isList(args[1]) ? 2 : 1
		const options: unknown = args[at]
		const given = optionOf(options, "execArgv")
		const execArgv: Array<string> = []
		for (const one of isList(given) ? given : process.execArgv) {
			execArgv.push(String(one))
		}
		if (!recordsAlready(execArgv)) {
			const own = typeof options === "object" && options !== null ? options : {}
			args[at] = { ...own, execArgv: [...recorderArguments(to), ...execArgv] }
		}
		read("file", process.execPath)
		return undefined
	}
	wrapped(childHost, "fork", forked, asIs)
	/** A worker thread, which runs its own modules: under this recorder, as its arguments (execArgv) start it. */
	const threads = process.getBuiltinModule("node:worker_threads")
	const Original = threads.Worker
	const threadsHost: Record<string, unknown> = threads
	threadsHost["Worker"] = class extends Original {
		constructor(filename: string | URL, options: WorkerOptions | undefined) {
			const execArgv: Array<string> = []
			for (const one of options?.execArgv ?? process.execArgv) {
				execArgv.push(one)
			}
			super(
				filename,
				recordsAlready(execArgv)
					? options
					: { ...options, execArgv: [...recorderArguments(to), ...execArgv] }
			)
		}
	}
	wrapped(
		process,
		"dlopen",
		(args) => {
			const addon = pathOf(args[1])
			read("file", addon)
			observed("process.dlopen, a native addon's own reads", addon ?? String(args[1]))
			return undefined
		},
		asIs
	)
	wrapped(
		process,
		"loadEnvFile",
		(args) => {
			read("file", pathOf(args[0] ?? ".env"))
			return undefined
		},
		asIs
	)
	/** A temporary directory as mkdtemp returns it, a path or (node:fs/promises') a promise of one, the child's own. */
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
	/**
	 * A realpath call's walk of its path `given`: from its answer `answer` where the call is sync (none where it threw), or
	 * walked by the recorder itself where it is async.
	 */
	const resolving = (call: string, given: unknown, answer: unknown): void => {
		const file = pathOf(given)
		if (file !== undefined) {
			;(NATIVE_REALPATHS.has(call) ? walkedNatively : walked)(file, answer)
		}
	}
	/** What a call of node:fs records of its arguments, by its act (runner/intercept.ts Act), given its name. */
	const actOf =
		(call: string, act: (typeof FS_ACTS)[number][1]) =>
		(args: Array<unknown>): After => {
			switch (act) {
				case "reads":
					read("file", pathOf(args[0]))
					return undefined
				case "lists":
					if (optionOf(args[1], "recursive") === true) {
						observed(`${call}, recursive`, pathOf(args[0]) ?? String(args[0]))
						return undefined
					}
					read("directory", pathOf(args[0]))
					return undefined
				case "probes":
				case "inspects":
					read("presence", pathOf(args[0]))
					return undefined
				case "resolves":
					resolving(call, args[0], undefined)
					return undefined
				case "readsLink":
					read("link", pathOf(args[0]))
					return undefined
				case "watches":
					return undefined
				case "globs":
					observed(call, String(args[0]))
					return undefined
				case "opens":
					if (writes(args[1])) {
						made(pathOf(args[0]), false)
						return undefined
					}
					read("file", pathOf(args[0]))
					return undefined
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
				case "copies": {
					const source = pathOf(args[0])
					const status = source === undefined ? undefined : statusOf(source)
					if (status !== undefined && status !== "failed" && status.isDirectory()) {
						observed(`${call}, a directory`, source ?? String(args[0]))
						return undefined
					}
					read("file", source)
					made(pathOf(args[1]), false)
					return undefined
				}
			}
		}
	/**
	 * A sync realpath call (SYNC_REALPATHS) wrapped to record its walk from its answer, even where it throws (the walk then
	 * made by the recorder itself, up to the component that is not there).
	 */
	const answered = (host: object, name: string, call: string): void => {
		const replaced: unknown = Reflect.get(host, name)
		if (!isCallable(replaced)) {
			return
		}
		const wrapper = function (this: unknown, ...args: Array<unknown>): unknown {
			let answer: unknown
			try {
				answer = Reflect.apply(replaced, this, args)
				return answer
			} finally {
				resolving(call, args[0], answer)
			}
		}
		Object.defineProperties(wrapper, Object.getOwnPropertyDescriptors(replaced))
		Reflect.set(host, name, wrapper)
	}
	const fsHost: Record<string, unknown> = fs
	const promisesHost: Record<string, unknown> = fs.promises
	for (const [name, act] of FS_ACTS) {
		for (const call of [name, `${name}Sync`]) {
			if (SYNC_REALPATHS.has(call)) {
				answered(fsHost, call, call)
			} else {
				wrapped(fsHost, call, actOf(call, act), asIs)
			}
			const host: unknown = fsHost[call]
			if (isCallable(host)) {
				if (SYNC_REALPATHS.has(`${call}.native`)) {
					answered(host, "native", `${call}.native`)
				} else {
					wrapped(host, "native", actOf(`${call}.native`, act), asIs)
				}
			}
		}
		wrapped(promisesHost, name, actOf(`promises.${name}`, act), asIs)
	}
	const loader = loaderInternalsOf(within((): unknown => require("node:internal/modules/helpers")))
	if (loader === undefined) {
		observed("the module loader, whose reads this Node does not offer", process.version)
		return
	}
	let inner = false
	/** A loader method's native answer to `args`, past this recorder's own override. */
	const nativeOf = (key: string, ...args: Array<unknown>): unknown => {
		const method: unknown = Reflect.get(loader.loaderMethods, key)
		if (!isCallable(method)) {
			return undefined
		}
		inner = true
		try {
			return Reflect.apply(method, undefined, args)
		} finally {
			inner = false
		}
	}
	/**
	 * The package.json reads of the native walk up from a module at `file` for its nearest package.json (the binding's
	 * TraverseParent: each directory above the module but the root, stopping at a node_modules directory, which it does
	 * not read): each absent package.json's presence, the found one's bytes.
	 */
	const traversed = (file: string, found: string | undefined): void => {
		if (!firstWalk(`traversed\u0000${path.dirname(file)}\u0000${found ?? ""}`)) {
			return
		}
		for (let directory = path.dirname(file); path.dirname(directory) !== directory;) {
			if (path.basename(directory) === "node_modules") {
				return
			}
			const candidate = path.join(directory, "package.json")
			if (candidate === found) {
				read("file", candidate)
				return
			}
			read("presence", candidate)
			directory = path.dirname(directory)
		}
	}
	/**
	 * The package.json reads of the native lookup of a module's package scope at `resolved`, a URL (the binding's
	 * GetPackageScopeConfig: from the module's directory up to the root's, stopping before a node_modules directory's):
	 * each absent package.json's presence, the found one's bytes.
	 */
	const scoped = (resolved: string, found: string | undefined): void => {
		if (!URL.canParse(resolved) || new URL(resolved).protocol !== "file:") {
			return
		}
		const start = path.dirname(url.fileURLToPath(resolved))
		if (!firstWalk(`scoped\u0000${start}\u0000${found ?? ""}`)) {
			return
		}
		for (let directory = start; ;) {
			if (path.basename(directory) === "node_modules") {
				return
			}
			const candidate = path.join(directory, "package.json")
			if (candidate === found) {
				read("file", candidate)
				return
			}
			read("presence", candidate)
			const up = path.dirname(directory)
			if (up === directory) {
				return
			}
			directory = up
		}
	}
	/** What a loader method read, given its arguments and its native answer (`threw` where it threw). */
	const loaderRead = (
		key: (typeof LOADER_READS)[number],
		args: ReadonlyArray<unknown>,
		answer: Readonly<{ kind: "answered"; value: unknown }> | Readonly<{ kind: "threw" }>
	): void => {
		const value = answer.kind === "answered" ? answer.value : undefined
		switch (key) {
			case "internalModuleStat":
				read("presence", pathOf(args[0]))
				return
			case "readPackageJSON":
				read(
					answer.kind === "answered" && value === undefined ? "presence" : "file",
					pathOf(args[0])
				)
				return
			case "legacyMainResolve": {
				const directory = String(args[0])
				const main = args[1]
				for (let index = 0; index < loader.extensions.length; index += 1) {
					const byMain = index <= loader.lastByMain
					if (byMain && (typeof main !== "string" || main === "")) {
						continue
					}
					read(
						"presence",
						path.resolve(
							directory,
							`${byMain ? String(main) : ""}${loader.extensions[index] ?? ""}`
						)
					)
					if (answer.kind === "answered" && value === index) {
						return
					}
				}
				return
			}
			case "getFormatOfExtensionlessFile":
				read("file", pathOf(args[0]))
				return
			case "getNearestParentPackageJSON":
				traversed(String(args[0]), foundIn(value))
				return
			case "getNearestParentPackageJSONType":
				traversed(String(args[0]), foundIn(nativeOf("getNearestParentPackageJSON", args[0])))
				return
			case "getPackageScopeConfig":
				scoped(String(args[0]), foundIn(value))
				return
			case "getPackageType":
				scoped(String(args[0]), foundIn(nativeOf("getPackageScopeConfig", args[0])))
				return
		}
	}
	const overrides: Record<string, unknown> = {}
	for (const key of LOADER_READS) {
		overrides[key] = (...args: Array<unknown>): unknown => {
			if (inner) {
				return undefined
			}
			let value: unknown
			try {
				value = nativeOf(key, ...args)
			} catch (failure) {
				loaderRead(key, args, { kind: "threw" })
				throw failure
			}
			loaderRead(key, args, { kind: "answered", value })
			return value === undefined ? loader.noResult : value
		}
	}
	loader.setLoaderOverrides(overrides)
}

const to = new URL(import.meta.url).searchParams.get("to")
const installed: unknown = Reflect.get(globalThis, RECORDER_KEY)
if (to !== null) {
	if (isInstalled(installed)) {
		installed.add(to)
	} else {
		install(to)
	}
}
