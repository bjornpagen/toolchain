import { assert } from "@bjornpagen/testing/assert"
import type { CheckoutDir } from "@bjornpagen/testing/checkout"
import { boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import { type Need, NeedFailed } from "@bjornpagen/testing/property"
import {
	Array as Arr,
	Deferred,
	Effect,
	Fiber,
	FileSystem,
	Option,
	Order,
	Path,
	Stream,
	String as Str
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/**
 * The gate's snapshot cache (bin/gate.sh) over real git repositories: the scenarios its properties draw (gate.test.ts),
 * the repositories a case builds in its own scratch directory, and what a run of the gate there shows. Each case runs
 * the gate with a cache of its own (XDG_CACHE_HOME inside its scratch directory), so nothing here touches the real
 * cache, and with no git configuration but its own, so nothing of the machine's moves a case.
 */

/** The environment every command of a case runs with: a git identity, local file transport for submodules, and no
 * global or system git configuration. */
export const IDENTITY: Readonly<Record<string, string>> = Object.freeze({
	GIT_AUTHOR_NAME: "gate-test",
	GIT_AUTHOR_EMAIL: "gate-test@localhost",
	GIT_COMMITTER_NAME: "gate-test",
	GIT_COMMITTER_EMAIL: "gate-test@localhost",
	GIT_ALLOW_PROTOCOL: "file",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1"
})

/** A case's sandbox, in its scratch directory: the directory its repositories are made in, its gate cache
 * (XDG_CACHE_HOME), the cache's root, where the key directories are, the gate it runs (the checkout's bin/gate.sh, so a
 * mutant of the gate in a worker tree is the gate the case runs), and the lockfile its repositories commit. */
export type Sandbox = Readonly<{
	dir: string
	cache: string
	root: string
	gate: string
	lockfile: string
}>

/** The sandbox in a case's scratch directory, running the gate of the dev tools' directory in the checkout. */
export const sandboxOf = (dir: string, checkout: CheckoutDir, lockfile: string): Sandbox => ({
	dir,
	cache: `${dir}/xdg`,
	root: `${dir}/xdg/toolchain-snapshots`,
	gate: `${checkout}/bin/gate.sh`,
	lockfile
})

/**
 * The toolchain.config.ts of a scenario's repository: a toolchain of no decisions whose clones land on `trunk` under
 * the lock `~/land.lock` (bin/land.sh), a plain object, since the repository installs no dev tools to import.
 */
export const toolchainConfig = (trunk: string): string =>
	`export default { rejected: { rules: {}, diagnostics: {} }, exceptions: [], effectFree: [], packs: {}, bannedPackages: [], land: { lock: "~/land.lock", branch: "${trunk}" } }\n`

/**
 * The files of a pnpm workspace with no package of its own, as every scenario's repository holds them. Its trunk is a
 * branch no case of the gate's pushes, so the push mode's landing check (bin/land.sh pre-push, land.test.ts's) passes
 * every push the gate's cases send, main among them.
 */
const WORKSPACE: ReadonlyArray<readonly [path: string, text: string]> = [
	[".gitignore", "node_modules\nout\n"],
	["pnpm-workspace.yaml", "packages: []\n"],
	["toolchain.config.ts", toolchainConfig("trunk")]
]

/**
 * The lockfile of an empty pnpm workspace, which pnpm writes once a worker: every scenario's repository commits this
 * text, so a case runs no pnpm of its own beside the gate's install, the one the gate is checked on. Its importers name
 * no package, so it fits every repository whatever its name.
 */
export const workspaceLockfile: Need<string> = {
	key: "bjornpagen.devtools.gate.workspace-lockfile",
	open: Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const directory = yield* fs.makeTempDirectoryScoped({ prefix: "gate-lockfile-" })
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

/** Runs a command to completion in a directory, with the sandbox's cache, answering its status and output. */
const ran = Effect.fn("ran")(function* (
	sandbox: Sandbox,
	cwd: string,
	command: string,
	args: ReadonlyArray<string>
) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const [stdout, stderr, status] = yield* Effect.scoped(
		Effect.flatMap(
			spawner.spawn(
				ChildProcess.make(command, args, {
					cwd,
					stdin: "ignore",
					extendEnv: true,
					env: { ...IDENTITY, XDG_CACHE_HOME: sandbox.cache }
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

/** Runs a command that must succeed, answering its output. */
export const sh = Effect.fn("sh")(function* (
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

/** The gate's run of a shell script on HEAD's commit, in a clone, which must succeed. */
const gated = Effect.fn("gated")(function* (sandbox: Sandbox, clone: string, script: string) {
	const done = yield* ran(sandbox, clone, "sh", [sandbox.gate, "run", "HEAD", "sh", "-c", script])
	assert.deepEqual(
		done.status,
		0,
		`the gate's run in ${clone} exited ${String(done.status)}: ${done.stderr}`
	)
	return done.stdout
})

/** Stages every change of a working tree and commits it. */
export const committed = (sandbox: Sandbox, directory: string, message: string) =>
	sh(sandbox, directory, "git", "add", "-A").pipe(
		Effect.andThen(sh(sandbox, directory, "git", "commit", "-qm", message))
	)

/**
 * A repository of the files every scenario's has, committed on main: a workspace and its lockfile, node_modules under
 * .gitignore, and a readme naming it.
 */
export const repository = Effect.fn("repository")(function* (sandbox: Sandbox, name: string) {
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

/** A clone of `origin` named `name` in the scratch directory, its submodules checked out. */
const cloneOf = Effect.fn("cloneOf")(function* (sandbox: Sandbox, origin: string, name: string) {
	const path = yield* Path.Path
	yield* sh(sandbox, sandbox.dir, "git", "clone", "-q", "--recurse-submodules", origin, name)
	return path.join(sandbox.dir, name)
})

/** A submodule's file that names its version `version`: v<v>.txt, which no other version holds. */
export const versionFile = (version: number): string => `sub/v${String(version)}.txt`

/** The files of a snapshot that name its submodule's version. */
export const versionFilesOf = (seen: Seen): ReadonlyArray<string> =>
	Arr.filter(
		Arr.map(seen.files, ([path]) => path),
		Str.startsWith("sub/v")
	)

/** The text of a submodule's s.txt at version `version`. */
const versionText = (version: number): string => `version ${String(version)}\n`

/**
 * A repository whose commits are versions 0, 1, and on: version v holds s.txt (versionText) and v<v>.txt, a file no
 * other version holds. Answers its directory and each version's commit, in order.
 */
const versioned = Effect.fn("versioned")(function* (
	sandbox: Sandbox,
	name: string,
	versions: number
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const directory = path.join(sandbox.dir, name)
	yield* fs.makeDirectory(directory)
	yield* sh(sandbox, directory, "git", "init", "-q", "-b", "main")
	return {
		directory,
		commits: yield* Effect.forEach(
			Array.from({ length: versions }, (_, version) => version),
			(version) =>
				Effect.gen(function* () {
					if (version > 0) {
						yield* fs.remove(path.join(directory, `v${String(version - 1)}.txt`))
					}
					yield* fs.writeFileString(path.join(directory, "s.txt"), versionText(version))
					yield* fs.writeFileString(
						path.join(directory, `v${String(version)}.txt`),
						`${String(version)}\n`
					)
					yield* committed(sandbox, directory, `version ${String(version)}`)
					return yield* Effect.map(sh(sandbox, directory, "git", "rev-parse", "HEAD"), Str.trim)
				})
		)
	}
})

/** The script a gate run looks at the snapshot with: each file outside node_modules and git's own files, with its git
 * hash, then each stamp under node_modules. */
const LOOK: ReadonlyArray<string> = [
	String.raw`for f in $(find . \( -name node_modules -o -name .git \) -prune -o -type f -print); do`,
	String.raw`	printf 'file %s %s\n' "${"$"}{f#./}" "$(git hash-object --no-filters -- "$f")"`,
	"done",
	"for f in node_modules/stamp-*; do",
	String.raw`	if [ -e "$f" ]; then printf 'stamp %s\n' "${"$"}{f#node_modules/}"; fi`,
	"done"
]

/** A file and its git hash. */
export type File = readonly [path: string, hash: string]

const byPath = Order.mapInput(Order.String, (file: File) => file[0])

/** What a gate run's command saw of the snapshot: its files, in path order, and the stamps under node_modules, in
 * name order. */
export type Seen = Readonly<{ files: ReadonlyArray<File>; stamps: ReadonlyArray<string> }>

/** The fields of a line of output after its tag, when the line has that tag. */
const tagged =
	(tag: string) =>
	(line: string): Option.Option<ReadonlyArray<string>> => {
		const [head, ...rest] = Str.split(" ")(line)
		return head === tag ? Option.some(rest) : Option.none()
	}

/** What LOOK printed, read back. */
const seenOf = (stdout: string): Seen => {
	const lines = Str.split("\n")(stdout)
	return {
		files: Arr.sort(
			Arr.flatMap(Arr.getSomes(Arr.map(lines, tagged("file"))), ([path, hash]) =>
				path === undefined || hash === undefined ? [] : [[path, hash] as const]
			),
			byPath
		),
		stamps: Arr.sort(
			Arr.flatMap(Arr.getSomes(Arr.map(lines, tagged("stamp"))), (fields) => fields),
			Order.String
		)
	}
}

/** What one run's command leaves in the snapshot after it has looked: a stamp under node_modules, which .gitignore
 * names, and strays, each named after the run: a file .gitignore does not name, and an output under out/, which it
 * does, as a check's generated output is (a package's declarations, a framework's route types). */
export type Leaves = Readonly<{ stamp: boolean; stray: boolean }>

/** The gate's run in a clone, the run numbered `index` of its case: its command looks at the snapshot, then leaves
 * what `leaves` says. */
export const looked = Effect.fn("looked")(function* (
	sandbox: Sandbox,
	clone: string,
	index: number,
	leaves: Leaves
) {
	const run = String(index)
	const script = Arr.join(
		[
			...LOOK,
			...(leaves.stamp ? [`mkdir -p node_modules && echo ${run} >node_modules/stamp-${run}`] : []),
			...(leaves.stray
				? [`echo ${run} >stray-${run}.txt`, `mkdir -p out && echo ${run} >out/stray-${run}.txt`]
				: [])
		],
		"\n"
	)
	return yield* Effect.map(gated(sandbox, clone, script), seenOf)
})

/** The format `git ls-tree` prints each entry in, read back by treeEntries: its type, its object and its path. */
const TREE_FORMAT = "--format=%(objecttype) %(objectname) %(path)"

/** The blobs of a TREE_FORMAT listing, each under `prefix`, and its gitlinks: the path and commit of each submodule. */
const treeEntries = (listed: string, prefix: string) => {
	const entries = Arr.flatMap(Str.split("\n")(listed), (line) => {
		const [type, hash, path] = Str.split(" ")(line)
		return hash === undefined || path === undefined
			? []
			: [{ type, hash, path: `${prefix}${path}` }]
	})
	return {
		blobs: Arr.flatMap(entries, ({ type, hash, path }): ReadonlyArray<File> =>
			type === "blob" ? [[path, hash]] : []
		),
		gitlinks: Arr.filter(entries, ({ type }) => type === "commit")
	}
}

/**
 * The files a clone's HEAD commit holds, in path order: each blob of its tree, and each submodule's blobs at the commit
 * the tree records, read from the submodule's repository in the clone.
 */
export const treeOf = Effect.fn("treeOf")(function* (sandbox: Sandbox, clone: string) {
	const path = yield* Path.Path
	const listed = yield* sh(sandbox, clone, "git", "ls-tree", "-r", TREE_FORMAT, "HEAD")
	const top = treeEntries(listed, "")
	const nested = yield* Effect.forEach(top.gitlinks, (link) =>
		Effect.map(
			sh(sandbox, path.join(clone, link.path), "git", "ls-tree", "-r", TREE_FORMAT, link.hash),
			(listed) => treeEntries(listed, `${link.path}/`).blobs
		)
	)
	return Arr.sort([...top.blobs, ...Arr.flatten(nested)], byPath)
})

/** The cache's key directories, the ones a run made visible, in name order. */
export const keys = Effect.fn("keys")(function* (sandbox: Sandbox) {
	const fs = yield* FileSystem.FileSystem
	const names = yield* fs.readDirectory(sandbox.root)
	return Arr.sort(
		Arr.filter(names, (name) => !Str.startsWith(".")(name)),
		Order.String
	)
})

/** The cache's one key directory, when a run has made exactly one visible: every clone of one repository shares it. */
export const onlyKey = Effect.fn("onlyKey")(function* (sandbox: Sandbox) {
	const made = yield* keys(sandbox)
	const [only, ...rest] = made
	if (only === undefined || Arr.isReadonlyArrayNonEmpty(rest)) {
		return assert.fail(`the cache holds one key directory, not [${Arr.join(made, ", ")}]`)
	}
	return only
})

/** The common git directories a key directory's clones file lists, in its order. */
export const clonesListed = Effect.fn("clonesListed")(function* (sandbox: Sandbox, key: string) {
	const fs = yield* FileSystem.FileSystem
	const text = yield* fs.readFileString(`${sandbox.root}/${key}/clones`)
	return Arr.filter(Str.split("\n")(text), Str.isNonEmpty)
})

/** The objects directory a key directory's first push snapshot borrows (its alternates): runs one at a time claim it. */
export const alternatesOf = Effect.fn("alternatesOf")(function* (sandbox: Sandbox, key: string) {
	const fs = yield* FileSystem.FileSystem
	const text = yield* fs.readFileString(`${sandbox.root}/${key}/push.0.git/objects/info/alternates`)
	return Str.trim(text)
})

/** A clone's common git directory, as the gate lists it. */
export const commonDirectory = (clone: string): string => `${clone}/.git`

/** A clone's objects, which the snapshot borrows while a run checks the clone's commit. */
export const objectsOf = (clone: string): string => `${clone}/.git/objects`

/** The runs before the one at `index`. */
const before = <A>(runs: ReadonlyArray<A>, index: number): ReadonlyArray<A> => Arr.take(runs, index)

/** The run just before the one at `index`, if any. */
const previous = <A>(runs: ReadonlyArray<A>, index: number): Option.Option<A> =>
	index === 0 ? Option.none() : Arr.get(runs, index - 1)

/** A plain repository and `count` clones of it (one at least), c0, c1 and on: answers the repository and the clones. */
export const clonedRepository = Effect.fn("clonedRepository")(function* (
	sandbox: Sandbox,
	count: number
) {
	const origin = yield* repository(sandbox, "origin")
	const first = yield* cloneOf(sandbox, origin, "c0")
	const rest = yield* Effect.forEach(
		Array.from({ length: count - 1 }, (_, index) => index + 1),
		(index) => cloneOf(sandbox, origin, `c${String(index)}`)
	)
	const clones: Arr.NonEmptyReadonlyArray<string> = [first, ...rest]
	return { origin, clones }
})

/** How a clone's origin remote URL is written: as it was cloned, or with a trailing .git or /, each the same repository. */
export type Spelling = "as cloned" | "with .git" | "with /"

const SPELLINGS = ["as cloned", "with .git", "with /"] as const

/** What each spelling adds to the URL a clone was cloned from. */
const SUFFIXES: Readonly<Record<Spelling, string>> = {
	"as cloned": "",
	"with .git": ".git",
	"with /": "/"
}

/**
 * Clones of one repository and the gate's runs in them, in order: how every clone but the first writes its origin
 * remote URL, and for each run the clone it runs in, by its place among the clones, and whether its command leaves a
 * stamp under node_modules, which .gitignore names.
 */
export type Sharing = Readonly<{
	clones: number
	spelling: Spelling
	runs: Arr.NonEmptyReadonlyArray<Readonly<{ clone: number; stamps: boolean }>>
}>

/**
 * Every way three runs fall among up to three clones, each clone named by the run that first uses it (the first run
 * in c0, a new clone the next of c1, c2), each run leaving a stamp, and every clone after the first writing its origin
 * each way: thirteen layouts, the smallest that reach every situation (a second clone's first run after a first's
 * stamp, a clone again after another, three clones on one snapshot, a clone whose origin ends in .git or /).
 */
export const sharings: Gen<Sharing> = (source) => {
	const second = source.draw(int(0, 1))
	const third = source.draw(int(0, second + 1))
	const clones = Math.max(second, third) + 1
	return {
		clones,
		spelling: clones > 1 ? source.draw(element(SPELLINGS)) : "as cloned",
		runs: [
			{ clone: 0, stamps: true },
			{ clone: second, stamps: true },
			{ clone: third, stamps: true }
		]
	}
}

/** The situations a Sharing puts the cache in. */
export type SharingFeature =
	| "a second clone's first run finds what a first run installed"
	| "a clone runs again after another clone's run"
	| "three clones share one snapshot"
	| "a clone whose origin URL ends in .git shares the snapshot"
	| "a clone whose origin URL ends in / shares the snapshot"

/** The situation a clone after the first is in, by how it writes its origin. */
const SPELLING_FEATURES: Readonly<Record<Spelling, ReadonlyArray<SharingFeature>>> = {
	"as cloned": [],
	"with .git": ["a clone whose origin URL ends in .git shares the snapshot"],
	"with /": ["a clone whose origin URL ends in / shares the snapshot"]
}

/** The situations each run of a Sharing is in. */
export const sharingFeatures = (sharing: Sharing): ReadonlyArray<SharingFeature> => [
	...Arr.flatMap(sharing.runs, (run, index): ReadonlyArray<SharingFeature> => {
		const earlier = before(sharing.runs, index)
		const ranHere = Arr.some(earlier, (one) => one.clone === run.clone)
		return [
			...(!ranHere && Arr.some(earlier, (one) => one.stamps && one.clone !== run.clone)
				? ["a second clone's first run finds what a first run installed" as const]
				: []),
			...(ranHere && Option.exists(previous(sharing.runs, index), (one) => one.clone !== run.clone)
				? ["a clone runs again after another clone's run" as const]
				: [])
		]
	}),
	...(Arr.dedupe(Arr.map(sharing.runs, (run) => run.clone)).length === 3
		? ["three clones share one snapshot" as const]
		: []),
	...(sharing.clones > 1 ? SPELLING_FEATURES[sharing.spelling] : [])
]

/** The repository of a Sharing and its clones, every clone after the first writing its origin as the Sharing spells it. */
export const spelledClones = Effect.fn("spelledClones")(function* (
	sandbox: Sandbox,
	sharing: Sharing
) {
	const made = yield* clonedRepository(sandbox, sharing.clones)
	yield* Effect.forEach(Arr.drop(made.clones, 1), (clone) =>
		sh(
			sandbox,
			clone,
			"git",
			"remote",
			"set-url",
			"origin",
			`${made.origin}${SUFFIXES[sharing.spelling]}`
		)
	)
	return made
})

/** The stamps the runs before the one at `index` left under node_modules, in name order: what that run must find. */
export const stampsBefore = (sharing: Sharing, index: number): ReadonlyArray<string> =>
	Arr.sort(
		Arr.flatMap(before(sharing.runs, index), (run, at) =>
			run.stamps ? [`stamp-${String(at)}`] : []
		),
		Order.String
	)

/** The clones that have run by the run at `index`, by place, in the order they first ran: what the clones file lists
 * after it. */
export const clonesRunBy = (sharing: Sharing, index: number): ReadonlyArray<number> =>
	Arr.dedupe(Arr.map(Arr.take(sharing.runs, index + 1), (run) => run.clone))

/**
 * A clone of the repository, as a run checks it: whether it commits a file of its own (only-c<i>.txt), and whether its
 * working tree holds edits it has not committed (README.txt changed and staged, and an untracked file).
 */
export type CheckedClone = Readonly<{ ownFile: boolean; edited: boolean }>

/**
 * Clones of one repository, each with commits and edits of its own, and the gate's runs in them, in order: each run
 * names its clone, and whether its command leaves strays: a file .gitignore does not name, and an output it names.
 */
export type Checking = Readonly<{
	clones: Arr.NonEmptyReadonlyArray<CheckedClone>
	runs: Arr.NonEmptyReadonlyArray<Readonly<{ clone: number; strays: boolean }>>
}>

/** A clone with a commit of its own or none, and edits it has not committed or none. */
const checkedShapes: Gen<CheckedClone> = (source) => ({
	ownFile: source.draw(boolean),
	edited: source.draw(boolean)
})

/**
 * Two clones of every shape (sixteen layouts), checked in turn by three runs: the first clone's run leaves a stray
 * file, then the second clone's run, then the first clone's again, the smallest protocol that reaches every situation
 * (a commit after another clone's different one, a file the commit before held, uncommitted edits, an earlier stray).
 */
export const checkings: Gen<Checking> = (source) => ({
	clones: [source.draw(checkedShapes), source.draw(checkedShapes)],
	runs: [
		{ clone: 0, strays: true },
		{ clone: 1, strays: false },
		{ clone: 0, strays: false }
	]
})

/** The situations a Checking puts the snapshot in. */
export type CheckingFeature =
	| "a commit checked after another clone's different commit"
	| "a commit lacking a file the commit checked before held"
	| "a working tree with edits it has not committed"
	| "strays an earlier run left, ignored and not"

/** The situations each run of a Checking is in. */
export const checkingFeatures = (checking: Checking): ReadonlyArray<CheckingFeature> =>
	Arr.flatMap(checking.runs, (run, index): ReadonlyArray<CheckingFeature> => {
		const shape = Arr.getUnsafe(checking.clones, run.clone)
		const other = Option.filter(previous(checking.runs, index), (one) => one.clone !== run.clone)
		const otherShape = Option.map(other, (one) => Arr.getUnsafe(checking.clones, one.clone))
		return [
			...(Option.exists(otherShape, (one) => one.ownFile || shape.ownFile)
				? ["a commit checked after another clone's different commit" as const]
				: []),
			...(Option.exists(otherShape, (one) => one.ownFile)
				? ["a commit lacking a file the commit checked before held" as const]
				: []),
			...(shape.edited ? ["a working tree with edits it has not committed" as const] : []),
			...(Arr.some(before(checking.runs, index), (one) => one.strays)
				? ["strays an earlier run left, ignored and not" as const]
				: [])
		]
	})

/** The repository of a Checking and its clones, each with its own commit and its edits made. */
export const checkedClones = Effect.fn("checkedClones")(function* (
	sandbox: Sandbox,
	shapes: Arr.NonEmptyReadonlyArray<CheckedClone>
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const made = yield* clonedRepository(sandbox, shapes.length)
	yield* Effect.forEach(Arr.zip(made.clones, shapes), ([clone, shape]) =>
		Effect.gen(function* () {
			const name = path.basename(clone)
			if (shape.ownFile) {
				yield* fs.writeFileString(path.join(clone, `only-${name}.txt`), `${name}\n`)
				yield* committed(sandbox, clone, "a file of its own")
			}
			if (shape.edited) {
				yield* fs.writeFileString(path.join(clone, "README.txt"), "edited, not committed\n")
				yield* sh(sandbox, clone, "git", "add", "README.txt")
				yield* fs.writeFileString(path.join(clone, "untracked.txt"), "untracked\n")
			}
		})
	)
	return made
})

/**
 * A clone of a repository with a submodule: the submodule's version its HEAD records (the origin's, or another its own
 * commit moves it to), and the version its working tree has the submodule checked out at.
 */
export type SubmoduleClone = Readonly<{ committed: number; checkedOut: number }>

/**
 * A repository with a submodule of `versions` versions, recording version `recorded`; its clones; and the gate's runs,
 * in order, each in the clone at that place.
 */
export type Filling = Readonly<{
	versions: number
	recorded: number
	clones: Arr.NonEmptyReadonlyArray<SubmoduleClone>
	runs: Arr.NonEmptyReadonlyArray<number>
}>

/** A clone's submodule versions, of the two a Filling's submodule has: the one it commits and the one it checks out. */
const submoduleShapes: Gen<SubmoduleClone> = (source) => ({
	committed: source.draw(int(0, 1)),
	checkedOut: source.draw(int(0, 1))
})

/**
 * A submodule of two versions, recorded at either, and two clones of every shape, run in turn: thirty-two layouts, the
 * smallest that reach every situation (the recorded version, one a clone's own commit moved, one behind the tip, a
 * working tree checked out at another, a fill at another version by the run before).
 */
export const fillings: Gen<Filling> = (source) => ({
	versions: 2,
	recorded: source.draw(int(0, 1)),
	clones: [source.draw(submoduleShapes), source.draw(submoduleShapes)],
	runs: [0, 1]
})

/** The situations a Filling puts the snapshot's submodule in. */
export type FillingFeature =
	| "a submodule at the commit the repository recorded"
	| "a submodule its clone's own commit moved"
	| "a submodule recorded behind its repository's tip"
	| "a working tree's submodule checked out at another commit"
	| "a submodule filled at another commit by the run before"

/** The situations each run of a Filling is in. */
export const fillingFeatures = (filling: Filling): ReadonlyArray<FillingFeature> =>
	Arr.flatMap(filling.runs, (at, index): ReadonlyArray<FillingFeature> => {
		const shape = Arr.getUnsafe(filling.clones, at)
		return [
			shape.committed === filling.recorded
				? "a submodule at the commit the repository recorded"
				: "a submodule its clone's own commit moved",
			...(shape.committed < filling.versions - 1
				? ["a submodule recorded behind its repository's tip" as const]
				: []),
			...(shape.checkedOut === shape.committed
				? []
				: ["a working tree's submodule checked out at another commit" as const]),
			...(Option.exists(
				previous(filling.runs, index),
				(one) => Arr.getUnsafe(filling.clones, one).committed !== shape.committed
			)
				? ["a submodule filled at another commit by the run before" as const]
				: [])
		]
	})

/**
 * The repository of a Filling, its submodule at the version it records, and its clones, each with the submodule's
 * version its own commit records and its working tree's checkout.
 */
export const submoduleClones = Effect.fn("submoduleClones")(function* (
	sandbox: Sandbox,
	filling: Filling
) {
	const path = yield* Path.Path
	const sub = yield* versioned(sandbox, "sub", filling.versions)
	const commitOf = (version: number): string => Arr.getUnsafe(sub.commits, version)
	const origin = yield* repository(sandbox, "origin")
	yield* sh(sandbox, origin, "git", "submodule", "add", "-q", sub.directory, "sub")
	yield* sh(sandbox, path.join(origin, "sub"), "git", "checkout", "-q", commitOf(filling.recorded))
	yield* committed(sandbox, origin, "the submodule")
	const clones = yield* Effect.forEach(filling.clones, (shape, index) =>
		Effect.gen(function* () {
			const clone = yield* cloneOf(sandbox, origin, `c${String(index)}`)
			const checkout = path.join(clone, "sub")
			if (shape.committed !== filling.recorded) {
				yield* sh(sandbox, checkout, "git", "checkout", "-q", commitOf(shape.committed))
				yield* committed(sandbox, clone, "moves the submodule")
			}
			if (shape.checkedOut !== shape.committed) {
				yield* sh(sandbox, checkout, "git", "checkout", "-q", commitOf(shape.checkedOut))
			}
			return clone
		})
	)
	return { origin, clones }
})

/** What became of a clone a key directory lists, after it ran: still there, removed, or re-pointed (its origin remote
 * now names another repository, so its key is another). */
export type Fate = "present" | "removed" | "re-pointed"

/** A key directory's lock beside it (`.<key>.lock`): none, held by a live run, or left by a run that has exited, which
 * the kernel let go of. */
export type Lock = "none" | "live" | "stale"

/**
 * A key directory of the cache beside the repository a run checks: the clones of another repository that ran the gate,
 * keyed by that repository's URL, or a repository with no origin remote that ran the gate, keyed by its own path.
 */
export type Entry =
	| Readonly<{ kind: "clones"; fates: Arr.NonEmptyReadonlyArray<Fate>; lock: Lock }>
	| Readonly<{ kind: "repository"; fate: Fate; lock: Lock }>

const FATES = ["present", "removed", "re-pointed"] as const

const fateGen: Gen<Fate> = (source) => Arr.getUnsafe(FATES, source.draw(int(0, FATES.length - 1)))

/** The fates of one or two clones, as a multiset: the second never before the first, so each is drawn once. */
const fatesGen: Gen<Arr.NonEmptyReadonlyArray<Fate>> = (source) => {
	const first = source.draw(int(0, FATES.length - 1))
	return source.draw(boolean)
		? [Arr.getUnsafe(FATES, first), Arr.getUnsafe(FATES, source.draw(int(first, FATES.length - 1)))]
		: [Arr.getUnsafe(FATES, first)]
}

const lockGen: Gen<Lock> = (source) => source.draw(element(["none", "live", "stale"] as const))

const entryGen: Gen<Entry> = (source) => {
	const kind = source.draw(element(["clones", "repository"] as const))
	switch (kind) {
		case "clones":
			return { kind, fates: source.draw(fatesGen), lock: source.draw(lockGen) }
		case "repository":
			return { kind, fate: source.draw(fateGen), lock: source.draw(lockGen) }
	}
}

/**
 * One key directory beside the one the run checks, of every kind: a repository's clones (one or two, each fate) or a
 * repository with no origin remote, each under no lock, a live one or a stale one. Thirty-six layouts; a run judges
 * each key directory alone, so one a case reaches every situation.
 */
export const collectings: Gen<Arr.NonEmptyReadonlyArray<Entry>> = (source) => [
	source.draw(entryGen)
]

/** The fates of the clones a key directory lists. */
const fatesOf = (entry: Entry): Arr.NonEmptyReadonlyArray<Fate> => {
	switch (entry.kind) {
		case "clones":
			return entry.fates
		case "repository":
			return [entry.fate]
	}
}

/**
 * Whether a run keeps a key directory, by the gate's contract: while one of the clones it lists is still there under its
 * key, or a live run holds its lock.
 */
export const kept = (entry: Entry): boolean =>
	Arr.contains(fatesOf(entry), "present") || entry.lock === "live"

/** The situations a key directory is in. */
export type CollectingFeature =
	| "a key directory whose clones are all gone is collected"
	| "a key directory kept by a clone still there among gone ones"
	| "a key directory whose clones are gone kept by a live lock"
	| "a stale lock keeps nothing"
	| "a re-pointed clone counts as gone"
	| "a repository with no origin remote, keyed by its path"

/** The situations an entry is in. */
const entryFeatures = (entry: Entry): ReadonlyArray<CollectingFeature> => {
	const fates = fatesOf(entry)
	const gone = !Arr.contains(fates, "present")
	return [
		...(kept(entry) ? [] : ["a key directory whose clones are all gone is collected" as const]),
		...(!gone && !Arr.every(fates, (fate) => fate === "present")
			? ["a key directory kept by a clone still there among gone ones" as const]
			: []),
		...(gone && entry.lock === "live"
			? ["a key directory whose clones are gone kept by a live lock" as const]
			: []),
		...(gone && entry.lock === "stale" ? ["a stale lock keeps nothing" as const] : []),
		...(!kept(entry) && Arr.contains(fates, "re-pointed")
			? ["a re-pointed clone counts as gone" as const]
			: []),
		...(entry.kind === "repository"
			? ["a repository with no origin remote, keyed by its path" as const]
			: [])
	]
}

/** The situations the key directories of a case are in. */
export const collectingFeatures = (
	entries: ReadonlyArray<Entry>
): ReadonlyArray<CollectingFeature> => Arr.flatMap(entries, entryFeatures)

/**
 * Holds a lock on `file`, shared (-s) or exclusive (-x), as a run of a gate since 434ec12 holds one, with flock(1),
 * which a run of this gate's holder (hold.pl) must keep as it keeps its own, the two gates sharing one cache while
 * repositories repin: flock(1) in a child process that keeps it until the case's scope closes. flock lets go of the file before it starts its command (-o), so killing
 * it lets go of the lock, and its command, which only waits on its input, ends when the case's end closes that input.
 */
const holding = Effect.fn("holding")(function* (sandbox: Sandbox, file: string, kind: "-s" | "-x") {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const handle = yield* spawner.spawn(
		ChildProcess.make("flock", ["-o", kind, file, "sh", "-c", "echo held; exec cat >/dev/null"], {
			cwd: sandbox.dir,
			extendEnv: true,
			env: IDENTITY
		})
	)
	const said = yield* Stream.runHead(Stream.decodeText(handle.stdout))
	assert.deepEqual(Option.map(said, Str.trim), Option.some("held"), `flock never held ${file}`)
})

/** Whether a lock file is free: flock(1) takes it at once and lets go. */
export const free = Effect.fn("free")(function* (sandbox: Sandbox, file: string) {
	const done = yield* ran(sandbox, sandbox.dir, "flock", ["-n", file, "true"])
	return done.status === 0
})

/** Takes a key directory's lock as `lock` draws it: held by a live process, or left by one that exited, a file no
 * process holds. */
const locked = Effect.fn("locked")(function* (sandbox: Sandbox, key: string, lock: Lock) {
	const fs = yield* FileSystem.FileSystem
	const file = `${sandbox.root}/.${key}.lock`
	switch (lock) {
		case "none":
			return
		case "live":
			return yield* holding(sandbox, file, "-s")
		case "stale":
			return yield* fs.writeFileString(file, "")
	}
})

/** What becomes of a clone or a repository after it ran: nothing, its removal, or a new origin remote, set (a clone's)
 * or added (a repository's, which had none). */
const befallen = Effect.fn("befallen")(function* (
	sandbox: Sandbox,
	directory: string,
	fate: Fate,
	remote: "set-url" | "add"
) {
	const fs = yield* FileSystem.FileSystem
	if (fate === "removed") {
		yield* fs.remove(directory, { recursive: true })
	}
	if (fate === "re-pointed") {
		yield* sh(sandbox, directory, "git", "remote", remote, "origin", `${sandbox.dir}/elsewhere`)
	}
})

/** A key directory beside the repository a run checks, as a case made it: the entry it was drawn as, its name, and
 * the clones or the repository that registered it. */
export type Registered = Readonly<{ entry: Entry; key: string; registrants: ReadonlyArray<string> }>

/** The key directories a run of the gate made visible since the cache listed `before`, which must be exactly one. */
const madeSince = Effect.fn("madeSince")(function* (
	sandbox: Sandbox,
	before: ReadonlyArray<string>
) {
	const after = yield* keys(sandbox)
	const made = Arr.difference(after, before)
	const [only, ...rest] = made
	if (only === undefined || Arr.isReadonlyArrayNonEmpty(rest)) {
		return assert.fail(`one repository makes one key directory, not [${Arr.join(made, ", ")}]`)
	}
	return only
})

/** The clones of a new repository named `name`, one a fate, each having run the gate: the key directory they made. */
const clonesRegistered = Effect.fn("clonesRegistered")(function* (
	sandbox: Sandbox,
	name: string,
	fates: Arr.NonEmptyReadonlyArray<Fate>,
	listed: ReadonlyArray<string>
) {
	const origin = yield* repository(sandbox, name)
	const clones = yield* Effect.forEach(fates, (_, at) =>
		cloneOf(sandbox, origin, `${name}c${String(at)}`)
	)
	yield* Effect.forEach(clones, (clone) => gated(sandbox, clone, "true"))
	const key = yield* madeSince(sandbox, listed)
	return { key, clones }
})

/**
 * A key directory beside the repository a run checks, as the entry at `index` draws it. The clones of a repository
 * register under its URL, a run of the gate in each, and a repository with no remote under its path, by a run in
 * itself.
 */
export const registered = Effect.fn("registered")(function* (
	sandbox: Sandbox,
	entry: Entry,
	index: number
) {
	const fs = yield* FileSystem.FileSystem
	const name = `e${String(index)}`
	const present = yield* fs.exists(sandbox.root)
	const listed = present ? yield* keys(sandbox) : []
	switch (entry.kind) {
		case "clones": {
			const { key, clones } = yield* clonesRegistered(sandbox, name, entry.fates, listed)
			const made: Registered = { entry, key, registrants: clones }
			return made
		}
		case "repository": {
			const directory = yield* repository(sandbox, name)
			yield* gated(sandbox, directory, "true")
			const key = yield* madeSince(sandbox, listed)
			const made: Registered = { entry, key, registrants: [directory] }
			return made
		}
	}
})

/** What becomes of a registered key directory before the run: each clone or repository that registered it meets its
 * fate, and the lock its entry draws is taken. */
export const befell = Effect.fn("befell")(function* (sandbox: Sandbox, made: Registered) {
	const { entry } = made
	switch (entry.kind) {
		case "clones":
			yield* Effect.forEach(Arr.zip(made.registrants, entry.fates), ([clone, fate]) =>
				befallen(sandbox, clone, fate, "set-url")
			)
			return yield* locked(sandbox, made.key, entry.lock)
		case "repository":
			yield* Effect.forEach(made.registrants, (directory) =>
				befallen(sandbox, directory, entry.fate, "add")
			)
			return yield* locked(sandbox, made.key, entry.lock)
	}
})

/** A snapshot of the push mode as a run finds it: free (none yet, or one a run checked in and left), held by a live
 * run, or left half-filled by a run that was killed, whose lock the kernel let go of. */
export type Slot = "free" | "live" | "killed"

const SLOTS = ["free", "live", "killed"] as const

/** The push mode's first two snapshots, each of every kind: nine layouts, the smallest that reach every situation. */
export const claimings: Gen<readonly [Slot, Slot]> = (source) => [
	source.draw(element(SLOTS)),
	source.draw(element(SLOTS))
]

/** The snapshot a run claims, by the gate's contract: the first that no live run holds, else the next after them all. */
export const claimedSlot = (slots: ReadonlyArray<Slot>): number =>
	Option.getOrElse(
		Arr.findFirstIndex(slots, (slot) => slot !== "live"),
		() => slots.length
	)

/** The situations a run is in among the snapshots it finds. */
export type ClaimingFeature =
	| "a run claims a snapshot no run holds"
	| "a run passes a snapshot a live run holds"
	| "a run takes over a snapshot a killed run left half-filled"
	| "every snapshot held: a run makes a new one"

/** The situation of the snapshot a run claims, by what it finds there. */
const CLAIMED_FEATURES: Readonly<Record<Slot, ReadonlyArray<ClaimingFeature>>> = {
	free: ["a run claims a snapshot no run holds"],
	live: [],
	killed: ["a run takes over a snapshot a killed run left half-filled"]
}

/** The situations a run is in among `slots`. */
export const claimingFeatures = (slots: ReadonlyArray<Slot>): ReadonlyArray<ClaimingFeature> => {
	const at = claimedSlot(slots)
	return [
		...(at > 0 ? ["a run passes a snapshot a live run holds" as const] : []),
		...Option.match(Arr.get(slots, at), {
			onNone: () => ["every snapshot held: a run makes a new one" as const],
			onSome: (slot) => CLAIMED_FEATURES[slot]
		})
	]
}

/** The lock of the push mode's snapshot numbered `at` in a key directory. */
export const pushLock = (sandbox: Sandbox, key: string, at: number): string =>
	`${sandbox.root}/${key}/push.${String(at)}.lock`

/**
 * The push mode's snapshot numbered `at`, as a run that was killed while filling it leaves it: the first snapshot's
 * files and git directory (copied to `at` when it is another), one tracked file cut short, one deleted and a stray
 * beside them, and its lock a file no process holds.
 */
const halfFilled = Effect.fn("halfFilled")(function* (sandbox: Sandbox, key: string, at: number) {
	const fs = yield* FileSystem.FileSystem
	const base = `${sandbox.root}/${key}`
	const snapshot = `${base}/push.${String(at)}`
	if (at > 0) {
		yield* sh(sandbox, base, "cp", "-a", "push.0", `push.${String(at)}`)
		yield* sh(sandbox, base, "cp", "-a", "push.0.git", `push.${String(at)}.git`)
		yield* fs.writeFileString(`${snapshot}/.git`, `gitdir: ${snapshot}.git\n`)
	}
	yield* fs.writeFileString(`${snapshot}/README.txt`, "cut sh")
	yield* fs.remove(`${snapshot}/package.json`)
	yield* fs.writeFileString(`${snapshot}/half-${String(at)}.txt`, "a killed run's\n")
	yield* fs.writeFileString(pushLock(sandbox, key, at), "")
})

/** Puts the push mode's snapshot numbered `at` of a key directory in the state `slot` draws. */
export const slotted = Effect.fn("slotted")(function* (
	sandbox: Sandbox,
	key: string,
	slot: Slot,
	at: number
) {
	switch (slot) {
		case "free":
			return
		case "live":
			return yield* holding(sandbox, pushLock(sandbox, key, at), "-x")
		case "killed":
			return yield* halfFilled(sandbox, key, at)
	}
})

/** A commit in a clone that a snapshot filled before has not seen: a file of its own. */
export const newCommit = Effect.fn("newCommit")(function* (sandbox: Sandbox, clone: string) {
	const fs = yield* FileSystem.FileSystem
	yield* fs.writeFileString(`${clone}/after.txt`, "a later commit\n")
	yield* committed(sandbox, clone, "a later commit")
})

/** The gate's run in a clone whose command looks at the snapshot and names it: what it saw, and the snapshot's name. */
export const claimedBy = Effect.fn("claimedBy")(function* (sandbox: Sandbox, clone: string) {
	const stdout = yield* gated(
		sandbox,
		clone,
		Arr.join([...LOOK, String.raw`printf 'in %s\n' "${"$"}{PWD##*/}"`], "\n")
	)
	const names = Arr.flatMap(
		Arr.getSomes(Arr.map(Str.split("\n")(stdout), tagged("in"))),
		(fields) => fields
	)
	return { seen: seenOf(stdout), snapshot: Arr.join(names, " ") }
})

/**
 * Where a run of the gate is in its life when another repository's run collects garbage beside it: holding its key and
 * reading the push's lines, before it claims a snapshot; filling the snapshot it claimed, while a file is checked out;
 * checking, while its command runs; at exit, its shell gone and a process its command started still in the snapshot;
 * or exited, with everything it started.
 */
export type Phase = "before claiming" | "while filling" | "while checking" | "at exit" | "exited"

const PHASES = ["before claiming", "while filling", "while checking", "at exit", "exited"] as const

/**
 * How the collect beside a run reads the run's clone: still there under the run's key, or re-pointed at another
 * repository since the run began, so the registry reads the repository gone, as every older gate read a clone whose
 * origin ends in .git (effect-openapi-cli-generator's), and only the run's hold keeps its directory.
 */
export type Standing = "present" | "re-pointed"

const STANDINGS = ["present", "re-pointed"] as const

/** A run of one repository in a phase of its life, its clone as the collect beside it reads it. */
export type Sweep = Readonly<{ phase: Phase; clone: Standing }>

/** Every phase with each standing: ten layouts, the smallest that reach every situation. */
export const sweeps: Gen<Sweep> = (source) => ({
	phase: source.draw(element(PHASES)),
	clone: source.draw(element(STANDINGS))
})

/** Whether a run in a phase still holds its key: in every phase but once it and everything it started have exited. */
const holds = (phase: Phase): boolean => phase !== "exited"

/** Whether the collect beside a run leaves the run's key directory, by the gate's contract: while anything of the run
 * holds it, or while its clone is still there under its key. */
export const keptThrough = (sweep: Sweep): boolean =>
	holds(sweep.phase) || sweep.clone === "present"

/** The situations a Sweep puts a run in. */
export type SweepFeature =
	| "a run holding its key before it claims a snapshot keeps it"
	| "a run filling its snapshot keeps it"
	| "a run checking keeps its snapshot"
	| "a process a run left in its snapshot keeps it"
	| "a run's hold alone keeps a repository its registry reads gone"
	| "an exited run's repository read gone is collected"

const PHASE_FEATURES: Readonly<Record<Phase, ReadonlyArray<SweepFeature>>> = {
	"before claiming": ["a run holding its key before it claims a snapshot keeps it"],
	"while filling": ["a run filling its snapshot keeps it"],
	"while checking": ["a run checking keeps its snapshot"],
	"at exit": ["a process a run left in its snapshot keeps it"],
	exited: []
}

/** The situations a Sweep puts its run in. */
export const sweepFeatures = (sweep: Sweep): ReadonlyArray<SweepFeature> => [
	...PHASE_FEATURES[sweep.phase],
	...(sweep.clone === "re-pointed"
		? [
				holds(sweep.phase)
					? ("a run's hold alone keeps a repository its registry reads gone" as const)
					: ("an exited run's repository read gone is collected" as const)
			]
		: [])
]

/** What the gate prints once a run holds its key (bin/gate.sh), before the push's lines are read. */
const HOLDS = "toolchain-gate: holds "

/** What a run's pause prints once the run is in its phase. */
const pausedIn = (phase: Phase): string => `paused ${phase}`

/** The line a run prints once it is in its phase, for the phases it is held in while it runs; none for one whose run has
 * exited by then. */
const reachedLine = (phase: Phase): Option.Option<string> => {
	switch (phase) {
		case "before claiming":
			return Option.some(HOLDS)
		case "while filling":
		case "while checking":
			return Option.some(pausedIn(phase))
		case "at exit":
		case "exited":
			return Option.none()
	}
}

/**
 * The check a run's push gate runs, as a script outside its repository (the repository's check is `sh
 * "$GATE_PROBE"`): it looks at the snapshot; while checking, it says so and waits for `go` first; at exit, it leaves a
 * process in the snapshot that waits for `go` and then looks into `seen`, and returns at once.
 */
const probeOf = (phase: Phase, go: string, seen: string): string => {
	switch (phase) {
		case "while checking":
			return Arr.join([`echo '${pausedIn(phase)}' >&2`, `read _ <'${go}'`, ...LOOK], "\n")
		case "at exit":
			return Arr.join(
				["(", `read _ <'${go}'`, "{", ...LOOK, `} >'${seen}'`, ") </dev/null >/dev/null 2>&1 &"],
				"\n"
			)
		case "before claiming":
		case "while filling":
		case "exited":
			return Arr.join(LOOK, "\n")
	}
}

/**
 * The git configuration of a run: while filling, the filter `pause`, which the repository has paused.txt checked out
 * through, says so, waits for `go` and passes the file through; every other run has none, as every other command of a
 * case.
 */
const configOf = Effect.fn("configOf")(function* (sandbox: Sandbox, phase: Phase, go: string) {
	const fs = yield* FileSystem.FileSystem
	if (phase !== "while filling") {
		return "/dev/null"
	}
	const pause = `${sandbox.dir}/pause.sh`
	const config = `${sandbox.dir}/pause.gitconfig`
	yield* fs.writeFileString(
		pause,
		Arr.join([`echo '${pausedIn(phase)}' >&2`, `read _ <'${go}'`, "exec cat", ""], "\n")
	)
	yield* fs.writeFileString(config, `[filter "pause"]\n\tsmudge = sh ${pause}\n`)
	return config
})

/** A FIFO named `name` in the case's scratch directory. */
const fifo = Effect.fn("fifo")(function* (sandbox: Sandbox, name: string) {
	const path = `${sandbox.dir}/${name}`
	yield* sh(sandbox, sandbox.dir, "mkfifo", path)
	return path
})

/**
 * A repository whose check is the probe (package.json's check, `sh "$GATE_PROBE"`) and whose paused.txt is checked out
 * through the filter `pause`, which only a run's own configuration defines, and a clone of it that has run the gate
 * once, leaving a stamp under node_modules in the snapshot, then committed a change to paused.txt the snapshot has not
 * seen, so the next fill checks it out again.
 */
const sweptClone = Effect.fn("sweptClone")(function* (sandbox: Sandbox) {
	const fs = yield* FileSystem.FileSystem
	const origin = yield* repository(sandbox, "swept")
	yield* fs.writeFileString(
		`${origin}/package.json`,
		`{"name":"swept","private":true,"scripts":{"check":"sh \\"$GATE_PROBE\\""}}\n`
	)
	yield* fs.writeFileString(`${origin}/.gitattributes`, "paused.txt filter=pause\n")
	yield* fs.writeFileString(`${origin}/paused.txt`, "0\n")
	yield* committed(sandbox, origin, "a probed check")
	const clone = yield* cloneOf(sandbox, origin, "swept-c0")
	yield* gated(sandbox, clone, "mkdir -p node_modules && echo warm >node_modules/stamp-warm")
	yield* fs.writeFileString(`${clone}/paused.txt`, "1\n")
	yield* committed(sandbox, clone, "a change the snapshot has not seen")
	return clone
})

/** Writes a line into a FIFO, once a reader has it open. */
const signalled = (sandbox: Sandbox, path: string) =>
	sh(sandbox, sandbox.dir, "sh", "-c", `echo go >"$1"`, "sh", path)

/**
 * A run of the push gate on a clone's HEAD, as git sends a new branch, brought to the phase `sweep` draws; then the
 * clone meets its standing and another repository's run collects garbage beside it, and the run goes on. Answers the
 * run's status, what its check (at exit, the process it left) saw of the snapshot, the files of the clone's HEAD, and
 * whether the run's key directory was still there after the collect.
 */
export const sweptBeside = Effect.fn("sweptBeside")(function* (sandbox: Sandbox, sweep: Sweep) {
	const fs = yield* FileSystem.FileSystem
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const clone = yield* sweptClone(sandbox)
	const key = yield* onlyKey(sandbox)
	const otherOrigin = yield* repository(sandbox, "other")
	const other = yield* cloneOf(sandbox, otherOrigin, "other-c0")
	const go = yield* fifo(sandbox, "go")
	const seen = yield* fifo(sandbox, "seen")
	const probe = `${sandbox.dir}/probe.sh`
	yield* fs.writeFileString(probe, probeOf(sweep.phase, go, seen))
	const config = yield* configOf(sandbox, sweep.phase, go)
	const head = yield* Effect.map(sh(sandbox, clone, "git", "rev-parse", "HEAD"), Str.trim)
	const sent = yield* Deferred.make<void>()
	const handle = yield* spawner.spawn(
		ChildProcess.make("sh", [sandbox.gate, "push"], {
			cwd: clone,
			stdin: {
				stream: Stream.fromEffect(Deferred.await(sent)).pipe(
					Stream.map(() =>
						new TextEncoder().encode(
							`refs/heads/main ${head} refs/heads/main ${Str.repeat(40)("0")}\n`
						)
					)
				)
			},
			extendEnv: true,
			env: {
				...IDENTITY,
				GIT_CONFIG_GLOBAL: config,
				GATE_PROBE: probe,
				XDG_CACHE_HOME: sandbox.cache
			}
		})
	)
	const reached = yield* Deferred.make<void>()
	const ended = yield* Deferred.make<number>()
	const awaited = reachedLine(sweep.phase)
	yield* Effect.forkScoped(
		Stream.runForEach(Stream.splitLines(Stream.decodeText(handle.stderr)), (line) =>
			Option.exists(awaited, (start) => Str.startsWith(start)(line))
				? Deferred.succeed(reached, undefined)
				: Effect.void
		)
	)
	const stdout = yield* Effect.forkScoped(Stream.mkString(Stream.decodeText(handle.stdout)))
	yield* Effect.forkScoped(
		Effect.flatMap(handle.exitCode, (status) => Deferred.succeed(ended, status))
	)
	if (sweep.phase !== "before claiming") {
		yield* Deferred.succeed(sent, undefined)
	}
	yield* Option.match(awaited, {
		onNone: () => Deferred.await(ended),
		onSome: () =>
			Effect.raceFirst(
				Deferred.await(reached),
				Effect.flatMap(Deferred.await(ended), (status) =>
					Effect.sync(() =>
						assert.fail(`the run exited ${String(status)} before it was ${sweep.phase}`)
					)
				)
			)
	})
	if (sweep.clone === "re-pointed") {
		yield* sh(sandbox, clone, "git", "remote", "set-url", "origin", `${sandbox.dir}/elsewhere`)
	}
	yield* gated(sandbox, other, "true")
	const after = yield* keys(sandbox)
	const left = Arr.contains(after, key)
	switch (sweep.phase) {
		case "before claiming":
			yield* Deferred.succeed(sent, undefined)
			break
		case "while filling":
		case "while checking":
			yield* Effect.raceFirst(signalled(sandbox, go), Deferred.await(ended))
			break
		case "at exit":
			yield* signalled(sandbox, go)
			break
		case "exited":
			break
	}
	const status = yield* Deferred.await(ended)
	const looked =
		sweep.phase === "at exit"
			? yield* sh(sandbox, sandbox.dir, "cat", seen)
			: yield* Fiber.join(stdout)
	const tree = yield* treeOf(sandbox, clone)
	return { status, seen: seenOf(looked), tree, left }
})

/** How a push-mode run of the gate is called: by hand with nothing, as git calls the pre-push hook (the remote's name
 * and its URL, or a URL twice when the push names no remote), or as a lane mistook the pre-push script for the gate. */
export type PushCall =
	| "by hand"
	| "git, by remote"
	| "git, by URL"
	| "run index pnpm check"
	| "run index"

const PUSH_CALLS = [
	"by hand",
	"git, by remote",
	"git, by URL",
	"run index pnpm check",
	"run index"
] as const

/** Every way a push-mode run is called: five. */
export const pushCalls: Gen<PushCall> = (source) => source.draw(element(PUSH_CALLS))

/** Whether the gate takes a call, by its contract: git's arguments or none. */
export const takesCall = (call: PushCall): boolean => {
	switch (call) {
		case "by hand":
		case "git, by remote":
		case "git, by URL":
			return true
		case "run index pnpm check":
		case "run index":
			return false
	}
}

/** The situation a call is in. */
export type PushCallFeature =
	| "a run by hand with no arguments is taken"
	| "git's call by a remote's name is taken"
	| "git's call by a URL is taken"
	| "a lane's run index with a command is refused"
	| "a lane's run index alone, two arguments as git's are, is refused"

const PUSH_CALL_FEATURES: Readonly<Record<PushCall, PushCallFeature>> = {
	"by hand": "a run by hand with no arguments is taken",
	"git, by remote": "git's call by a remote's name is taken",
	"git, by URL": "git's call by a URL is taken",
	"run index pnpm check": "a lane's run index with a command is refused",
	"run index": "a lane's run index alone, two arguments as git's are, is refused"
}

/** The situations a call is in. */
export const pushCallFeatures = (call: PushCall): ReadonlyArray<PushCallFeature> => [
	PUSH_CALL_FEATURES[call]
]

/** The arguments of a call, in a clone of `origin`. */
const argumentsOf = (call: PushCall, origin: string): ReadonlyArray<string> => {
	switch (call) {
		case "by hand":
			return []
		case "git, by remote":
			return ["origin", origin]
		case "git, by URL":
			return [origin, origin]
		case "run index pnpm check":
			return ["run", "index", "pnpm", "check"]
		case "run index":
			return ["run", "index"]
	}
}

/** What the gate says when it refuses a push-mode call. */
export const REFUSED_CALL = "push takes git's pre-push arguments"

/** A push-mode run of the gate in a clone of `origin`, called as `call`, with no pre-push lines: its status and output. */
export const pushedAs = Effect.fn("pushedAs")(function* (
	sandbox: Sandbox,
	clone: string,
	origin: string,
	call: PushCall
) {
	return yield* ran(sandbox, clone, "sh", [sandbox.gate, "push", ...argumentsOf(call, origin)])
})

/** What a run of the push gate whose snapshot's lock was made again under it says as it stops (gate.sh held). */
const RELOCKED = "is no longer the file this run locked"

/** When a run of the push gate starts its check: the line it writes then. */
const CHECKING = "toolchain-gate: pnpm check on "

/**
 * A run of the push gate on a clone's HEAD, as git sends a new branch, whose check (the probe) waits on a FIFO; while
 * it waits, its snapshot's lock file is deleted and made again, held by another process when `heldAgain` (a later
 * run's claim) or by none, as a hand's rm or a collect that sees no hold would leave it; then the check ends, and the
 * run goes on to its affected properties. Answers the run's status, whether it said it stopped for its lock, and
 * whether it stamped a tree as passed.
 */
export const relockedRun = Effect.fn("relockedRun")(function* (
	sandbox: Sandbox,
	heldAgain: boolean
) {
	const fs = yield* FileSystem.FileSystem
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const origin = yield* repository(sandbox, "relocked")
	yield* fs.writeFileString(
		`${origin}/package.json`,
		`{"name":"relocked","private":true,"scripts":{"check":"sh \\"$GATE_PROBE\\""}}\n`
	)
	yield* committed(sandbox, origin, "a probed check")
	const clone = yield* cloneOf(sandbox, origin, "relocked-c0")
	const go = yield* fifo(sandbox, "go")
	const probe = `${sandbox.dir}/probe.sh`
	yield* fs.writeFileString(probe, `read _ <'${go}'\n`)
	const head = yield* Effect.map(sh(sandbox, clone, "git", "rev-parse", "HEAD"), Str.trim)
	const handle = yield* spawner.spawn(
		ChildProcess.make("sh", [sandbox.gate, "push"], {
			cwd: clone,
			stdin: {
				stream: Stream.make(
					new TextEncoder().encode(
						`refs/heads/main ${head} refs/heads/main ${Str.repeat(40)("0")}\n`
					)
				)
			},
			extendEnv: true,
			env: { ...IDENTITY, GATE_PROBE: probe, XDG_CACHE_HOME: sandbox.cache }
		})
	)
	const checking = yield* Deferred.make<void>()
	const said = yield* Effect.forkScoped(
		Stream.runFoldEffect(
			Stream.splitLines(Stream.decodeText(handle.stderr)),
			() => "",
			(text, line) =>
				Effect.as(
					Str.startsWith(CHECKING)(line) ? Deferred.succeed(checking, undefined) : Effect.void,
					`${text}${line}\n`
				)
		)
	)
	yield* Effect.forkScoped(Stream.runDrain(handle.stdout))
	yield* Deferred.await(checking)
	const key = yield* onlyKey(sandbox)
	const lock = pushLock(sandbox, key, 0)
	yield* fs.remove(lock)
	yield* heldAgain ? holding(sandbox, lock, "-x") : fs.writeFileString(lock, "")
	yield* signalled(sandbox, go)
	const status = yield* handle.exitCode
	const stderr = yield* Fiber.join(said)
	const stamps = yield* fs.readDirectory(`${sandbox.root}/${key}`)
	return {
		status: Number(status),
		refused: Str.includes(RELOCKED)(stderr),
		stamped: Arr.contains(stamps, "push.passed")
	}
})
