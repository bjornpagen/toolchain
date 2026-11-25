import { regex } from "arkregex"
import { Array as Arr, Effect, FileSystem, Option, Record as Rec, String as Str } from "effect"
import { element, finite } from "#gen.ts"
import {
	type ConsumerFiles,
	consumerIn,
	type Layout,
	manifestOf,
	ran
} from "#runner/consumer.fixtures.ts"

/**
 * What the reuse property (reuse.test.ts) runs: a consumer package holding the library as a workspace link, in a git
 * repository with its lockfile, so its verdicts are keyed, whose one property `toolchain-test run` runs twice, one input
 * of its verdict's key changed between the runs, or none, or one input that is no part of it; or whose property observes
 * past its key, which no run answers from the cache.
 */

/**
 * What changes between a case's two runs: nothing; a module the property imports; a file of the toolchain no module
 * imports; the value of a variable the runner config gives its workers; the value of a variable it does not, which the
 * property reads and must find unset; TEST_SEED, set for the second run; nothing, or the file, of a property that reads
 * a fixture file at run time, of one whose child process reads it, of one that resolves a path (realpath, whose own
 * walk of the path is no act of the property's) and of one that reads a symbolic link's text; another checkout of the
 * repository running it second, its property resolving the checkout's own root; and nothing, of a property that reads a
 * file's status, which no key holds.
 */
const CHANGES = [
	"nothing",
	"a module it imports",
	"a file of the toolchain",
	"a variable its workers are given",
	"a variable its workers are not given",
	"TEST_SEED",
	"nothing, a file read at run time",
	"a file it reads at run time",
	"nothing, a file its child process reads",
	"a file its child process reads",
	"nothing, a path resolved at run time",
	"a path it resolves at run time",
	"nothing, a link read at run time",
	"a link it reads at run time",
	"another checkout of it, its root resolved at run time",
	"nothing, a file's status read at run time"
] as const

export type Change = (typeof CHANGES)[number]

/** Every case: each change. */
export const changes = finite((source): Change => source.draw(element(CHANGES)))

/** The consumer's layout: the library linked, in a git repository with its lockfile and TypeScript, so it is keyed. */
const layout: Layout = { library: "link", git: true, lockfile: true, typescript: true }

/** The variable the consumer's runner config gives its workers, and one it does not. */
const GIVEN = "TOOLCHAIN_REUSE_GIVEN"

const UNGIVEN = "TOOLCHAIN_REUSE_UNGIVEN"

/** A check that observes nothing past its key, and finds the variable no worker is given unset. */
const PLAIN_CHECK = `() => (a) => (process.env["${UNGIVEN}"] === undefined && a + shared >= 0 ? Effect.void : Effect.die("a variable no worker is given reached one"))`

/** A check that reads a fixture file at run time, which its trace keys. */
const READS = `() => (a) => (readFileSync(new URL("./data.txt", import.meta.url), "utf8").length + a >= 0 ? Effect.void : Effect.die("never"))`

/** A check whose child process reads a fixture file, which the child's trace keys. */
const CHILD_READS = `() => (a) => (spawnSync("cat", [new URL("./data.txt", import.meta.url).pathname]).status === 0 && a >= 0 ? Effect.void : Effect.die("cat failed"))`

/**
 * A check that resolves `path` (from the property's module) at run time through realpath's callback form, which walks
 * the path with lstat, stat and readlink.
 */
const resolving = (path: string): string =>
	`() => (a) => Effect.asVoid(Effect.promise(() => new Promise((answer) => realpath(new URL("${path}", import.meta.url).pathname, (failure, to) => answer([failure, to, a])))))`

/** A check that resolves the link the link-reading check reads (POINTER). */
const RESOLVES = resolving("./pointer")

/** A check that resolves its checkout's root, which every checkout of the repository resolves alike. */
const RESOLVES_ROOT = resolving("..")

/** A check that reads a symbolic link's text at run time, the link pointing at a file in both runs. */
const READS_LINK = `() => (a) => (readlinkSync(new URL("./pointer", import.meta.url)).length + a >= 0 ? Effect.void : Effect.die("never"))`

/** A check that reads a file's status at run time, which no key holds (its times, its inode). */
const STATUS = `() => (a) => (statSync(new URL("./data.txt", import.meta.url)).size + a >= 0 ? Effect.void : Effect.die("never"))`

/** Both runs' variables: the given one's and the ungiven one's first values. */
const FIRST: Readonly<Record<string, string>> = { [GIVEN]: "first", [UNGIVEN]: "first" }

/** What a case writes in the consumer, by a path from its root: a file's text, or a symbolic link to a target. */
type Write =
	| Readonly<{ kind: "file"; path: string; text: string }>
	| Readonly<{ kind: "link"; path: string; to: string }>

/**
 * What a change is: the property's check (what it observes at run time), what is written before the first run and
 * between the runs, the second run's variables, and the checkout the second run runs in: the first run's, or another
 * of the same repository, written alike.
 */
type Making = Readonly<{
	check: string
	first: ReadonlyArray<Write>
	between: ReadonlyArray<Write>
	second: Readonly<Record<string, string>>
	checkout: "same" | "another"
}>

/** A change whose check is `check`, `between` written between its runs, `second` the second run's variables. */
const making = (
	check: string,
	between: ReadonlyArray<Write>,
	second: Readonly<Record<string, string>>
): Making => ({ check, first: [], between, second, checkout: "same" })

/** The remote every checkout of the consumer names, so its checkouts are one repository's and share its verdicts. */
const REMOTE = "https://consumer.invalid/consumer.git"

/** The link the link-reading check reads, written before its first run. */
const POINTER: Write = { kind: "link", path: "test/pointer", to: "data.txt" }

/** Each change as it is made. */
const MAKINGS: Readonly<Record<Change, Making>> = {
	nothing: making(PLAIN_CHECK, [], FIRST),
	"a module it imports": making(
		PLAIN_CHECK,
		[{ kind: "file", path: "test/shared.ts", text: "export const shared = 2\n" }],
		FIRST
	),
	"a file of the toolchain": making(
		PLAIN_CHECK,
		[{ kind: "file", path: "vendor/testing/src/unloaded.txt", text: "no module loads this\n" }],
		FIRST
	),
	"a variable its workers are given": making(PLAIN_CHECK, [], { ...FIRST, [GIVEN]: "second" }),
	"a variable its workers are not given": making(PLAIN_CHECK, [], {
		...FIRST,
		[UNGIVEN]: "second"
	}),
	TEST_SEED: making(PLAIN_CHECK, [], { ...FIRST, TEST_SEED: "7" }),
	"nothing, a file read at run time": making(READS, [], FIRST),
	"a file it reads at run time": making(
		READS,
		[{ kind: "file", path: "test/data.txt", text: "other data\n" }],
		FIRST
	),
	"nothing, a file its child process reads": making(CHILD_READS, [], FIRST),
	"a file its child process reads": making(
		CHILD_READS,
		[{ kind: "file", path: "test/data.txt", text: "other data\n" }],
		FIRST
	),
	"nothing, a path resolved at run time": { ...making(RESOLVES, [], FIRST), first: [POINTER] },
	"a path it resolves at run time": {
		...making(RESOLVES, [{ kind: "link", path: "test/pointer", to: "shared.ts" }], FIRST),
		first: [POINTER]
	},
	"nothing, a link read at run time": { ...making(READS_LINK, [], FIRST), first: [POINTER] },
	"a link it reads at run time": {
		...making(READS_LINK, [{ kind: "link", path: "test/pointer", to: "shared.ts" }], FIRST),
		first: [POINTER]
	},
	"another checkout of it, its root resolved at run time": {
		...making(RESOLVES_ROOT, [], FIRST),
		checkout: "another"
	},
	"nothing, a file's status read at run time": making(STATUS, [], FIRST)
}

/** Writes `write` in the consumer at `consumer`, a link replacing whatever its path held. */
const written = (consumer: string, write: Write) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = `${consumer}/${write.path}`
		switch (write.kind) {
			case "file":
				return yield* fs.writeFileString(path, write.text)
			case "link":
				yield* fs.remove(path, { force: true })
				return yield* fs.symlink(write.to, path)
		}
	})

/** The consumer's files: its manifest, its runner config giving GIVEN, its one property, the module it imports, a fixture. */
const filesOf = (change: Change): ConsumerFiles => [
	["package.json", manifestOf(layout)],
	[
		"test.config.ts",
		`import { defineRunner, noMutation } from "@bjornpagen/testing/runner"\nimport { Layer } from "effect"\n\nexport default defineRunner({ include: ["test/*.test.ts"], smallStack: [], conditions: [], environment: ["${GIVEN}"], layer: Layer.empty, mutation: noMutation })\n`
	],
	["test/shared.ts", "export const shared = 1\n"],
	["test/data.txt", "data\n"],
	[
		"test/reused.test.ts",
		`import { readFileSync, readlinkSync, realpath, statSync } from "node:fs"\nimport { spawnSync } from "node:child_process"\nimport { Effect } from "effect"\nimport { int } from "@bjornpagen/testing/gen"\nimport { property } from "@bjornpagen/testing/property"\nimport { shared } from "./shared.ts"\n\nexport const reused = property.explore(int(0, 9), {\n\tneeds: {},\n\tsituations: [],\n\tcheck: ${MAKINGS[change].check},\n\toracle: { kind: "specification", name: "never fails" },\n\tkept: [],\n\tkills: []\n})\n`
	]
]

/** How a run went, as the check compares it: whether it passed, and how many properties it answered cached and ran. */
export type Reused = Readonly<{ passed: boolean; cached: number; ran: number }>

/** The summary line a run ends on: `<n> properties: <c> cached, <r> run (...)`. */
const SUMMARY = regex("([0-9]+) properties: ([0-9]+) cached, ([0-9]+) run")

/**
 * `toolchain-test run` in the consumer at `directory`, its cache under `cache`, git looking no higher, its CPU allowance
 * two CPUs (one worker), and the variables `env` names added; how it went (Reused), or none when it printed no summary.
 * It runs as a transient unit of systemd's (`systemd-run --user --wait --pipe`), no descendant of this process, so the
 * guard of the worker that runs this case (runner/observe.ts) traces none of it, and the consumer's own workers trace
 * their children as a lane's do: a process has one tracer.
 */
const runIn = (directory: string, cache: string, env: Readonly<Record<string, string>>) =>
	Effect.map(
		ran(
			directory,
			"systemd-run",
			[
				"--user",
				"--quiet",
				"--wait",
				"--pipe",
				"--collect",
				`--working-directory=${directory}`,
				...Arr.flatMap(
					Rec.toEntries({
						...env,
						XDG_CACHE_HOME: cache,
						GIT_CEILING_DIRECTORIES: Arr.join(Arr.initNonEmpty(Str.split("/")(directory)), "/"),
						TOOLCHAIN_CPU_ALLOWANCE: "2"
					}),
					([name, value]) => ["-E", `${name}=${value}`]
				),
				"--",
				process.execPath,
				"--disable-warning=ExperimentalWarning",
				"vendor/testing/src/runner/cli-entry.ts",
				"run"
			],
			{}
		),
		([exitCode, stdout]): Option.Option<Reused> =>
			Option.map(Option.fromNullishOr(SUMMARY.exec(stdout)), (found) => ({
				passed: exitCode === 0,
				cached: Number(found[2]),
				ran: Number(found[3])
			}))
	)

/**
 * Writes the consumer for `change` into `directory` from the checkout whose testing package is at `library`
 * (Checkout.dir, so a kill's mutant is in it), runs `toolchain-test run` there, makes the change, and runs it again;
 * gives how the second run went.
 */
export const reusedOf = (directory: string, library: string, change: Change) =>
	Effect.gen(function* () {
		const cache = `${directory}/cache`
		const made = MAKINGS[change]
		const checkoutAt = (consumer: string) =>
			Effect.gen(function* () {
				yield* consumerIn(consumer, layout, library, filesOf(change))
				yield* ran(consumer, "git", ["remote", "add", "origin", REMOTE], {})
				yield* Effect.forEach(made.first, (write) => written(consumer, write), { discard: true })
				return consumer
			})
		const first = yield* checkoutAt(`${directory}/consumer`)
		yield* runIn(first, cache, FIRST)
		const second = made.checkout === "same" ? first : yield* checkoutAt(`${directory}/another`)
		yield* Effect.forEach(made.between, (write) => written(second, write), { discard: true })
		return yield* runIn(second, cache, made.second)
	})

/**
 * How the second run must go, by the specification: it passes, and answers its one property from the cache exactly
 * when nothing its key or its trace holds changed (nothing, or a variable no worker is given, a file it or its child
 * reads, a path it resolves or a link it reads unchanged, another checkout of the repository) and the property
 * observes nothing past both (a file's status); else it runs it.
 */
export const expectedOf = (change: Change): Option.Option<Reused> => {
	const answered =
		change === "nothing" ||
		change === "a variable its workers are not given" ||
		change === "nothing, a file read at run time" ||
		change === "nothing, a file its child process reads" ||
		change === "nothing, a path resolved at run time" ||
		change === "nothing, a link read at run time" ||
		change === "another checkout of it, its root resolved at run time"
	return Option.some({ passed: true, cached: answered ? 1 : 0, ran: answered ? 0 : 1 })
}
