import { Array as Arr, Option, String as Str } from "effect"
import type { Observation } from "#runner/observe.ts"
import type { RecordedLine } from "#runner/recorder.ts"
import {
	type ChildActs,
	type KeyedRead,
	type Made,
	ownedOut,
	straceActsOf
} from "#runner/strace.ts"

/**
 * What a child the guard watched did (runner/observe.ts), read off its record directory once it has exited: the record
 * its Node processes' recorders appended (runner/recorder.ts), where the child is Node, and the trace of each process of
 * its tree strace traced (runner/strace.ts); its acts are their reads and makings joined, its own data taken out
 * (ownedOut), and its first observation past every key, if any: one a recorder told, or a Node child whose recorder
 * never started (a child whose reads are then not known).
 */

/** A child's record directory as the guard read it: whether the child is Node, its record file's text, its traces' texts. */
export type ChildRecord = Readonly<{
	node: boolean
	record: string | undefined
	traces: ReadonlyArray<string>
}>

/** What a child did, by its record directory (ChildRecord): its acts, and its first observation past every key. */
export type ChildOutcome = Readonly<{ acts: ChildActs; observation: Observation | undefined }>

/**
 * A recorded line of a kind and its fields, as the recorder wrote it (runner/recorder.ts RecordedLine), with how many
 * fields it took; none where the text there is no line of a record's (a recorder of another toolchain's, or a write
 * cut short).
 */
const lineAt = (
	fields: ReadonlyArray<string>,
	at: number
): Option.Option<Readonly<{ line: RecordedLine; taken: number }>> => {
	const kind = fields[at] ?? ""
	const first = fields[at + 1] ?? ""
	const second = fields[at + 2] ?? ""
	const third = fields[at + 3] ?? ""
	if (kind === "installed" && (first === "first" || first === "late")) {
		return Option.some({ line: [kind, first], taken: 2 })
	}
	if (kind === "file" || kind === "directory" || kind === "presence" || kind === "link") {
		return Option.some({ line: [kind, first], taken: 2 })
	}
	if (kind === "made" && (second === "file" || second === "directory")) {
		return Option.some({ line: [kind, first, second], taken: 3 })
	}
	if (kind === "observed" && (first === "read" || first === "child")) {
		return Option.some({ line: [kind, first, second, third], taken: 4 })
	}
	return Option.none()
}

/**
 * The lines of a record, each as its recorder wrote it, its fields NUL-separated and NUL-ended: each line all of whose
 * fields ended, in order, up to the first that did not (a child killed mid-write) or is no line.
 */
export const linesOf = (text: string): ReadonlyArray<RecordedLine> => {
	const fields = Str.split("\u0000")(text)
	const ended = fields.length - 1
	const lines: Array<RecordedLine> = []
	for (let at = 0; at < ended;) {
		const found = lineAt(fields, at)
		if (Option.isNone(found) || at + found.value.taken > ended) {
			return lines
		}
		lines.push(found.value.line)
		at += found.value.taken
	}
	return lines
}

/** The acts and observation of a record's lines, and whether any recorder of it started. */
const recordedOf = (
	lines: ReadonlyArray<RecordedLine>
): Readonly<{ acts: ChildActs; observation: Observation | undefined; started: boolean }> => {
	const reads: Array<KeyedRead> = []
	const made: Array<Made> = []
	let observation: Observation | undefined
	let started = false
	for (const line of lines) {
		switch (line[0]) {
			case "installed":
				started = true
				break
			case "made":
				made.push({ path: line[1], directory: line[2] === "directory" })
				break
			case "observed":
				observation =
					observation ??
					(line[1] === "read"
						? { kind: "read", call: line[2], path: line[3] }
						: { kind: "child", call: line[2], command: line[3] })
				break
			case "file":
			case "directory":
			case "presence":
			case "link":
				reads.push({ kind: line[0], path: line[1] })
				break
		}
	}
	return { acts: { reads, made }, observation, started }
}

/**
 * What a child did, read off its record directory (ChildRecord): its Node processes' records' acts and each trace's,
 * joined, its own data taken out; its first observation, a Node child with no recorder started (its record empty or
 * gone) among them.
 */
export const childOutcomeOf = (record: ChildRecord): ChildOutcome => {
	const recorded = recordedOf(record.record === undefined ? [] : linesOf(record.record))
	const traced = Arr.map(record.traces, straceActsOf)
	const acts = ownedOut({
		reads: Arr.flatMap([recorded.acts, ...traced], (one) => one.reads),
		made: Arr.flatMap([recorded.acts, ...traced], (one) => one.made)
	})
	const unstarted: Observation | undefined =
		record.node && !recorded.started
			? { kind: "child", call: "a Node child whose recorder never started", command: "node" }
			: undefined
	return { acts, observation: recorded.observation ?? unstarted }
}
