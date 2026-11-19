import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	Order,
	Path,
	type PlatformError,
	Stream
} from "effect"
import { ChildProcess } from "effect/process"
import { assert } from "#assert.ts"
import { array, boolean, element, type Gen } from "#gen.ts"
import type { RealPath } from "#mutate/mutated.ts"

/** Where a drawn file stands in the checkout. */
export const STATES = ["tracked", "untracked", "ignored", "deleted"] as const

export type State = (typeof STATES)[number]

/** The paths a checkout's files take. */
const PATHS = ["a.ts", "src/b.ts", "src/deep/c.ts", "docs/d.txt", "e.json"] as const

/** A checkout's submodule: none, one checked out, or one left uninitialized (an empty directory). */
export const SUBMODULES = ["no submodule", "a submodule", "an uninitialized submodule"] as const

/**
 * How the checkout's node_modules links its workspace package: relatively, as pnpm does, or by its absolute path into
 * the checkout.
 */
export const WORKSPACE_LINKS = ["a relative workspace link", "an absolute workspace link"] as const

/**
 * Where the checkout's installed package lives: in its own node_modules, or beside the checkout, in another clone's
 * install, which a relative link leaving the checkout reaches (a clone whose node_modules another clone's install made).
 */
export const INSTALLS = ["installed in the checkout", "installed beside the checkout"] as const

/**
 * A case: the checkout's files and their states, whether it holds a tracked symbolic link, its submodule, how its
 * node_modules links its workspace package and where its installed package lives, and whether the file a mutant
 * replaces (the workspace package's index.ts) is executable.
 */
export type Checkout = Readonly<{
	files: ReadonlyArray<Readonly<{ path: string; state: State }>>
	link: boolean
	submodule: (typeof SUBMODULES)[number]
	workspace: (typeof WORKSPACE_LINKS)[number]
	installed: (typeof INSTALLS)[number]
	executable: boolean
}>

export const checkoutGen: Gen<Checkout> = (source) => ({
	files: Arr.map(Arr.dedupe(source.draw(array(element(PATHS), { min: 1, max: 5 }))), (path) => ({
		path,
		state: source.draw(element(STATES))
	})),
	link: source.draw(boolean),
	submodule: source.draw(element(SUBMODULES)),
	workspace: source.draw(element(WORKSPACE_LINKS)),
	installed: source.draw(element(INSTALLS)),
	executable: source.draw(boolean)
})

/** Where the checkout at `directory` has its installed package's files, as the case says. */
export const installedAt = (directory: RealPath, checkout: Checkout): string => {
	switch (checkout.installed) {
		case "installed in the checkout":
			return `${directory}/node_modules/dep`
		case "installed beside the checkout":
			return `${directory}-beside/node_modules/dep`
	}
}

/** Runs git in `directory`, failing the case on a non-zero exit. */
const git = (directory: string, args: ReadonlyArray<string>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const handle = yield* ChildProcess.make(
				"git",
				["-c", "user.name=t", "-c", "user.email=t@t", "-c", "protocol.file.allow=always", ...args],
				{ cwd: directory, stdin: "ignore", extendEnv: true }
			)
			const [, , code] = yield* Effect.all(
				[Stream.runDrain(handle.stdout), Stream.runDrain(handle.stderr), handle.exitCode],
				{ concurrency: "unbounded" }
			)
			assert.deepEqual<{ git: ReadonlyArray<string>; code: number }>(
				{ git: args, code },
				{ git: args, code: 0 }
			)
		})
	)

/** Every regular file under `root`, by its path from it, with its text, outside node_modules and .git. */
export const filesIn = (
	root: string
): Effect.Effect<
	ReadonlyArray<readonly [string, string]>,
	PlatformError.PlatformError,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const walk = (
			relative: string
		): Effect.Effect<
			ReadonlyArray<readonly [string, string]>,
			PlatformError.PlatformError,
			FileSystem.FileSystem | Path.Path
		> =>
			Effect.gen(function* () {
				const entries = yield* fs.readDirectoryEntries(path.join(root, relative))
				const found = yield* Effect.forEach(entries, (entry) => {
					const at = relative === "" ? entry.name : `${relative}/${entry.name}`
					if (entry.name === "node_modules" || entry.name === ".git") {
						return Effect.succeed([])
					}
					if (entry.type === "Directory") {
						return walk(at)
					}
					return entry.type === "File"
						? Effect.map(fs.readFileString(path.join(root, at)), (text) => [[at, text] as const])
						: Effect.succeed([])
				})
				return Arr.flatten(found)
			})
		const found = yield* walk("")
		return Arr.sort(
			found,
			Order.mapInput(Order.String, ([at]: readonly [string, string]) => at)
		)
	})

/** A checkout as the case states it, with a workspace package, an installed package and its node_modules. */
export const made = (directory: RealPath, checkout: Checkout) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const write = (file: string, text: string) =>
			Effect.andThen(
				fs.makeDirectory(path.dirname(path.join(directory, file)), { recursive: true }),
				fs.writeFileString(path.join(directory, file), text)
			)
		yield* git(directory, ["init", "-q"])
		yield* write(".gitignore", "node_modules\nignored-*\n")
		yield* write("packages/pkg/package.json", `{"name":"@scope/pkg"}`)
		yield* write("packages/pkg/index.ts", "export const pkg = 1\n")
		for (const file of checkout.files) {
			const name = file.state === "ignored" ? `ignored-${path.basename(file.path)}` : file.path
			yield* write(name, `the text of ${file.path}`)
		}
		if (checkout.link) {
			yield* fs.symlink("packages/pkg/index.ts", path.join(directory, "linked.ts"))
		}
		if (checkout.submodule !== "no submodule") {
			const origin = `${directory}-sub`
			yield* fs.makeDirectory(origin)
			yield* git(origin, ["init", "-q"])
			yield* fs.writeFileString(path.join(origin, "sub.ts"), "the submodule's text")
			yield* git(origin, ["add", "."])
			yield* git(origin, ["commit", "-qm", "sub"])
			yield* git(directory, ["submodule", "add", "-q", origin, "vendor/sub"])
		}
		yield* git(directory, ["add", "."])
		const untracked = Arr.flatMap(checkout.files, (f) => (f.state === "untracked" ? [f.path] : []))
		if (Arr.isReadonlyArrayNonEmpty(untracked)) {
			yield* git(directory, ["reset", "-q", "--", ...untracked])
		}
		yield* git(directory, ["commit", "-qm", "checkout", "--allow-empty"])
		if (checkout.submodule === "an uninitialized submodule") {
			yield* git(directory, ["submodule", "deinit", "-q", "-f", "vendor/sub"])
		}
		for (const file of checkout.files) {
			if (file.state === "deleted") {
				yield* fs.remove(path.join(directory, file.path))
			}
		}
		if (checkout.executable) {
			yield* fs.chmod(path.join(directory, "packages/pkg/index.ts"), 0o755)
		}
		const installed = installedAt(directory, checkout)
		yield* fs.makeDirectory(installed, { recursive: true })
		yield* fs.writeFileString(path.join(installed, "index.js"), "export const dep = 1\n")
		yield* fs.makeDirectory(path.join(directory, "node_modules/@scope"), { recursive: true })
		yield* fs.symlink(
			checkout.workspace === "a relative workspace link"
				? "../../packages/pkg"
				: path.join(directory, "packages/pkg"),
			path.join(directory, "node_modules/@scope/pkg")
		)
		yield* fs.makeDirectory(path.join(directory, "packages/pkg/node_modules"), { recursive: true })
		yield* fs.symlink(
			path.relative(path.join(directory, "packages/pkg/node_modules"), installed),
			path.join(directory, "packages/pkg/node_modules/dep")
		)
	})

/** The inodes of the regular files under `root`, every directory walked and no link followed. */
const fileInodes = (
	root: string
): Effect.Effect<
	ReadonlyArray<bigint>,
	PlatformError.PlatformError,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const entries = yield* fs.readDirectoryEntries(root)
		const found = yield* Effect.forEach(entries, (entry) => {
			const at = path.join(root, entry.name)
			if (entry.type === "Directory") {
				return fileInodes(at)
			}
			return entry.type === "File"
				? Effect.map(fs.stat(at), (info) => Option.toArray(info.ino))
				: Effect.succeed([])
		})
		return Arr.flatten(found)
	})

/** How many distinct regular files the trees' home holds. */
export const filesHeld = (home: string) =>
	Effect.map(fileInodes(home), (inodes) => new Set(inodes).size)
