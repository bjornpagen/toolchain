/**
 * Worker trees (mutate/tree.ts): a tree holds exactly the files git shows in the checkout, tracked or untracked and not
 * ignored, a submodule's included and a file deleted from the working tree left out, each with its text, a symbolic
 * link as the same link; its node_modules resolve a workspace package to the tree's own copy and an installed package
 * to the checkout's; and a mutant written into a tree stands there, and only there, until its scope closes and the
 * file's own text is back. Oracle: the specification, stated in the search.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { layer } from "@effect/vitest"
import { deepStrictEqual } from "@effect/vitest/utils"
import {
	Array as Arr,
	Duration,
	Effect,
	FileSystem,
	Formatter,
	Order,
	Path,
	type PlatformError,
	Stream,
	String as Str
} from "effect"
import { ChildProcess } from "effect/process"
import { drawn, explore } from "#explore.ts"
import { required } from "#features.ts"
import { array, boolean, element, type Gen } from "#gen.ts"
import { type RealPath, realPathOf } from "#mutate/mutated.ts"
import { mutantIn, treeOf } from "#mutate/tree.ts"
import { notesOnly } from "#sense.ts"
import { boundedShrink } from "#shrink.ts"
import { searched } from "#vitest/searched.ts"

/** Where a drawn file stands in the checkout. */
const STATES = ["tracked", "untracked", "ignored", "deleted"] as const

type State = (typeof STATES)[number]

/** The paths a checkout's files take. */
const PATHS = ["a.ts", "src/b.ts", "src/deep/c.ts", "docs/d.txt", "e.json"] as const

/** A case: the checkout's files and their states, whether it holds a tracked symbolic link, and a submodule. */
type Checkout = Readonly<{
	files: ReadonlyArray<Readonly<{ path: string; state: State }>>
	link: boolean
	submodule: boolean
}>

const checkoutGen: Gen<Checkout> = (source) => ({
	files: Arr.map(Arr.dedupe(source.draw(array(element(PATHS), { min: 1, max: 5 }))), (path) => ({
		path,
		state: source.draw(element(STATES))
	})),
	link: source.draw(boolean),
	submodule: source.draw(boolean)
})

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
			deepStrictEqual({ git: args, code }, { git: args, code: 0 })
		})
	)

/** Every regular file under `root`, by its path from it, with its text, outside node_modules and .git. */
const filesIn = (
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
const made = (directory: RealPath, checkout: Checkout) =>
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
		if (checkout.submodule) {
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
		for (const file of checkout.files) {
			if (file.state === "deleted") {
				yield* fs.remove(path.join(directory, file.path))
			}
		}
		yield* write("node_modules/dep/index.js", "export const dep = 1\n")
		yield* fs.makeDirectory(path.join(directory, "node_modules/@scope"), { recursive: true })
		yield* fs.symlink("../../packages/pkg", path.join(directory, "node_modules/@scope/pkg"))
		yield* fs.makeDirectory(path.join(directory, "packages/pkg/node_modules"), { recursive: true })
		yield* fs.symlink(
			"../../../node_modules/dep",
			path.join(directory, "packages/pkg/node_modules/dep")
		)
	})

layer(NodeServices.layer, { excludeTestServices: true })("a worker tree", (it) => {
	it.effect(
		"holds exactly the checkout's files git shows, links its workspace into itself, and keeps a mutant only for its scope",
		(ctx) =>
			searched(
				ctx,
				explore(
					{
						suite: "worker tree",
						oracle: {
							kind: "specification",
							name: "the tree's files are those git shows in the checkout, with their text; workspace links resolve in the tree, installed packages in the checkout; a mutant stands for its scope alone"
						},
						draw: drawn(checkoutGen),
						literal: Formatter.format,
						coverage: required<State | "a symbolic link" | "a submodule">(
							[...STATES, "a symbolic link", "a submodule"],
							{ cases: 60, sense: notesOnly }
						),
						kept: [],
						runs: 16,
						shrink: boundedShrink(30),
						steerEvery: 8,
						caseHang: Duration.minutes(1)
					},
					(checkout, c) =>
						Effect.scoped(
							Effect.gen(function* () {
								c.noteAll(Arr.map(checkout.files, (file) => file.state))
								if (checkout.link) {
									c.note("a symbolic link")
								}
								if (checkout.submodule) {
									c.note("a submodule")
								}
								const fs = yield* FileSystem.FileSystem
								const path = yield* Path.Path
								const scratch = yield* fs.makeTempDirectoryScoped({
									prefix: "toolchain-tree-test-"
								})
								const home = yield* realPathOf(scratch)
								yield* fs.makeDirectory(path.join(home, "checkout"))
								yield* fs.makeDirectory(path.join(home, "tree"))
								const directory = yield* realPathOf(path.join(home, "checkout"))
								const root = yield* realPathOf(path.join(home, "tree"))
								yield* made(directory, checkout)
								const tree = yield* treeOf(directory, root)
								const inCheckout = yield* filesIn(directory)
								const shown = Arr.filter(
									inCheckout,
									([at]) => !Str.startsWith("ignored-")(path.basename(at))
								)
								const target = yield* realPathOf(path.join(directory, "packages/pkg/index.ts"))
								const during = yield* Effect.scoped(
									Effect.andThen(
										mutantIn(tree, { target, text: "export const pkg = 2\n" }),
										Effect.all([
											fs.readFileString(path.join(root, "packages/pkg/index.ts")),
											fs.readFileString(target)
										])
									)
								)
								deepStrictEqual(
									{
										files: yield* filesIn(root),
										link: checkout.link ? [yield* fs.readLink(path.join(root, "linked.ts"))] : [],
										workspace: yield* fs.realPath(path.join(root, "node_modules/@scope/pkg")),
										installed: yield* fs.realPath(path.join(root, "packages/pkg/node_modules/dep")),
										during,
										after: yield* fs.readFileString(path.join(root, "packages/pkg/index.ts"))
									},
									{
										files: shown,
										link: checkout.link ? ["packages/pkg/index.ts"] : [],
										workspace: path.join(root, "packages/pkg"),
										installed: path.join(directory, "node_modules/dep"),
										during: ["export const pkg = 2\n", "export const pkg = 1\n"],
										after: "export const pkg = 1\n"
									}
								)
							})
						)
				)
			)
	)
})
