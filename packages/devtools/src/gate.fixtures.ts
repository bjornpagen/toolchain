import { pid } from "node:process"
import { deepStrictEqual, fail } from "@bjornpagen/testing/assert"
import { array, boolean, element, type Gen, int } from "@bjornpagen/testing/gen"
import {
	Array as Arr,
	Effect,
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

const GATE = new URL("../bin/gate.sh", import.meta.url).pathname

/** The environment every command of a case runs with: a git identity, local file transport for submodules, and no
 * global or system git configuration. */
const IDENTITY: Readonly<Record<string, string>> = Object.freeze({
	GIT_AUTHOR_NAME: "gate-test",
	GIT_AUTHOR_EMAIL: "gate-test@localhost",
	GIT_COMMITTER_NAME: "gate-test",
	GIT_COMMITTER_EMAIL: "gate-test@localhost",
	GIT_ALLOW_PROTOCOL: "file",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1"
})

/** A case's sandbox, in its scratch directory: the directory its repositories are made in, its gate cache
 * (XDG_CACHE_HOME), and the cache's root, where the key directories are. */
type Sandbox = Readonly<{ dir: string; cache: string; root: string }>

/** The sandbox in a case's scratch directory. */
export const sandboxOf = (dir: string): Sandbox => ({
	dir,
	cache: `${dir}/xdg`,
	root: `${dir}/xdg/toolchain-gate`
})

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
const sh = Effect.fn("sh")(function* (
	sandbox: Sandbox,
	cwd: string,
	command: string,
	...args: ReadonlyArray<string>
) {
	const done = yield* ran(sandbox, cwd, command, args)
	deepStrictEqual(
		done.status,
		0,
		`${command} ${Arr.join(args, " ")} exited ${String(done.status)} in ${cwd}: ${done.stderr}`
	)
	return done.stdout
})

/** The gate's run of a shell script on HEAD's commit, in a clone, which must succeed. */
const gated = Effect.fn("gated")(function* (sandbox: Sandbox, clone: string, script: string) {
	const done = yield* ran(sandbox, clone, "sh", [GATE, "run", "HEAD", "sh", "-c", script])
	deepStrictEqual(
		done.status,
		0,
		`the gate's run in ${clone} exited ${String(done.status)}: ${done.stderr}`
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
	yield* fs.writeFileString(path.join(directory, ".gitignore"), "node_modules\n")
	yield* fs.writeFileString(
		path.join(directory, "package.json"),
		`{"name":"${name}","private":true}\n`
	)
	yield* fs.writeFileString(path.join(directory, "pnpm-workspace.yaml"), "packages: []\n")
	yield* fs.writeFileString(path.join(directory, "README.txt"), `${name}\n`)
	yield* sh(sandbox, directory, "pnpm", "install", "--lockfile-only", "--reporter=silent")
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
 * names, and a stray file .gitignore does not name, each named after the run. */
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
			...(leaves.stray ? [`echo ${run} >stray-${run}.txt`] : [])
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
		return fail(`the cache holds one key directory, not [${Arr.join(made, ", ")}]`)
	}
	return only
})

/** The common git directories a key directory's clones file lists, in its order. */
export const clonesListed = Effect.fn("clonesListed")(function* (sandbox: Sandbox, key: string) {
	const fs = yield* FileSystem.FileSystem
	const text = yield* fs.readFileString(`${sandbox.root}/${key}/clones`)
	return Arr.filter(Str.split("\n")(text), Str.isNonEmpty)
})

/** The objects directory a key directory's push snapshot borrows (its alternates). */
export const alternatesOf = Effect.fn("alternatesOf")(function* (sandbox: Sandbox, key: string) {
	const fs = yield* FileSystem.FileSystem
	const text = yield* fs.readFileString(`${sandbox.root}/${key}/push.git/objects/info/alternates`)
	return Str.trim(text)
})

/** A clone's common git directory, as the gate lists it. */
export const commonDirectory = (clone: string): string => `${clone}/.git`

/** A clone's objects, which the snapshot borrows while a run checks the clone's commit. */
export const objectsOf = (clone: string): string => `${clone}/.git/objects`

/** Between one and `max` items of `item`: the first drawn alone, so the array is never empty. */
const nonEmpty =
	<A>(item: Gen<A>, max: number): Gen<Arr.NonEmptyReadonlyArray<A>> =>
	(source) => [source.draw(item), ...source.draw(array(item, { min: 0, max: max - 1 }))]

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

/**
 * Clones of one repository and the gate's runs in them, in order: each run names the clone it runs in, by its place
 * among the clones, and whether its command leaves a stamp under node_modules, which .gitignore names.
 */
export type Sharing = Readonly<{
	clones: number
	runs: Arr.NonEmptyReadonlyArray<Readonly<{ clone: number; stamps: boolean }>>
}>

/** Up to three clones and up to four runs among them. */
export const sharings: Gen<Sharing> = (source) => {
	const clones = source.draw(int(1, 3))
	return {
		clones,
		runs: source.draw(
			nonEmpty(
				(inner) => ({ clone: inner.draw(int(0, clones - 1)), stamps: inner.draw(boolean) }),
				4
			)
		)
	}
}

/** The situations a Sharing puts the cache in. */
export type SharingFeature =
	| "a second clone's first run finds what a first run left under .gitignore"
	| "a clone runs again after another clone's run"
	| "three clones share one snapshot"

/** The situations each run of a Sharing is in. */
export const sharingFeatures = (sharing: Sharing): ReadonlyArray<SharingFeature> => [
	...Arr.flatMap(sharing.runs, (run, index): ReadonlyArray<SharingFeature> => {
		const earlier = before(sharing.runs, index)
		const ranHere = Arr.some(earlier, (one) => one.clone === run.clone)
		return [
			...(!ranHere && Arr.some(earlier, (one) => one.stamps && one.clone !== run.clone)
				? ["a second clone's first run finds what a first run left under .gitignore" as const]
				: []),
			...(ranHere && Option.exists(previous(sharing.runs, index), (one) => one.clone !== run.clone)
				? ["a clone runs again after another clone's run" as const]
				: [])
		]
	}),
	...(Arr.dedupe(Arr.map(sharing.runs, (run) => run.clone)).length === 3
		? ["three clones share one snapshot" as const]
		: [])
]

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
 * names its clone, and whether its command leaves a stray file .gitignore does not name.
 */
export type Checking = Readonly<{
	clones: Arr.NonEmptyReadonlyArray<CheckedClone>
	runs: Arr.NonEmptyReadonlyArray<Readonly<{ clone: number; strays: boolean }>>
}>

/** Up to three clones and up to four runs among them. */
export const checkings: Gen<Checking> = (source) => {
	const clones = source.draw(
		nonEmpty((inner) => ({ ownFile: inner.draw(boolean), edited: inner.draw(boolean) }), 3)
	)
	return {
		clones,
		runs: source.draw(
			nonEmpty(
				(inner) => ({
					clone: inner.draw(int(0, clones.length - 1)),
					strays: inner.draw(boolean)
				}),
				4
			)
		)
	}
}

/** The situations a Checking puts the snapshot in. */
export type CheckingFeature =
	| "a commit checked after another clone's different commit"
	| "a commit lacking a file the commit checked before held"
	| "a working tree with edits it has not committed"
	| "a stray file an earlier run left"

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
				? ["a stray file an earlier run left" as const]
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

/** A submodule of up to three versions, up to two clones and up to three runs among them. */
export const fillings: Gen<Filling> = (source) => {
	const versions = source.draw(int(1, 3))
	const version = int(0, versions - 1)
	const clones = source.draw(
		nonEmpty((inner) => ({ committed: inner.draw(version), checkedOut: inner.draw(version) }), 2)
	)
	return {
		versions,
		recorded: source.draw(version),
		clones,
		runs: source.draw(nonEmpty(int(0, clones.length - 1), 3))
	}
}

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

/** A lock in a key directory: none, or one on a snapshot whose pid file names a live process or one that has exited. */
export type Lock =
	| Readonly<{ kind: "none" }>
	| Readonly<{ kind: "live" | "stale"; snapshot: "commit" | "push" }>

/**
 * A key directory of the cache beside the repository a run checks: the clones of another repository that ran the gate,
 * keyed by that repository's URL; a repository with no origin remote that ran the gate, keyed by its own path; or a
 * directory of the old per-path layout, with no clones file, held by a live run or not.
 */
export type Entry =
	| Readonly<{ kind: "clones"; fates: Arr.NonEmptyReadonlyArray<Fate>; lock: Lock }>
	| Readonly<{ kind: "repository"; fate: Fate; lock: Lock }>
	| Readonly<{ kind: "old layout"; held: boolean }>

const fateGen: Gen<Fate> = element(["present", "removed", "re-pointed"] as const)

const lockGen: Gen<Lock> = (source) => {
	const kind = source.draw(element(["none", "live", "stale"] as const))
	return kind === "none"
		? { kind }
		: { kind, snapshot: source.draw(element(["commit", "push"] as const)) }
}

const entryGen: Gen<Entry> = (source) => {
	const kind = source.draw(element(["clones", "repository", "old layout"] as const))
	switch (kind) {
		case "clones":
			return { kind, fates: source.draw(nonEmpty(fateGen, 2)), lock: source.draw(lockGen) }
		case "repository":
			return { kind, fate: source.draw(fateGen), lock: source.draw(lockGen) }
		case "old layout":
			return { kind, held: source.draw(boolean) }
	}
}

/** Up to three key directories beside the one the run checks. */
export const collectings: Gen<Arr.NonEmptyReadonlyArray<Entry>> = nonEmpty(entryGen, 3)

/** The fates of the clones a key directory lists, or none for one of the old layout, which lists none. */
const fatesOf = (entry: Entry): ReadonlyArray<Fate> => {
	switch (entry.kind) {
		case "clones":
			return entry.fates
		case "repository":
			return [entry.fate]
		case "old layout":
			return []
	}
}

/**
 * Whether a run keeps a key directory, by the gate's contract: a directory of the old layout always (an older gate may
 * be running in it), and any other while one of the clones it lists is still there under its key or a live run holds
 * one of its locks.
 */
export const kept = (entry: Entry): boolean =>
	entry.kind === "old layout" ||
	Arr.contains(fatesOf(entry), "present") ||
	entry.lock.kind === "live"

/** The situations a key directory is in. */
export type CollectingFeature =
	| "a key directory whose clones are all gone is collected"
	| "a key directory kept by a clone still there among gone ones"
	| "a key directory whose clones are gone kept by a live lock"
	| "a stale lock keeps nothing"
	| "a re-pointed clone counts as gone"
	| "a repository with no origin remote, keyed by its path"
	| "an old-layout directory left alone"
	| "a held old-layout directory left alone"

/** The situations an entry is in. */
const entryFeatures = (entry: Entry): ReadonlyArray<CollectingFeature> => {
	if (entry.kind === "old layout") {
		return [
			entry.held ? "a held old-layout directory left alone" : "an old-layout directory left alone"
		]
	}
	const fates = fatesOf(entry)
	const gone = !Arr.contains(fates, "present")
	return [
		...(kept(entry) ? [] : ["a key directory whose clones are all gone is collected" as const]),
		...(!gone && !Arr.every(fates, (fate) => fate === "present")
			? ["a key directory kept by a clone still there among gone ones" as const]
			: []),
		...(gone && entry.lock.kind === "live"
			? ["a key directory whose clones are gone kept by a live lock" as const]
			: []),
		...(gone && entry.lock.kind === "stale" ? ["a stale lock keeps nothing" as const] : []),
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

/** A pid no process holds any more: a shell's, after it exited. */
const exitedPid = (sandbox: Sandbox) =>
	Effect.map(sh(sandbox, sandbox.dir, "sh", "-c", "echo $$"), Str.trim)

/** Holds a lock in a key directory: a pid file naming this process, or a process that has exited. */
const locked = Effect.fn("locked")(function* (sandbox: Sandbox, key: string, lock: Lock) {
	const fs = yield* FileSystem.FileSystem
	if (lock.kind === "none") {
		return
	}
	const held = `${sandbox.root}/${key}/${lock.snapshot}.lock`
	yield* fs.makeDirectory(held, { recursive: true })
	const holder = lock.kind === "live" ? String(pid) : yield* exitedPid(sandbox)
	yield* fs.writeFileString(`${held}/pid`, `${holder}\n`)
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
		return fail(`one repository makes one key directory, not [${Arr.join(made, ", ")}]`)
	}
	return only
})

/**
 * A key directory beside the repository a run checks, as the entry at `index` draws it. The clones of a repository
 * register under its URL, a run of the gate in each, and a repository with no remote under its path, by a run in
 * itself; a directory of the old layout is made as an older gate left it, a snapshot and no clones file.
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
			const origin = yield* repository(sandbox, name)
			const clones = yield* Effect.forEach(entry.fates, (_, at) =>
				cloneOf(sandbox, origin, `${name}c${String(at)}`)
			)
			yield* Effect.forEach(clones, (clone) => gated(sandbox, clone, "true"))
			const key = yield* madeSince(sandbox, listed)
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
		case "old layout": {
			const key = `00000000000${String(index)}`
			yield* fs.makeDirectory(`${sandbox.root}/${key}/commit`, { recursive: true })
			const made: Registered = { entry, key, registrants: [] }
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
		case "old layout":
			return yield* locked(
				sandbox,
				made.key,
				entry.held ? { kind: "live", snapshot: "commit" } : { kind: "none" }
			)
	}
})
