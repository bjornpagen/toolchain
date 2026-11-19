import * as NodeServices from "@effect/platform-node/NodeServices"
import { Array as Arr, Effect, FileSystem, Option, Stream, String as Str } from "effect"
import { ChildProcess } from "effect/process"
import { awaitFact } from "#fact.ts"
import { element, type Gen, int } from "#gen.ts"
import type { CheckoutDir } from "#mutate/checkout.ts"
import { processRuns } from "#pg/server.ts"
import { processScratch } from "#resources/scratch.ts"
import { HARDENED_FLAGS } from "#runner/config.ts"

/**
 * The bound scratch property (scratch.test.ts scratchOutlivesNoProcess) needs a process that makes a scratch directory
 * and ends: this module is that program when run, and the support of the property that starts it. The program makes a
 * scratch directory (processScratch), writes `files` files in it, prints the directory's path and its remover's process
 * id (its one child), and ends as it is told.
 */

/** How the process that made a scratch directory ends: its scope closed, exited with its scope open, or SIGKILLed. */
export const ENDINGS = ["its scope closed", "it exited", "it was killed"] as const

export type Ending = (typeof ENDINGS)[number]

/** One case: how the maker ends, and how many files it writes in its directory. */
export type Made = Readonly<{ ending: Ending; files: number }>

export const madeGen: Gen<Made> = (source) => ({
	ending: source.draw(element(ENDINGS)),
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
			const directory = yield* processScratch("toolchain-scratch-test-")
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
 */
export const madeAndEnded = (checkout: CheckoutDir, made: Made) =>
	Effect.scoped(
		Effect.gen(function* () {
			const handle = yield* ChildProcess.make(
				process.execPath,
				[...HARDENED_FLAGS, programIn(checkout), made.ending, String(made.files)],
				{ stdin: "ignore", stderr: "ignore", detached: false }
			)
			const line = yield* Stream.runHead(Stream.splitLines(Stream.decodeText(handle.stdout)))
			const printed = yield* Option.match(line, {
				onNone: () => Effect.die("the program ended before it printed its scratch directory"),
				onSome: Effect.succeed
			})
			const [directory, ...removers] = Str.split(" ")(printed)
			if (made.ending === "it was killed") {
				yield* handle.kill({ killSignal: "SIGKILL" })
			}
			yield* Effect.ignore(handle.exitCode)
			yield* awaitFact(
				Effect.sync(() =>
					Arr.some(removers, (pid) => processRuns(Number(pid))) ? Option.none() : Option.some(true)
				)
			)
			return { directory, removers: removers.length }
		})
	)

if (import.meta.main) {
	const [ending, files] = process.argv.slice(2)
	const told = Arr.findFirst(ENDINGS, (one) => one === ending)
	if (Option.isSome(told) && files !== undefined) {
		await Effect.runPromise(
			madeAsProgram({ ending: told.value, files: Number(files) }).pipe(
				Effect.provide(NodeServices.layer)
			)
		)
	}
}
