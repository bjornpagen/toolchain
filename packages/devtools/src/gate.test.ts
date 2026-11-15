/**
 * The gate's snapshot cache (bin/gate.sh): one snapshot per repository, shared by every clone of it, with the objects
 * of the clone whose commit is checked, and a snapshot whose repository is gone collected.
 *
 * Each case builds a small repository with a submodule in a scratch directory and runs the gate over its clones with a
 * cache of its own (XDG_CACHE_HOME), so nothing here touches the real cache. Oracle: the specification: a command the
 * gate runs on a commit sees that commit's files, and a file a first run left under .gitignore (node_modules) is still
 * there for a second clone's first run, which is what a warm snapshot is.
 */
import { NodeServices } from "@effect/platform-node"
import { layer } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import { Array as Arr, Effect, FileSystem, Order, Path, Stream, String as Str } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

const GATE = new URL("../bin/gate.sh", import.meta.url).pathname

const IDENTITY: Readonly<Record<string, string>> = Object.freeze({
	GIT_AUTHOR_NAME: "gate-test",
	GIT_AUTHOR_EMAIL: "gate-test@localhost",
	GIT_COMMITTER_NAME: "gate-test",
	GIT_COMMITTER_EMAIL: "gate-test@localhost",
	GIT_ALLOW_PROTOCOL: "file"
})

type Scratch = Readonly<{ dir: string; cache: string; root: string }>

/** Runs a command to completion in a directory, answering its status and output, with the scratch's cache. */
const ran = Effect.fn("ran")(function* (
	scratch: Scratch,
	cwd: string,
	command: string,
	args: ReadonlyArray<string>
) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const [stdout, status] = yield* Effect.scoped(
		Effect.flatMap(
			spawner.spawn(
				ChildProcess.make(command, args, {
					cwd,
					stdin: "ignore",
					extendEnv: true,
					env: { ...IDENTITY, XDG_CACHE_HOME: scratch.cache }
				})
			),
			(handle) =>
				Effect.all([Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode], {
					concurrency: "unbounded"
				})
		)
	)
	return { stdout, status }
})

/** Runs a command that must succeed, answering its output. */
const sh = Effect.fn("sh")(function* (
	scratch: Scratch,
	cwd: string,
	command: string,
	...args: ReadonlyArray<string>
) {
	const { stdout, status } = yield* ran(scratch, cwd, command, args)
	deepStrictEqual(status, 0, `${command} ${Arr.join(args, " ")} exited ${status} in ${cwd}`)
	return stdout
})

/** The gate's run of a command on HEAD, in a clone. */
const gate = (scratch: Scratch, clone: string, ...command: ReadonlyArray<string>) =>
	ran(scratch, clone, "sh", [GATE, "run", "HEAD", ...command])

const gated = (scratch: Scratch, clone: string, ...command: ReadonlyArray<string>) =>
	Effect.map(gate(scratch, clone, ...command), ({ stdout }) => stdout)

/** A repository of one file under a workspace and a lockfile, committed. */
const repository = Effect.fn("repository")(function* (scratch: Scratch, name: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const directory = path.join(scratch.dir, name)
	yield* fs.makeDirectory(directory)
	yield* sh(scratch, directory, "git", "init", "-q", "-b", "main")
	yield* fs.writeFileString(path.join(directory, ".gitignore"), "node_modules\n")
	yield* fs.writeFileString(
		path.join(directory, "package.json"),
		`{"name":"${name}","private":true}\n`
	)
	yield* fs.writeFileString(path.join(directory, "pnpm-workspace.yaml"), "packages: []\n")
	yield* sh(scratch, directory, "pnpm", "install", "--lockfile-only", "--reporter=silent")
	return directory
})

const committed = (scratch: Scratch, directory: string, message: string) =>
	sh(scratch, directory, "git", "add", ".").pipe(
		Effect.andThen(sh(scratch, directory, "git", "commit", "-qm", message))
	)

/** A repository with a submodule, and two clones of it. */
const cloned = Effect.fn("cloned")(function* (scratch: Scratch) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const sub = path.join(scratch.dir, "sub")
	yield* fs.makeDirectory(sub)
	yield* sh(scratch, sub, "git", "init", "-q", "-b", "main")
	yield* fs.writeFileString(path.join(sub, "s.txt"), "submodule\n")
	yield* committed(scratch, sub, "sub")
	const origin = yield* repository(scratch, "origin")
	yield* sh(scratch, origin, "git", "submodule", "add", "-q", sub, "sub")
	yield* committed(scratch, origin, "origin")
	yield* sh(scratch, scratch.dir, "git", "clone", "-q", "--recurse-submodules", origin, "a")
	yield* sh(scratch, scratch.dir, "git", "clone", "-q", "--recurse-submodules", origin, "b")
	return { a: path.join(scratch.dir, "a"), b: path.join(scratch.dir, "b") }
})

/** The cache's key directories, the ones a run made visible, in name order. */
const keys = Effect.fn("keys")(function* (scratch: Scratch) {
	const fs = yield* FileSystem.FileSystem
	const names = yield* fs.readDirectory(scratch.root)
	return Arr.sort(
		Arr.filter(names, (name) => !Str.startsWith(".")(name)),
		Order.String
	)
})

const scratched = <A, E, R>(body: (scratch: Scratch) => Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const dir = yield* fs.makeTempDirectoryScoped({ prefix: "toolchain-gate-test-" })
		const cache = path.join(dir, "xdg")
		return yield* body({ dir, cache, root: path.join(cache, "toolchain-gate") })
	}).pipe(Effect.scoped)

layer(NodeServices.layer)("the gate's snapshot cache", (it) => {
	it.effect("shares one snapshot between clones of a repository, warm for the second", () =>
		scratched((scratch) =>
			Effect.gen(function* () {
				const { a, b } = yield* cloned(scratch)
				yield* gate(
					scratch,
					a,
					"sh",
					"-c",
					"mkdir -p node_modules && echo first >node_modules/stamp"
				)
				const seen = yield* gated(scratch, b, "cat", "node_modules/stamp")
				deepStrictEqual(seen, "first\n")
				deepStrictEqual((yield* keys(scratch)).length, 1)
			})
		)
	)

	it.effect("checks a commit in a clone against that clone's tree and objects", () =>
		scratched((scratch) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem.FileSystem
				const path = yield* Path.Path
				const { a, b } = yield* cloned(scratch)
				yield* gate(scratch, a, "true")
				yield* fs.writeFileString(path.join(b, "only-b.txt"), "b\n")
				yield* committed(scratch, b, "b")
				const seen = yield* gated(scratch, b, "cat", "only-b.txt")
				deepStrictEqual(seen, "b\n")
				const [key = ""] = yield* keys(scratch)
				const alternates = yield* fs.readFileString(
					path.join(scratch.root, key, "push.git", "objects", "info", "alternates")
				)
				deepStrictEqual(Str.trim(alternates), path.join(b, ".git", "objects"))
				const back = yield* gate(scratch, a, "cat", "only-b.txt")
				deepStrictEqual(
					back.status !== 0,
					true,
					"clone A's commit lacks only-b.txt, so the snapshot must too"
				)
			})
		)
	)

	it.effect("fills a submodule at the commit the snapshot records", () =>
		scratched((scratch) =>
			Effect.gen(function* () {
				const { a } = yield* cloned(scratch)
				const seen = yield* gated(scratch, a, "cat", "sub/s.txt")
				deepStrictEqual(seen, "submodule\n")
			})
		)
	)

	it.effect(
		"collects a snapshot whose repository is gone, and keeps a held one and the old per-path layout an older gate may be running in",
		() =>
			scratched((scratch) =>
				Effect.gen(function* () {
					const fs = yield* FileSystem.FileSystem
					const path = yield* Path.Path
					const { a, b } = yield* cloned(scratch)
					yield* gate(scratch, a, "true")
					const [live = ""] = yield* keys(scratch)
					const other = yield* repository(scratch, "other")
					yield* committed(scratch, other, "other")
					yield* gate(scratch, other, "true")
					deepStrictEqual((yield* keys(scratch)).length, 2)
					yield* fs.makeDirectory(path.join(scratch.root, "0123456789ab", "commit"), {
						recursive: true
					})
					const held = path.join(scratch.root, "ba9876543210", "commit.lock")
					yield* fs.makeDirectory(held, { recursive: true })
					yield* fs.writeFileString(path.join(held, "pid"), `${process.pid}\n`)
					yield* fs.remove(other, { recursive: true })
					yield* gate(scratch, b, "true")
					const left = yield* keys(scratch)
					deepStrictEqual(left, Arr.sort([live, "0123456789ab", "ba9876543210"], Order.String))
				})
			)
	)
})
