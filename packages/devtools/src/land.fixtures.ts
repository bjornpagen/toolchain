import { assert, defined } from "@bjornpagen/testing/assert"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { Array as Arr, Effect, FileSystem, Option, Order, Stream, String as Str } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import {
	committed,
	IDENTITY,
	repository,
	type Sandbox,
	sh,
	toolchainConfig
} from "#gate.fixtures.ts"

/**
 * toolchain-land (bin/land.sh) over real git repositories: the scenarios its properties draw (land.test.ts), the hub
 * and clones a case builds in its own scratch directory, and what their landings and pushes show. Each case runs with
 * the scratch directory as HOME, so the binding's lock (`~/land.lock`, gate.fixtures.ts toolchainConfig) is the case's
 * own, and with no git configuration but its own (gate.fixtures.ts IDENTITY).
 */

/** Where a case's clones push: a local hub, a bare repository by its directory, which a landing guards with its
 * pre-receive hook, or a remote by URL, as GitHub is, which runs no hook of a landing's (the same bare repository by a
 * file:// URL). */
export type Origin = "a local hub" | "a remote"

/** A command's exit status and its output. */
type Ran = Readonly<{ status: number; stdout: string; stderr: string }>

/** The files land.sh and the toolchain's lock holder are in, in the checkout's dev tools. */
const landOf = (sandbox: Sandbox): string =>
	Str.replace("/bin/gate.sh", "/bin/land.sh")(sandbox.gate)

const holdOf = (sandbox: Sandbox): string =>
	Str.replace("/bin/gate.sh", "/../testing/scripts/hold.pl")(sandbox.gate)

/** The lock every clone of a case's repository lands under: its binding's `~/land.lock`, HOME the scratch directory. */
const lockOf = (sandbox: Sandbox): string => `${sandbox.dir}/land.lock`

/** A command's words, from its first. */
type Command = Arr.NonEmptyReadonlyArray<string>

/** Runs a command to completion in a directory as a case's landing or push runs, HOME the scratch directory and
 * `env` beside the case's identity, answering its status and output. */
const ran = Effect.fn("ran")(function* (
	sandbox: Sandbox,
	cwd: string,
	command: Command,
	env: Readonly<Record<string, string>>
) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const [stdout, stderr, status] = yield* Effect.scoped(
		Effect.flatMap(
			spawner.spawn(
				ChildProcess.make(Arr.headNonEmpty(command), Arr.drop(command, 1), {
					cwd,
					stdin: "ignore",
					extendEnv: true,
					env: { ...IDENTITY, ...env, HOME: sandbox.dir, XDG_CACHE_HOME: sandbox.cache }
				})
			),
			(handle) =>
				Effect.all(
					[
						Stream.mkString(Stream.decodeText(handle.stdout)),
						Stream.mkString(Stream.decodeText(handle.stderr)),
						handle.exitCode
					],
					{ concurrency: "unbounded" }
				)
		)
	)
	const done: Ran = { status, stdout, stderr }
	return done
})

/**
 * A case's hub: a bare repository seeded with one commit on main of a repository bound to land on main, whose check
 * (`pnpm check`, the push gate's) passes, and the URL its clones take as origin, by `origin`.
 */
export const hubOf = Effect.fn("hubOf")(function* (sandbox: Sandbox, origin: Origin) {
	const fs = yield* FileSystem.FileSystem
	const seed = yield* repository(sandbox, "seed")
	yield* fs.writeFileString(`${seed}/toolchain.config.ts`, toolchainConfig("main"))
	yield* fs.writeFileString(
		`${seed}/package.json`,
		`{"name":"seed","private":true,"scripts":{"check":"true"}}\n`
	)
	yield* committed(sandbox, seed, "bound to land on main")
	const directory = `${sandbox.dir}/hub.git`
	yield* sh(sandbox, sandbox.dir, "git", "clone", "-q", "--bare", seed, directory)
	return { directory, url: origin === "a local hub" ? directory : `file://${directory}` }
})

/** The pre-push hook a clone runs: the push gate (toolchain-gate push, as lefthook runs it), a repository's own
 * pre-push script that runs the landing's check alone (as grizzle's runs it before its own gate), a hook older than
 * land that checks nothing, or a stand-in gate that runs the landing's check and then records, in `gates`, when it
 * ran and which commit it was given, taking a second to do so. */
export type Hook =
	| "the push gate"
	| "a repository's pre-push script"
	| "a hook older than land"
	| "a stand-in gate"

/** The file a stand-in gate records its runs in, a line each: when it started and ended, in nanoseconds, and the
 * commit it was given. */
const gatesOf = (sandbox: Sandbox): string => `${sandbox.dir}/gates`

const hookText = (sandbox: Sandbox, hook: Hook): string => {
	switch (hook) {
		case "the push gate":
			return `exec sh '${sandbox.gate}' push "$@"`
		case "a repository's pre-push script":
			return `exec sh '${landOf(sandbox)}' pre-push`
		case "a hook older than land":
			return "cat >/dev/null"
		case "a stand-in gate":
			return Arr.join(
				[
					"lines=$(cat)",
					`printf '%s\\n' "$lines" | sh '${landOf(sandbox)}' pre-push || exit $?`,
					"start=$(date +%s%N)",
					"sleep 1",
					`printf '%s %s %s\\n' "$start" "$(date +%s%N)" "$(printf '%s\\n' "$lines" | cut -d' ' -f2)" >>'${gatesOf(sandbox)}'`
				],
				"\n"
			)
	}
}

/** A clone of the hub named `name`, which runs `hook` before each push. */
export const cloneOf = Effect.fn("cloneOf")(function* (
	sandbox: Sandbox,
	url: string,
	name: string,
	hook: Hook
) {
	const fs = yield* FileSystem.FileSystem
	const clone = `${sandbox.dir}/${name}`
	yield* sh(sandbox, sandbox.dir, "git", "clone", "-q", url, clone)
	const file = `${clone}/.git/hooks/pre-push`
	yield* fs.writeFileString(file, `#!/bin/sh\n${hookText(sandbox, hook)}\n`)
	yield* fs.chmod(file, 0o755)
	return clone
})

/** Commits `text` as `file` in a clone, answering the commit. */
export const changed = Effect.fn("changed")(function* (
	sandbox: Sandbox,
	clone: string,
	file: string,
	text: string
) {
	const fs = yield* FileSystem.FileSystem
	yield* fs.writeFileString(`${clone}/${file}`, text)
	yield* committed(sandbox, clone, `${file}: ${Str.trim(text)}`)
	return yield* Effect.map(sh(sandbox, clone, "git", "rev-parse", "HEAD"), Str.trim)
})

/** A landing from a clone: `toolchain-land`, its status and output. */
export const landed = (sandbox: Sandbox, clone: string) =>
	ran(sandbox, clone, ["sh", landOf(sandbox)], {})

/** The commits the hub's `branch` holds, newest first; none when it has no such branch. */
export const hubCommits = Effect.fn("hubCommits")(function* (
	sandbox: Sandbox,
	hub: string,
	branch: string
) {
	const done = yield* ran(
		sandbox,
		sandbox.dir,
		["git", `--git-dir=${hub}`, "rev-list", `refs/heads/${branch}`],
		{}
	)
	return done.status === 0 ? Arr.filter(Str.split("\n")(done.stdout), Str.isNonEmpty) : []
})

/** The merges the hub's main holds: none, for a history every landing kept linear. */
export const hubMerges = (sandbox: Sandbox, hub: string) =>
	Effect.map(
		sh(sandbox, sandbox.dir, "git", `--git-dir=${hub}`, "rev-list", "--merges", "main"),
		(listed) => Arr.filter(Str.split("\n")(listed), Str.isNonEmpty)
	)

/** Whether the hub's main holds `file`. */
export const hubHolds = Effect.fn("hubHolds")(function* (
	sandbox: Sandbox,
	hub: string,
	file: string
) {
	const listed = yield* sh(
		sandbox,
		sandbox.dir,
		"git",
		`--git-dir=${hub}`,
		"ls-tree",
		"--name-only",
		"main",
		file
	)
	return Str.trim(listed) === file
})

/** A clone's standing after a landing it was refused: the commit it holds, and whether it is clean and mid-rebase. */
export const standing = Effect.fn("standing")(function* (sandbox: Sandbox, clone: string) {
	const fs = yield* FileSystem.FileSystem
	const head = yield* Effect.map(sh(sandbox, clone, "git", "rev-parse", "HEAD"), Str.trim)
	const status = yield* sh(sandbox, clone, "git", "status", "--porcelain")
	const rebasing = yield* fs.exists(`${clone}/.git/rebase-merge`)
	return { head, clean: Str.isEmpty(status), rebasing }
})

/** A run of the stand-in gate: when it started and ended, in nanoseconds, and the commit it was given. */
export type GateRun = Readonly<{ start: bigint; end: bigint; commit: string }>

/** The stand-in gate's runs, in the order they started. */
export const gateRuns = Effect.fn("gateRuns")(function* (sandbox: Sandbox) {
	const fs = yield* FileSystem.FileSystem
	const file = gatesOf(sandbox)
	if (!(yield* fs.exists(file))) {
		return []
	}
	const text = yield* fs.readFileString(file)
	const runs = Arr.map(Arr.filter(Str.split("\n")(text), Str.isNonEmpty), (line): GateRun => {
		const [start, end, commit] = Str.split(" ")(line)
		return {
			start: BigInt(start),
			end: BigInt(defined(end, `a gate's run names no end: ${line}`)),
			commit: defined(commit, `a gate's run names no commit: ${line}`)
		}
	})
	return Arr.sort(
		runs,
		Order.mapInput(Order.BigInt, (run: GateRun) => run.start)
	)
})

/** Whether no two runs overlap: each starts after the one before it ended. */
export const inTurn = (runs: ReadonlyArray<GateRun>): boolean =>
	Arr.every(Arr.zip(runs, Arr.drop(runs, 1)), ([before, after]) => after.start >= before.end)

/** A landing scenario: how many clones land at once, and whether two of them change the same line. */
export type Landing =
	| "one clone"
	| "two clones"
	| "three clones"
	| "two clones whose commits conflict"

const LANDINGS = [
	"one clone",
	"two clones",
	"three clones",
	"two clones whose commits conflict"
] as const

/** A landing scenario and the origin its clones push to. */
export type Landings = Readonly<{ landing: Landing; origin: Origin }>

const ORIGINS = ["a local hub", "a remote"] as const

/** Every landing scenario at each origin: eight. */
export const landingsGen: Gen<Landings> = (source) => ({
	landing: source.draw(element(LANDINGS)),
	origin: source.draw(element(ORIGINS))
})

/** How many clones a scenario lands from. */
export const clonesIn = (landing: Landing): number => {
	switch (landing) {
		case "one clone":
			return 1
		case "two clones":
		case "two clones whose commits conflict":
			return 2
		case "three clones":
			return 3
	}
}

/** Whether a scenario's clones change the same line, so the landing that comes second conflicts. */
export const conflicting = (landing: Landing): boolean =>
	landing === "two clones whose commits conflict"

/** What clone `at` of a scenario commits: a file of its own, or, where the scenario conflicts, its own text of the
 * readme every clone holds. */
export const changeOf = (landing: Landing, at: number): readonly [file: string, text: string] =>
	conflicting(landing)
		? ["README.txt", `clone ${String(at)}\n`]
		: [`c${String(at)}.txt`, `clone ${String(at)}\n`]

/** The situations a landing scenario is in. */
export type LandingFeature =
	| "a clone lands alone"
	| "two clones land at once"
	| "three clones land at once"
	| "the second of two landings conflicts"
	| "a landing on a local hub"
	| "a landing on a remote"

const LANDING_FEATURES: Readonly<Record<Landing, LandingFeature>> = {
	"one clone": "a clone lands alone",
	"two clones": "two clones land at once",
	"three clones": "three clones land at once",
	"two clones whose commits conflict": "the second of two landings conflicts"
}

export const landingFeatures = (landings: Landings): ReadonlyArray<LandingFeature> => [
	LANDING_FEATURES[landings.landing],
	landings.origin === "a local hub" ? "a landing on a local hub" : "a landing on a remote"
]

/** What checks a push to the trunk: the push gate, a repository's own pre-push script, or a local hub's pre-receive
 * hook behind a clone whose hook is older than land. */
export type Checker = "the push gate" | "a repository's pre-push script" | "a local hub"

/** How a push is made: plainly; naming as its holder a process that holds the lock but that it does not descend
 * from (another clone's landing); naming as its holder its own git push, which holds no lock; or by a landing. */
export type Way =
	| "a plain push"
	| "a push naming a holder it does not descend from"
	| "a push naming itself, which holds no lock"
	| "a landing"

/** The branch a push updates: the trunk or another. */
export type Target = "the trunk" | "another branch"

/** A push: what checks it, how it is made and what it updates; a landing updates the trunk alone. */
export type Pushing = Readonly<{ checker: Checker; way: Way; target: Target }>

const CHECKERS = ["the push gate", "a repository's pre-push script", "a local hub"] as const

const PUSH_WAYS = [
	"a plain push",
	"a push naming a holder it does not descend from",
	"a push naming itself, which holds no lock"
] as const

const TARGETS = ["the trunk", "another branch"] as const

/** Every push: each checker, each way of pushing at each target, and a landing; twenty-one. */
export const pushings: Gen<Pushing> = (source) => {
	const checker = source.draw(element(CHECKERS))
	const landing = source.draw(element([false, true] as const))
	if (landing) {
		return { checker, way: "a landing", target: "the trunk" }
	}
	return { checker, way: source.draw(element(PUSH_WAYS)), target: source.draw(element(TARGETS)) }
}

/** Whether a push is taken, by the landing's contract: a landing's, or one of another branch than the trunk. */
export const taken = (pushing: Pushing): boolean =>
	pushing.way === "a landing" || pushing.target === "another branch"

/** What a checker says when it refuses a push to the trunk. */
export const refusalOf = (checker: Checker): string =>
	checker === "a local hub" ? "main moves only by pnpm land" : "land on main with pnpm land"

/** The situations a push is in. */
export type PushingFeature =
	| "the push gate checks a push"
	| "a repository's pre-push script checks a push"
	| "a local hub checks a push"
	| "a plain push"
	| "a push naming a holder it does not descend from"
	| "a push naming itself, which holds no lock"
	| "a landing"
	| "a push to the trunk"
	| "a push to another branch"

const CHECKER_FEATURES: Readonly<Record<Checker, PushingFeature>> = {
	"the push gate": "the push gate checks a push",
	"a repository's pre-push script": "a repository's pre-push script checks a push",
	"a local hub": "a local hub checks a push"
}

export const pushingFeatures = (pushing: Pushing): ReadonlyArray<PushingFeature> => [
	CHECKER_FEATURES[pushing.checker],
	pushing.way,
	pushing.target === "the trunk" ? "a push to the trunk" : "a push to another branch"
]

/** The hook a checker's clone runs, and the origin it pushes to. */
const setupOf = (checker: Checker): readonly [Hook, Origin] => {
	switch (checker) {
		case "the push gate":
			return ["the push gate", "a remote"]
		case "a repository's pre-push script":
			return ["a repository's pre-push script", "a remote"]
		case "a local hub":
			return ["a hook older than land", "a local hub"]
	}
}

/**
 * The hub and a clone ready to push as `pushing` draws: behind a local hub, a first landing from another clone has
 * installed the hub's hook; elsewhere the lock's file exists, as any landing leaves it. The clone has committed a
 * change of its own. Answers the hub's directory, the clone, and the commits the hub's main held before.
 */
export const readyToPush = Effect.fn("readyToPush")(function* (sandbox: Sandbox, checker: Checker) {
	const fs = yield* FileSystem.FileSystem
	const [hook, origin] = setupOf(checker)
	const hub = yield* hubOf(sandbox, origin)
	if (checker === "a local hub") {
		const first = yield* cloneOf(sandbox, hub.url, "first", hook)
		yield* changed(sandbox, first, "first.txt", "first\n")
		const done = yield* landed(sandbox, first)
		assert.deepEqual(done.status, 0, `the first landing failed: ${done.stderr}`)
	} else {
		yield* fs.writeFileString(lockOf(sandbox), "")
	}
	const clone = yield* cloneOf(sandbox, hub.url, "pusher", hook)
	yield* changed(sandbox, clone, "pushed.txt", "pushed\n")
	const before = yield* hubCommits(sandbox, hub.directory, "main")
	return { hub: hub.directory, clone, before }
})

/** The ref a target names. */
const refOf = (target: Target): string => (target === "the trunk" ? "main" : "elsewhere")

/** The branch of the hub a push updates. */
export const branchOf = (pushing: Pushing): string => refOf(pushing.target)

/**
 * A push from `clone` made as `pushing` draws: its status and output. A holder it does not descend from is a process
 * of the toolchain's holder (hold.pl) that holds the lock until the case's scope closes, as a landing in another clone
 * would.
 */
export const pushedThrough = Effect.fn("pushedThrough")(function* (
	sandbox: Sandbox,
	clone: string,
	pushing: Pushing
) {
	const push = ["git", "push", "-q", "origin", `HEAD:refs/heads/${refOf(pushing.target)}`] as const
	switch (pushing.way) {
		case "a plain push":
			return yield* ran(sandbox, clone, push, {})
		case "a push naming itself, which holds no lock":
			return yield* ran(
				sandbox,
				clone,
				["sh", "-c", `export TOOLCHAIN_LAND_HOLDER=$$; exec ${Arr.join(push, " ")}`],
				{}
			)
		case "a push naming a holder it does not descend from": {
			const holder = yield* heldElsewhere(sandbox)
			return yield* ran(sandbox, clone, push, { TOOLCHAIN_LAND_HOLDER: holder })
		}
		case "a landing":
			return yield* landed(sandbox, clone)
	}
})

/** A process that holds the lock, exclusive, as a landing's first shell does, until the case's scope closes: the
 * toolchain's holder, which says `held` and holds until its input ends. Answers its pid. */
const heldElsewhere = Effect.fn("heldElsewhere")(function* (sandbox: Sandbox) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const handle = yield* spawner.spawn(
		ChildProcess.make("perl", [holdOf(sandbox), "wait", "exclusive", "1", lockOf(sandbox)], {
			cwd: sandbox.dir,
			stdin: { stream: Stream.never },
			extendEnv: true,
			env: IDENTITY
		})
	)
	const said = yield* Stream.runHead(Stream.decodeText(handle.stdout))
	assert.deepEqual(
		Option.map(said, Str.trim),
		Option.some("held"),
		"the holder never held the lock"
	)
	return String(handle.pid)
})
