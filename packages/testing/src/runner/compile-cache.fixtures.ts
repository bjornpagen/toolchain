import { Array as Arr, Effect, FileSystem, String as Str } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { characterOf, int, map, type Gen, string, uniqueArray } from "#gen.ts"
import { compileCacheIn, FANOUT } from "#runner/compile-cache.ts"

/**
 * What the compile store's properties (compile-cache.test.ts) draw and run: roots with the modules their processes
 * load, laid out as Node lays out a cache directory; and processes of one root started at once, each computing its
 * directory with the checkout's compile-cache.ts (Checkout.dir, so a mutant of it is what they run).
 */

/** A root and how many modules its processes load. */
export type Rooted = Readonly<{ root: string; modules: number }>

/** The most modules a drawn root loads: within a shard level's fan-out, so a root's own directory never exceeds it. */
export const MOST_MODULES = 32

/** The store the layout property lays roots out in. */
export const STORE = "/store"

/** The directory Node keeps a runtime's entries under in a cache directory (its version, arch, flags and user). */
const RUNTIME = "v26.13.1-arm64-2a81aeeb-1000"

/** Roots: distinct absolute paths, from one to two shard levels' worth, each loading its modules. */
export const rootsGen: Gen<ReadonlyArray<Rooted>> = uniqueArray(
	string(characterOf(["a", "b", "c", "d", "e", "f", "g", "h", "/", "-", "."]), { min: 1, max: 16 }),
	(name) => map(int(1, MOST_MODULES), (modules): Rooted => ({ root: `/${name}`, modules })),
	{ min: 1, max: 2 * FANOUT }
)

/**
 * Every entry Node writes for `roots` in `store`, as a path: in each root's directory (compileCacheIn), under its
 * runtime's directory, one entry for each module, named for the module's path as Node names it (a CRC of the path; here
 * the path itself, escaped, so two roots' modules never share a name, as their paths never do).
 */
export const entriesOf = (store: string, roots: ReadonlyArray<Rooted>): ReadonlyArray<string> =>
	Arr.flatMap(roots, ({ root, modules }) =>
		Arr.makeBy(
			modules,
			(module) =>
				`${compileCacheIn(store, root)}/${RUNTIME}/${encodeURIComponent(`${root}/m${module}.js`)}`
		)
	)

/** How many entries each directory under `store` holds, given the files under it. */
export const heldBy = (
	store: string,
	files: ReadonlyArray<string>
): ReadonlyMap<string, number> => {
	const children = new Map<string, Set<string>>()
	for (const file of files) {
		const segments = Str.split("/")(Str.slice(store.length + 1)(file))
		Arr.forEach(segments, (segment, depth) => {
			const directory = Arr.join([store, ...Arr.take(segments, depth)], "/")
			const held = children.get(directory) ?? new Set<string>()
			held.add(segment)
			children.set(directory, held)
		})
	}
	return new Map(Arr.map([...children], ([directory, held]) => [directory, held.size]))
}

/**
 * A process of `root`: it computes its root's directory in `store` with the checkout's compile-cache.ts, enables
 * Node's compile cache there, and loads the root's module.
 */
const PROCESS = Arr.join(
	[
		"const { compileCacheIn } = await import(process.env.COMPILE_CACHE_MODULE)",
		'const { enableCompileCache } = await import("node:module")',
		"enableCompileCache(compileCacheIn(process.env.COMPILE_CACHE_STORE, process.env.COMPILE_CACHE_ROOT))",
		'await import(process.env.COMPILE_CACHE_ROOT + "/loaded.mjs")'
	],
	"\n"
)

/** The module a root's processes load. */
const LOADED = "export const loaded = (n) => n + 1\nexport const twice = (n) => loaded(loaded(n))\n"

/**
 * Starts `processes` processes of one root at once, each over the store `store`, from the package root
 * `packageRoot` (its compile-cache.ts the one they compute their directory with), and answers every file under the
 * store once all have exited, by its path, with their exit statuses. The root is `<directory>/root`, its module
 * written there first. Only PATH and HOME reach them: no compile cache is inherited or turned off.
 */
export const startedAtOnce = (
	packageRoot: string,
	directory: string,
	store: string,
	processes: number
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const root = `${directory}/root`
		yield* fs.makeDirectory(root, { recursive: true })
		yield* fs.writeFileString(`${root}/loaded.mjs`, LOADED)
		const statuses = yield* Effect.all(
			Arr.makeBy(processes, () =>
				spawner.exitCode(
					ChildProcess.make(process.execPath, ["--input-type=module", "-e", PROCESS], {
						env: {
							PATH: "/usr/bin:/bin",
							HOME: directory,
							COMPILE_CACHE_MODULE: `${packageRoot}/src/runner/compile-cache.ts`,
							COMPILE_CACHE_STORE: store,
							COMPILE_CACHE_ROOT: root
						},
						extendEnv: false,
						stdin: "ignore",
						stdout: "ignore",
						stderr: "inherit"
					})
				)
			),
			{ concurrency: "unbounded" }
		)
		const listed = yield* fs.readDirectory(store, { recursive: true })
		const paths = Arr.map(listed, (relative) => `${store}/${relative}`)
		const typed = yield* Effect.forEach(paths, (path) =>
			Effect.map(fs.stat(path), (info) => ({ path, file: info.type === "File" }))
		)
		const files = Arr.map(
			Arr.filter(typed, ({ file }) => file),
			({ path }) => path
		)
		return { root, statuses: Arr.map(statuses, Number), files: Arr.sort(files, Str.Order) }
	})
