import { registerHooks } from "node:module"
import { regex } from "arkregex"

/**
 * What a runner process resolved, and how a worker starts from its parent's: every module specifier a process resolves
 * (an import, a re-export, a dynamic import or a require of each module it loads), from the module that names it under
 * the process's conditions, to the URL and format Node answered. Node's resolver walks the file system for each one
 * (package.json scopes and exports, a stat and a realpath through pnpm's symlinks): 1,953 resolutions, about 40% of
 * the CPU an edullm worker takes to start with a warm compile cache, 4,559 of a grizzle worker's. A run's parent has
 * resolved, before its pool forks a worker, nearly all a worker will (99.2% of an edullm run's: the runner's own
 * modules, the runner config's, and every test module's, which it imports to discover properties). So each runner
 * process answers a resolution from what it was handed when it holds the key, and from Node's resolver otherwise,
 * keeping that answer too; the pool writes what its process holds to each worker's standard input (runner/pool.ts),
 * and a worker's entry installs it before the worker's own modules load (runner/worker-entry.ts). An answer is Node's
 * own for that key, given earlier in the same run over the same files: a run never changes the files a resolution
 * reads (a mutant rewrites a module's text, never its path or a package.json), so a handed answer is the one Node
 * would give again. This module loads only Node's own and arkregex (two modules), so it is in place before Effect's
 * modules resolve.
 */

/** What Node answered for a resolution: the module's URL, and its format, empty when Node named none. */
type Answer = Readonly<{ url: string; format: string }>

/** A resolution's conditions as its key holds them: each followed by a comma. */
const conditionsOf = (conditions: ReadonlyArray<string>): string => {
	let joined = ""
	for (const condition of conditions) {
		joined += `${condition},`
	}
	return joined
}

/**
 * A text that cannot stand in a line of resolutionsText, holding a tab or a line break: a specifier holding one (a
 * data: URL written over several lines) is resolved by Node each time, never kept.
 */
const UNPLAIN = regex("[\t\n]")

/** Every resolution this process holds: those it was handed, and those Node answered here since. */
const known = new Map<string, Answer>()

/**
 * Answers each resolution of this process from what it holds, and keeps each answer Node gives it. Installed once, as a
 * process's first act (runner/cli-entry.ts, runner/worker-entry.ts), so every module it loads after is resolved so.
 */
export const resolveKnown = (): void => {
	registerHooks({
		resolve: (specifier, context, nextResolve) => {
			const parent = context.parentURL ?? ""
			const conditions = conditionsOf(context.conditions)
			const key = `${parent}\t${specifier}\t${conditions}`
			const held = known.get(key)
			if (held !== undefined) {
				return {
					url: held.url,
					format: held.format === "" ? undefined : held.format,
					shortCircuit: true
				}
			}
			const resolved = nextResolve(specifier, context)
			const answer: Answer = { url: resolved.url, format: resolved.format ?? "" }
			const fields = `${parent}${specifier}${conditions}${answer.url}${answer.format}`
			if (!UNPLAIN.test(fields)) {
				known.set(key, answer)
			}
			return resolved
		}
	})
}

/** Every resolution this process holds, as text: a line each, the key's three fields, then the URL and the format. */
const resolutionsText = (): string => {
	let text = ""
	for (const [key, answer] of known) {
		text += `${key}\t${answer.url}\t${answer.format}\n`
	}
	return text
}

/** Takes the resolutions of a text (resolutionsText) for this process to answer from. */
const handed = (text: string): void => {
	const lines = regex(
		"^(?<key>[^\t\n]*\t[^\t\n]*\t[^\t\n]*)\t(?<url>[^\t\n]*)\t(?<format>[^\t\n]*)$",
		"gm"
	)
	for (let line = lines.exec(text); line !== null; line = lines.exec(text)) {
		known.set(line.groups.key, { url: line.groups.url, format: line.groups.format })
	}
}

/** The bytes of a payload's length, which come first: an unsigned 32-bit big-endian count of the bytes after them. */
const LENGTH_BYTES = 4

/**
 * Every resolution this process holds, as the payload a worker is handed on its standard input: the text
 * (resolutionsText), deflated, after its length. Deflated, an edullm run's 525 KB of text fits a socket's buffer, so
 * the pool's write of it to a new worker completes at once, and with its length first a worker reads exactly that much
 * and never waits for its parent to close the stream: a worker never waits on its parent's event loop to start.
 */
export const resolutionsPayload = (): Uint8Array => {
	const deflated = process.getBuiltinModule("node:zlib").deflateRawSync(resolutionsText())
	const payload = new Uint8Array(LENGTH_BYTES + deflated.length)
	new DataView(payload.buffer).setUint32(0, deflated.length)
	payload.set(deflated, LENGTH_BYTES)
	return payload
}

/** Reads exactly `length` bytes from the descriptor `fd`, blocking until they come. */
const readExactly = (fd: number, length: number): Uint8Array => {
	const fs = process.getBuiltinModule("node:fs")
	const bytes = new Uint8Array(length)
	for (let read = 0; read < length;) {
		const got = fs.readSync(fd, bytes, read, length - read, null)
		if (got === 0) {
			throw new Error(`the resolutions payload ended after ${read} of its ${length} bytes`)
		}
		read += got
	}
	return bytes
}

/**
 * Takes the resolutions of a payload (resolutionsPayload) read from the descriptor `fd` for this process to answer
 * from: its length, then exactly that many bytes, inflated.
 */
export const handedFrom = (fd: number): void => {
	const length = new DataView(readExactly(fd, LENGTH_BYTES).buffer).getUint32(0)
	handed(
		process.getBuiltinModule("node:zlib").inflateRawSync(readExactly(fd, length)).toString("utf8")
	)
}
