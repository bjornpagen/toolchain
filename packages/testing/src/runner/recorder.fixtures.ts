import { Array as Arr, Effect, Order, Schema, String as Str } from "effect"
import { element, finite } from "#gen.ts"
import type { CheckoutDir } from "#mutate/checkout.ts"
import { childOutcomeOf, linesOf } from "#runner/child-record.ts"
import { STRACE, STRACE_PREFIX } from "#runner/intercept.ts"
import { unwatched } from "#runner/observe.ts"
import { type KeyedRead, RUNNER_READ_KINDS } from "#runner/strace.ts"

/**
 * What the recorder properties (recorder.test.ts) run: a Node child program in a tree of the case's own, run three ways,
 * each by Node's spawn as it was before the worker's guard wrapped it (runner/observe.ts unwatched), so no guard of the
 * worker's watches them and a process has one tracer: alone under strace(1), the reference, its reads read off its
 * trace as the guard read every child's before the recorder (runner/strace.ts straceActsOf, ownedOut); through the
 * checkout's guard in a fresh process that starts it as a property would (Checkout.dir, so a kill's mutant is what it
 * loads), under its recorder, its reads what the guard drained; and plain, for the budget. The runtime's own start (what
 * `node -e ""` reads under strace: its executable, libraries, ICU and OpenSSL configuration) is no read of a program's.
 */

/**
 * One program: a module of the tree's own (its relative import, its package's imports, a package's exports, a package's
 * legacy main, a package behind a link, a CommonJS require that probes extensions and node_modules, a JSON module, a
 * dynamic import); the testing library's own module graph (Effect's among it); a file's bytes (read whole, by
 * promise, by callback, by stream, by a named import); an absent file; a directory's entries; a path's status; a link's
 * text; a real path (through a link, natively, and one that is not there); its own files (made, read back, copied); a
 * Node child (spawned, forked); another program (spawned, through a shell, exec'd); a worker thread.
 */
const PROGRAMS = [
	"a relative import",
	"its package's imports",
	"a package's exports",
	"a package's legacy main",
	"a package behind a link",
	"a CommonJS require",
	"a JSON module",
	"a dynamic import",
	"the testing library's own modules",
	"a file's bytes",
	"an absent file",
	"a directory's entries",
	"a path's status",
	"a link's text",
	"a real path",
	"its own files",
	"a Node child",
	"another program",
	"a worker thread"
] as const

export type Program = (typeof PROGRAMS)[number]

/** Every case: each program. */
export const programs = finite((source): Program => source.draw(element(PROGRAMS)))

/** The recorder's own modules, from the checkout's package: the recorder and the interception it imports. */
const RECORDER_OWN: ReadonlyArray<string> = ["src/runner/recorder.ts", "src/runner/intercept.ts"]

/** The tree every program runs in: each file's path under the tree's root and its text. */
const TREE: ReadonlyArray<readonly [path: string, text: string]> = [
	[
		"app/package.json",
		'{ "name": "app", "type": "module", "imports": { "#util": "./src/util.ts" } }'
	],
	["app/src/util.ts", 'export const util: string = "util"'],
	["app/src/deep/dyn.ts", 'export const dynamic: string = "dynamic"'],
	["app/data.json", '{ "x": 1 }'],
	[
		"node_modules/esm-pkg/package.json",
		'{ "name": "esm-pkg", "type": "module", "exports": { ".": "./dist/index.js" } }'
	],
	["node_modules/esm-pkg/dist/index.js", 'export const esm = "esm"'],
	["node_modules/main-pkg/package.json", '{ "name": "main-pkg", "main": "lib/entry" }'],
	["node_modules/main-pkg/lib/entry.js", 'module.exports = "main"'],
	["pkgsrc/package.json", '{ "name": "@w/pkg", "type": "module", "exports": "./index.ts" }'],
	["pkgsrc/index.ts", 'export const linked: string = "linked"'],
	["cjsdir/package.json", '{ "type": "commonjs" }'],
	["cjsdir/c.js", 'module.exports = require("./helper") + require("cjs-dep")'],
	["cjsdir/helper.js", 'module.exports = "helper"'],
	["cjsdir/node_modules/cjs-dep/package.json", '{ "name": "cjs-dep", "main": "index.js" }'],
	["cjsdir/node_modules/cjs-dep/index.js", 'module.exports = "dep"'],
	["files/a.txt", "a\n"],
	["files/b.txt", "b\n"],
	["files/c.txt", "c\n"],
	["files/sub/d.txt", "d\n"],
	[
		"grand.mjs",
		'console.log(process.getBuiltinModule("node:fs").readFileSync(new URL("./files/" + process.argv[2], import.meta.url), "utf8").trim())'
	],
	[
		"thread.mjs",
		'process.getBuiltinModule("node:fs").readFileSync(new URL("./files/b.txt", import.meta.url))'
	]
]

/** The tree's symbolic links: each link's path under the tree's root and its text. */
const LINKS: ReadonlyArray<readonly [path: string, text: string]> = [
	["node_modules/@w/pkg", "../../pkgsrc"],
	["files/link", "a.txt"],
	["files/sub-link", "sub"]
]

/** The body of a program's module (app/src/deep/main.ts), `dir` the tree's root, `library` the checkout's package. */
const bodyOf = (program: Program, library: CheckoutDir): ReadonlyArray<string> => {
	switch (program) {
		case "a relative import":
			return ['const { util } = await import("../util.ts")', "say(util)"]
		case "its package's imports":
			return ['const { util } = await import("#util")', "say(util)"]
		case "a package's exports":
			return ['const { esm } = await import("esm-pkg")', "say(esm)"]
		case "a package's legacy main":
			return ['const { default: main } = await import("main-pkg")', "say(main)"]
		case "a package behind a link":
			return ['const { linked } = await import("@w/pkg")', "say(linked)"]
		case "a CommonJS require":
			return ['const { default: c } = await import("../../../cjsdir/c.js")', "say(c)"]
		case "a JSON module":
			return [
				'const { default: data } = await import("../../data.json", { with: { type: "json" } })',
				'const required = (await import("node:module")).createRequire(import.meta.url)("../../data.json")',
				"say(data.x + required.x)"
			]
		case "a dynamic import":
			return [
				'const { dynamic } = await import(new URL("./dyn.ts", import.meta.url).href)',
				"say(dynamic)"
			]
		case "the testing library's own modules":
			return [
				`const traces = await import("${process.getBuiltinModule("node:url").pathToFileURL(`${library}/src/runner/traces.ts`).href}")`,
				"say(Object.keys(traces).length)"
			]
		case "a file's bytes":
			return [
				'const { readFileSync } = await import("node:fs")',
				'say(fs.readFileSync(dir + "files/a.txt", "utf8") + readFileSync(dir + "files/sub/d.txt", "utf8"))',
				'say(await fs.promises.readFile(dir + "files/b.txt", "utf8"))',
				'say(await new Promise((resolve) => fs.readFile(dir + "files/c.txt", "utf8", (_, text) => resolve(text))))',
				'await new Promise((resolve) => fs.createReadStream(dir + "files/link").on("data", say).on("close", resolve))'
			]
		case "an absent file":
			return [
				'say(fs.existsSync(dir + "files/absent"))',
				'say(await new Promise((resolve) => fs.readFile(dir + "files/nothing", (failure) => resolve(failure?.code))))'
			]
		case "a directory's entries":
			return [
				'say(fs.readdirSync(dir + "files").length)',
				'const opened = fs.opendirSync(dir + "files/sub")',
				"say(opened.readSync()?.name)",
				"opened.closeSync()"
			]
		case "a path's status":
			return [
				'say(fs.statSync(dir + "files/a.txt").size + fs.lstatSync(dir + "files/link").size)',
				'fs.accessSync(dir + "files/b.txt")'
			]
		case "a link's text":
			return ['say(fs.readlinkSync(dir + "files/link"))']
		case "a real path":
			return [
				'say(fs.realpathSync(dir + "files/sub-link/d.txt"))',
				'say(fs.realpathSync.native(dir + "files/link"))',
				'say(await fs.promises.realpath(dir + "node_modules/@w/pkg/index.ts"))',
				'try { fs.realpathSync(dir + "files/nothing/there") } catch (failure) { say(failure.code) }'
			]
		case "its own files":
			return [
				'fs.mkdirSync(dir + "made")',
				'fs.writeFileSync(dir + "made/own.txt", "own")',
				'say(fs.readFileSync(dir + "made/own.txt", "utf8"))',
				'fs.copyFileSync(dir + "files/c.txt", dir + "made/copy.txt")',
				'say(fs.readdirSync(dir + "made").length)'
			]
		case "a Node child":
			return [
				'say(child.spawnSync(process.execPath, [dir + "grand.mjs", "c.txt"], { encoding: "utf8" }).stdout)',
				'say(await new Promise((resolve) => child.fork(dir + "grand.mjs", ["sub/d.txt"], { stdio: "pipe" }).on("exit", resolve)))'
			]
		case "another program":
			return [
				'say(child.spawnSync("cat", [dir + "files/a.txt"], { encoding: "utf8" }).stdout)',
				'say(child.spawnSync("cat " + dir + "files/b.txt", { shell: true, encoding: "utf8" }).stdout)',
				'say(child.execSync("cat " + dir + "files/c.txt", { encoding: "utf8" }))',
				'say(await new Promise((resolve) => child.exec("cat " + dir + "files/sub/d.txt", (_, out) => resolve(out))))'
			]
		case "a worker thread":
			return [
				'const { Worker } = await import("node:worker_threads")',
				'say(await new Promise((resolve) => new Worker(new URL(dir + "thread.mjs", "file:"), { execArgv: [] }).on("exit", resolve)))'
			]
	}
}

/**
 * A program's module: what it does (bodyOf, none for the empty program) between its prelude and its report, one line of
 * JSON: what it said, and what its process spent, as it states it at its end: its CPU (user and system) and its voluntary
 * context switches (a tracer's every stop is one).
 */
const moduleOf = (body: ReadonlyArray<string>): string =>
	Arr.join(
		[
			'const fs = process.getBuiltinModule("node:fs")',
			'const child = process.getBuiltinModule("node:child_process")',
			'const dir = new URL("../../../", import.meta.url).pathname',
			"const said = []",
			"const say = (value) => { said.push(String(value)) }",
			...body,
			"const cpu = process.cpuUsage()",
			"console.log(JSON.stringify({ said, spent: { cpu: (cpu.user + cpu.system) / 1000, switches: process.resourceUsage().voluntaryContextSwitches } }))",
			""
		],
		"\n"
	)

/** Writes the tree under `root` and a program's module of `body` in it (moduleOf): its module's path. */
const treeWritten = (root: string, body: ReadonlyArray<string>): string => {
	const fs = process.getBuiltinModule("node:fs")
	const path = process.getBuiltinModule("node:path")
	fs.rmSync(root, { recursive: true, force: true })
	for (const [file, text] of TREE) {
		fs.mkdirSync(path.dirname(`${root}/${file}`), { recursive: true })
		fs.writeFileSync(`${root}/${file}`, text)
	}
	for (const [link, text] of LINKS) {
		fs.mkdirSync(path.dirname(`${root}/${link}`), { recursive: true })
		fs.symlinkSync(text, `${root}/${link}`)
	}
	const main = `${root}/app/src/deep/main.ts`
	fs.mkdirSync(path.dirname(main), { recursive: true })
	fs.writeFileSync(main, moduleOf(body))
	return main
}

/** What a process said and how it ended: its exit code (or the signal that ended it) and its standard output. */
type Said = Readonly<{ code: string; stdout: string }>

/**
 * The environment every program runs in: this process's, with Node's compile cache off, whose entries are the runtime's
 * own (V8's code for a source it already compiled, checked against the source) and no program's reads, so neither run
 * reads one the other wrote.
 */
const environmentOf = (): NodeJS.ProcessEnv => {
	const environment: NodeJS.ProcessEnv = { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" }
	Reflect.deleteProperty(environment, "NODE_COMPILE_CACHE")
	return environment
}

/** Runs `command` with `args` in `cwd` by Node's spawn as it was before the guard wrapped it, to its end: what it said. */
const ranUnwatched = (
	cwd: string,
	command: string,
	args: ReadonlyArray<string>
): Effect.Effect<Said> =>
	Effect.callback<Said>((resume) => {
		const started = unwatched.spawn(command, [...args], {
			cwd,
			env: environmentOf(),
			stdio: ["ignore", "pipe", "inherit"]
		})
		let stdout = ""
		started.stdout.setEncoding("utf8")
		started.stdout.on("data", (text: string) => {
			stdout += text
		})
		started.once("error", (cause) => {
			resume(Effect.die(cause))
		})
		started.once("close", (code, signal) => {
			resume(Effect.succeed({ code: String(code ?? signal), stdout }))
		})
		return Effect.sync(() => {
			started.kill("SIGKILL")
		})
	})

/** The reads strace's trace at `trace` holds, as the guard reads a traced child's (childOutcomeOf). */
const tracedReadsOf = (trace: string): ReadonlyArray<KeyedRead> =>
	childOutcomeOf({
		node: false,
		record: undefined,
		traces: [process.getBuiltinModule("node:fs").readFileSync(trace, "utf8")]
	}).acts.reads

/** The reads of `command` run in `cwd` alone under strace, as the guard read a child's before the recorder, and what it said. */
const underStrace = (cwd: string, trace: string, command: string, args: ReadonlyArray<string>) =>
	Effect.map(
		ranUnwatched(cwd, STRACE, [...STRACE_PREFIX, trace, "--", command, ...args]),
		(said) => ({ said, reads: tracedReadsOf(trace) })
	)

/** What the guard program printed: what its child said, the reads the guard drained, and whether it observed. */
const Guarded = Schema.fromJsonString(
	Schema.Struct({
		code: Schema.String,
		stdout: Schema.String,
		reads: Schema.Array(Schema.Tuple([Schema.Literals(RUNNER_READ_KINDS), Schema.String])),
		records: Schema.Array(Schema.String),
		observed: Schema.Boolean
	})
)

/**
 * The program that starts the child as a property would: the checkout's guard installed first, its reader given it (which
 * keeps the text of the child's record as it reads it), a unit's window opened, the child spawned in it by Node's
 * spawnSync (which the guard wraps), the reads drained, and what it saw printed as JSON.
 */
const guardProgramOf = (library: CheckoutDir, main: string, tree: string): string => {
	const url = process.getBuiltinModule("node:url")
	return Arr.join(
		[
			`import { guardInstalled, guardWindow, guardDrain, guardChildren } from "${url.pathToFileURL(`${library}/src/runner/observe.ts`).href}"`,
			"let observed = false",
			"guardInstalled(() => { observed = true })",
			`const { childOutcomeOf } = await import("${url.pathToFileURL(`${library}/src/runner/child-record.ts`).href}")`,
			"const records = []",
			"guardChildren((record) => { records.push(record.record ?? ''); return childOutcomeOf(record) })",
			'const child = await import("node:child_process")',
			"guardWindow({ kind: 'open', unit: 1 })",
			`const ran = child.spawnSync(process.execPath, ["${main}"], { cwd: "${tree}", encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })`,
			"const reads = guardDrain().reads.map((read) => [read.kind, read.path])",
			"guardWindow({ kind: 'closed' })",
			"console.log(JSON.stringify({ code: String(ran.status ?? ran.signal), stdout: ran.stdout, reads, records, observed }))",
			""
		],
		"\n"
	)
}

/**
 * The keyed form of reads past the runtime's own start (`start`'s) and the recorder's own modules' bytes (`own`, which
 * load before it records, and which the toolchain digest keys in every key): each `<kind> <path>`, an absent path's read
 * of its bytes, entries or presence its absence alike (each reads `absent`, traces.ts standingOf), sorted, each once.
 */
const keyedOf = (
	reads: ReadonlyArray<KeyedRead>,
	start: ReadonlySet<string>,
	own: ReadonlySet<string>
): ReadonlyArray<string> => {
	const keyed = new Set<string>()
	for (const read of reads) {
		const text = `${read.kind} ${read.path}`
		if (start.has(text) || own.has(text)) {
			continue
		}
		const absent =
			(read.kind === "file" || read.kind === "directory" || read.kind === "presence") &&
			!unwatched.existsSync(read.path)
		keyed.add(absent ? `absent ${read.path}` : text)
	}
	return Arr.sort([...keyed], Order.String)
}

/** What a program reports at its end (moduleOf): what it said, and what its process spent. */
const Report = Schema.fromJsonString(
	Schema.Struct({
		said: Schema.Array(Schema.String),
		spent: Schema.Struct({ cpu: Schema.Finite, switches: Schema.Finite })
	})
)

/** What a program's process spent (Report): its CPU in milliseconds and its voluntary context switches. */
export type Spent = (typeof Report.Type)["spent"]

/** What a run said: its exit and its report (Report), the report none where it printed none. */
type Reported = Readonly<{ code: string; report: typeof Report.Type }>

/** A run's report (Report) off what it printed, the run failing where it printed none. */
const reportOf = (said: Said): Effect.Effect<Reported> =>
	Effect.map(Effect.orDie(Schema.decodeEffect(Report)(Str.trim(said.stdout))), (report) => ({
		code: said.code,
		report
	}))

/**
 * A program run through the checkout's guard in a fresh tree at `tree` (guardProgramOf), its guard program under `out`:
 * its report, the reads the guard drained of it, and whether the guard observed past every key.
 */
const guardedOf = (out: string, tree: string, body: ReadonlyArray<string>, library: CheckoutDir) =>
	Effect.gen(function* () {
		const main = treeWritten(tree, body)
		process
			.getBuiltinModule("node:fs")
			.writeFileSync(`${out}/guard.mjs`, guardProgramOf(library, main, tree))
		const guarded = yield* ranUnwatched(out, process.execPath, [
			"--disable-warning=ExperimentalWarning",
			`${out}/guard.mjs`
		])
		const printed = yield* Effect.orDie(Schema.decodeEffect(Guarded)(Str.trim(guarded.stdout)))
		const reported = yield* reportOf({ code: printed.code, stdout: printed.stdout })
		const lines = Arr.flatMap(printed.records, linesOf)
		return {
			reported,
			reads: Arr.map(printed.reads, ([kind, path]): KeyedRead => ({ kind, path })),
			lines: lines.length,
			distinct: new Set(Arr.map(lines, (line) => Arr.join(line, "\u0000"))).size,
			installs: Arr.filter(lines, (line) => line[0] === "installed").length,
			observed: printed.observed
		}
	})

/** A case's directories under `directory`, made afresh: its tree's and its runs' own. */
const freshOf = (directory: string): Readonly<{ tree: string; out: string }> => {
	const fs = process.getBuiltinModule("node:fs")
	const out = `${directory}/out`
	fs.rmSync(out, { recursive: true, force: true })
	fs.mkdirSync(out, { recursive: true })
	return { tree: `${directory}/tree/`, out }
}

/**
 * A program run twice in a fresh tree under `directory`: alone under strace, and through the checkout's guard under its
 * recorder; each run's reads in their keyed form (keyedOf) past the runtime's own start, how each ended and what it said,
 * and whether the guard observed past every key.
 */
export const comparedOf = (directory: string, library: CheckoutDir, program: Program) =>
	Effect.gen(function* () {
		const { tree, out } = freshOf(directory)
		const body = bodyOf(program, library)
		const start = yield* underStrace(out, `${out}/start.trace`, process.execPath, ["-e", ""])
		const starting = new Set(Arr.map(start.reads, (read) => `${read.kind} ${read.path}`))
		const own = new Set(Arr.map(RECORDER_OWN, (file) => `file ${library}/${file}`))
		const traced = yield* underStrace(tree, `${out}/child.trace`, process.execPath, [
			treeWritten(tree, body)
		])
		const tracedReport = yield* reportOf(traced.said)
		const recorded = yield* guardedOf(out, tree, body, library)
		return {
			traced: {
				said: { code: tracedReport.code, said: tracedReport.report.said },
				reads: keyedOf(traced.reads, starting, own)
			},
			recorded: {
				said: { code: recorded.reported.code, said: recorded.reported.report.said },
				reads: keyedOf(recorded.reads, starting, own)
			},
			observed: recorded.observed
		}
	})

/**
 * A program run plain, alone, and as a property starts it, through the checkout's guard under its recorder, beside the
 * empty one (no body) run so too, each in a fresh tree under `directory`: what each run spent (Spent), how many lines the
 * program's record held (each a distinct read or making of its process tree's, and each recorder's start), and whether
 * the guard observed past every key.
 */
export const spentOf = (directory: string, library: CheckoutDir, program: Program) =>
	Effect.gen(function* () {
		const { tree, out } = freshOf(directory)
		const plain = yield* Effect.flatMap(
			ranUnwatched(tree, process.execPath, [treeWritten(tree, bodyOf(program, library))]),
			reportOf
		)
		const recorded = yield* guardedOf(out, tree, bodyOf(program, library), library)
		const recordedEmpty = yield* guardedOf(out, tree, [], library)
		return {
			plain: plain.report.spent,
			recorded: recorded.reported.report.spent,
			recordedEmpty: recordedEmpty.reported.report.spent,
			lines: recorded.lines,
			distinct: recorded.distinct,
			installs: recorded.installs,
			observed: recorded.observed
		}
	})

/**
 * The factor of a plain run's own work a recorded run's may reach: the recorder's work for a read is a set's lookup and,
 * for a read it records, one line and one write(2), at most the work the call it records does (a system call and Node's
 * own code around it), so a program's work recorded is at most twice its work plain, past the recorder's own load on
 * Node's start (what the empty program spends recorded); and it stops at no call, so its voluntary context switches are
 * its own work's (a traced child stops at every file call it makes, and switches at each).
 *
 * @limitKind derived
 * @owner the testing library's recorder (runner/recorder.ts)
 * @unit times a plain run's CPU and voluntary context switches
 * @scope each program of the recorder properties' roster (recorder.fixtures.ts PROGRAMS), plain and recorded, each alone
 * @derivation O(1) in-process work a read and one write a distinct read, no tracer: the program's own file work at most
 *   once again, 2. Context switches vary with the machine's load between two runs of the same work, never with the
 *   reads; measured at load 270 for the testing library's own module graph (lane TRACE, 2026-11-26): 415 to 835 plain,
 *   441 to 755 recorded, 8,720 to 9,051 traced
 */
const recordedAtMost = 2

/**
 * What a program's recorded run spent past its bound (spentOf), none where it kept within it: a line its record holds
 * twice from one recorder (each line is one write(2), so a recorder writes once a distinct read of its own); its CPU and
 * its voluntary context switches past twice its plain run's (recordedAtMost) and what the empty program spends recorded
 * (the recorder's own load on Node's start).
 */
export const exceededOf = (
	spent: Readonly<{
		plain: Spent
		recorded: Spent
		recordedEmpty: Spent
		lines: number
		distinct: number
		installs: number
	}>
): ReadonlyArray<string> => {
	const bound = (name: "cpu" | "switches"): number =>
		recordedAtMost * spent.plain[name] + spent.recordedEmpty[name]
	return Arr.filter(
		[
			spent.lines > spent.distinct * spent.installs
				? `${spent.lines} lines recorded, ${spent.distinct} distinct, by ${spent.installs} recorders`
				: "",
			spent.recorded.cpu > bound("cpu")
				? `${spent.recorded.cpu} ms of CPU recorded past ${bound("cpu")}: ${spent.plain.cpu} plain, ${spent.recordedEmpty.cpu} empty`
				: "",
			spent.recorded.switches > bound("switches")
				? `${spent.recorded.switches} voluntary context switches recorded past ${bound("switches")}: ${spent.plain.switches} plain, ${spent.recordedEmpty.switches} empty`
				: ""
		],
		(exceeded) => exceeded !== ""
	)
}
