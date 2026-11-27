/**
 * What the guard (runner/observe.ts) and a Node child's recorder (runner/recorder.ts) share to wrap Node's process-wide
 * functions in place and to start a child process watched: a path as node:fs takes one, open's flags, the one wrapper,
 * node:fs's calls by what each does with its arguments, the machine's live state, a command found on a search path, the
 * arguments that start a child under strace(1), and whether a thread runs under a recorder. This module loads only Node's own, so the recorder that imports it
 * is in place before any module of the child's loads.
 */

/** A callable, as a wrapper wraps one. */
export type Callable = (...args: Array<unknown>) => unknown

/** Whether a value is callable. */
export const isCallable = (value: unknown): value is Callable => typeof value === "function"

/** Whether a value is an iterable object: a list of arguments, never an options object. */
export const isList = (value: unknown): value is Iterable<unknown> =>
	typeof value === "object" && value !== null && Symbol.iterator in value

/** What a wrapped call does after the original returns, given what it returned, if anything. */
export type After = ((returned: unknown) => void) | undefined

/** How a wrapped call runs its original, given the call of it: as it is, or inside a context of the wrapper's. */
export type Runs = (apply: () => unknown) => unknown

/** A wrapped call's original run as it is. */
export const asIs: Runs = (apply) => apply()

/**
 * Replaces `host[name]` by a function that calls `before` with the call's arguments, then the original as `runs` runs it,
 * then what `before` gave with what the original returned, keeping the original's own properties (util.promisify's
 * custom form among them); nothing where the host has no such function.
 */
export const wrapped = (
	host: object,
	name: string,
	before: (args: Array<unknown>) => After,
	runs: Runs
): void => {
	const original: unknown = Reflect.get(host, name)
	if (!isCallable(original)) {
		return
	}
	const wrapper = function (this: unknown, ...args: Array<unknown>): unknown {
		const after = before(args)
		return runs(() => {
			const returned = Reflect.apply(original, this, args)
			if (after !== undefined) {
				after(returned)
			}
			return returned
		})
	}
	Object.defineProperties(wrapper, Object.getOwnPropertyDescriptors(original))
	Reflect.set(host, name, wrapper)
}

/** A file's path as node:fs takes one: a string, a Buffer or a file: URL, made absolute; none for a file descriptor. */
export const pathOf = (given: unknown): string | undefined => {
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

/** The letters of open's text flags that write: w, a and +. */
const WRITING_LETTERS: ReadonlySet<string> = new Set(["w", "a", "+"])

/** Whether open's flags write: a numeric flag with any of O_WRONLY, O_RDWR, O_CREAT, or a text with w, a or +. */
export const writes = (flags: unknown): boolean => {
	const { constants } = process.getBuiltinModule("node:fs")
	if (typeof flags === "number") {
		return (flags & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT)) !== 0
	}
	if (typeof flags !== "string") {
		return false
	}
	for (const letter of flags) {
		if (WRITING_LETTERS.has(letter)) {
			return true
		}
	}
	return false
}

/**
 * What a call of node:fs does with its arguments: reads its path's bytes; lists its directory; probes its presence;
 * resolves it, every symbolic link followed (realpath); reads its symbolic link's text; inspects its status, which no key
 * holds (a time, an inode); watches it; walks a pattern's matches (glob); opens it, reading or writing as its flags
 * say; makes a temporary directory, its returned path the process's own; makes a directory or a file at its path, the
 * process's own; links its second path to its first, the second its own; moves its first path to its second, the second
 * its own; or reads its first path and makes its second its own.
 */
export type Act =
	| "reads"
	| "lists"
	| "probes"
	| "resolves"
	| "readsLink"
	| "inspects"
	| "watches"
	| "globs"
	| "opens"
	| "temporary"
	| "makesDirectory"
	| "makes"
	| "links"
	| "moves"
	| "copies"

/**
 * node:fs's functions a watcher wraps, by what each does with its arguments: each under its name, its Sync name and its
 * name in node:fs/promises, wherever the module has one.
 */
export const FS_ACTS: ReadonlyArray<readonly [name: string, act: Act]> = [
	["readFile", "reads"],
	["readdir", "lists"],
	["opendir", "lists"],
	["stat", "inspects"],
	["lstat", "inspects"],
	["statfs", "inspects"],
	["exists", "probes"],
	["access", "probes"],
	["realpath", "resolves"],
	["readlink", "readsLink"],
	["watch", "watches"],
	["watchFile", "watches"],
	["glob", "globs"],
	["createReadStream", "reads"],
	["openAsBlob", "reads"],
	["open", "opens"],
	["mkdtemp", "temporary"],
	["mkdir", "makesDirectory"],
	["writeFile", "makes"],
	["appendFile", "makes"],
	["createWriteStream", "makes"],
	["symlink", "links"],
	["link", "links"],
	["copyFile", "copies"],
	["cp", "copies"],
	["rename", "moves"]
]

/** The directories whose files are the machine's live state, never a program's input: proc(5), sysfs, devices. */
const LIVE: ReadonlySet<string> = new Set(["/proc", "/sys", "/dev"])

/** Whether an absolute path lies in the machine's live state (LIVE): it or a directory above it is one of them. */
export const isLive = (path: string): boolean => {
	const { dirname } = process.getBuiltinModule("node:path")
	for (let at = path; ; at = dirname(at)) {
		if (LIVE.has(at)) {
			return true
		}
		if (dirname(at) === at) {
			return false
		}
	}
}

/** The parts of a text between each occurrence of the one character `separator`, in order, empty ones among them. */
export const partsOf = (text: string, separator: string): ReadonlyArray<string> => {
	const parts: Array<string> = []
	let part = ""
	for (const character of text) {
		if (character === separator) {
			parts.push(part)
			part = ""
		} else {
			part += character
		}
	}
	parts.push(part)
	return parts
}

/**
 * strace's arguments before a child's trace file: every process it starts, its file and listing calls, each fd's path,
 * and its tracees killed with it.
 */
export const STRACE_PREFIX: ReadonlyArray<string> = [
	"-f",
	"--seccomp-bpf",
	"--kill-on-exit",
	"-qq",
	"-y",
	"-e",
	"trace=%file,getdents64",
	"-o"
]

/** strace(1), where the machine has it. */
export const STRACE = "/usr/bin/strace"

/**
 * The record file of a child's record directory, which every recorder of the child's process tree appends its lines to
 * (runner/recorder.ts); each other file of the directory is the trace of a child strace traced.
 */
export const RECORD_FILE = "reads"

/** The name of a thread's trace file of a record directory, its process's, its thread's and its count's. */
export const traceFileOf = (pid: number, thread: number, index: number): string =>
	`strace-${pid}-${thread}-${index}`

/** The key under which a process's recorder (runner/recorder.ts) is installed on its globalThis, once a thread. */
export const RECORDER_KEY: unique symbol = Symbol.for("@bjornpagen/testing/recorder")

/** Whether this thread runs under a recorder (runner/recorder.ts), which records every child it starts itself. */
export const recorded = (): boolean => Reflect.has(globalThis, RECORDER_KEY)

/** One place a command was looked for on its search path, and whether an executable file stood there. */
export type Looked = Readonly<{ path: string; found: boolean }>

/**
 * Where execvp(3), as libuv runs it, looks for `command` started from `cwd` with the search path `searchPath` (the
 * child's PATH), in order, up to the executable file it runs, read through the process's own `status` (whether a path
 * is an executable regular file): a command naming a path is that path alone; a bare name each directory of the search
 * path in turn, an empty entry the working directory.
 */
export const lookedFor = (
	command: string,
	searchPath: string,
	cwd: string,
	executable: (path: string) => boolean
): ReadonlyArray<Looked> => {
	const path = process.getBuiltinModule("node:path")
	if (path.basename(command) !== command) {
		const at = path.resolve(cwd, command)
		return [{ path: at, found: executable(at) }]
	}
	const looked: Array<Looked> = []
	for (const directory of partsOf(searchPath, ":")) {
		const at = path.resolve(cwd, directory, command)
		const found = executable(at)
		looked.push({ path: at, found })
		if (found) {
			return looked
		}
	}
	return looked
}

/** A child's start as node:child_process's spawn, execFile and their Sync forms take it: its command, arguments, options. */
export type Start = Readonly<{ command: string; args: ReadonlyArray<string>; options: unknown }>

/**
 * A child's start from a call's arguments (`args[0]` the command, then its arguments, a list or none, then its options);
 * the arguments made over to start `start` in its place, in place, keeping what follows the options (execFile's callback).
 */
export const startOf = (args: ReadonlyArray<unknown>): Start => {
	const second = args[1]
	if (isList(second)) {
		const listed: Array<string> = []
		for (const one of second) {
			listed.push(String(one))
		}
		return { command: String(args[0]), args: listed, options: args[2] }
	}
	return { command: String(args[0]), args: [], options: second }
}

/** Makes a call's arguments over in place to start `start` (startOf's inverse), keeping what follows its options. */
export const restarted = (args: Array<unknown>, start: Start): void => {
	const listed = isList(args[1])
	if (!listed) {
		args.splice(1, 0, [])
	}
	args[0] = start.command
	args[1] = [...start.args]
}

/** An options object's field, none where the options are none or lack it. */
export const optionOf = (options: unknown, name: string): unknown =>
	typeof options === "object" && options !== null ? Reflect.get(options, name) : undefined

/** A word quoted for sh(1): every character its own, a single quote closed, escaped and opened again. */
export const shellQuoted = (word: string): string => {
	let quoted = "'"
	for (const character of word) {
		quoted += character === "'" ? "'\\''" : character
	}
	return `${quoted}'`
}

/** Words joined by one space, as a shell reads a command's words and as Node joins a shell child's. */
export const wordsJoined = (words: ReadonlyArray<string>): string => {
	let joined = ""
	for (const word of words) {
		joined = joined === "" ? word : `${joined} ${word}`
	}
	return joined
}

/** Whether a child's options run it through a shell. */
export const throughShell = (options: unknown): boolean => Boolean(optionOf(options, "shell"))

/** The search path a child's options give it: its own environment's PATH, else that of `environment`, this process's. */
export const searchPathOf = (options: unknown, environment: object): string => {
	const env = optionOf(options, "env")
	const own: unknown = Reflect.get(
		typeof env === "object" && env !== null ? env : environment,
		"PATH"
	)
	return typeof own === "string" ? own : ""
}

/** The working directory a child's options give it: their cwd, else this process's. */
export const cwdOf = (options: unknown): string => {
	const cwd = pathOf(optionOf(options, "cwd"))
	return cwd ?? process.cwd()
}
