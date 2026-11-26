import { Array as Arr, Console, Effect, Fiber, Option, Ref, Stream, String as Str } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { LoadCache, LoadKey } from "#runner/cache.ts"
import { childCompileCacheOf, sharedStore } from "#runner/compile-cache.ts"
import type { RunnerConfig } from "#runner/config.ts"
import { childEnvironmentOf, workerEnvironmentOf } from "#runner/environment.ts"
import { reportedBy, type ModuleVerdict } from "#runner/load-report.ts"
import { configOf, matchedBy } from "#runner/load.ts"
import { freshChunksOf, knownChunk, payloadOf } from "#runner/resolutions.ts"
import { loadWorkers, nodePoolFlag } from "#workers.ts"

/**
 * `toolchain-test load`, the cheap check that every test module of a package loads, for a repository's `pnpm check`
 * and its push gate: a module that throws as it loads (a const read in its temporal dead zone, an initializer that
 * throws, an export that is no property) fails every full run and every `pnpm mutate` before anything runs, and the
 * check names it with what it threw, where only a run that loads every module met it. Each module the runner config
 * includes loads apart, in a process of its own under this process's flags, as a worker loads a property's module
 * first (load-entry.ts, through the runner's own discover), so whether it loads is a function of its closure alone and
 * never of which module a process loaded before it; the processes run one for every two CPUs of the run's allowance,
 * never of the task's share (workers.ts loadWorkers). Each process starts as a pool's worker starts: the worker
 * environment and the root's compile cache (environment.ts childEnvironmentOf), and on its standard input every
 * resolution this process holds and every one its earlier processes handed back (resolutions.ts), so only the first
 * process to meet a module compiles it and resolves its specifiers: the work that is a function of the files alone is
 * done once a load, and each process does what isolation needs, its closure's modules linked and run afresh (grizzle,
 * 2026-11-26, lane LOADFAST: 2.77 CPU-s a process compiling and resolving everything, 0.96 handed and cached). A module
 * whose closure (with the config's and the runner's) loaded before is a known answer: the repository's load cache holds its pass
 * (`<toolchain-test cache>/<repository key>/loads`, cache.ts loadCacheAt, keyed by affected.ts loadKeyingAt), and it is
 * not loaded again; a failure records nothing, so a module that failed loads again next time.
 */

/**
 * How a command's modules are keyed: `keyed`, each with its load key, in the repository's load cache; or `unkeyed`,
 * with why no key could be made (no git repository, a closure that will not hash, the closure hasher not loaded), every
 * module then loaded and none recorded.
 */
export type LoadKeying =
	| Readonly<{
			kind: "keyed"
			cache: LoadCache
			keys: ReadonlyArray<Readonly<{ module: string; key: LoadKey }>>
	  }>
	| Readonly<{ kind: "unkeyed"; why: string }>

/** The module each test module loads in: load-entry.ts, beside this one. */
const LOAD_ENTRY = `${import.meta.dirname}/load-entry.ts`

/** What loading one module came to: it loaded, or what it threw, with what its process printed before. */
type Loaded = Readonly<{ module: string }> & ModuleVerdict

/**
 * How a load's processes start: the environment each is given (childEnvironmentOf), and the resolutions each is handed,
 * the bytes of this process's own chunk first, then of each chunk an earlier process handed back, as they came.
 */
type Start = Readonly<{
	env: Readonly<Record<string, string>>
	chunks: Ref.Ref<ReadonlyArray<Uint8Array>>
}>

/** How the load of `config`'s package at `root` starts its processes: the worker environment, the root's compile cache. */
const startOf = (root: string, config: RunnerConfig) =>
	Effect.gen(function* () {
		const cache = yield* childCompileCacheOf(sharedStore, root, false)
		const chunks = yield* Ref.make<ReadonlyArray<Uint8Array>>([knownChunk()])
		return {
			env: childEnvironmentOf(workerEnvironmentOf(config.environment, process.env), cache),
			chunks
		} satisfies Start
	})

/**
 * `module` of the package at `root` loaded in a process of its own under this process's flags (load-entry.ts), started
 * as `start` says: handed every resolution `start` holds. Its verdict is its report (load-report.ts), read to the end of
 * its descriptor 3, what its chunk holds that this process did not kept for every process after it (freshChunksOf); then its process group is ended, so a module that left a
 * handle open holds nothing, and no process of a load ever ends by process.exit (nodejs/node#54918). A process that
 * ended before it reported fails, with what it printed.
 */
const loadedApart = (root: string, module: string, start: Start) =>
	Effect.scoped(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			const handed = yield* Ref.get(start.chunks)
			const handle = yield* spawner.spawn(
				ChildProcess.make(
					process.execPath,
					[...process.execArgv, nodePoolFlag, LOAD_ENTRY, root, module],
					{
						cwd: root,
						env: start.env,
						extendEnv: false,
						stdin: Stream.make(payloadOf(handed)),
						additionalFds: { fd3: { type: "output" } }
					}
				)
			)
			const printing = yield* Effect.forkScoped(
				Effect.all(
					[
						Stream.mkString(Stream.decodeText(handle.stdout)),
						Stream.mkString(Stream.decodeText(handle.stderr))
					],
					{ concurrency: "unbounded" }
				)
			)
			const parts = yield* Stream.runCollect(handle.getOutputFd(3))
			yield* Effect.ignore(handle.kill({ killSignal: "SIGKILL" }))
			const [stdout, stderr] = yield* Fiber.join(printing)
			const report = reportedBy(parts)
			const fresh = yield* Effect.sync(() => freshChunksOf(report.chunks))
			yield* Ref.update(start.chunks, Arr.appendAll(fresh))
			return Option.match(report.verdict, {
				onNone: (): Loaded => ({
					module,
					kind: "failed",
					message: Str.trim(
						`its process ended before it reported, having printed: ${stdout}${stderr}`
					)
				}),
				onSome: (verdict): Loaded =>
					verdict.kind === "loads"
						? { module, kind: "loads" }
						: { module, kind: "failed", message: Str.trim(`${stdout}${stderr}${verdict.message}`) }
			})
		})
	)

/** Every module of `modules` loaded apart, as many at once as the load's width (workers.ts loadWorkers). */
const loadedEach = (root: string, modules: ReadonlyArray<string>, start: Start) =>
	Effect.forEach(modules, (module) => loadedApart(root, module, start), {
		concurrency: loadWorkers
	})

/** What a load check found: each module it loaded and how, how many it took as cached, and what it says beside. */
type Checked = Readonly<{
	loaded: ReadonlyArray<Loaded>
	cached: number
	said: ReadonlyArray<string>
}>

/** The modules a keying loads: those whose key holds no pass, each loaded, and every pass recorded. */
const checkedBy = (
	root: string,
	modules: ReadonlyArray<string>,
	keying: LoadKeying,
	start: Start
) => {
	switch (keying.kind) {
		case "keyed":
			return Effect.gen(function* () {
				const answered = yield* Effect.forEach(keying.keys, (keyed) =>
					keying.cache.passed(keyed.key).pipe(
						Effect.map((cached) => ({ keyed, cached, said: [] })),
						Effect.catchTag("VerdictCorrupt", (corrupt) =>
							Effect.succeed({
								keyed,
								cached: false,
								said: [`${corrupt.path} is no record of its key; ${keyed.module} loads again`]
							})
						)
					)
				)
				const due = Arr.filter(answered, (one) => !one.cached)
				const loaded = yield* loadedEach(
					root,
					Arr.map(due, (one) => one.keyed.module),
					start
				)
				yield* Effect.forEach(
					Arr.zip(due, loaded),
					([one, outcome]) =>
						keying.cache.record(one.keyed.key, outcome.kind === "loads" ? "passed" : "failed"),
					{ discard: true }
				)
				return {
					loaded,
					cached: answered.length - due.length,
					said: Arr.flatMap(answered, (one) => one.said)
				} satisfies Checked
			})
		case "unkeyed":
			return Effect.map(loadedEach(root, modules, start), (loaded): Checked => ({
				loaded,
				cached: 0,
				said: [`loads not recorded: ${keying.why}`]
			}))
	}
}

/**
 * `load` in the package at `root`: every test module its runner config includes that has no cached load, loaded apart
 * (loadedApart), keyed by `keyingOf` (affected.ts loadKeyingAt, or unkeyed where the closure hasher does not load);
 * each failure printed with what it threw, then a count; 1 when any module failed to load.
 */
export const loadCommand = <R>(
	root: string,
	keyingOf: (
		config: RunnerConfig,
		modules: ReadonlyArray<string>
	) => Effect.Effect<LoadKeying, never, R>
) =>
	Effect.gen(function* () {
		const config = yield* configOf(root)
		const modules = yield* matchedBy(root, config.include)
		const keying = yield* keyingOf(config, modules)
		const start = yield* startOf(root, config)
		const checked = yield* checkedBy(root, modules, keying, start)
		const failed = Arr.filter(checked.loaded, (one) => one.kind === "failed")
		yield* Console.log(
			Arr.join(
				[
					...checked.said,
					...Arr.map(failed, (one) => `${one.module}: FAILED TO LOAD: ${one.message}`),
					`${modules.length} modules: ${checked.loaded.length} loaded apart, ${checked.cached} cached, ${failed.length} failed`
				],
				"\n"
			)
		)
		return Arr.isReadonlyArrayNonEmpty(failed) ? 1 : 0
	})
