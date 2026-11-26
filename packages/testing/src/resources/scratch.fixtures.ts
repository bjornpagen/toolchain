import * as NodeServices from "@effect/platform-node/NodeServices"
import { Array as Arr, Effect, FileSystem, Option, Predicate, Result, String as Str } from "effect"
import { awaitFact } from "#fact.ts"
import { element, type Gen, int } from "#gen.ts"
import type { CheckoutDir } from "#mutate/checkout.ts"
import { cachedScratch, processScratch } from "#resources/scratch.ts"
import { HARDENED_FLAGS } from "#runner/config.ts"
import { unwatched } from "#runner/observe.ts"

/**
 * The bound scratch property (scratch.test.ts scratchOutlivesNoProcess) needs a process that makes a scratch directory
 * and ends: this module is that program when run, and the support of the property that starts it. The program makes a
 * scratch directory (processScratch, or cachedScratch in toolchain-test's cache), writes `files` files in it, prints the directory's path and its remover's process
 * id (its one child), and ends as it is told.
 */

/**
 * Whether a process of `pid` runs on this machine: signal 0 reaches it, or reaches a process of another user, which
 * refuses it (EPERM). Only an answer that no such process exists (ESRCH) says it has ended.
 */
const processRuns = (pid: number): boolean =>
	Result.match(Result.try({ try: () => process.kill(pid, 0), catch: (error) => error }), {
		onSuccess: () => true,
		onFailure: (error) => !(Predicate.hasProperty(error, "code") && error.code === "ESRCH")
	})

/** How the process that made a scratch directory ends: its scope closed, exited with its scope open, or SIGKILLed. */
export const ENDINGS = ["its scope closed", "it exited", "it was killed"] as const

export type Ending = (typeof ENDINGS)[number]

/** Where the maker makes its scratch directory: the run's temporary directory (processScratch) or the cache's. */
export const PLACES = ["in the run's temporary directory", "in toolchain-test's cache"] as const

export type Place = (typeof PLACES)[number]

/** One case: how the maker ends, where it makes its directory, and how many files it writes in it. */
export type Made = Readonly<{ ending: Ending; place: Place; files: number }>

export const madeGen: Gen<Made> = (source) => ({
	ending: source.draw(element(ENDINGS)),
	place: source.draw(element(PLACES)),
	files: source.draw(int(0, 3))
})

/** The program a case starts: this module, in the testing package's checkout the case is given (Checkout.dir), so a
 * mutant of the code it runs reaches it. */
const programIn = (checkout: CheckoutDir): string => `${checkout}/src/resources/scratch.fixtures.ts`

/** This process's children's process ids, as Linux lists them for its main thread. */
const children = Effect.map(
	Effect.flatMap(FileSystem.FileSystem, (fs) =>
		fs.readFileString(`/proc/self/task/${String(process.pid)}/children`)
	),
	(listed) => Arr.filter(Str.split(" ")(Str.trim(listed)), Str.isNonEmpty)
)

/** The program: a scratch directory made with `files` files in it, its path and its remover's printed, then its ending. */
const madeAsProgram = (made: Made) =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const directory = yield* made.place === "in toolchain-test's cache"
				? cachedScratch("toolchain-scratch-test-")
				: processScratch({ prefix: "toolchain-scratch-test-" })
			yield* Effect.forEach(
				Array.from({ length: made.files }, (_, i) => `${directory}/${String(i)}`),
				(file) => fs.writeFileString(file, file),
				{ discard: true }
			)
			const remover = yield* children
			yield* Effect.sync(() => {
				process.stdout.write(`${directory} ${Arr.join(remover, " ")}\n`)
			})
			switch (made.ending) {
				case "its scope closed":
					return
				case "it exited":
					return yield* Effect.sync(() => process.exit(0))
				case "it was killed":
					return yield* Effect.never
			}
		})
	)

/**
 * The scratch directory a program made as `made` says, once the program has ended as told (the case kills a program
 * told it was killed, with SIGKILL) and the directory's remover has ended too: what the remover leaves is all there is.
 * The program is started by Node's spawn as it was before the worker's guard wrapped it (runner/observe.ts unwatched):
 * it and its remover are the runner's own machinery under test (scratch.ts processScratch), and under the guard's strace
 * the SIGKILL reached strace, whose --kill-on-exit killed the remover with it, so a killed program's directory was left
 * (scratchOutlivesNoProcess under the toolchain merge's gate, 2026-11-26), as orphans.fixtures.ts heldProgram's worker
 * was.
 */
export const madeAndEnded = (checkout: CheckoutDir, made: Made) =>
	Effect.gen(function* () {
		const printed = yield* Effect.callback<string>((resume) => {
			const child = unwatched.spawn(
				process.execPath,
				[...HARDENED_FLAGS, programIn(checkout), made.ending, made.place, String(made.files)],
				{ stdio: ["ignore", "pipe", "ignore"] }
			)
			let text = ""
			let line = Option.none<string>()
			child.stdout.setEncoding("utf8")
			child.stdout.on("data", (chunk: string) => {
				if (Option.isSome(line)) {
					return
				}
				text += chunk
				line = Option.map(Str.indexOf("\n")(text), (end) => Str.slice(0, end)(text))
				if (Option.isSome(line) && made.ending === "it was killed") {
					child.kill("SIGKILL")
				}
			})
			child.once("error", (cause) => {
				resume(Effect.die(cause))
			})
			child.once("exit", () => {
				resume(
					Option.match(line, {
						onNone: () => Effect.die("the program ended before it printed its scratch directory"),
						onSome: Effect.succeed
					})
				)
			})
			return Effect.sync(() => {
				child.kill("SIGKILL")
			})
		})
		const [directory, ...removers] = Str.split(" ")(printed)
		yield* awaitFact(
			Effect.sync(() =>
				Arr.some(removers, (pid) => processRuns(Number(pid))) ? Option.none() : Option.some(true)
			)
		)
		return { directory, removers: removers.length }
	})

if (import.meta.main) {
	const [ending, place, files] = process.argv.slice(2)
	const told = Arr.findFirst(ENDINGS, (one) => one === ending)
	const where = Arr.findFirst(PLACES, (one) => one === place)
	if (Option.isSome(told) && Option.isSome(where) && files !== undefined) {
		await Effect.runPromise(
			madeAsProgram({ ending: told.value, place: where.value, files: Number(files) }).pipe(
				Effect.provide(NodeServices.layer)
			)
		)
	}
}
