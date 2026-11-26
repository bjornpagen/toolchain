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
 * and a worker's entry installs it before the worker's own modules load (runner/worker-entry.ts). A load's process
 * (runner/load-entry.ts) is handed what its parent holds alike, and hands back what Node answered it (answeredChunk),
 * which its parent hands every later one (runner/loads.ts), since a load's parent imports no test module. An answer is Node's
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

/** The resolutions Node answered in this process, each in `known` too: what a load's process hands back. */
const answered = new Map<string, Answer>()

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
				answered.set(key, answer)
			}
			return resolved
		}
	})
}

/** Resolutions as text: a line each, the key's three fields, then the URL and the format. */
const resolutionsText = (resolutions: ReadonlyMap<string, Answer>): string => {
	let text = ""
	for (const [key, answer] of resolutions) {
		text += `${key}\t${answer.url}\t${answer.format}\n`
	}
	return text
}

/**
 * Takes the resolutions of a chunk's deflated text (resolutionsText) for this process to answer from, and answers those
 * it did not hold before.
 */
const handed = (deflated: Uint8Array): ReadonlyMap<string, Answer> => {
	const text = process.getBuiltinModule("node:zlib").inflateRawSync(deflated).toString("utf8")
	const lines = regex(
		"^(?<key>[^\t\n]*\t[^\t\n]*\t[^\t\n]*)\t(?<url>[^\t\n]*)\t(?<format>[^\t\n]*)$",
		"gm"
	)
	const fresh = new Map<string, Answer>()
	for (let line = lines.exec(text); line !== null; line = lines.exec(text)) {
		if (known.has(line.groups.key)) {
			continue
		}
		const answer = { url: line.groups.url, format: line.groups.format }
		known.set(line.groups.key, answer)
		fresh.set(line.groups.key, answer)
	}
	return fresh
}

/** The bytes of a length, which come before what it counts: an unsigned 32-bit big-endian count of the bytes after it. */
const LENGTH_BYTES = 4

/** The length a framed text states at `at` of `bytes`. */
const lengthAt = (bytes: Uint8Array, at: number): number =>
	new DataView(bytes.buffer, bytes.byteOffset + at, LENGTH_BYTES).getUint32(0)

/**
 * A chunk of resolutions: their text (resolutionsText), deflated, after its length (payloadOf, its one framing). A
 * payload holds chunks one after another, and a process takes every one: a pool's payload is the one chunk of everything
 * its process holds, a load's the chunk of what its parent holds and each its earlier processes handed back.
 */
const chunkOf = (resolutions: ReadonlyMap<string, Answer>): Uint8Array =>
	payloadOf([process.getBuiltinModule("node:zlib").deflateRawSync(resolutionsText(resolutions))])

/** The chunk of every resolution this process holds. */
export const knownChunk = (): Uint8Array => chunkOf(known)

/** The chunk of the resolutions Node answered in this process: what a load's process hands back (runner/load-child.ts). */
export const answeredChunk = (): Uint8Array => chunkOf(answered)

/**
 * `parts` after the length of them all: a chunk, its deflated text the one part; or the payload a child of the runner's
 * is handed on its standard input, the bytes of whole chunks in order (a chunk this process made, or one a load's
 * process handed back, in the parts its pipe delivered it in). Deflated, an edullm run's 525 KB of text fits a socket's buffer, so a pool's write of its payload
 * to a new worker completes at once; and with its length first a child reads exactly that much and never waits for its
 * parent to close the stream. A load's process ended as it handed back fails the load by its exit, and its cut chunk
 * every process after it, as they read it.
 */
export const payloadOf = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
	const joined = concatenated(parts)
	const payload = new Uint8Array(LENGTH_BYTES + joined.length)
	new DataView(payload.buffer).setUint32(0, joined.length)
	payload.set(joined, LENGTH_BYTES)
	return payload
}

/** The bytes of `parts`, in order, as one array. */
const concatenated = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
	let length = 0
	for (const part of parts) {
		length += part.length
	}
	const joined = new Uint8Array(length)
	let at = 0
	for (const part of parts) {
		joined.set(part, at)
		at += part.length
	}
	return joined
}

/**
 * What the frames (payloadOf's) that `parts` hold one after another frame, in order: each whole one, and none of a last
 * one cut short, as a process ended while writing it leaves it.
 */
export const framesOf = (parts: ReadonlyArray<Uint8Array>): ReadonlyArray<Uint8Array> => {
	const bytes = concatenated(parts)
	const frames: Array<Uint8Array> = []
	let at = 0
	while (at + LENGTH_BYTES <= bytes.length) {
		const end = at + LENGTH_BYTES + lengthAt(bytes, at)
		if (end > bytes.length) {
			return frames
		}
		frames.push(bytes.subarray(at + LENGTH_BYTES, end))
		at = end
	}
	return frames
}

/** Every resolution this process holds, as the payload a pool hands each of its workers: one chunk. */
export const resolutionsPayload = (): Uint8Array => payloadOf([knownChunk()])

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
 * Takes the resolutions of a payload (payloadOf) read from the descriptor `fd` for this process to answer from: its
 * length, then exactly that many bytes, each chunk of them inflated in turn.
 */
export const handedFrom = (fd: number): void => {
	for (const deflated of framesOf([readExactly(fd, lengthAt(readExactly(fd, LENGTH_BYTES), 0))])) {
		handed(deflated)
	}
}

/**
 * Takes the chunks a load's process handed back (answeredChunk) into this process's resolutions, and answers the chunk
 * of those this process did not hold, none where it held them all: what a load's parent hands every later process
 * (runner/loads.ts), so a process is handed each resolution once, however many of its earlier processes, started
 * together, each resolved it.
 */
export const freshChunksOf = (chunks: ReadonlyArray<Uint8Array>): ReadonlyArray<Uint8Array> => {
	const fresh = new Map<string, Answer>()
	for (const deflated of framesOf(chunks)) {
		for (const [key, answer] of handed(deflated)) {
			fresh.set(key, answer)
		}
	}
	return fresh.size === 0 ? [] : [chunkOf(fresh)]
}
