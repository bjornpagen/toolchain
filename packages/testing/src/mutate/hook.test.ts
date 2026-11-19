/**
 * A worker started from a mutant's image (mutate/image.ts, mutate/hook.ts): every way a process reaches the mutant's
 * file, a static import, a require, a dynamic import and an import through another module, loads the mutated text, in
 * the file's own format, TypeScript or JavaScript; every other module loads as it is; and a process started from the
 * checkout's plain image loads the file as it is. The hook runs in the processes the check starts, so the property
 * needs Checkout.dir: its kills run in a worker tree.
 */
import { Array as Arr, Effect, FileSystem, Option, Path, Stream, String as Str } from "effect"
import { ChildProcess } from "effect/process"
import { assert } from "#assert.ts"
import { boolean, element, int, shuffled } from "#gen.ts"
import { Checkout } from "#mutate/checkout.ts"
import { type Hooked, mainOf, valueModule, WAYS } from "#mutate/hook.fixtures.ts"
import { imagesOf } from "#mutate/image.ts"
import { realPathOf } from "#mutate/mutated.ts"
import { servedArgv } from "#mutate/pool.ts"
import { treesOf } from "#mutate/tree.ts"
import { property } from "#property.ts"

export const hookedImage = property.explore(
	(source): Hooked => {
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
	},
	{
		needs: { checkout: Checkout.dir },
		situations: [...WAYS, "JavaScript", "unhooked"],
		check: (_resources, c) => (hooked) =>
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
						? Option.some({ target, text: valueModule(hooked.extension, hooked.mutant) })
						: Option.none()
				)
				const handle = yield* ChildProcess.make(
					process.execPath,
					[...servedArgv(image.served), "main.ts"],
					{
						cwd: image.root,
						extendEnv: true,
						stdin: "ignore"
					}
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
				assert.deepEqual(
					{ read: Arr.map(Str.split(" ")(Str.trim(printed)), Number), failure },
					{ read: [500, ...Arr.map(hooked.ways, () => read)], failure: "" }
				)
			}),
		oracle: {
			kind: "specification",
			name: "a hooked process reads the mutant's value every way it reaches the file, an unhooked one the file's own, and the untouched module its own"
		},
		kept: [],
		kills: [
			{
				file: "packages/testing/src/mutate/hook.ts",
				original: "? { format: unmutated.format, source: text, shortCircuit: true }",
				replacement: '? { format: "module", source: text, shortCircuit: true }',
				why: "The mutant is served as JavaScript whatever its file's format, so a TypeScript mutant fails to parse."
			},
			{
				file: "packages/testing/src/mutate/hook.ts",
				original: "return loaded === url",
				replacement: "return loaded !== url",
				why: "The hook serves the mutant in place of every module but its own."
			}
		]
	}
)
