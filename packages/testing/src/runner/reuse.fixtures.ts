import { regex } from "arkregex"
import { Array as Arr, Effect, FileSystem, Option, String as Str } from "effect"
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
 * property reads and must find unset; TEST_SEED, set for the second run; or the property reads a fixture file, or starts
 * a child process, at run time, with nothing changed.
 */
const CHANGES = [
	"nothing",
	"a module it imports",
	"a file of the toolchain",
	"a variable its workers are given",
	"a variable its workers are not given",
	"TEST_SEED",
	"it reads a file at run time",
	"it starts a child process"
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

/** Both runs' variables: the given one's and the ungiven one's first values. */
const FIRST: Readonly<Record<string, string>> = { [GIVEN]: "first", [UNGIVEN]: "first" }

/**
 * What a change is: the property's check (what it observes at run time), the files written between the runs (paths
 * from the consumer's root, and their text), and the second run's variables.
 */
type Making = Readonly<{
	check: string
	between: ReadonlyArray<readonly [path: string, text: string]>
	second: Readonly<Record<string, string>>
}>

/** Each change as it is made. */
const MAKINGS: Readonly<Record<Change, Making>> = {
	nothing: { check: PLAIN_CHECK, between: [], second: FIRST },
	"a module it imports": {
		check: PLAIN_CHECK,
		between: [["test/shared.ts", "export const shared = 2\n"]],
		second: FIRST
	},
	"a file of the toolchain": {
		check: PLAIN_CHECK,
		between: [["vendor/testing/src/unloaded.txt", "no module loads this\n"]],
		second: FIRST
	},
	"a variable its workers are given": {
		check: PLAIN_CHECK,
		between: [],
		second: { ...FIRST, [GIVEN]: "second" }
	},
	"a variable its workers are not given": {
		check: PLAIN_CHECK,
		between: [],
		second: { ...FIRST, [UNGIVEN]: "second" }
	},
	TEST_SEED: { check: PLAIN_CHECK, between: [], second: { ...FIRST, TEST_SEED: "7" } },
	"it reads a file at run time": {
		check: `() => (a) => (readFileSync(new URL("./data.txt", import.meta.url), "utf8").length + a >= 0 ? Effect.void : Effect.die("never"))`,
		between: [],
		second: FIRST
	},
	"it starts a child process": {
		check: `() => (a) => (spawnSync("true").status === 0 && a >= 0 ? Effect.void : Effect.die("true failed"))`,
		between: [],
		second: FIRST
	}
}

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
		`import { readFileSync } from "node:fs"\nimport { spawnSync } from "node:child_process"\nimport { Effect } from "effect"\nimport { int } from "@bjornpagen/testing/gen"\nimport { property } from "@bjornpagen/testing/property"\nimport { shared } from "./shared.ts"\n\nexport const reused = property.explore(int(0, 9), {\n\tneeds: {},\n\tsituations: [],\n\tcheck: ${MAKINGS[change].check},\n\toracle: { kind: "specification", name: "never fails" },\n\tkept: [],\n\tkills: []\n})\n`
	]
]

/** How a run went, as the check compares it: whether it passed, and how many properties it answered cached and ran. */
export type Reused = Readonly<{ passed: boolean; cached: number; ran: number }>

/** The summary line a run ends on: `<n> properties: <c> cached, <r> run (...)`. */
const SUMMARY = regex("([0-9]+) properties: ([0-9]+) cached, ([0-9]+) run")

/**
 * `toolchain-test run` in the consumer at `directory`, its cache under `cache`, git looking no higher, its CPU allowance
 * two CPUs (one worker), and the variables `env` names added; how it went (Reused), or none when it printed no summary.
 */
const runIn = (directory: string, cache: string, env: Readonly<Record<string, string>>) =>
	Effect.map(
		ran(
			directory,
			process.execPath,
			["--disable-warning=ExperimentalWarning", "vendor/testing/src/runner/cli-entry.ts", "run"],
			{
				...env,
				XDG_CACHE_HOME: cache,
				GIT_CEILING_DIRECTORIES: Arr.join(Arr.initNonEmpty(Str.split("/")(directory)), "/"),
				TOOLCHAIN_CPU_ALLOWANCE: "2"
			}
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
		const fs = yield* FileSystem.FileSystem
		const consumer = `${directory}/consumer`
		const cache = `${directory}/cache`
		yield* consumerIn(consumer, layout, library, filesOf(change))
		yield* runIn(consumer, cache, FIRST)
		const making = MAKINGS[change]
		yield* Effect.forEach(
			making.between,
			([path, text]) => fs.writeFileString(`${consumer}/${path}`, text),
			{ discard: true }
		)
		return yield* runIn(consumer, cache, making.second)
	})

/**
 * How the second run must go, by the specification: it passes, and answers its one property from the cache exactly
 * when nothing its key holds changed (nothing, or a variable no worker is given) and the property observes nothing past
 * its key; else it runs it.
 */
export const expectedOf = (change: Change): Option.Option<Reused> => {
	const answered = change === "nothing" || change === "a variable its workers are not given"
	return Option.some({ passed: true, cached: answered ? 1 : 0, ran: answered ? 0 : 1 })
}
