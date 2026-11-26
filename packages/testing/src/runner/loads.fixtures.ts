import {
	Array as Arr,
	Config,
	ConfigProvider,
	Effect,
	FileSystem,
	Option,
	Order,
	Schema,
	Stream,
	String as Str
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { boolean, element, finite } from "#gen.ts"
import { compileCacheOf } from "#runner/compile-cache.ts"
import { HARDENED_FLAGS } from "#runner/config.ts"
import {
	type ConsumerFiles,
	consumerIn,
	type Layout,
	manifestOf,
	ran
} from "#runner/consumer.fixtures.ts"

/**
 * What the load-check property (loads.test.ts) draws, and the consumer package its check runs `toolchain-test load` in
 * twice: a package holding the library as a workspace link, in a git repository with its lockfile, its runner config
 * including test/*.test.ts, with a module that loads, a module that loads through a fixture module (test/shared.ts,
 * which the include leaves out), and at most one module that throws as it loads; between the two runs the fixture may
 * be changed to throw.
 */

/**
 * How a module can fail to load, or none; or how it loads with a handle left open, which holds no process of the load,
 * since its parent ends each process once it reported.
 */
export type Fault =
	| "none"
	| "a temporal dead zone"
	| "a throwing initializer"
	| "an export that is no property"
	| "an exit as it loads"
	| "a handle left open"

/** A case: the module that fails to load, if any, and whether the fixture is changed to throw before the second run. */
export type Package = Readonly<{ fault: Fault; fixtureThrows: boolean }>

/** Every case: each fault and none, the fixture changed or not. */
export const packages = finite((source): Package => ({
	fault: source.draw(
		element([
			"none",
			"a temporal dead zone",
			"a throwing initializer",
			"an export that is no property",
			"an exit as it loads",
			"a handle left open"
		] as const)
	),
	fixtureThrows: source.draw(boolean)
}))

/** The consumer's layout: the library linked, in git, with its lockfile and TypeScript, so its loads are keyed. */
const layout: Layout = { library: "link", git: true, lockfile: true, typescript: true }

/** A property module's imports and the spec every property of these modules shares; the properties never run. */
const PROLOGUE = Arr.join(
	[
		'import { Effect } from "effect"',
		'import { int } from "@bjornpagen/testing/gen"',
		'import { property } from "@bjornpagen/testing/property"',
		'const spec = { needs: {}, situations: [], check: () => () => Effect.void, oracle: { kind: "specification", name: "never run" }, kept: [], kills: [] } as const',
		""
	],
	"\n"
)

/** The text of the module that fails to load as `fault` says, none for no fault. */
const faultText = (fault: Fault): Option.Option<string> => {
	switch (fault) {
		case "none":
			return Option.none()
		case "a temporal dead zone":
			return Option.some(
				`${PROLOGUE}export const read = property.explore(int(0, size), spec)\nconst size = 9\n`
			)
		case "a throwing initializer":
			return Option.some(
				`${PROLOGUE}const size: number = (() => {\n\tthrow new Error("an initializer throws")\n})()\nexport const thrown = property.explore(int(0, size), spec)\n`
			)
		case "an export that is no property":
			return Option.some(`${PROLOGUE}export const helper = 9\n`)
		case "an exit as it loads":
			return Option.some(
				`${PROLOGUE}process.exit(0)\nexport const exited = property.explore(int(0, 9), spec)\n`
			)
		case "a handle left open":
			return Option.some(
				`${PROLOGUE}setInterval(() => undefined, 1000)\nexport const held = property.explore(int(0, 9), spec)\n`
			)
	}
}

/** What a run says of a module that fails as `fault` says, a part of its message; none for a module that loads. */
const faultMessage = (fault: Fault): Option.Option<string> => {
	switch (fault) {
		case "none":
		case "a handle left open":
			return Option.none()
		case "a temporal dead zone":
			return Option.some("Cannot access 'size' before initialization")
		case "a throwing initializer":
			return Option.some("an initializer throws")
		case "an export that is no property":
			return Option.some("test/fault.test.ts#helper is neither a Property nor a Family")
		case "an exit as it loads":
			return Option.some("its process ended before it reported")
	}
}

/** The failing module of `drawn`'s package and what its failure says, none when it holds no module that fails. */
const faultOf = (drawn: Package): Option.Option<readonly [module: string, says: string]> =>
	Option.map(faultMessage(drawn.fault), (says) => ["test/fault.test.ts", says] as const)

/** The module the changed fixture fails, and what its failure says. */
const FIXTURED: readonly [module: string, says: string] = [
	"test/fixtured.test.ts",
	"the fixture throws"
]

/** The fixture as the first run sees it, and as a changed one throws. */
const FIXTURE = "export const shared = 9\n"

const THROWING_FIXTURE = 'throw new Error("the fixture throws")\nexport const shared = 9\n'

/** The consumer's own files for `drawn`, the fixture as the first run sees it. */
const filesOf = (drawn: Package): ConsumerFiles => [
	["package.json", manifestOf(layout)],
	[
		"test.config.ts",
		'import { defineRunner, noMutation } from "@bjornpagen/testing/runner"\nimport { Layer } from "effect"\n\nexport default defineRunner({ include: ["test/*.test.ts"], smallStack: [], conditions: [], environment: [], layer: Layer.empty, mutation: noMutation })\n'
	],
	["test/plain.test.ts", `${PROLOGUE}export const plain = property.explore(int(0, 9), spec)\n`],
	["test/shared.ts", FIXTURE],
	[
		"test/fixtured.test.ts",
		`${PROLOGUE}import { shared } from "./shared.ts"\nexport const fixtured = property.explore(int(0, shared), spec)\n`
	],
	...Option.match(faultText(drawn.fault), {
		onNone: () => [],
		onSome: (text) => [["test/fault.test.ts", text] as const]
	})
]

/** What one `toolchain-test load` run said: its exit code, the modules it failed with their messages, and its counts. */
export type LoadRun = Readonly<{
	exitCode: number
	failed: ReadonlyArray<readonly [module: string, message: string]>
	summary: string
}>

/** The line a run's failure is printed on: `<module>: FAILED TO LOAD: <message>`. */
const FAILED = ": FAILED TO LOAD: "

/** `toolchain-test load` run in the consumer at `directory`, its cache under `cache`, git looking no higher. */
const loadRun = (directory: string, cache: string) =>
	Effect.map(
		ran(
			directory,
			process.execPath,
			["--disable-warning=ExperimentalWarning", "vendor/testing/src/runner/cli-entry.ts", "load"],
			{
				XDG_CACHE_HOME: cache,
				GIT_CEILING_DIRECTORIES: Arr.join(Arr.initNonEmpty(Str.split("/")(directory)), "/")
			}
		),
		([exitCode, stdout, stderr]): LoadRun => {
			const lines = Arr.filter(Str.split("\n")(`${stdout}${stderr}`), Str.isNonEmpty)
			return {
				exitCode,
				failed: Arr.flatMap(lines, (line) =>
					Option.match(Str.indexOf(FAILED)(line), {
						onNone: () => [],
						onSome: (at) => [[Str.slice(0, at)(line), Str.slice(at + FAILED.length)(line)] as const]
					})
				),
				summary: Option.getOrElse(Arr.last(lines), () => "")
			}
		}
	)

/**
 * Writes the consumer for `drawn` into `directory` from the checkout whose testing package is at `library`, runs
 * `toolchain-test load` there, changes the fixture to throw when `drawn` says so, and runs it again.
 */
export const loadedTwice = (directory: string, library: string, drawn: Package) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const consumer = `${directory}/consumer`
		yield* consumerIn(consumer, layout, library, filesOf(drawn))
		const first = yield* loadRun(consumer, `${directory}/cache`)
		if (drawn.fixtureThrows) {
			yield* fs.writeFileString(`${consumer}/test/shared.ts`, THROWING_FIXTURE)
		}
		const second = yield* loadRun(consumer, `${directory}/cache`)
		return { first, second }
	})

/** A run as the check compares it: its exit code, each failed module and whether it said what it threw, its count. */
export type Compared = Readonly<{
	exitCode: number
	failed: ReadonlyArray<readonly [module: string, said: boolean]>
	summary: string
}>

/**
 * What `toolchain-test load` must say of `drawn`'s package, by the specification: its first run loads every module apart,
 * none cached, and fails the faulty one, naming it with what it threw; its second loads only what has no cached load,
 * the faulty module again (a failure records nothing) and the fixtured module when its fixture now throws, failing
 * each, and takes every other as cached. Each fails the run, exit 1.
 */
export const expectedOf = (drawn: Package, run: "first" | "second"): Compared => {
	const modules = 2 + Option.match(faultText(drawn.fault), { onNone: () => 0, onSome: () => 1 })
	const failing = [
		...Option.toArray(faultOf(drawn)),
		...(run === "second" && drawn.fixtureThrows ? [FIXTURED] : [])
	]
	const loaded = run === "first" ? modules : failing.length
	return {
		exitCode: failing.length > 0 ? 1 : 0,
		failed: Arr.map(failing, ([module]) => [module, true] as const),
		summary: `${modules} modules: ${loaded} loaded apart, ${modules - loaded} cached, ${failing.length} failed`
	}
}

/** What a run said of `drawn`'s package, as compared: each failure's module, and whether it says what that module threw. */
export const comparedOf = (drawn: Package, run: LoadRun): Compared => ({
	exitCode: run.exitCode,
	failed: Arr.map(run.failed, ([module, message]) => [
		module,
		Arr.some(
			[...Option.toArray(faultOf(drawn)), FIXTURED],
			([failing, says]) => failing === module && Str.includes(says)(message)
		)
	]),
	summary: run.summary
})

/**
 * What the apart-load property (loads.test.ts loadsApartAtItsBound) draws, and the consumer its one load runs in, one
 * module at a time (TOOLCHAIN_CPU_ALLOWANCE=2, so loadWorkers is 1 and the processes start in path order): a.test.ts
 * importing the shared fixture, b.test.ts the shared fixture and the pair, c.test.ts the fixtures the case draws, each
 * fixture importing a deeper one; and two modules entering one import cycle (cycle-x.ts and cycle-y.ts, each importing
 * the other) from its two sides, the one entering at x reading x in its temporal dead zone (cycle-y.ts runs first and
 * reads x), the one entering at y loading, the reading one sorted first or second. An observer every process of the load
 * imports (the parent's --import, which each process it starts inherits with its flags) writes down, as each process
 * exits, its role, its module, how many resolutions of a specifier named by a module of the consumer's test/ reached
 * Node's resolver (a hook installed first, so the last a resolution reaches, as resolutions.fixtures.ts counts), its
 * compile cache's directory and whether Node's switch reached it. The load's parent is started as an account's unit
 * starts it: the switch set (NODE_DISABLE_COMPILE_CACHE=1), no compile cache directory, the hardened flags given.
 */

/** A fixture a test module of the apart load may import. */
export type Fixture = "shared" | "pair"

/** A case: whether the module reading the cycle's const in its temporal dead zone sorts first, and c.test.ts's fixtures. */
export type Apart = Readonly<{ readingFirst: boolean; third: ReadonlyArray<Fixture> }>

/** Every case: either side of the cycle first, and c.test.ts importing no fixture, either one, or both. */
export const aparts = finite((source): Apart => ({
	readingFirst: source.draw(boolean),
	third: source.draw(
		element<ReadonlyArray<Fixture>>([[], ["shared"], ["pair"], ["shared", "pair"]])
	)
}))

/** A module of the consumer's: its path, what it imports (the names, then the specifier), in order, and its body. */
type Module = Readonly<{
	path: string
	imports: ReadonlyArray<readonly [names: string, specifier: string]>
	body: string
}>

/** What every test module of the apart load imports first, and the spec every property of it shares. */
const PROPERTY_IMPORTS: ReadonlyArray<readonly [string, string]> = [
	["Effect", "effect"],
	["int", "@bjornpagen/testing/gen"],
	["property", "@bjornpagen/testing/property"]
]

const SPEC =
	'const spec = { needs: {}, situations: [], check: () => () => Effect.void, oracle: { kind: "specification", name: "never run" }, kept: [], kills: [] } as const\n'

/** A test module of the apart load: the property imports, its own, and one property bounded by `bound`. */
const testModule = (
	path: string,
	own: ReadonlyArray<readonly [string, string]>,
	name: string,
	bound: string
): Module => ({
	path,
	imports: [...PROPERTY_IMPORTS, ...own],
	body: `${SPEC}export const ${name} = property.explore(int(0, ${bound}), spec)\n`
})

/** The fixtures, by what imports them: each imports Effect and the deeper fixture. */
const FIXTURES: Readonly<Record<Fixture, Module>> = {
	shared: {
		path: "test/shared.ts",
		imports: [
			["Effect", "effect"],
			["deep", "./deeper.ts"]
		],
		body: "export const shared = deep + 1\n"
	},
	pair: {
		path: "test/pair.ts",
		imports: [
			["Effect", "effect"],
			["deep", "./deeper.ts"]
		],
		body: "export const pair = deep + 2\n"
	}
}

/** The module the apart load's case enters its cycle at x by, and the one at y, by where each sorts. */
const cycleModules = (drawn: Apart): readonly [readingAtX: string, loadingAtY: string] =>
	drawn.readingFirst
		? ["test/k-enters-x.test.ts", "test/m-enters-y.test.ts"]
		: ["test/m-enters-x.test.ts", "test/k-enters-y.test.ts"]

/** Every module of the apart load's consumer for `drawn`, its test modules in path order after the rest. */
const apartModules = (drawn: Apart): ReadonlyArray<Module> => {
	const [atX, atY] = cycleModules(drawn)
	const cycle = Arr.sort(
		[
			testModule(atX, [["x", "./cycle-x.ts"]], "enteredAtX", "x"),
			testModule(atY, [["y", "./cycle-y.ts"]], "enteredAtY", "y")
		],
		Order.mapInput(Str.Order, (module: Module) => module.path)
	)
	return [
		FIXTURES.shared,
		FIXTURES.pair,
		{
			path: "test/deeper.ts",
			imports: [["int", "@bjornpagen/testing/gen"]],
			body: "export const deep = 3\n"
		},
		{
			path: "test/cycle-x.ts",
			imports: [["y", "./cycle-y.ts"]],
			body: "export const x = 4\nexport const viaY = () => y\n"
		},
		{ path: "test/cycle-y.ts", imports: [["x", "./cycle-x.ts"]], body: "export const y = x + 1\n" },
		testModule("test/a.test.ts", [["shared", "./shared.ts"]], "a", "shared"),
		testModule(
			"test/b.test.ts",
			[
				["shared", "./shared.ts"],
				["pair", "./pair.ts"]
			],
			"b",
			"shared + pair"
		),
		testModule(
			"test/c.test.ts",
			Arr.map(drawn.third, (fixture) => [fixture, `./${fixture}.ts`] as const),
			"c",
			Arr.join(["9", ...drawn.third], " + ")
		),
		...cycle
	]
}

/** A module's text: its imports, a line each, then its body. */
const textOf = (module: Module): string =>
	Arr.join(
		[
			...Arr.map(module.imports, ([names, specifier]) => `import { ${names} } from "${specifier}"`),
			module.body
		],
		"\n"
	)

/** The test modules of `modules`, in path order. */
const testModulesOf = (modules: ReadonlyArray<Module>): ReadonlyArray<string> =>
	Arr.sort(
		Arr.filter(
			Arr.map(modules, (module) => module.path),
			Str.endsWith(".test.ts")
		),
		Str.Order
	)

/**
 * The resolutions a module's process sends to Node's resolver from the consumer's test/ modules, by the specification:
 * its closure's every (module, specifier), which a process resolves before any module of it runs, but those an earlier
 * process of the load resolved, which it is handed; so each process after the first resolves only what no process
 * before it met. A relative specifier names a module of test/; any other a package's, outside test/.
 */
const byNodeOf = (modules: ReadonlyArray<Module>): ReadonlyArray<readonly [string, number]> => {
	const byPath = new Map(Arr.map(modules, (module) => [module.path, module] as const))
	const closureKeys = (entry: string): ReadonlySet<string> => {
		const keys = new Set<string>()
		const seen = new Set<string>()
		const visit = (path: string): void => {
			if (seen.has(path)) {
				return
			}
			seen.add(path)
			for (const [, specifier] of byPath.get(path)?.imports ?? []) {
				keys.add(`${path}\t${specifier}`)
				if (Str.startsWith("./")(specifier)) {
					visit(`test/${Str.slice(2)(specifier)}`)
				}
			}
		}
		visit(entry)
		return keys
	}
	const resolved = new Set<string>()
	return Arr.map(testModulesOf(modules), (module) => {
		const keys = [...closureKeys(module)]
		const fresh = Arr.filter(keys, (key) => !resolved.has(key)).length
		for (const key of keys) {
			resolved.add(key)
		}
		return [module, fresh] as const
	})
}

/**
 * The observer the apart load's processes import, which writes a line of JSON (Observed) for each event: a load's
 * process as it starts (its module, its compile cache's directory, whether Node's switch reached it), each resolution of
 * a specifier named by a module of the consumer's test/ that reaches Node's resolver in one, and each call of
 * process.exit by one; and the load's parent as it exits (its compile cache's directory, the switch). A load's process
 * keeps its descriptor 3 open until it ends (its close does nothing), so its parent reads the report's end only once the
 * process ended on its own, and a call of process.exit on its way out is seen whatever the machine's load.
 */
const OBSERVER = Arr.join(
	[
		'import { appendFileSync } from "node:fs"',
		'import { getCompileCacheDir, registerHooks } from "node:module"',
		"const asked = new URL(import.meta.url).searchParams",
		'const out = asked.get("out")',
		'const tree = asked.get("tree")',
		'const entry = process.argv[1] ?? ""',
		'const role = entry.endsWith("/runner/load-entry.ts") ? "child" : entry.endsWith("/runner/cli-entry.ts") ? "parent" : "other"',
		'const module = role === "child" ? process.argv[3] : ""',
		'const record = (event) => appendFileSync(out, JSON.stringify({ module, ...event }) + "\\n")',
		'const cache = () => ({ compileCache: getCompileCacheDir() ?? "", switched: process.env.NODE_DISABLE_COMPILE_CACHE !== undefined })',
		'if (role === "child") {',
		'\trecord({ role: "child", ...cache() })',
		'\tregisterHooks({ resolve: (specifier, context, nextResolve) => { if ((context.parentURL ?? "").startsWith(tree)) { record({ role: "resolution" }) } return nextResolve(specifier, context) } })',
		"\tconst exit = process.exit",
		'\tprocess.exit = (code) => { record({ role: "exit" }); return exit(code) }',
		'\tconst fs = process.getBuiltinModule("node:fs")',
		"\tconst close = fs.closeSync",
		"\tfs.closeSync = (fd) => (fd === 3 ? undefined : close(fd))",
		"}",
		'if (role === "parent") {',
		'\tprocess.on("exit", () => record({ role: "parent", ...cache() }))',
		"}",
		""
	],
	"\n"
)

/** What the observer wrote of one event of the load: a process's start or the parent's exit, a resolution, an exit call. */
const Observed = Schema.Union([
	Schema.Struct({
		role: Schema.Literals(["parent", "child"]),
		module: Schema.String,
		compileCache: Schema.String,
		switched: Schema.Boolean
	}),
	Schema.Struct({ role: Schema.Literals(["resolution", "exit"]), module: Schema.String })
])

const decodeObserved = Schema.decodeUnknownEffect(Schema.fromJsonString(Observed))

/** What the apart load came to: its exit code, its failures, its summary, each event the observer saw, in order. */
export type ApartRun = Readonly<{
	exitCode: number
	failed: ReadonlyArray<readonly [module: string, message: string]>
	summary: string
	events: ReadonlyArray<typeof Observed.Type>
	cacheDirectory: string
}>

/**
 * Writes the apart load's consumer for `drawn` into `directory` from the checkout whose testing package is at `library`,
 * with its observer, and runs `toolchain-test load` in it once, one module at a time, as an account's unit starts it.
 */
export const loadedApartOnce = (directory: string, library: string, drawn: Apart) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
		const consumer = `${directory}/consumer`
		const cache = `${directory}/cache`
		const observed = `${directory}/observed.jsonl`
		const modules = apartModules(drawn)
		yield* consumerIn(consumer, layout, library, [
			["package.json", manifestOf(layout)],
			[
				"test.config.ts",
				'import { defineRunner, noMutation } from "@bjornpagen/testing/runner"\nimport { Layer } from "effect"\n\nexport default defineRunner({ include: ["test/*.test.ts"], smallStack: [], conditions: [], environment: [], layer: Layer.empty, mutation: noMutation })\n'
			],
			...Arr.map(modules, (module) => [module.path, textOf(module)] as const)
		])
		yield* fs.writeFileString(`${directory}/observer.mjs`, OBSERVER)
		yield* fs.writeFileString(observed, "")
		const observer = new URL(`file://${directory}/observer.mjs`)
		observer.searchParams.set("out", observed)
		observer.searchParams.set("tree", `file://${consumer}/test/`)
		const path = yield* Config.String("PATH")
		const [exitCode, stdout, stderr] = yield* Effect.scoped(
			Effect.flatMap(
				spawner.spawn(
					ChildProcess.make(
						process.execPath,
						[
							`--import=${observer.href}`,
							"--disable-warning=ExperimentalWarning",
							...HARDENED_FLAGS,
							"vendor/testing/src/runner/cli-entry.ts",
							"load"
						],
						{
							cwd: consumer,
							env: {
								PATH: path,
								HOME: directory,
								TMPDIR: directory,
								XDG_CACHE_HOME: cache,
								GIT_CEILING_DIRECTORIES: Arr.join(Arr.initNonEmpty(Str.split("/")(directory)), "/"),
								TOOLCHAIN_CPU_ALLOWANCE: "2",
								NODE_DISABLE_COMPILE_CACHE: "1"
							},
							extendEnv: false,
							stdin: "ignore"
						}
					)
				),
				(handle) =>
					Effect.all(
						[
							handle.exitCode,
							Stream.mkString(Stream.decodeText(handle.stdout)),
							Stream.mkString(Stream.decodeText(handle.stderr))
						],
						{ concurrency: "unbounded" }
					)
			)
		)
		const written = yield* fs.readFileString(observed)
		const lines = Arr.filter(Str.split("\n")(written), Str.isNonEmpty)
		const events = yield* Effect.forEach(lines, (line) => decodeObserved(line))
		const cacheDirectory = yield* compileCacheOf(consumer).pipe(
			Effect.provideService(
				ConfigProvider.ConfigProvider,
				ConfigProvider.fromEnvRecord({ HOME: directory, XDG_CACHE_HOME: cache })
			)
		)
		const said = Arr.filter(Str.split("\n")(`${stdout}${stderr}`), Str.isNonEmpty)
		return {
			exitCode: Number(exitCode),
			failed: Arr.flatMap(said, (line) =>
				Option.match(Str.indexOf(FAILED)(line), {
					onNone: () => [],
					onSome: (at) => [[Str.slice(0, at)(line), Str.slice(at + FAILED.length)(line)] as const]
				})
			),
			summary: Option.getOrElse(Arr.last(said), () => ""),
			events,
			cacheDirectory
		} satisfies ApartRun
	})

/** The apart load as compared: each failure and whether it says what its module threw, its summary, and its processes. */
export type ApartCompared = Readonly<{
	exitCode: number
	failed: ReadonlyArray<readonly [module: string, said: boolean]>
	summary: string
	processes: ReadonlyArray<
		Readonly<{
			role: string
			module: string
			byNode: number
			inRootsDirectory: boolean
			switched: boolean
		}>
	>
	exited: ReadonlyArray<string>
}>

/** What the TDZ read of the module entering the cycle at x says. */
const TDZ = "Cannot access 'x' before initialization"

/** The apart load as compared, from what it came to: each process with the resolutions it sent to Node's resolver. */
export const comparedApart = (drawn: Apart, run: ApartRun): ApartCompared => ({
	exitCode: run.exitCode,
	failed: Arr.map(run.failed, ([module, message]) => [
		module,
		module === cycleModules(drawn)[0] && Str.includes(TDZ)(message)
	]),
	summary: run.summary,
	processes: Arr.flatMap(run.events, (event) =>
		event.role === "child" || event.role === "parent"
			? [
					{
						role: event.role,
						module: event.module,
						byNode: Arr.filter(
							run.events,
							(other) => other.role === "resolution" && other.module === event.module
						).length,
						inRootsDirectory: Str.startsWith(`${run.cacheDirectory}/`)(event.compileCache),
						switched: event.switched
					}
				]
			: []
	),
	exited: Arr.flatMap(run.events, (event) => (event.role === "exit" ? [event.module] : []))
})

/**
 * What the apart load must come to, by the specification: every module loaded apart, one process each in path order
 * (the parent's exit last), exactly the module entering the cycle at x failing with its temporal dead zone read and the
 * one entering at y loading, whichever sorts first; each process resolving by Node only what no process before it met
 * (byNodeOf); the parent and every process with its compile cache in the root's directory of the store and none
 * reached by the account's switch; and no process calling process.exit.
 */
export const expectedApart = (drawn: Apart): ApartCompared => {
	const modules = apartModules(drawn)
	const tested = testModulesOf(modules)
	return {
		exitCode: 1,
		failed: [[cycleModules(drawn)[0], true]],
		summary: `${tested.length} modules: ${tested.length} loaded apart, 0 cached, 1 failed`,
		processes: [
			...Arr.map(byNodeOf(modules), ([module, byNode]) => ({
				role: "child",
				module,
				byNode,
				inRootsDirectory: true,
				switched: false
			})),
			{ role: "parent", module: "", byNode: 0, inRootsDirectory: true, switched: false }
		],
		exited: []
	}
}
