import { Array as Arr, Option } from "effect"
import { framesOf, payloadOf } from "#runner/resolutions.ts"

/**
 * What a load's process (load-child.ts) reports to its parent (loads.ts) on its descriptor 3, the one way it ends: its
 * verdict's kind and message, each framed (resolutions.ts payloadOf, the one framing), then the chunk of what Node
 * resolved for it (resolutions.ts answeredChunk), after which it closes the descriptor, and its parent ends its process
 * group. It never calls process.exit, whose join of V8's platform threads
 * can wait forever on a background compile parked for a garbage collection only the exiting thread would run
 * (nodejs/node#54918, Node 26.13.1: a grizzle load's process held 20 minutes after its module loaded, lane LOADFAST),
 * and its parent never reads its exit status: a process that ended before it reported (its module exited as it loaded,
 * or it was ended) reported nothing, and fails.
 */

/** A module's verdict: it loaded, or what it threw as it loaded (the runner's LoadFailed message). */
export type ModuleVerdict =
	| Readonly<{ kind: "loads" }>
	| Readonly<{ kind: "failed"; message: string }>

/** The text of `text`, as a frame holds it. */
const framed = (text: string): Uint8Array => payloadOf([new TextEncoder().encode(text)])

/** A report's bytes, in order: the verdict's kind, its message (empty where it loaded), each framed, then the chunk. */
export const reportOf = (verdict: ModuleVerdict, chunk: Uint8Array): ReadonlyArray<Uint8Array> => {
	switch (verdict.kind) {
		case "loads":
			return [framed("loads"), framed(""), chunk]
		case "failed":
			return [framed("failed"), framed(verdict.message), chunk]
	}
}

/** A report as its parent reads it: the verdict, none where the process ended before it reported; and its chunk, if whole. */
type Reported = Readonly<{
	verdict: Option.Option<ModuleVerdict>
	chunks: ReadonlyArray<Uint8Array>
}>

/** The verdict a report's kind and message state, none for a report cut before them. */
const verdictOf = (kind: string, message: string): Option.Option<ModuleVerdict> => {
	switch (kind) {
		case "loads":
			return Option.some({ kind: "loads" })
		case "failed":
			return Option.some({ kind: "failed", message })
		default:
			return Option.none()
	}
}

/** What the bytes a process wrote on its descriptor 3 report, in the parts its pipe delivered them in. */
export const reportedBy = (parts: ReadonlyArray<Uint8Array>): Reported => {
	const [kind = new Uint8Array(), message, ...chunks] = framesOf(parts)
	const text = new TextDecoder()
	return {
		verdict: Option.flatMap(Option.fromUndefinedOr(message), (said) =>
			verdictOf(text.decode(kind), text.decode(said))
		),
		chunks: Arr.map(chunks, (chunk) => payloadOf([chunk]))
	}
}
