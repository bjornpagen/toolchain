import { Array as Arr, Console, Effect, Stream, String as Str } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { LoadCache, LoadKey } from "#runner/cache.ts"
import type { RunnerConfig } from "#runner/config.ts"
import { configOf, matchedBy } from "#runner/load.ts"
import { nodePoolFlag, testWorkers } from "#workers.ts"

/**
 * `toolchain-test load`, the cheap check that every test module of a package loads, for a repository's `pnpm check`
 * and its push gate: a module that throws as it loads (a const read in its temporal dead zone, an initializer that
 * throws, an export that is no property) fails every full run and every `pnpm mutate` before anything runs, and the
 * check names it with what it threw, where only a run that loads every module met it. Each module the runner config
 * includes loads apart, in a process of its own under this process's flags, as a worker loads a property's module
 * first (load-entry.ts, through the runner's own discover), so whether it loads is a function of its closure alone and
 * never of which module a process loaded before it; the processes run one for every two CPUs of the run's allowance (testWorkers). A module whose closure (with the
 * config's and the runner's) loaded before is a known answer: the repository's load cache holds its pass
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

/** What loading one module came to: it loaded, or what it threw (the runner's LoadFailed message). */
type Loaded =
	| Readonly<{ module: string; kind: "loads" }>
	| Readonly<{ module: string; kind: "failed"; message: string }>

/** `module` of the package at `root` loaded in a process of its own under this process's flags (load-entry.ts). */
const loadedApart = (root: string, module: string) =>
	Effect.scoped(
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			const handle = yield* spawner.spawn(
				ChildProcess.make(
					process.execPath,
					[...process.execArgv, nodePoolFlag, LOAD_ENTRY, root, module],
					{
						cwd: root,
						stdin: "ignore"
					}
				)
			)
			const [stdout, stderr, exitCode] = yield* Effect.all(
				[
					Stream.mkString(Stream.decodeText(handle.stdout)),
					Stream.mkString(Stream.decodeText(handle.stderr)),
					handle.exitCode
				],
				{ concurrency: "unbounded" }
			)
			return exitCode === 0
				? ({ module, kind: "loads" } satisfies Loaded)
				: ({
						module,
						kind: "failed",
						message: Str.trim(`${stdout}${stderr}`)
					} satisfies Loaded)
		})
	)

/** Every module of `modules` loaded apart, one process for every two CPUs of the run's allowance at once (testWorkers). */
const loadedEach = (root: string, modules: ReadonlyArray<string>) =>
	Effect.forEach(modules, (module) => loadedApart(root, module), { concurrency: testWorkers })

/** What a load check found: each module it loaded and how, how many it took as cached, and what it says beside. */
type Checked = Readonly<{
	loaded: ReadonlyArray<Loaded>
	cached: number
	said: ReadonlyArray<string>
}>

/** The modules a keying loads: those whose key holds no pass, each loaded, and every pass recorded. */
const checkedBy = (root: string, modules: ReadonlyArray<string>, keying: LoadKeying) => {
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
					Arr.map(due, (one) => one.keyed.module)
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
			return Effect.map(loadedEach(root, modules), (loaded): Checked => ({
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
		const checked = yield* checkedBy(root, modules, keying)
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
