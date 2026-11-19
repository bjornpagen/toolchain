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

/**
 * A worker tree: a copy of a repository's checkout at `root`, for a property whose check runs the repository's code in
 * child processes (it needs Checkout.dir, checkout.ts), which no module hook of its worker reaches. The mutator writes
 * one mutant into the tree's copy of its file and starts the property's workers in the tree, so every process they
 * start loads the mutant from disk. A tree holds every file git shows in the checkout (tracked, or untracked and not
 * ignored, each submodule's too) and each package's node_modules, whose links to the workspace's own packages resolve
 * in the tree and whose installed packages are the checkout's, shared.
 */
export type Tree = Readonly<{ checkout: RealPath; root: RealPath }>

/** A worker tree could not be made or written. */
export class TreeFailed extends Schema.TaggedError<TreeFailed, { readonly brand: unique symbol }>()(
	"TreeFailed",
	{ message: Schema.String }
) {}

const failed = (message: string) => (cause: unknown) =>
	TreeFailed.make({ message: `${message}: ${String(cause)}` })

/** The paths git shows in `directory`, tracked or untracked but not ignored, relative to it. */
const gitShown = Effect.fnUntraced(function* (directory: string) {
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
	const [output, exitCode] = yield* Effect.scoped(
		Effect.flatMap(
			spawner.spawn(
				ChildProcess.make("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
					cwd: directory,
					stdin: "ignore",
					stderr: "inherit"
				})
			),
			(handle) =>
				Effect.all([Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode], {
					concurrency: "unbounded"
				})
		)
	).pipe(Effect.mapError(failed(`git ls-files in ${directory} did not run`)))
	return exitCode === 0
		? Arr.filter(Str.split("\u0000")(output), Str.isNonEmpty)
		: yield* TreeFailed.make({ message: `git ls-files exited ${String(exitCode)} in ${directory}` })
})

/** A file of a checkout, by its path relative to the checkout, and whether it is a symbolic link. */
type Shown = Readonly<{ path: string; link: boolean }>

/**
 * The files git shows under `relative` in the checkout, recursing into each submodule, which git shows as the one
 * directory of its gitlink; a path it shows that no longer exists (deleted in the working tree) is not the checkout's.
 * An uninitialized submodule is an empty directory, in which git shows its own gitlink as `./`: it holds no files.
 */
const filesUnder = (
	checkout: RealPath,
	relative: string
): Effect.Effect<
	ReadonlyArray<Shown>,
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
						return [{ path: at, link: true }]
					}
					const info = yield* fs.stat(absolute).pipe(Effect.option)
					if (Option.isNone(info)) {
						return []
					}
					return info.value.type === "Directory"
						? yield* filesUnder(checkout, at)
						: [{ path: at, link: false }]
				}),
			{ concurrency: "unbounded" }
		)
		return Arr.flatten(found)
	})

/**
 * Recreates the node_modules directory `from` at `to`: a symbolic link as the same link, so a workspace package's
 * relative link resolves to the tree's copy of the package; a scope (`@...`) and `.bin` as directories of their own,
 * entry by entry alike; and every other entry, an installed package or pnpm's store, as a link to the checkout's.
 */
const modulesInto = (
	from: string,
	to: string
): Effect.Effect<void, TreeFailed, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const path = yield* Path.Path
		yield* fs.makeDirectory(to, { recursive: true }).pipe(Effect.mapError(failed(`mkdir ${to}`)))
		const entries = yield* fs
			.readDirectoryEntries(from)
			.pipe(Effect.mapError(failed(`reading ${from}`)))
		yield* Effect.forEach(
			entries,
			(entry) => {
				const source = path.join(from, entry.name)
				const target = path.join(to, entry.name)
				if (entry.type === "SymbolicLink") {
					return Effect.flatMap(fs.readLink(source), (link) => fs.symlink(link, target)).pipe(
						Effect.mapError(failed(`linking ${target}`))
					)
				}
				return entry.type === "Directory" &&
					(Str.startsWith("@")(entry.name) || entry.name === ".bin")
					? modulesInto(source, target)
					: fs.symlink(source, target).pipe(Effect.mapError(failed(`linking ${target}`)))
			},
			{ concurrency: "unbounded", discard: true }
		)
	})

/**
 * A new worker tree of `checkout` at `root`, an empty directory: every file git shows in the checkout, copied (a
 * symbolic link as the same link), and the node_modules of the checkout's root and of each directory that holds a
 * package.json it copied (modulesInto).
 */
export const treeOf = Effect.fn("testing.mutate.treeOf")(function* (
	checkout: RealPath,
	root: RealPath
) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const files = yield* filesUnder(checkout, "")
	const directories = Arr.dedupe(Arr.map(files, (file) => path.dirname(file.path)))
	yield* Effect.forEach(
		directories,
		(directory) =>
			fs
				.makeDirectory(path.join(root, directory), { recursive: true })
				.pipe(Effect.mapError(failed(`mkdir ${directory}`))),
		{ concurrency: "unbounded", discard: true }
	)
	yield* Effect.forEach(
		files,
		(file) => {
			const source = path.join(checkout, file.path)
			const target = path.join(root, file.path)
			return (
				file.link
					? Effect.flatMap(fs.readLink(source), (link) => fs.symlink(link, target))
					: fs.copyFile(source, target)
			).pipe(Effect.mapError(failed(`copying ${file.path}`)))
		},
		{ concurrency: "unbounded", discard: true }
	)
	const packages = Arr.dedupe([
		".",
		...Arr.flatMap(files, (file) =>
			path.basename(file.path) === "package.json" ? [path.dirname(file.path)] : []
		)
	])
	yield* Effect.forEach(
		Arr.sort(packages, Order.String),
		(directory) => {
			const modules = path.join(checkout, directory, "node_modules")
			return Effect.flatMap(
				fs.exists(modules).pipe(Effect.mapError(failed(`reading ${modules}`))),
				(present) =>
					present ? modulesInto(modules, path.join(root, directory, "node_modules")) : Effect.void
			)
		},
		{ concurrency: "unbounded", discard: true }
	)
	const tree: Tree = { checkout, root }
	return tree
})

/** Where a checkout's file stands in a tree; a file outside the checkout has no place there. */
const placeIn = (tree: Tree, target: RealPath) =>
	Effect.gen(function* () {
		const path = yield* Path.Path
		const relative = path.relative(tree.checkout, target)
		return Str.startsWith("..")(relative) || path.isAbsolute(relative)
			? yield* TreeFailed.make({
					message: `${target} lies outside the checkout ${tree.checkout}, so no worker tree holds it`
				})
			: path.join(tree.root, relative)
	})

/**
 * The tree with `mutant` written into its copy of the mutant's file for the enclosing scope, whose close writes the
 * file's own text back, however the scope ends.
 */
export const mutantIn = Effect.fn("testing.mutate.mutantIn")(function* (
	tree: Tree,
	mutant: MutatedFile
) {
	const fs = yield* FileSystem.FileSystem
	const place = yield* placeIn(tree, mutant.target)
	const own = yield* fs.readFileString(place).pipe(Effect.mapError(failed(`reading ${place}`)))
	yield* Effect.acquireRelease(
		fs.writeFileString(place, mutant.text).pipe(Effect.mapError(failed(`writing ${place}`))),
		() => Effect.orDie(fs.writeFileString(place, own))
	)
})

/**
 * A run's worker trees, made as they are first needed and each used by one lease at a time: `take` lends a tree for the
 * enclosing scope, a free one or a new one, so a run makes as many as it ever uses at once. They live in a directory of
 * the run's scope, removed when it closes.
 */
export type Trees = Readonly<{ take: Effect.Effect<Tree, TreeFailed, Scope.Scope> }>

/** The worker trees of a run over `checkout`. */
export const treesOf = Effect.fn("testing.mutate.treesOf")(function* (checkout: RealPath) {
	const fs = yield* FileSystem.FileSystem
	const path = yield* Path.Path
	const services = yield* Effect.context<
		FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
	>()
	const directory = yield* processScratch("toolchain-trees-").pipe(
		Effect.mapError(failed("making the trees' directory"))
	)
	const home = yield* realPathOf(directory).pipe(Effect.mapError(failed(`reading ${directory}`)))
	const free = yield* Ref.make<ReadonlyArray<Tree>>([])
	const made = yield* Ref.make(0)
	const fresh = Effect.gen(function* () {
		const index = yield* Ref.getAndUpdate(made, (n) => n + 1)
		const at = path.join(home, String(index))
		yield* fs.makeDirectory(at).pipe(Effect.mapError(failed(`mkdir ${at}`)))
		const root = yield* realPathOf(at).pipe(Effect.mapError(failed(`reading ${at}`)))
		return yield* treeOf(checkout, root)
	})
	const lent = Effect.flatMap(
		Ref.modify(free, (trees): readonly [Option.Option<Tree>, ReadonlyArray<Tree>] => [
			Arr.head(trees),
			Arr.drop(trees, 1)
		]),
		Option.match({ onNone: () => fresh, onSome: Effect.succeed })
	)
	const trees: Trees = {
		take: Effect.acquireRelease(Effect.provideContext(lent, services), (tree) =>
			Ref.update(free, Arr.append(tree))
		)
	}
	return trees
})
