import { Array as Arr, Effect, FileSystem, Option, Result, Schema, String as Str } from "effect"
import { Digest } from "effect/crypto"
import type { ChildProcessSpawner } from "effect/process"
import { postgresStanding } from "#runner/grounds.ts"
import { type KeyedRead, RUNNER_READ_KINDS } from "#runner/strace.ts"
import {
	absoluteOf,
	placeOf,
	type Standing,
	standingOf as fileStandingOf,
	TracedRead as FileRead
} from "#traces.ts"

/**
 * A pass's verifying trace: every keyable read (runner/strace.ts KeyedRead) the workers that ran a property made up to its
 * last unit there (runner/pool.ts Observed's traces), each with the digest of what it read as the read stands once the
 * run ended, checked whenever its key is read: the pass answers while some trace of it reads alike. So a property that
 * reads a fixture, a program's prelude, the PostgreSQL build's catalog, or what a child process reads at run time
 * (tsgo's sources, a compiler's libraries) is answered from the cache exactly while all of it stands, which no closure
 * hash can hold, since nothing imports it. A worker's reads up to a unit are every trace's that ran a unit there by
 * then, a value a module kept from them among what a later property may read through it.
 *
 * A run keeps its reads once, whatever number of passes it keeps: its reads file (`reads/<digest>.reads` in the cache's
 * verdicts) holds each distinct read with its digest once, and each worker's reads in the order it made them, as
 * indices of those; a pass's trace (`<record>.<the reads file's digest>.trace`, beside the pass's record) names the
 * reads file and, for each worker that ran the property, how many of its reads, from its first, the trace takes. A
 * run's traces cost its distinct reads and its workers' orders, not its passes times its reads, and a lookup weighs each
 * read once (TraceLookup), however many traces hold it. Two checkouts whose runs read unlike at one key (a fixture
 * changed in one) each keep a trace, and each finds its own.
 *
 * A read's path is kept by where it lies: under the repository, from its root (so every checkout's run of the repository
 * reads its own copy), or anywhere else, as it stands (the machine's: a program, a library, an installation). A read
 * whose path changed after the run began (its modification time, or its nearest existing directory's for a path that
 * is absent, at or past the run's start) answers for no pass: what the run read and what the digest holds may differ, so
 * the pass is not kept and the property runs again.
 */

/** One read of a trace as a pass keeps it (traces.ts TracedRead), of the runner's kinds (RUNNER_READ_KINDS). */
const TracedRead = Schema.Struct({ ...FileRead.fields, kind: Schema.Literals(RUNNER_READ_KINDS) })

/**
 * A run's reads as its reads file holds them: each distinct read once, with its digest; and each worker's reads in the
 * order it made them, as indices of those, as far as some trace the run kept takes them.
 */
const ReadsFile = Schema.fromJsonString(
	Schema.Struct({
		reads: Schema.Array(TracedRead),
		workers: Schema.Array(Schema.Array(Schema.Int))
	})
)

const encodeReadsFile = Schema.encodeEffect(ReadsFile)

const decodeReadsFile = Schema.decodeUnknownEffect(ReadsFile)

/**
 * A pass's trace as its file holds it: the digest naming its run's reads file, and for each worker that ran the
 * property, its index in the reads file and how many of its reads, from its first, the trace takes.
 */
const TraceFile = Schema.fromJsonString(
	Schema.Struct({
		reads: Schema.String,
		prefixes: Schema.Array(Schema.Tuple([Schema.Int, Schema.Int]))
	})
)

const encodeTraceFile = Schema.encodeEffect(TraceFile)

const decodeTraceFile = Schema.decodeUnknownEffect(TraceFile)

/**
 * A worker's keyable reads as a property's trace takes them: the worker's reads in the order it made them (the list the
 * pool keeps for it, which every trace of the worker shares), and how many of them, from its first, the trace takes.
 */
export type WorkerReads = Readonly<{ reads: ReadonlyArray<KeyedRead>; upTo: number }>

/**
 * What a runner's read reads as it stands (traces.ts Standing), in the repository at `repository`: a file-system read's
 * as traces.ts standingOf states it, the one implementation; a read of the PostgreSQL serving the run's own members, the
 * installation and the cluster configuration as they stand (grounds.ts postgresStanding).
 */
const standingOf = (
	repository: string,
	kind: KeyedRead["kind"],
	path: string
): Effect.Effect<
	Standing,
	never,
	FileSystem.FileSystem | Digest.Digest | ChildProcessSpawner.ChildProcessSpawner
> => (kind === "postgres" ? postgresStanding : fileStandingOf(repository, kind, path))

/**
 * What a read reads as it stands (standingOf), in the repository at `repository`, read once a run through `standings`,
 * the run's memo of every read it has weighed, the PostgreSQL's installation among them.
 */
const standingIn = (
	repository: string,
	standings: Map<string, Standing>,
	kind: KeyedRead["kind"],
	path: string
) =>
	Effect.gen(function* () {
		const memo = `${kind}\u0000${path}`
		const known = standings.get(memo)
		if (known !== undefined) {
			return known
		}
		const standing = yield* standingOf(repository, kind, path)
		standings.set(memo, standing)
		return standing
	})

/** A file written in place whole: renamed from a temporary file beside it, so no reader sees part of it. */
const writtenWhole = (file: string, text: string) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const directory = process.getBuiltinModule("node:path").dirname(file)
			yield* fs.makeDirectory(directory, { recursive: true })
			const temporary = yield* fs.makeTempFileScoped({ directory, prefix: ".trace-" })
			yield* fs.writeFileString(temporary, text)
			yield* fs.rename(temporary, file)
		})
	).pipe(Effect.orDie)

/** The first 16 hex digits of a text's SHA-256, which name a reads file and a trace. */
const nameOf = (text: string) =>
	Effect.gen(function* () {
		const digest = yield* Digest.Digest
		const hex = yield* digest.digestHex(Digest.sha256, new TextEncoder().encode(text))
		return Str.slice(0, 16)(hex)
	})

/** A pass a run would keep: its record file, and its trace's reads (WorkerReads), one for each worker that ran it. */
type Kept = Readonly<{ record: string; traces: ReadonlyArray<WorkerReads> }>

/**
 * The traces of a run's passes `passes`, in the repository at `repository`, under the cache's verdicts directory
 * `verdicts`: each pass's trace beside its record, then the run's reads file, written once, so a reads file no trace
 * names was never one a trace needed. It gives the record files of the
 * passes kept (`kept`), each a pass none of whose reads changed at or after `began` (milliseconds since the epoch), the
 * run's start, and of every other the first read of its trace that did (`changed`). Each read is weighed once, through
 * `standings`.
 */
export const tracesWritten = (
	repository: string,
	verdicts: string,
	began: number,
	passes: ReadonlyArray<Kept>,
	standings: Map<string, Standing>
) =>
	Effect.gen(function* () {
		const workers = new Map<ReadonlyArray<KeyedRead>, number>()
		for (const pass of passes) {
			for (const trace of pass.traces) {
				workers.set(trace.reads, Math.max(workers.get(trace.reads) ?? 0, trace.upTo))
			}
		}
		const table = new Map<string, number>()
		const reads: Array<typeof TracedRead.Type> = []
		const orders: Array<ReadonlyArray<number>> = []
		const changedFrom: Array<number> = []
		const changedPaths: Array<string> = []
		const indexOf = new Map<ReadonlyArray<KeyedRead>, number>()
		for (const [made, upTo] of workers) {
			const order: Array<number> = []
			let changed = upTo
			let changedPath = ""
			for (const [at, read] of Arr.take(made, upTo).entries()) {
				const standing = yield* standingIn(repository, standings, read.kind, read.path)
				if (standing.changed >= began && at < changed) {
					changed = at
					changedPath = read.path
				}
				const place = placeOf(repository, read.path)
				const entry = {
					kind: read.kind,
					place: place.kind,
					path: place.path,
					digest: standing.digest
				}
				const key = `${entry.kind}\u0000${entry.place}\u0000${entry.path}\u0000${entry.digest}`
				const known = table.get(key)
				if (known === undefined) {
					table.set(key, reads.length)
					order.push(reads.length)
					reads.push(entry)
				} else {
					order.push(known)
				}
			}
			indexOf.set(made, orders.length)
			orders.push(order)
			changedFrom.push(changed)
			changedPaths.push(changedPath)
		}
		/** The read of a pass's trace that changed since the run began, the first its workers made; none where none did. */
		const changedIn = (pass: Kept): Option.Option<string> =>
			Arr.findFirst(pass.traces, (trace) => {
				const worker = indexOf.get(trace.reads) ?? -1
				return trace.upTo > (changedFrom[worker] ?? 0)
					? Option.some(changedPaths[worker] ?? "")
					: Option.none()
			})
		const changed = new Map(
			Arr.filterMap(passes, (pass) =>
				Option.match(changedIn(pass), {
					onNone: () => Result.failVoid,
					onSome: (path) => Result.succeed([pass.record, path] as const)
				})
			)
		)
		const keptPasses = Arr.filter(passes, (pass) => !changed.has(pass.record))
		if (!Arr.isReadonlyArrayNonEmpty(keptPasses)) {
			return { kept: new Set<string>(), changed }
		}
		const text = yield* Effect.orDie(encodeReadsFile({ reads, workers: orders }))
		const name = yield* nameOf(text)
		for (const pass of keptPasses) {
			const trace = yield* Effect.orDie(
				encodeTraceFile({
					reads: name,
					prefixes: Arr.map(pass.traces, (one) => [indexOf.get(one.reads) ?? 0, one.upTo] as const)
				})
			)
			yield* writtenWhole(`${pass.record}.${name}.trace`, trace)
		}
		yield* writtenWhole(`${verdicts}/reads/${name}.reads`, text)
		return { kept: new Set(Arr.map(keptPasses, (pass) => pass.record)), changed }
	})

/** Removes every trace of the record file `record`: its key holds no pass, so none of them answers. */
export const tracesRemoved = (record: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = process.getBuiltinModule("node:path")
		const directory = path.dirname(record)
		const named = `${path.basename(record)}.`
		const names = yield* Effect.orElseSucceed(fs.readDirectory(directory), () => [])
		yield* Effect.forEach(
			Arr.filter(names, (name) => Str.startsWith(named)(name) && Str.endsWith(".trace")(name)),
			(name) => Effect.ignore(fs.remove(`${directory}/${name}`, { force: true })),
			{ discard: true }
		)
	})

/**
 * A run's reads file as a lookup weighs it: its reads and its workers' orders, whether each read stands (none until
 * weighed), and for each worker how far its reads have been weighed and the first that does not stand, if any.
 */
type ReadsWeighed = Readonly<{
	reads: ReadonlyArray<typeof TracedRead.Type>
	workers: ReadonlyArray<ReadonlyArray<number>>
	stands: Map<number, boolean>
	weighedTo: Array<number>
	unlike: Array<number | undefined>
}>

/**
 * What one run's lookups of the cache weigh once, however many traces hold it: each read as it stands (`standings`),
 * and each reads file a trace names, by its name, none where it cannot be read.
 */
type TraceLookup = Readonly<{
	repository: string
	verdicts: string
	standings: Map<string, Standing>
	readsFiles: Map<string, Option.Option<ReadsWeighed>>
}>

/** A lookup of the cache's traces for one run, in the repository at `repository`, its verdicts at `verdicts`. */
export const traceLookupOf = (repository: string, verdicts: string): TraceLookup => ({
	repository,
	verdicts,
	standings: new Map(),
	readsFiles: new Map()
})

/** The reads file named `name`, as `lookup` weighs it, read once a lookup; none where it is gone or unreadable. */
const readsFileIn = (lookup: TraceLookup, name: string) =>
	Effect.gen(function* () {
		const known = lookup.readsFiles.get(name)
		if (known !== undefined) {
			return known
		}
		const fs = yield* FileSystem.FileSystem
		const text = yield* Effect.option(fs.readFileString(`${lookup.verdicts}/reads/${name}.reads`))
		const decoded = Option.isSome(text)
			? yield* Effect.option(decodeReadsFile(text.value))
			: Option.none()
		const weighed = Option.map(decoded, (file): ReadsWeighed => ({
			reads: file.reads,
			workers: file.workers,
			stands: new Map(),
			weighedTo: Arr.map(file.workers, () => 0),
			unlike: Arr.map(file.workers, () => undefined)
		}))
		lookup.readsFiles.set(name, weighed)
		return weighed
	})

/**
 * Whether the first `upTo` reads of worker `worker` of a reads file stand: each weighed once a lookup, in the worker's
 * order, up to the first that reads unlike.
 */
const prefixStands = (lookup: TraceLookup, file: ReadsWeighed, worker: number, upTo: number) =>
	Effect.gen(function* () {
		const order = file.workers[worker]
		if (order === undefined || order.length < upTo) {
			return false
		}
		const known = file.unlike[worker]
		if (known !== undefined) {
			return known >= upTo
		}
		for (let at = file.weighedTo[worker] ?? 0; at < upTo; at += 1) {
			const index = order[at] ?? -1
			const read = file.reads[index]
			if (read === undefined) {
				return false
			}
			const weighed = file.stands.get(index)
			const stands =
				weighed ??
				(yield* Effect.map(
					standingIn(
						lookup.repository,
						lookup.standings,
						read.kind,
						absoluteOf(lookup.repository, { kind: read.place, path: read.path })
					),
					(standing) => standing.digest === read.digest
				))
			file.stands.set(index, stands)
			if (!stands) {
				file.unlike[worker] = at
				return false
			}
			file.weighedTo[worker] = at + 1
		}
		return true
	})

/**
 * Whether some trace of the pass whose record file is `record` reads alike now (traceStandsIn), as `lookup` weighs
 * them: none where the pass has none, so a record with no trace answers nothing.
 */
export const traceStands = (
	lookup: TraceLookup,
	record: string
): Effect.Effect<
	boolean,
	never,
	FileSystem.FileSystem | Digest.Digest | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = process.getBuiltinModule("node:path")
		const directory = path.dirname(record)
		const named = `${path.basename(record)}.`
		const names = yield* Effect.orElseSucceed(fs.readDirectory(directory), () => [])
		for (const name of names) {
			if (Str.startsWith(named)(name) && Str.endsWith(".trace")(name)) {
				if (yield* traceStandsIn(lookup, `${directory}/${name}`)) {
					return true
				}
			}
		}
		return false
	})

/**
 * Whether the trace in `file` reads alike now: its reads file there, and each worker's reads it takes standing, each
 * read weighed once a lookup (prefixStands). A trace or a reads file unreadable reads unlike.
 */
const traceStandsIn = (
	lookup: TraceLookup,
	file: string
): Effect.Effect<
	boolean,
	never,
	FileSystem.FileSystem | Digest.Digest | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const text = yield* Effect.option(fs.readFileString(file))
		if (Option.isNone(text)) {
			return false
		}
		const trace = yield* Effect.option(decodeTraceFile(text.value))
		if (Option.isNone(trace)) {
			return false
		}
		const reads = yield* readsFileIn(lookup, trace.value.reads)
		if (Option.isNone(reads)) {
			return false
		}
		for (const [worker, upTo] of trace.value.prefixes) {
			if (!(yield* prefixStands(lookup, reads.value, worker, upTo))) {
				return false
			}
		}
		return true
	})
