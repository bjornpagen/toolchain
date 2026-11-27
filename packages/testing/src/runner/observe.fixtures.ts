import { Array as Arr, Effect, Schema, String as Str } from "effect"
import { element, finite } from "#gen.ts"
import type { CheckoutDir } from "#mutate/checkout.ts"
import { ran } from "#runner/consumer.fixtures.ts"

/**
 * What the guard property (observe.test.ts) runs: one act of a property's code, made in a unit's window of a fresh
 * Node process that installs the checkout's guard (runner/observe.ts) as a worker does, and what the guard made of it.
 */

/**
 * One act: connecting to a socket the run's own server listens at (one the guard was told of) or to another's; reading
 * a file's bytes; probing a path that is not there; resolving a path through realpath's callback form, which walks it
 * with lstat, stat and readlink; reading a symbolic link's text; reading a file's status; reading what the process made
 * itself; or starting a child process that reads a file (cat, which the guard traces under strace once given its reader).
 */
const ACTS = [
	"a connection to the run's own server",
	"a connection to another server",
	"a file's bytes read",
	"a path probed and absent",
	"a path resolved",
	"a link read",
	"a file's status read",
	"its own file read",
	"a child that reads a file"
] as const

export type Act = (typeof ACTS)[number]

/** Every case: each act. */
export const acts = finite((source): Act => source.draw(element(ACTS)))

/**
 * What the guard made of an act: the keyable reads it drained of the case's own directory and of the run's PostgreSQL
 * (a child's reads of the machine's programs and libraries left out), by kind, and whether it told an observation.
 */
type Made = Readonly<{ reads: ReadonlyArray<string>; observed: boolean }>

/** What the program prints: the drained reads (`<kind> <path>`) and whether an observation was told. */
const Printed = Schema.fromJsonString(
	Schema.Struct({ reads: Schema.Array(Schema.String), observed: Schema.Boolean })
)

/** The program's body for `act`, which runs in the open window; `data` a file it reads, `here` a directory of its own. */
const actText = (act: Act): string => {
	switch (act) {
		case "a connection to the run's own server":
			return "await connected(ownSocket)"
		case "a connection to another server":
			return "await connected(otherSocket)"
		case "a file's bytes read":
			return "fs.readFileSync(data)"
		case "a path probed and absent":
			return "fs.existsSync(data + '.absent')"
		case "a path resolved":
			return "await new Promise((resolve) => fs.realpath(data, () => resolve()))"
		case "a link read":
			return "fs.readlinkSync(pointer)"
		case "a file's status read":
			return "fs.statSync(data)"
		case "its own file read":
			return "fs.mkdirSync(here + '/made'); fs.writeFileSync(here + '/made/file', 'x'); fs.readFileSync(here + '/made/file')"
		case "a child that reads a file":
			return "child.spawnSync('cat', [data], { cwd: '/' })"
	}
}

/**
 * The program a case runs: the guard installed first (its own module, from the checkout), its children's reader given
 * it, two socket servers listening outside any window, the run's own one told the guard; then one unit's window, `act`
 * made in it, the reads drained, and what it saw printed as JSON.
 */
const programOf = (checkout: CheckoutDir, act: Act): string => {
	const observe = process
		.getBuiltinModule("node:url")
		.pathToFileURL(`${checkout}/src/runner/observe.ts`).href
	const recorded = process
		.getBuiltinModule("node:url")
		.pathToFileURL(`${checkout}/src/runner/child-record.ts`).href
	return Arr.join(
		[
			`import { guardInstalled, guardWindow, guardDrain, guardServers, guardChildren } from "${observe}"`,
			"let observed = false",
			"guardInstalled(() => { observed = true })",
			`const { childOutcomeOf } = await import("${recorded}")`,
			"guardChildren(childOutcomeOf)",
			'const fs = await import("node:fs")',
			'const net = await import("node:net")',
			'const child = await import("node:child_process")',
			"const here = process.argv[2]",
			"const data = here + '/data.txt'",
			"const pointer = here + '/pointer'",
			"const ownSocket = here + '/own.sock'",
			"const otherSocket = here + '/other.sock'",
			"const listening = (path) => new Promise((resolve) => { const server = net.createServer((socket) => socket.end()); server.listen(path, () => resolve(server)) })",
			"const servers = [await listening(ownSocket), await listening(otherSocket)]",
			"guardServers([ownSocket])",
			"const connected = (path) => new Promise((resolve) => { const socket = net.connect(path, () => { socket.destroy(); resolve() }) })",
			"guardWindow({ kind: 'open', unit: 1 })",
			actText(act),
			"const reads = guardDrain().reads.filter((read) => read.kind === 'postgres' || read.path.startsWith(here)).map((read) => read.kind + ' ' + read.path.replace(here, '<here>'))",
			"guardWindow({ kind: 'closed' })",
			"for (const server of servers) server.close()",
			"console.log(JSON.stringify({ reads, observed }))",
			""
		],
		"\n"
	)
}

/**
 * What the guard of a fresh process made of `act`, made in a unit's window (programOf), a child's reads as the bytes it
 * read (its probes are its program's own way to read them), in a directory of the case's own
 * (`directory`, its data file written there first), the checkout's guard at `checkout` (Checkout.dir, so a kill's
 * mutant is what it loads). The process runs as a transient unit of systemd's, no descendant of the worker that runs the
 * case, whose own guard would trace it, and a process has one tracer.
 */
export const madeOf = (directory: string, checkout: CheckoutDir, act: Act) =>
	Effect.gen(function* () {
		const fs = process.getBuiltinModule("node:fs")
		fs.writeFileSync(`${directory}/data.txt`, "data\n")
		fs.rmSync(`${directory}/pointer`, { force: true })
		fs.symlinkSync("data.txt", `${directory}/pointer`)
		fs.writeFileSync(`${directory}/program.mjs`, programOf(checkout, act))
		const [, stdout, stderr] = yield* ran(
			directory,
			"systemd-run",
			[
				"--user",
				"--quiet",
				"--wait",
				"--pipe",
				"--collect",
				`--working-directory=${directory}`,
				"--",
				process.execPath,
				"--disable-warning=ExperimentalWarning",
				`${directory}/program.mjs`,
				directory
			],
			{}
		)
		const printed = yield* Effect.mapError(
			Schema.decodeEffect(Printed)(Str.trim(stdout)),
			() => `the program printed no report: ${stdout} ${stderr}`
		)
		return {
			reads:
				act === "a child that reads a file"
					? Arr.filter(printed.reads, Str.startsWith("file "))
					: printed.reads,
			observed: printed.observed
		} satisfies Made
	}).pipe(Effect.orDie)

/**
 * What the guard must make of `act`, by the specification: a connection to the run's own server a read of the
 * PostgreSQL that serves it, to another an observation; a file's bytes a read of the file, an absent path's probe a read
 * of its presence, a path's resolution a read of where it resolves to and nothing of realpath's own walk of it, a link's
 * text a read of the link; a file's status an observation, which no key holds; what the process made itself nothing at
 * all; and a child's reads, under strace, reads of what it read (the file among them).
 */
export const expectedOf = (
	act: Act
): Readonly<{ reads: ReadonlyArray<string>; observed: boolean }> => {
	switch (act) {
		case "a connection to the run's own server":
			return { reads: ["postgres "], observed: false }
		case "a connection to another server":
			return { reads: [], observed: true }
		case "a file's bytes read":
			return { reads: ["file <here>/data.txt"], observed: false }
		case "a path probed and absent":
			return { reads: ["presence <here>/data.txt.absent"], observed: false }
		case "a path resolved":
			return { reads: ["resolution <here>/data.txt"], observed: false }
		case "a link read":
			return { reads: ["link <here>/pointer"], observed: false }
		case "a file's status read":
			return { reads: [], observed: true }
		case "its own file read":
			return { reads: [], observed: false }
		case "a child that reads a file":
			return { reads: ["file <here>/data.txt"], observed: false }
	}
}
