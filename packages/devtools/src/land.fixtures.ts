import { assert, defined } from "@bjornpagen/testing/assert"
import type { CheckoutDir } from "@bjornpagen/testing/checkout"
import { element, type Gen } from "@bjornpagen/testing/gen"
import { type Need, NeedFailed } from "@bjornpagen/testing/property"
import {
	Array as Arr,
	Deferred,
	Effect,
	Fiber,
	FileSystem,
	Option,
	Path,
	type PlatformError,
	Ref,
	Stream,
	String as Str
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/**
 * toolchain-land (bin/land.sh) over real repositories: a bare hub, as each repository's hub on this machine is, and jj
 * workspaces colocated with git clones of it, its remote named `hub`, as every lane is, in a case's own scratch
 * directory; the scenarios the landing property draws (land.test.ts) and what their landings show. Each landing runs
 * with the scratch directory as HOME and a jj configuration of the case's own (an identity, nothing of the machine's).
 * The hub's typecheck (package.json's `types`, the thin gate's) is the probe: it records the tree each landing's gate
 * checked, and holds a gate whose landing names a FIFO that is still there. Each lane's formatter
 * (node_modules/.bin/oxfmt, which jj fix runs) is a stand-in that strips the spaces ending each line, so what a landing
 * pushed shows whether it ran.
 */

/** The environment every command of a case runs with: a git identity, local file transport for submodules, and no
 * global or system git configuration. */
const IDENTITY: Readonly<Record<string, string>> = Object.freeze({
	GIT_AUTHOR_NAME: "land-test",
	GIT_AUTHOR_EMAIL: "land-test@localhost",
	GIT_COMMITTER_NAME: "land-test",
	GIT_COMMITTER_EMAIL: "land-test@localhost",
	GIT_ALLOW_PROTOCOL: "file",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1"
})

/** A case's sandbox, in its scratch directory: the directory its repositories and lanes are made in, its cache
 * (XDG_CACHE_HOME, so pnpm's metadata cache is the case's), the landing it runs (the checkout's bin/land.sh, so a mutant
 * of it in a worker tree is the landing the case runs), and the lockfile its repositories commit. */
export type Sandbox = Readonly<{ dir: string; cache: string; land: string; lockfile: string }>

/** The sandbox in a case's scratch directory, running the landing of the dev tools' directory in the checkout. */
export const sandboxOf = (dir: string, checkout: CheckoutDir, lockfile: string): Sandbox => ({
	dir,
	cache: `${dir}/xdg`,
	land: `${checkout}/bin/land.sh`,
	lockfile
})

/** The files of a pnpm workspace with no package of its own, as every scenario's repository holds them. */
const WORKSPACE: ReadonlyArray<readonly [path: string, text: string]> = [
	[".gitignore", "node_modules\nout\n"],
	["pnpm-workspace.yaml", "packages: []\n"]
]

/**
 * The CPU, in milliseconds, the lockfile's open may spend (property.ts Need): a test's own input, a minute, far past
 * what one pnpm install of an empty workspace's lockfile spends.
 */
const lockfileBudget = 60_000

/**
 * The lockfile of an empty pnpm workspace, which pnpm writes once a worker: every scenario's repository commits this
 * text, so a case runs no pnpm of its own beside its landings' installs. Its importers name no package, so it fits every
 * repository whatever its name.
 */
export const workspaceLockfile: Need<string> = {
	key: "bjornpagen.devtools.land.workspace-lockfile",
	budget: lockfileBudget,
	runNeeds: [],
	open: Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const directory = yield* fs.makeTempDirectoryScoped({ prefix: "land-lockfile-" })
			yield* Effect.forEach(
				[...WORKSPACE, ["package.json", `{"name":"workspace","private":true}\n`] as const],
				([path, text]) => fs.writeFileString(`${directory}/${path}`, text),
				{ discard: true }
			)
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
			const status = yield* Effect.scoped(
				Effect.flatMap(
					spawner.spawn(
						ChildProcess.make("pnpm", ["install", "--lockfile-only", "--reporter=silent"], {
							cwd: directory,
							stdin: "ignore"
						})
					),
					(handle) => handle.exitCode
				)
			)
			if (status !== 0) {
				return yield* NeedFailed.make({
					need: "workspaceLockfile",
					message: `pnpm install --lockfile-only exited ${String(status)}`
				})
			}
			return yield* fs.readFileString(`${directory}/pnpm-lock.yaml`)
		})
	).pipe(
		Effect.map((text) => Effect.succeed(text)),
		Effect.catchTags({
			PlatformError: (cause) =>
				NeedFailed.make({ need: "workspaceLockfile", message: String(cause) })
		})
	)
}

/** A command's exit status and its output. */
type Ran = Readonly<{ status: number; stdout: string; stderr: string }>

/** Runs a command to completion in a directory, with the sandbox's cache and `env` beside the case's identity, answering
 * its status and output. */
const ranWith = Effect.fn("ranWith")(function* (
	sandbox: Sandbox,
	cwd: string,
	command: Arr.NonEmptyReadonlyArray<string>,
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
					env: { ...IDENTITY, XDG_CACHE_HOME: sandbox.cache, ...env }
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

/** Runs a command to completion in a directory, with the sandbox's cache, answering its status and output. */
const ran = (sandbox: Sandbox, cwd: string, command: string, args: ReadonlyArray<string>) =>
	ranWith(sandbox, cwd, [command, ...args], {})

/** Runs a command that must succeed, answering its output. */
const sh = Effect.fn("sh")(function* (
	sandbox: Sandbox,
	cwd: string,
	command: string,
	...args: ReadonlyArray<string>
) {
	const done = yield* ran(sandbox, cwd, command, args)
	assert.deepEqual(
		done.status,
		0,
		`${command} ${Arr.join(args, " ")} exited ${String(done.status)} in ${cwd}: ${done.stderr}`
	)
	return done.stdout
})

/** Stages every change of a working tree and commits it. */
const committed = (sandbox: Sandbox, directory: string, message: string) =>
	sh(sandbox, directory, "git", "add", "-A").pipe(
		Effect.andThen(sh(sandbox, directory, "git", "commit", "-qm", message))
	)

/**
 * A repository of the files every scenario's has, committed on main: a workspace and its lockfile, node_modules under
 * .gitignore, and a readme naming it.
 */
const repository = Effect.fn("repository")(function* (sandbox: Sandbox, name: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const directory = path.join(sandbox.dir, name)
	yield* fs.makeDirectory(directory)
	yield* sh(sandbox, directory, "git", "init", "-q", "-b", "main")
	yield* Effect.forEach(
		[
			...WORKSPACE,
			["package.json", `{"name":"${name}","private":true}\n`] as const,
			["pnpm-lock.yaml", sandbox.lockfile] as const,
			["README.txt", `${name}\n`] as const
		],
		([file, text]) => fs.writeFileString(path.join(directory, file), text),
		{ discard: true }
	)
	yield* committed(sandbox, directory, name)
	return directory
})

/**
 * A command started in the background, whose standard error is watched for lines: `seen` waits for the first line that
 * starts with any of `prefixes` (each one it was started to watch for) and answers it, failing the case when the command
 * ends first, and `ended` waits for its end, answering its status and output.
 */
type Started = Readonly<{
	seen: (
		prefixes: Arr.NonEmptyReadonlyArray<string>
	) => Effect.Effect<string, PlatformError.PlatformError>
	ended: Effect.Effect<Ran, PlatformError.PlatformError>
}>

/**
 * Starts a command in a directory with the sandbox's cache, `input` on its standard input and `env` beside the case's
 * identity, watching its standard error for lines that start with each of `watched`; it is stopped, with whatever it
 * started outside a unit, when the case's scope closes.
 */
const startedWith = Effect.fn("startedWith")(function* (
	sandbox: Sandbox,
	cwd: string,
	command: Arr.NonEmptyReadonlyArray<string>,
	input: string,
	env: Readonly<Record<string, string>>,
	watched: ReadonlyArray<string>
) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const handle = yield* spawner.spawn(
		ChildProcess.make(Arr.headNonEmpty(command), Arr.drop(command, 1), {
			cwd,
			stdin: { stream: Stream.make(new TextEncoder().encode(input)) },
			extendEnv: true,
			env: { ...IDENTITY, XDG_CACHE_HOME: sandbox.cache, ...env }
		})
	)
	const lines = yield* Effect.forEach(watched, (prefix) =>
		Effect.map(Deferred.make<string>(), (line) => [prefix, line] as const)
	)
	const said = yield* Ref.make("")
	const stderr = yield* Effect.forkScoped(
		Stream.runForEach(Stream.splitLines(Stream.decodeText(handle.stderr)), (line) =>
			Effect.andThen(
				Ref.update(said, (text) => `${text}${line}\n`),
				Effect.forEach(
					lines,
					([prefix, deferred]) =>
						Str.startsWith(prefix)(line) ? Deferred.succeed(deferred, line) : Effect.void,
					{ discard: true }
				)
			)
		)
	)
	const stdout = yield* Effect.forkScoped(Stream.mkString(Stream.decodeText(handle.stdout)))
	const status = yield* Effect.forkScoped(handle.exitCode)
	const ended = Effect.gen(function* () {
		const code = yield* Fiber.join(status)
		yield* Fiber.join(stderr)
		const done: Ran = {
			status: Number(code),
			stdout: yield* Fiber.join(stdout),
			stderr: yield* Ref.get(said)
		}
		return done
	})
	const seen = (prefixes: Arr.NonEmptyReadonlyArray<string>) =>
		Effect.raceFirst(
			Effect.raceAll(
				Arr.map(prefixes, (prefix) =>
					Option.match(
						Arr.findFirst(lines, ([watching]) => watching === prefix),
						{
							onNone: () => Effect.sync(() => assert.fail(`no line starting ${prefix} is watched`)),
							onSome: ([, deferred]) => Deferred.await(deferred)
						}
					)
				)
			),
			Effect.flatMap(ended, (done) =>
				Effect.sync(() =>
					assert.fail(
						`${Arr.join(command, " ")} exited ${String(done.status)} before it said any of ${Arr.join(prefixes, ", ")}: ${done.stderr}`
					)
				)
			)
		)
	const running: Started = { seen, ended }
	return running
})

/** A FIFO named `name` in the case's scratch directory. */
const fifo = Effect.fn("fifo")(function* (sandbox: Sandbox, name: string) {
	const path = `${sandbox.dir}/${name}`
	yield* sh(sandbox, sandbox.dir, "mkfifo", path)
	return path
})

/** The jj configuration a case's workspaces run with: an identity, which jj needs to rewrite and push commits, and the
 * account's fixer (the workbench's jj part, which runs the workspace's node_modules/.bin/oxfmt), here over the scenario's
 * text files, which are what its lanes change. */
const JJ_CONFIG = Arr.join(
	[
		"[user]",
		'name = "land-test"',
		'email = "land-test@localhost"',
		"[fix.tools.oxfmt]",
		'command = ["node_modules/.bin/oxfmt", "--stdin-filepath=$path"]',
		`patterns = ['glob:"**/*.txt"']`,
		""
	],
	"\n"
)

/** The file a case's jj configuration is in. */
const jjConfigOf = (sandbox: Sandbox): string => `${sandbox.dir}/jj.toml`

/** The file the probe records each gated tree in, a line each. */
const gatesOf = (sandbox: Sandbox): string => `${sandbox.dir}/gates`

/** The probe, the hub's typecheck: it records the tree the gate checks, then, when its landing names in GATE_HOLD a
 * FIFO that is still there, says so and waits on it. */
const probeOf = (sandbox: Sandbox): string => `${sandbox.dir}/probe.sh`

/** What the probe says once it holds a gate. */
const PAUSED = "paused"

/** The environment of every landing and jj command of a case: HOME its scratch directory, its own jj configuration,
 * and the probe as the hub's check. */
const envOf = (sandbox: Sandbox): Readonly<Record<string, string>> => ({
	HOME: sandbox.dir,
	JJ_CONFIG: jjConfigOf(sandbox),
	GATE_PROBE: probeOf(sandbox)
})

/** Runs a command that must succeed in a case's environment, answering its output. */
const jjDone = Effect.fn("jjDone")(function* (
	sandbox: Sandbox,
	cwd: string,
	command: Arr.NonEmptyReadonlyArray<string>
) {
	const done = yield* ranWith(sandbox, cwd, command, envOf(sandbox))
	assert.deepEqual(
		done.status,
		0,
		`${Arr.join(command, " ")} exited ${String(done.status)} in ${cwd}: ${done.stderr}`
	)
	return done.stdout
})

/**
 * A case's hub: a bare repository seeded with a repository whose typecheck (`types`) is the probe, stating `trunk` as its
 * trunk branch (git config trunk.branch, as the workbench's trunk part writes it), or none; the probe and the case's jj
 * configuration are written beside it. A staging trunk is a branch of its own, behind main by a commit of production's
 * that staging lacks, as edullm's main is production and its trunk staging.
 */
const hubOf = Effect.fn("hubOf")(function* (sandbox: Sandbox, trunk: Trunk) {
	const fs = yield* FileSystem.FileSystem
	yield* fs.writeFileString(jjConfigOf(sandbox), JJ_CONFIG)
	yield* fs.writeFileString(
		probeOf(sandbox),
		Arr.join(
			[
				`git rev-parse 'HEAD^{tree}' >>'${gatesOf(sandbox)}'`,
				`if [ -n "\${GATE_HOLD:-}" ] && [ -p "$GATE_HOLD" ]; then`,
				`	echo ${PAUSED} >&2`,
				'	read _ <"$GATE_HOLD"',
				"fi",
				""
			],
			"\n"
		)
	)
	const seed = yield* repository(sandbox, "seed")
	yield* fs.writeFileString(
		`${seed}/package.json`,
		`{"name":"seed","private":true,"scripts":{"types":"sh \\"$GATE_PROBE\\""}}\n`
	)
	yield* committed(sandbox, seed, "a probed typecheck")
	if (trunk === "staging") {
		yield* sh(sandbox, seed, "git", "branch", "staging")
		yield* fs.writeFileString(`${seed}/production.txt`, "production\n")
		yield* committed(sandbox, seed, "production, which staging has not reached")
	}
	const hub = `${sandbox.dir}/hub.git`
	yield* sh(sandbox, sandbox.dir, "git", "clone", "-q", "--bare", seed, hub)
	if (trunk !== "none") {
		yield* sh(sandbox, sandbox.dir, "git", `--git-dir=${hub}`, "config", "trunk.branch", trunk)
	}
	return hub
})

/** The stand-in formatter every lane runs as jj fix's oxfmt: it strips the spaces that end each line. */
const FORMATTER = '#!/bin/sh\nexec sed "s/[[:space:]]*$//"\n'

/**
 * A lane of the hub named `name`: a jj workspace colocated with a git clone, as `jj git clone --colocate` makes, its
 * remote renamed `hub`, its working copy on `branch`, the trunk, as a lane starts (`jj workspace add -r <trunk>@hub`),
 * with the stand-in formatter installed where the repository's oxfmt is.
 */
const laneOf = Effect.fn("laneOf")(function* (
	sandbox: Sandbox,
	hub: string,
	name: string,
	branch: string
) {
	const fs = yield* FileSystem.FileSystem
	const lane = `${sandbox.dir}/${name}`
	yield* jjDone(sandbox, sandbox.dir, ["jj", "git", "clone", "--colocate", hub, lane])
	yield* jjDone(sandbox, lane, ["jj", "git", "remote", "rename", "origin", "hub"])
	yield* jjDone(sandbox, lane, ["jj", "new", `${branch}@hub`])
	yield* fs.makeDirectory(`${lane}/node_modules/.bin`, { recursive: true })
	yield* fs.writeFileString(`${lane}/node_modules/.bin/oxfmt`, FORMATTER)
	yield* fs.chmod(`${lane}/node_modules/.bin/oxfmt`, 0o755)
	return lane
})

/** A lane's finished commit of `text` as `file`: written, then `jj commit`, so @- holds it and @ is empty; its message
 * names its lane, as every commit's does. */
const finished = Effect.fn("finished")(function* (
	sandbox: Sandbox,
	lane: string,
	file: string,
	text: string
) {
	const fs = yield* FileSystem.FileSystem
	yield* fs.writeFileString(`${lane}/${file}`, text)
	yield* jjDone(sandbox, lane, [
		"jj",
		"commit",
		"-m",
		`${file}: ${Str.trim(text)}\n\nLane: ${Str.slice(sandbox.dir.length + 1)(lane)}`
	])
})

/** The landing command, `pnpm land`'s, from the checkout's dev tools. */
const landOf = (sandbox: Sandbox): string => sandbox.land

/** A landing from a lane, `toolchain-land`, to its end: its status and output. */
const landed = (sandbox: Sandbox, lane: string) =>
	ranWith(sandbox, lane, ["sh", landOf(sandbox)], envOf(sandbox))

/** The commits the hub's main holds, newest first. */
const hubCommits = Effect.fn("hubCommits")(function* (
	sandbox: Sandbox,
	hub: string,
	branch: string
) {
	const listed = yield* sh(sandbox, sandbox.dir, "git", `--git-dir=${hub}`, "rev-list", branch)
	return Arr.filter(Str.split("\n")(listed), Str.isNonEmpty)
})

/** The merges the hub's main holds: none, for a history every landing kept linear. */
const hubMerges = Effect.fn("hubMerges")(function* (sandbox: Sandbox, hub: string, branch: string) {
	const listed = yield* sh(
		sandbox,
		sandbox.dir,
		"git",
		`--git-dir=${hub}`,
		"rev-list",
		"--merges",
		branch
	)
	return Arr.filter(Str.split("\n")(listed), Str.isNonEmpty)
})

/** The tree of a commit the hub holds. */
const treeIn = Effect.fn("treeIn")(function* (sandbox: Sandbox, hub: string, commit: string) {
	return yield* Effect.map(
		sh(sandbox, sandbox.dir, "git", `--git-dir=${hub}`, "rev-parse", `${commit}^{tree}`),
		Str.trim
	)
})

/** The text of `file` on the hub's main; none when main does not hold it. */
const hubText = Effect.fn("hubText")(function* (
	sandbox: Sandbox,
	hub: string,
	branch: string,
	file: string
) {
	const done = yield* ranWith(
		sandbox,
		sandbox.dir,
		["git", `--git-dir=${hub}`, "show", `${branch}:${file}`],
		{}
	)
	return done.status === 0 ? done.stdout : ""
})

/** The trees the gate checked, in the order its checks began. */
const gatedTrees = Effect.fn("gatedTrees")(function* (sandbox: Sandbox) {
	const fs = yield* FileSystem.FileSystem
	const file = gatesOf(sandbox)
	if (!(yield* fs.exists(file))) {
		return []
	}
	const text = yield* fs.readFileString(file)
	return Arr.filter(Str.split("\n")(text), Str.isNonEmpty)
})

/**
 * A landing scenario: lanes landing at once (one, two or three, each with a file of its own); a lane whose commit
 * conflicts with one landed before it (the two change one line of the readme); or a lane whose trunk moves while it is
 * gated (another lane lands while the first's gate is held), so the first's push is refused and it lands again.
 */
export type Landing =
	| "one lane"
	| "two lanes at once"
	| "three lanes at once"
	| "a lane whose commit conflicts with one landed before it"
	| "a lane whose trunk moves while it is gated"
	| "a lane whose hub's trunk is staging"
	| "a lane whose hub states no trunk"

const LANDINGS = [
	"one lane",
	"two lanes at once",
	"three lanes at once",
	"a lane whose commit conflicts with one landed before it",
	"a lane whose trunk moves while it is gated",
	"a lane whose hub's trunk is staging",
	"a lane whose hub states no trunk"
] as const

/** Every landing scenario: seven. */
export const landings: Gen<Landing> = (source) => source.draw(element(LANDINGS))

/** The situations a landing scenario is in. */
export type LandingFeature =
	| "a lane lands alone"
	| "two lanes land at once"
	| "three lanes land at once"
	| "a landing whose commit conflicts is refused"
	| "a landing whose push is refused lands again"
	| "a landing pushes the hub's trunk when it is not main, and main stays"
	| "a hub that states no trunk refuses the landing"

const LANDING_FEATURES: Readonly<Record<Landing, LandingFeature>> = {
	"one lane": "a lane lands alone",
	"two lanes at once": "two lanes land at once",
	"three lanes at once": "three lanes land at once",
	"a lane whose commit conflicts with one landed before it":
		"a landing whose commit conflicts is refused",
	"a lane whose trunk moves while it is gated": "a landing whose push is refused lands again",
	"a lane whose hub's trunk is staging":
		"a landing pushes the hub's trunk when it is not main, and main stays",
	"a lane whose hub states no trunk": "a hub that states no trunk refuses the landing"
}

/** The trunk a hub states (git config trunk.branch): main, staging (edullm's), or none. */
export type Trunk = "main" | "staging" | "none"

/** The trunk a scenario's hub states. */
export const trunkOf = (landing: Landing): Trunk => {
	switch (landing) {
		case "a lane whose hub's trunk is staging":
			return "staging"
		case "a lane whose hub states no trunk":
			return "none"
		case "one lane":
		case "two lanes at once":
		case "three lanes at once":
		case "a lane whose commit conflicts with one landed before it":
		case "a lane whose trunk moves while it is gated":
			return "main"
	}
}

/** The branch a scenario's landings are judged on: its hub's trunk, or main where it states none. */
const branchOf = (trunk: Trunk): string => (trunk === "none" ? "main" : trunk)

export const landingFeatures = (landing: Landing): ReadonlyArray<LandingFeature> => [
	LANDING_FEATURES[landing]
]

/** How many lanes a scenario lands from. */
const lanesIn = (landing: Landing): number => {
	switch (landing) {
		case "one lane":
		case "a lane whose hub's trunk is staging":
		case "a lane whose hub states no trunk":
			return 1
		case "two lanes at once":
		case "a lane whose commit conflicts with one landed before it":
		case "a lane whose trunk moves while it is gated":
			return 2
		case "three lanes at once":
			return 3
	}
}

/** Whether a scenario's lanes change one line, so the lane that lands second conflicts. */
export const conflicting = (landing: Landing): boolean =>
	landing === "a lane whose commit conflicts with one landed before it"

/** What lane `at` of a scenario commits: a file of its own, or, where the scenario conflicts, its own text of the
 * readme every lane holds; each line ends in spaces, which the lane's formatter strips. */
const changeOf = (landing: Landing, at: number): readonly [file: string, text: string] => [
	conflicting(landing) ? "README.txt" : `l${String(at)}.txt`,
	`lane ${String(at)}   \n`
]

/** The text a lane's change lands as, by the landing's contract: as its formatter writes it, each line's ending spaces
 * gone. */
export const fixedText = (at: number): string => `lane ${String(at)}\n`

/** Lands every lane of a scenario as it draws them: at once; the second after the first; or the first held in its gate
 * while the second lands, then let go. Answers each landing's status and output, in the lanes' order. */
const landedAs = Effect.fn("landedAs")(function* (
	sandbox: Sandbox,
	landing: Landing,
	lanes: ReadonlyArray<string>
) {
	switch (landing) {
		case "one lane":
		case "two lanes at once":
		case "three lanes at once":
		case "a lane whose hub's trunk is staging":
		case "a lane whose hub states no trunk":
			return yield* Effect.forEach(lanes, (lane) => landed(sandbox, lane), {
				concurrency: "unbounded"
			})
		case "a lane whose commit conflicts with one landed before it":
			return yield* Effect.forEach(lanes, (lane) => landed(sandbox, lane))
		case "a lane whose trunk moves while it is gated": {
			const [first, second] = lanes
			const hold = yield* fifo(sandbox, "hold")
			const held = yield* startedWith(
				sandbox,
				defined(first, "the scenario's first lane"),
				["sh", landOf(sandbox)],
				"",
				{ ...envOf(sandbox), GATE_HOLD: hold },
				[PAUSED]
			)
			yield* held.seen([PAUSED])
			const other = yield* landed(sandbox, defined(second, "the scenario's second lane"))
			yield* sh(
				sandbox,
				sandbox.dir,
				"sh",
				"-c",
				'exec 3>"$1"; rm -f -- "$1"; echo go >&3',
				"sh",
				hold
			)
			const done: Ran = yield* held.ended
			return [done, other]
		}
	}
})

/**
 * A landing scenario, built and landed: a hub stating the scenario's trunk, a lane of it for each of the scenario's
 * lanes, each with its change finished, landed as the scenario draws. Answers each landing's status and output; the
 * commits the trunk (main where the hub states none) gained, newest first, and the tree of each; how many main gained;
 * the merges the trunk holds; the text of each lane's file it holds; and the trees the gate checked.
 */
export const landedAll = Effect.fn("landedAll")(function* (sandbox: Sandbox, landing: Landing) {
	const trunk = trunkOf(landing)
	const branch = branchOf(trunk)
	const hub = yield* hubOf(sandbox, trunk)
	const before = yield* hubCommits(sandbox, hub, branch)
	const mainBefore = yield* hubCommits(sandbox, hub, "main")
	const lanes = yield* Effect.forEach(
		Array.from({ length: lanesIn(landing) }, (_, at) => at),
		(at) =>
			Effect.gen(function* () {
				const lane = yield* laneOf(sandbox, hub, `lane${String(at)}`, branch)
				const [file, text] = changeOf(landing, at)
				yield* finished(sandbox, lane, file, text)
				return { lane, file }
			})
	)
	const lands = yield* landedAs(
		sandbox,
		landing,
		Arr.map(lanes, ({ lane }) => lane)
	)
	const after = yield* hubCommits(sandbox, hub, branch)
	const mainAfter = yield* hubCommits(sandbox, hub, "main")
	const gained = Arr.take(after, after.length - before.length)
	return {
		lands,
		gained: yield* Effect.forEach(gained, (commit) => treeIn(sandbox, hub, commit)),
		mainGained: mainAfter.length - mainBefore.length,
		merges: yield* hubMerges(sandbox, hub, branch),
		texts: yield* Effect.forEach(lanes, ({ file }) => hubText(sandbox, hub, branch, file)),
		gated: yield* gatedTrees(sandbox)
	}
})

/** Whether every tree the hub's trunk gained was gated. */
export const gatedEvery = (gained: ReadonlyArray<string>, gated: ReadonlyArray<string>): boolean =>
	Arr.every(gained, (tree) => Arr.contains(gated, tree))

/** The landings of a scenario that landed (exit status 0), by their lanes' places. */
export const landedAt = (lands: ReadonlyArray<Ran>): ReadonlyArray<number> =>
	Arr.filter(
		Array.from({ length: lands.length }, (_, at) => at),
		(at) => Arr.getUnsafe(lands, at).status === 0
	)

/** What a landing whose commit conflicts says. */
export const CONFLICT = "conflict with main"

/** What a landing on a hub that states no trunk says. */
export const NO_TRUNK = "states no trunk branch"

/** What a landing whose push was refused says as it lands again. */
export const AGAIN = "landing again"
