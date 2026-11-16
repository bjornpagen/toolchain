/**
 * A worker started from a mutant's image (mutate/image.ts, mutate/hook.ts): every way a process reaches the mutant's
 * file, a static import, a require, a dynamic import and an import through another module, loads the mutated text, in
 * the file's own format, TypeScript or JavaScript; every other module loads as it is; and a process started from the
 * checkout's plain image loads the file as it is. Oracle: the specification, stated in the search.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { layer } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import {
	Array as Arr,
	Duration,
	Effect,
	FileSystem,
	Formatter,
	Option,
	Path,
	Stream,
	String as Str
} from "effect"
import { ChildProcess } from "effect/process"
import { drawn, explore } from "#explore.ts"
import { required } from "#features.ts"
import { boolean, element, int, shuffled } from "#gen.ts"
import { imagesOf } from "#mutate/image.ts"
import { realPathOf } from "#mutate/mutated.ts"
import { treesOf } from "#mutate/tree.ts"
import { notesOnly } from "#sense.ts"
import { boundedShrink } from "#shrink.ts"
import { searched } from "#vitest/searched.ts"

/** The ways a process reaches the mutant's file. */
const WAYS = ["import", "require", "dynamic import", "through another module"] as const

type Way = (typeof WAYS)[number]

/** A case: the target's own number and its mutant's, the ways main reaches it, its extension, and whether it is hooked. */
type Hooked = Readonly<{
	own: number
	mutant: number
	ways: Arr.NonEmptyReadonlyArray<Way>
	extension: ".ts" | ".js"
	hooked: boolean
}>

/** A module exporting `value`, typed when it is TypeScript. */
const valueModule = (extension: Hooked["extension"], value: number) =>
	extension === ".ts"
		? `export const value: number = ${String(value)}\n`
		: `export const value = ${String(value)}\n`

/** How main reads the target's value one way. */
const readOf = (way: Way, target: string): Readonly<{ head: string; read: string }> => {
	switch (way) {
		case "import":
			return { head: `import { value as viaImport } from "./${target}"`, read: "viaImport" }
		case "require":
			return { head: "", read: `require("./${target}").value` }
		case "dynamic import":
			return { head: "", read: `(await import("./${target}")).value` }
		case "through another module":
			return { head: `import { relayed } from "./relay.ts"`, read: "relayed" }
	}
}

/** Main: reads the target each of `ways`, and the untouched module, and prints every value on one line. */
const mainOf = (ways: ReadonlyArray<Way>, target: string) => {
	const reads = Arr.map(ways, (way) => readOf(way, target))
	return Arr.join(
		[
			`import { createRequire } from "node:module"`,
			`import { value as untouched } from "./untouched.ts"`,
			...Arr.filter(
				Arr.map(reads, (r) => r.head),
				Str.isNonEmpty
			),
			"const require = createRequire(import.meta.url)",
			`console.log([untouched, ${Arr.join(
				Arr.map(reads, (r) => r.read),
				", "
			)}].join(" "))`
		],
		"\n"
	)
}

layer(NodeServices.layer, { excludeTestServices: true })("a mutant's worker image", (it) => {
	it.effect(
		"loads the mutated text wherever the process reaches the file, in its own format, and every other module as it is",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "mutant image",
						oracle: {
							kind: "specification",
							name: "a hooked process reads the mutant's value every way it reaches the file, an unhooked one the file's own, and the untouched module its own"
						},
						draw: drawn((source): Hooked => {
							const own = source.draw(int(0, 99))
							const first = source.draw(element(WAYS))
							return {
								own,
								mutant: own + source.draw(int(1, 9)),
								ways: Arr.prepend(
									source.draw(
										shuffled(
											Arr.filter(WAYS, (way) => way !== first),
											{ min: 0, max: 3 }
										)
									),
									first
								),
								extension: source.draw(element([".ts", ".js"])),
								hooked: source.draw(boolean)
							}
						}),
						literal: Formatter.format,
						coverage: required<Way | "JavaScript" | "unhooked">(
							[...WAYS, "JavaScript", "unhooked"],
							{ cases: 100, sense: notesOnly }
						),
						kept: [],
						runs: 40,
						shrink: boundedShrink(40),
						steerEvery: 8,
						caseHang: Duration.minutes(1)
					},
					(hooked, c) =>
						Effect.scoped(
							Effect.gen(function* () {
								c.noteAll(hooked.ways)
								if (hooked.extension === ".js") {
									c.note("JavaScript")
								}
								if (!hooked.hooked) {
									c.note("unhooked")
								}
								const fs = yield* FileSystem.FileSystem
								const path = yield* Path.Path
								const made = yield* fs.makeTempDirectoryScoped({ prefix: "toolchain-hook-test-" })
								const checkout = yield* realPathOf(made)
								const name = `target${hooked.extension}`
								const write = (file: string, text: string) =>
									fs.writeFileString(path.join(checkout, file), text)
								yield* write("package.json", `{"type":"module"}`)
								yield* write(name, valueModule(hooked.extension, hooked.own))
								yield* write("untouched.ts", valueModule(".ts", 500))
								yield* write("relay.ts", `export { value as relayed } from "./${name}"\n`)
								yield* write("main.ts", mainOf(hooked.ways, name))
								const target = yield* realPathOf(path.join(checkout, name))
								const trees = yield* treesOf(checkout)
								const images = yield* imagesOf(checkout, trees)
								const image = yield* images.open(
									"in-process",
									hooked.hooked
										? Option.some({
												target,
												text: valueModule(hooked.extension, hooked.mutant)
											})
										: Option.none()
								)
								const handle = yield* ChildProcess.make(
									process.execPath,
									[...image.execArgv, "main.ts"],
									{ cwd: image.root, extendEnv: true, stdin: "ignore" }
								)
								const [printed, failure] = yield* Effect.all(
									[
										Stream.mkString(Stream.decodeText(handle.stdout)),
										Stream.mkString(Stream.decodeText(handle.stderr)),
										handle.exitCode
									],
									{ concurrency: "unbounded" }
								)
								const read = hooked.hooked ? hooked.mutant : hooked.own
								deepStrictEqual(
									{ read: Arr.map(Str.split(" ")(Str.trim(printed)), Number), failure },
									{ read: [500, ...Arr.map(hooked.ways, () => read)], failure: "" }
								)
							})
						)
				)
			)
	)
})
