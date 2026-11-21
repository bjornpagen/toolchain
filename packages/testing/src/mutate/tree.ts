import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	Order,
	Path,
	Ref,
	Schema,
	type Scope,
	Stream,
	String as Str
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { type MutatedFile, type RealPath, realPathOf } from "#mutate/mutated.ts"
import { processScratch } from "#resources/scratch.ts"
import { toolchainTestCache } from "#runner/cache-home.ts"

/**
 * A worker tree: the repository's checkout again at `root`, for a property whose check runs the repository's code in
 * child processes (it needs Checkout.dir, checkout.ts), which no module hook of its worker reaches. The mutator puts
 * one mutant in the tree's place of its file and starts the property's workers in the tree, so every process they start
 * loads the mutant from disk. A tree holds every file git shows in the checkout (tracked, or untracked and not ignored,
 * each submodule's too) and each package's node_modules, and resolves every link as the checkout does.
 *
 * A tree owns its directories and its links, and no file: each of its files is a hard link to the run's base's (Base),
 * so a tree costs an inode a directory and a link, whatever the files hold. Its directories must be its own, since Node
 * and TypeScript name a module by its real path: under a directory linked to another's, an importer of the mutant's
 * file is that other directory's, and imports the file there, not the mutant. A hard link leaves the real path the
 * tree's.
 *
 * `compile` is the store of Node's compile cache its workers keep their entries in (runner/compile-cache.ts): the
 * run's own, in the trees' directory, removed with them, since a tree's path is new each run and no later run could
 * reuse what its processes compiled.
 */
export type Tree = Readonly<{ checkout: RealPath; base: RealPath; root: RealPath; compile: string }>

/** A worker tree could not be made or written. */
export class TreeFailed extends Schema.TaggedError<TreeFailed, { readonly brand: unique symbol }>()(
	"TreeFailed",
	{ message: Schema.String }
) {}

const failed = (message: string) => (cause: unknown) =>
	TreeFailed.make({ message: `${message}: ${String(cause)}` })

/** What git prints for `args` in `directory`. */
const gitOutput = Effect.fnUntraced(function* (directory: string, args: ReadonlyArray<string>) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const [output, exitCode] = yield* Effect.scoped(
		Effect.flatMap(
			spawner.spawn(
				ChildProcess.make("git", args, { cwd: directory, stdin: "ignore", stderr: "inherit" })
			),
			(handle) =>
				Effect.all([Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode], {
					concurrency: "unbounded"
				})
		)
	).pipe(Effect.mapError(failed(`git ${Arr.join(args, " ")} in ${directory} did not run`)))
	return exitCode === 0
		? output
		: yield* TreeFailed.make({
				message: `git ${Arr.join(args, " ")} exited ${String(exitCode)} in ${directory}`
			})
})

/** The paths git shows in `directory`, tracked or untracked but not ignored, relative to it. */
const gitShown = (directory: string) =>
	Effect.map(
		gitOutput(directory, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]),
		(output) => Arr.filter(Str.split("\u0000")(output), Str.isNonEmpty)
	)

/** A file of the checkout, by its path from the checkout, with its mode. */
type File = Readonly<{ path: string; mode: number }>

/** A link of a tree, by its path from the tree's root, and the text it holds. */
type Link = Readonly<{ path: string; text: string }>

/**
 * What the checkout holds at a path a tree makes: a file, or an entry a tree links to as the checkout resolves it (a
 * symbolic link, or an entry of node_modules a tree shares with the checkout).
 */
type Found = Readonly<{ kind: "file"; file: File }> | Readonly<{ kind: "link"; path: string }>

/**
 * What a run's trees hold, read from the checkout once and made again in every tree: its directories (each with every
 * directory above it), its files, and its links, by their paths from the root.
 */
type Layout = Readonly<{
	checkout: RealPath
	directories: ReadonlyArray<string>
	files: ReadonlyArray<File>
	links: ReadonlyArray<Link>
}>

/**
 * The files git shows under `relative` in the checkout, recursing into each submodule, which git shows as the one
 * directory of its gitlink; a path it shows that no longer exists (deleted in the working tree) is not the checkout's.
 * An uninitialized submodule is an empty directory, in which git shows its own gitlink as `./`: it holds no files.
 */
const filesUnder = (
	checkout: RealPath,
	relative: string
): Effect.Effect<
	ReadonlyArray<Found>,
	TreeFailed,
	FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const shown = yield* gitShown(path.join(checkout, relative))
		const found = yield* Effect.forEach(
			Arr.filter(shown, (entry) => entry !== "./"),
			(entry) =>
				Effect.gen(function* () {
					const at = path.join(relative, entry)
					const absolute = path.join(checkout, at)
					const linked = yield* fs.readLink(absolute).pipe(Effect.option)
					if (Option.isSome(linked)) {
						const link: Found = { kind: "link", path: at }
						return [link]
					}
					const info = yield* fs.stat(absolute).pipe(Effect.option)
					if (Option.isNone(info)) {
						return []
					}
					const file: Found = { kind: "file", file: { path: at, mode: info.value.mode } }
					return info.value.type === "Directory" ? yield* filesUnder(checkout, at) : [file]
				}),
			{ concurrency: "unbounded" }
		)
		return Arr.flatten(found)
	})

/** A node_modules directory as a tree holds it: the directories a tree makes for it, and each entry found in them. */
type Modules = Readonly<{ directories: ReadonlyArray<string>; found: ReadonlyArray<Found> }>

/** A package's node_modules where it has none. */
const noModules: Modules = { directories: [], found: [] }

/**
 * The node_modules directory `relative` of the checkout, as a tree holds it: its directories, and each entry found. A
 * scope (`@...`) and `.bin` are directories of the tree's, entry by entry alike, since what they link to is resolved
 * from where they stand (a workspace package's link, a bin's); every other entry (a package's link, an installed
 * package, pnpm's store) is a link, resolved as the checkout resolves it (linkOf). A file of `.bin` (pnpm's shim of a
 * bin whose command takes arguments or another interpreter, which finds its target from its own real directory) is a
 * file of the tree's, as a shown file is: linked to the checkout's, it ran the checkout's code from every tree, its
 * real directory the checkout's, so a mutant of a workspace package reached through its bin ran nowhere and its kills
 * went unjudged (metis's INSTALL-HANG, 2026-11-21: grizzle's CLI from a tree imported the checkout's grizzle, and the
 * tree's config "must be built by defineConfig").
 */
const modulesUnder = (
	checkout: RealPath,
	relative: string
): Effect.Effect<Modules, TreeFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const from = path.join(checkout, relative)
		const listed = yield* fs
			.readDirectoryEntries(from)
			.pipe(Effect.mapError(failed(`reading ${from}`)))
		const inBin = path.basename(relative) === ".bin"
		const under = yield* Effect.forEach(
			listed,
			(entry) => {
				const at = path.join(relative, entry.name)
				const linked: Modules = { directories: [], found: [{ kind: "link", path: at }] }
				if (inBin && entry.type === "File") {
					return Effect.mapBoth(fs.stat(path.join(checkout, at)), {
						onFailure: failed(`reading ${at}`),
						onSuccess: (info): Modules => ({
							directories: [],
							found: [{ kind: "file", file: { path: at, mode: info.mode } }]
						})
					})
				}
				return entry.type === "Directory" &&
					(Str.startsWith("@")(entry.name) || entry.name === ".bin")
					? modulesUnder(checkout, at)
					: Effect.succeed(linked)
			},
			{ concurrency: "unbounded" }
		)
		const modules: Modules = {
			directories: [relative, ...Arr.flatMap(under, (one) => one.directories)],
			found: Arr.flatMap(under, (one) => one.found)
		}
		return modules
	})

/** `relative` and every directory above it, to the root (`.`). */
const aboveAndAt = (path: Path.Path, relative: string): ReadonlyArray<string> =>
	relative === "." ? ["."] : [relative, ...aboveAndAt(path, path.dirname(relative))]

/**
 * A tree's link at `at`, the checkout's entry there as the checkout resolves it: where the tree holds the checkout's
 * real target, the path from the link to it in the tree, so a workspace package the checkout links to, however its link
 * is spelled, is the tree's own; anywhere else (outside the checkout, an installed package, a file git does not show),
 * the real target itself, so the tree reaches what the checkout reaches however it was installed. A link that
 * resolves to nothing in the checkout is the same link. The empty relative path is spelled `.` (path.normalize).
 */
const linkOf = (
	checkout: RealPath,
	held: ReadonlySet<string>,
	at: string
): Effect.Effect<Link, TreeFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		const absolute = path.join(checkout, at)
		const real = yield* fs.realPath(absolute).pipe(Effect.option)
		const text = yield* Option.match(real, {
			onNone: () => fs.readLink(absolute).pipe(Effect.mapError(failed(`reading ${at}`))),
			onSome: (target) => {
				const inTree = path.normalize(path.relative(checkout, target))
				return Effect.succeed(
					held.has(inTree) ? path.normalize(path.relative(path.dirname(at), inTree)) : target
				)
			}
		})
		const link: Link = { path: at, text }
		return link
	})

/**
 * The layout of a tree of `checkout`: every file git shows in the checkout, the directories that hold them, and the
 * node_modules of the checkout's root and of each directory that holds a package.json it shows (modulesUnder), each
 * link resolved as the checkout resolves it (linkOf).
 */
const layoutOf = Effect.fn("testing.mutate.layoutOf")(function* (checkout: RealPath) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const shown = yield* filesUnder(checkout, "")
	const packages = Arr.dedupe([
		".",
		...Arr.flatMap(shown, (one) =>
			one.kind === "file" && path.basename(one.file.path) === "package.json"
				? [path.dirname(one.file.path)]
				: []
		)
	])
	const modules = yield* Effect.forEach(
		Arr.sort(packages, Order.String),
		(directory) => {
			const relative = path.join(directory, "node_modules")
			const at = path.join(checkout, relative)
			return Effect.flatMap(
				fs.exists(at).pipe(Effect.mapError(failed(`reading ${at}`))),
				(present) => (present ? modulesUnder(checkout, relative) : Effect.succeed(noModules))
			)
		},
		{ concurrency: "unbounded" }
	)
	const found = [...shown, ...Arr.flatMap(modules, (module) => module.found)]
	const files = Arr.flatMap(found, (one) => (one.kind === "file" ? [one.file] : []))
	const linked = Arr.flatMap(found, (one) => (one.kind === "link" ? [one.path] : []))
	const placed = [...Arr.map(files, (file) => file.path), ...linked]
	const made = Arr.flatMap(modules, (module) => module.directories)
	const directories = Arr.dedupe([
		...Arr.flatMap(placed, (at) => aboveAndAt(path, path.dirname(at))),
		...Arr.flatMap(made, (at) => aboveAndAt(path, at))
	])
	const held = new Set([...directories, ...Arr.map(files, (file) => file.path)])
	const links = yield* Effect.forEach(linked, (at) => linkOf(checkout, held, at), {
		concurrency: "unbounded"
	})
	const layout: Layout = { checkout, directories, files, links }
	return layout
})

/**
 * A run's base: the checkout's files as the run's trees first need them, copied once at `root`, each without write
 * permission. Every tree's file is a hard link to the base's, so no tree holds a copy of its own, and a process of a
 * tree that writes a file it did not make, in place, is refused, where it would write every tree's file at once; the
 * checkout's files are never linked, so nothing a tree does reaches them.
 */
type Base = Readonly<{ layout: Layout; root: RealPath }>

/** The permission bits a base's file keeps of its checkout file's: all but write. */
const READ_ONLY = 0o7555

/** The base of `layout` at `root`, an empty directory. */
const baseOf = Effect.fnUntraced(function* (layout: Layout, root: RealPath) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	yield* Effect.forEach(
		Arr.dedupe(Arr.map(layout.files, (file) => path.dirname(file.path))),
		(directory) =>
			fs
				.makeDirectory(path.join(root, directory), { recursive: true })
				.pipe(Effect.mapError(failed(`mkdir ${directory}`))),
		{ concurrency: "unbounded", discard: true }
	)
	yield* Effect.forEach(
		layout.files,
		(file) => {
			const target = path.join(root, file.path)
			return Effect.andThen(
				fs.copyFile(path.join(layout.checkout, file.path), target),
				fs.chmod(target, file.mode & READ_ONLY)
			).pipe(Effect.mapError(failed(`copying ${file.path}`)))
		},
		{ concurrency: "unbounded", discard: true }
	)
	const base: Base = { layout, root }
	return base
})

/**
 * A new worker tree of `base` at `root`, an empty directory on the base's filesystem, whose workers keep their compile
 * cache in the run's store `compile`.
 */
const treeOf = Effect.fnUntraced(function* (base: Base, root: RealPath, compile: string) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	yield* Effect.forEach(
		base.layout.directories,
		(directory) =>
			fs
				.makeDirectory(path.join(root, directory), { recursive: true })
				.pipe(Effect.mapError(failed(`mkdir ${directory}`))),
		{ concurrency: "unbounded", discard: true }
	)
	yield* Effect.forEach(
		base.layout.files,
		(file) =>
			fs
				.link(path.join(base.root, file.path), path.join(root, file.path))
				.pipe(Effect.mapError(failed(`linking ${file.path}`))),
		{ concurrency: "unbounded", discard: true }
	)
	yield* Effect.forEach(
		base.layout.links,
		(link) =>
			fs
				.symlink(link.text, path.join(root, link.path))
				.pipe(Effect.mapError(failed(`linking ${link.path}`))),
		{ concurrency: "unbounded", discard: true }
	)
	const tree: Tree = { checkout: base.layout.checkout, base: base.root, root, compile }
	return tree
})

/** A checkout's file by its path from the checkout; a file outside the checkout has no place in a tree. */
const placeIn = (tree: Tree, target: RealPath) =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		const relative = path.relative(tree.checkout, target)
		return Str.startsWith("..")(relative) || path.isAbsolute(relative)
			? yield* TreeFailed.make({
					message: `${target} lies outside the checkout ${tree.checkout}, so no worker tree holds it`
				})
			: relative
	})

/**
 * The tree with `mutant` in its place of the mutant's file for the enclosing scope: the tree's link to the base's file
 * is replaced by a file of the mutant's own, with the base's file's mode (an executable stays one), never written
 * through, and the scope's close links the base's file there again, however the scope ends.
 */
export const mutantIn = Effect.fn("testing.mutate.mutantIn")(function* (
	tree: Tree,
	mutant: MutatedFile
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const relative = yield* placeIn(tree, mutant.target)
	const place = path.join(tree.root, relative)
	const own = path.join(tree.base, relative)
	yield* Effect.acquireRelease(
		Effect.gen(function* () {
			const info = yield* fs.stat(own)
			yield* fs.remove(place)
			yield* fs.writeFileString(place, mutant.text, { mode: info.mode & READ_ONLY })
		}).pipe(Effect.mapError(failed(`writing ${place}`))),
		() => Effect.orDie(Effect.andThen(fs.remove(place), fs.link(own, place)))
	)
})

/**
 * A run's worker trees, made as they are first needed and each used by one lease at a time: `take` lends a tree for the
 * enclosing scope, a free one or a new one, so a run makes as many as it ever uses at once, all of one layout and base,
 * read and copied from the checkout when the first tree is made. They live in a directory of toolchain-test's cache
 * (cache-home.ts), on a disk's filesystem, never a tmpfs whose inodes several runs' trees would spend, removed when the
 * run's scope closes or its process ends (processScratch).
 */
export type Trees = Readonly<{ take: Effect.Effect<Tree, TreeFailed, Scope.Scope> }>

/** The worker trees of a run over `checkout`. */
export const treesOf = Effect.fn("testing.mutate.treesOf")(function* (checkout: RealPath) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const services = yield* Effect.context<
		FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
	>()
	const cache = yield* toolchainTestCache.pipe(
		Effect.mapError(failed("reading toolchain-test's cache"))
	)
	yield* fs
		.makeDirectory(cache, { recursive: true })
		.pipe(Effect.mapError(failed(`mkdir ${cache}`)))
	const directory = yield* processScratch({ directory: cache, prefix: "trees-" }).pipe(
		Effect.mapError(failed("making the trees' directory"))
	)
	const home = yield* realPathOf(directory).pipe(Effect.mapError(failed(`reading ${directory}`)))
	const made = yield* Ref.make(0)
	const fresh = Effect.gen(function* () {
		const index = yield* Ref.getAndUpdate(made, (n) => n + 1)
		const at = path.join(home, String(index))
		yield* fs.makeDirectory(at).pipe(Effect.mapError(failed(`mkdir ${at}`)))
		return yield* realPathOf(at).pipe(Effect.mapError(failed(`reading ${at}`)))
	})
	const base = yield* Effect.cached(
		Effect.gen(function* () {
			const layout = yield* layoutOf(checkout)
			const root = yield* fresh
			return yield* baseOf(layout, root)
		})
	)
	const free = yield* Ref.make<ReadonlyArray<Tree>>([])
	const lent = Effect.flatMap(
		Ref.modify(free, (trees): readonly [Option.Option<Tree>, ReadonlyArray<Tree>] => [
			Arr.head(trees),
			Arr.drop(trees, 1)
		]),
		Option.match({
			onNone: () =>
				Effect.flatMap(Effect.all([base, fresh]), ([of, root]) =>
					treeOf(of, root, path.join(home, "compile"))
				),
			onSome: Effect.succeed
		})
	)
	const trees: Trees = {
		take: Effect.acquireRelease(Effect.provideContext(lent, services), (tree) =>
			Ref.update(free, Arr.append(tree))
		)
	}
	return trees
})
