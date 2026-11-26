import { regex } from "arkregex"
import { Array as Arr, String as Str } from "effect"
import { READ_KINDS } from "#traces.ts"

/**
 * A child process's acts on the file system, read from strace(1)'s trace of it and of every process it starts (`strace
 * -f -y`): which paths it read, listed or probed (KeyedRead), which it made, and so are the starting process's own data,
 * and which it read that are the machine's live state (/proc, /sys, /dev: a runtime's look at itself, its CPUs and
 * cgroup, its terminal), which no key holds and which the runner assumes change no verdict. The guard (runner/observe.ts)
 * starts a property's child processes under strace, its trace written to a file of its own, and reads it here once the
 * child has exited, through the parser a worker gives it once its own modules have loaded (worker.ts).
 */

/**
 * What a runner's keyable read reads: a file-system read of its path (traces.ts READ_KINDS: a file's bytes, a directory's
 * entries, a path's presence, where it resolves to, a link's text), or, for a connection to one of the run's own
 * PostgreSQL servers (`postgres`, its path empty), the installation that serves it.
 */
export const RUNNER_READ_KINDS = [...READ_KINDS, "postgres"] as const

/** One keyable read of the runner's: what it reads (RUNNER_READ_KINDS) of its absolute path. */
export type KeyedRead = Readonly<{
	kind: (typeof RUNNER_READ_KINDS)[number]
	path: string
}>

/** A path a child made: a file it created or wrote, a directory it made, a name it renamed or linked to. */
export type Made = Readonly<{ path: string; directory: boolean }>

/** What a child's trace says it did: its keyable reads, and what it made. */
export type ChildActs = Readonly<{ reads: ReadonlyArray<KeyedRead>; made: ReadonlyArray<Made> }>

/** The directories whose files are the machine's live state, never a child's input: proc(5), sysfs, devices. */
const LIVE = ["/proc", "/sys", "/dev"] as const

/** Whether a path lies in the machine's live state (LIVE). */
const isLive = (path: string): boolean =>
	Arr.some(LIVE, (root) => path === root || Str.startsWith(`${root}/`)(path))

/** A finished call of a trace's line: its process, its name, its arguments' text and its result's text. */
type Call = Readonly<{ name: string; args: string; result: string }>

/** A line of a call that ran to its end at once: `<pid> <name>(<args>) = <result>`. */
const WHOLE = regex("^([0-9]+) ([a-z0-9_]+)\\((.*)\\) += (.*)$")

/** A line of a call another thread's interrupted: `<pid> <name>(<args> <unfinished ...>`. */
const UNFINISHED = regex("^([0-9]+) ([a-z0-9_]+)\\((.*) <unfinished \\.\\.\\.>$")

/** A line that ends an interrupted call: `<pid> <... <name> resumed><rest>) = <result>`. */
const RESUMED = regex("^([0-9]+) <\\.\\.\\. ([a-z0-9_]+) resumed>(.*)\\) += (.*)$")

/**
 * The calls of a trace, each whole: a call interrupted by another thread's is joined with its resumption, by process and
 * name; a line of no call (a signal, an exit) is none.
 */
const callsOf = (text: string): ReadonlyArray<Call> => {
	const calls: Array<Call> = []
	const pending = new Map<string, string>()
	for (const line of Str.split("\n")(text)) {
		const whole = WHOLE.exec(line)
		if (whole !== null) {
			const [, , name, args, result] = whole
			calls.push({ name, args, result })
			continue
		}
		const unfinished = UNFINISHED.exec(line)
		if (unfinished !== null) {
			const [, pid, name, args] = unfinished
			pending.set(`${pid} ${name}`, args)
			continue
		}
		const resumed = RESUMED.exec(line)
		if (resumed !== null) {
			const [, pid, name, rest, result] = resumed
			const begun = pending.get(`${pid} ${name}`)
			if (begun !== undefined) {
				pending.delete(`${pid} ${name}`)
				calls.push({ name, args: `${begun}${rest}`, result })
			}
		}
	}
	return calls
}

/**
 * A quoted C string's escapes as strace writes them: `\"`, `\\`, `\n`, `\t`, `\xHH` and octal `\NNN`; made anew for each
 * string read, since a global pattern keeps where it stopped.
 */
const escapesIn = () => regex('\\\\(x[0-9a-fA-F]{2}|[0-7]{1,3}|[\\\\"ntrvfab])', "g")

/** The character one escape's code (escapesIn's capture) stands for. */
const escaped = (code: string): string => {
	switch (code) {
		case "n":
			return "\n"
		case "t":
			return "\t"
		case "r":
			return "\r"
		case "v":
			return "\v"
		case "f":
			return "\f"
		case "a":
			return "\u0007"
		case "b":
			return "\b"
		case "\\":
			return "\\"
		case '"':
			return '"'
		default:
			return String.fromCharCode(
				Str.startsWith("x")(code)
					? Number.parseInt(Str.slice(1)(code), 16)
					: Number.parseInt(code, 8)
			)
	}
}

/** The text a C string literal's body stands for: each escape (escapesIn) the character it names. */
const unquoted = (body: string): string => {
	const pattern = escapesIn()
	let text = ""
	let from = 0
	for (let found = pattern.exec(body); found !== null; found = pattern.exec(body)) {
		text += Str.slice(from, found.index)(body) + escaped(found[1])
		from = found.index + found[0].length
	}
	return text + Str.slice(from)(body)
}

/** A call's first quoted string argument, the path it names, and the directory a relative one is read from. */
const PATH_ARGUMENT = regex('^(?:(?:AT_FDCWD|[0-9]+)<([^>]*)>, )?"((?:[^"\\\\]|\\\\.)*)"')

/** A call's second quoted string argument after its first: the target of a rename or a link. */
const SECOND_PATH = regex(
	'"(?:[^"\\\\]|\\\\.)*", (?:(?:AT_FDCWD|[0-9]+)<([^>]*)>, )?"((?:[^"\\\\]|\\\\.)*)"'
)

/** A file descriptor and the path strace gives it: `<n><path>`. */
const DESCRIPTOR = regex("^[0-9]+<([^>]*)>")

/** The absolute path a call names: its own when absolute, else read from the directory before it. */
const absolute = (directory: string | undefined, path: string): string => {
	const resolve = process.getBuiltinModule("node:path").resolve
	return directory === undefined ? resolve(path) : resolve(directory, path)
}

/** A call's path argument, absolute, or none where it names none (a call on a descriptor alone). */
const pathOfCall = (call: Call): string | undefined => {
	const found = PATH_ARGUMENT.exec(call.args)
	if (found === null) {
		return undefined
	}
	const [, directory, quoted] = found
	const path = unquoted(quoted)
	return path === "" ? undefined : absolute(directory, path)
}

/** Whether a call succeeded: its result no failure (`-1 ENOENT …`). */
const succeeded = (call: Call): boolean => !Str.startsWith("-1")(call.result)

/** The calls whose path a child probes for its presence and kind: stats and accesses. */
const PROBES: ReadonlySet<string> = new Set([
	"newfstatat",
	"fstatat64",
	"statx",
	"stat",
	"lstat",
	"stat64",
	"lstat64",
	"access",
	"faccessat",
	"faccessat2"
])

/** The calls that read a symbolic link's text at their path. */
const LINK_READS: ReadonlySet<string> = new Set(["readlink", "readlinkat"])

/** The calls that make a directory at their path. */
const MAKE_DIRECTORY: ReadonlySet<string> = new Set(["mkdir", "mkdirat"])

/** The calls whose second path a child makes: a rename's target, a link's or a symbolic link's name. */
const MAKE_SECOND: ReadonlySet<string> = new Set([
	"rename",
	"renameat",
	"renameat2",
	"link",
	"linkat",
	"symlink",
	"symlinkat"
])

/** Whether open's flags, as strace writes them, write or create. */
const WRITES = regex("O_WRONLY|O_RDWR|O_CREAT|O_TRUNC")

/**
 * What a child's trace says it did (ChildActs): each file it opened to read (its bytes), each directory it opened or
 * listed (its entries), each path it probed or failed to open (its presence), each link it read (its text), each
 * program it executed (its bytes), and
 * each path it created, wrote, made, renamed or linked to; its reads of the machine's live state, and of what it made
 * itself, are none of them.
 */
export const childActsOf = (text: string): ChildActs => {
	const reads = new Map<string, KeyedRead>()
	const made: Array<Made> = []
	const read = (
		kind: "file" | "directory" | "presence" | "link",
		path: string | undefined
	): void => {
		if (path !== undefined && !isLive(path)) {
			reads.set(`${kind}\u0000${path}`, { kind, path })
		}
	}
	for (const call of callsOf(text)) {
		const path = pathOfCall(call)
		if (call.name === "openat" || call.name === "open" || call.name === "creat") {
			if (call.name === "creat" || WRITES.test(call.args)) {
				if (path !== undefined && succeeded(call)) {
					made.push({ path, directory: false })
				}
				continue
			}
			if (!succeeded(call)) {
				read("presence", path)
				continue
			}
			read(Str.includes("O_DIRECTORY")(call.args) ? "directory" : "file", path)
			continue
		}
		if (call.name === "execve" || call.name === "execveat") {
			read(succeeded(call) ? "file" : "presence", path)
			continue
		}
		if (call.name === "getdents64" || call.name === "getdents") {
			const listed = DESCRIPTOR.exec(call.args)
			if (listed !== null) {
				read("directory", listed[1])
			}
			continue
		}
		if (PROBES.has(call.name)) {
			read("presence", path)
			continue
		}
		if (LINK_READS.has(call.name)) {
			read("link", path)
			continue
		}
		if (MAKE_DIRECTORY.has(call.name) && path !== undefined && succeeded(call)) {
			made.push({ path, directory: true })
			continue
		}
		if (MAKE_SECOND.has(call.name) && succeeded(call)) {
			const second = SECOND_PATH.exec(call.args)
			if (second !== null) {
				made.push({ path: absolute(second[1], unquoted(second[2])), directory: false })
			}
		}
	}
	const madeFiles = new Set<string>()
	const madeDirectories = new Set<string>()
	for (const one of made) {
		;(one.directory ? madeDirectories : madeFiles).add(one.path)
	}
	const dirname = process.getBuiltinModule("node:path").dirname
	const isMade = (path: string): boolean => {
		if (madeFiles.has(path)) {
			return true
		}
		let at = path
		for (;;) {
			if (madeDirectories.has(at)) {
				return true
			}
			const up = dirname(at)
			if (up === at) {
				return false
			}
			at = up
		}
	}
	const kept: Array<KeyedRead> = []
	for (const one of reads.values()) {
		if (!isMade(one.path)) {
			kept.push(one)
		}
	}
	return { reads: kept, made }
}
