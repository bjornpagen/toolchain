/**
 * Worker trees (mutate/tree.ts): a tree holds exactly the files git shows in the checkout, tracked or untracked and not
 * ignored, a submodule's included (an uninitialized one holds none) and a file deleted from the working tree left out,
 * each with its text; it resolves every link as the checkout does, to the tree's own place of what the checkout links
 * to where the tree holds it (a tracked link, a workspace package however its link is spelled) and to what the checkout
 * reaches anywhere else (an installed package, in the checkout's node_modules or beside the checkout); and a mutant put
 * in a tree stands there, and only there, with its file's mode, until its scope closes and the file is back.
 *
 * The work a run's trees do is counted, by inode: their files are the run's base's, copied from the checkout once, so
 * the regular files under the trees' home are the checkout's shown files and the mutants in place, however many trees
 * there are; and no tree's file can be written in place, so a tree's process that tries is refused, and the checkout,
 * the base and every other tree keep their text.
 */
import { Array as Arr, Effect, FileSystem, Path, String as Str } from "effect"
import { assert } from "#assert.ts"
import { realPathOf } from "#mutate/mutated.ts"
import {
	checkoutGen,
	filesHeld,
	filesIn,
	INSTALLS,
	installedAt,
	made,
	STATES,
	SUBMODULES,
	WORKSPACE_LINKS
} from "#mutate/tree.fixtures.ts"
import { mutantIn, treesOf } from "#mutate/tree.ts"
import { property } from "#property.ts"

export const workerTree = property.explore(checkoutGen, {
	needs: {},
	situations: [
		...STATES,
		"a symbolic link",
		...SUBMODULES,
		...WORKSPACE_LINKS,
		...INSTALLS,
		"an executable mutant"
	],
	check: (_resources, c) => (checkout) =>
		Effect.gen(function* () {
			c.noteAll(Arr.map(checkout.files, (file) => file.state))
			if (checkout.link) {
				c.note("a symbolic link")
			}
			c.note(checkout.submodule)
			c.note(checkout.workspace)
			c.note(checkout.installed)
			if (checkout.executable) {
				c.note("an executable mutant")
			}
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "toolchain-tree-test-" })
			const home = yield* realPathOf(scratch)
			yield* fs.makeDirectory(path.join(home, "checkout"))
			const directory = yield* realPathOf(path.join(home, "checkout"))
			yield* made(directory, checkout)
			const trees = yield* treesOf(directory)
			const [mutated, other] = yield* Effect.all([trees.take, trees.take], {
				concurrency: "unbounded"
			})
			const held = path.dirname(mutated.root)
			const inCheckout = yield* filesIn(directory)
			const shown = Arr.filter(inCheckout, ([at]) => !Str.startsWith("ignored-")(path.basename(at)))
			const file = "packages/pkg/index.ts"
			const target = yield* realPathOf(path.join(directory, file))
			const own = "export const pkg = 1\n"
			const textsOf = Effect.all([
				fs.readFileString(path.join(mutated.root, file)),
				fs.readFileString(path.join(other.root, file)),
				fs.readFileString(path.join(mutated.base, file)),
				fs.readFileString(target)
			])
			const modeOf = (at: string) => Effect.map(fs.stat(at), (info) => info.mode & 0o7777)
			const during = yield* Effect.scoped(
				Effect.andThen(
					mutantIn(mutated, { target, text: "export const pkg = 2\n" }),
					Effect.all({
						texts: textsOf,
						mode: modeOf(path.join(mutated.root, file)),
						files: filesHeld(held)
					})
				)
			)
			const written = yield* Effect.exit(
				fs.writeFileString(path.join(other.root, file), "written in place\n")
			)
			const files = yield* filesIn(mutated.root)
			const link = checkout.link ? [yield* fs.realPath(path.join(mutated.root, "linked.ts"))] : []
			const workspace = yield* fs.realPath(path.join(mutated.root, "node_modules/@scope/pkg"))
			const installed = yield* fs.realPath(path.join(mutated.root, "packages/pkg/node_modules/dep"))
			assert.deepEqual(
				{
					files,
					link,
					workspace,
					installed,
					during,
					written: written._tag,
					after: yield* textsOf,
					afterFiles: yield* filesHeld(held)
				},
				{
					files: shown,
					link: checkout.link ? [path.join(mutated.root, file)] : [],
					workspace: path.join(mutated.root, "packages/pkg"),
					installed: yield* fs.realPath(installedAt(directory, checkout)),
					during: {
						texts: ["export const pkg = 2\n", own, own, own],
						mode: (checkout.executable ? 0o755 : 0o644) & 0o555,
						files: shown.length + 1
					},
					written: "Failure",
					after: [own, own, own, own],
					afterFiles: shown.length
				}
			)
		}),
	oracle: {
		kind: "specification",
		name: "the tree's files are those git shows in the checkout, with their text; links resolve as the checkout's, in the tree where it holds their target; a mutant stands for its scope alone, with its file's mode; the trees' files are the base's, which none can write in place"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/mutate/tree.ts",
			original: '(Str.startsWith("@")(entry.name) || entry.name === ".bin")',
			replacement: 'entry.name === ".bin"',
			why: "A scope of node_modules is linked to the checkout's, so its workspace package's link resolves from the checkout's node_modules to the checkout's package, without the mutant."
		},
		{
			file: "packages/testing/src/mutate/tree.ts",
			original: '"--cached", "--others", "--exclude-standard"',
			replacement: '"--cached", "--exclude-standard"',
			why: "Untracked files that are not ignored are left out of the tree."
		},
		{
			file: "packages/testing/src/mutate/tree.ts",
			original: "? yield* filesUnder(checkout, at)",
			replacement: "? []",
			why: "A submodule's files are left out of the tree."
		},
		{
			file: "packages/testing/src/mutate/tree.ts",
			original: 'Arr.filter(shown, (entry) => entry !== "./")',
			replacement: "shown",
			why: "An uninitialized submodule's directory lists its own gitlink as ./, so the walk lists that directory again, forever."
		},
		{
			file: "packages/testing/src/mutate/tree.ts",
			original: "() => Effect.orDie(Effect.andThen(fs.remove(place), fs.link(own, place)))",
			replacement: "() => Effect.void",
			why: "The tree keeps a mutant after its scope closes."
		},
		{
			file: "packages/testing/src/mutate/tree.ts",
			original: ".link(path.join(base.root, file.path), path.join(root, file.path))",
			replacement: ".copyFile(path.join(base.root, file.path), path.join(root, file.path))",
			why: "Every tree copies every file of the checkout again (the trees that ran /tmp's tmpfs out of inodes), so a run's files grow with its trees."
		},
		{
			file: "packages/testing/src/mutate/tree.ts",
			original: ".link(path.join(base.root, file.path), path.join(root, file.path))",
			replacement: ".link(path.join(base.layout.checkout, file.path), path.join(root, file.path))",
			why: "A tree's files are hard links to the checkout's, so a tree's process that writes one in place writes the checkout's file."
		},
		{
			file: "packages/testing/src/mutate/tree.ts",
			original: "fs.chmod(target, file.mode & READ_ONLY)",
			replacement: "fs.chmod(target, file.mode)",
			why: "The base's files can be written, so a tree's process that writes one in place writes it in every tree at once."
		},
		{
			file: "packages/testing/src/mutate/tree.ts",
			original: "\t\t\tyield* fs.remove(place)\n",
			replacement: "",
			why: "A mutant is written through the tree's link into the base's file, every tree's."
		},
		{
			file: "packages/testing/src/mutate/tree.ts",
			original: "fs.writeFileString(place, mutant.text, { mode: info.mode & READ_ONLY })",
			replacement: "fs.writeFileString(place, mutant.text)",
			why: "A mutant's file takes a new file's mode, so a mutant of an executable is no longer one."
		},
		{
			file: "packages/testing/src/mutate/tree.ts",
			original:
				"held.has(inTree) ? path.normalize(path.relative(path.dirname(at), inTree)) : target",
			replacement: "path.normalize(path.relative(path.dirname(at), inTree))",
			why: "Every link of a tree is spelled from the link to its target as the checkout's relative link is, so one that leaves the checkout (an install another clone made) resolves to nothing in the tree (REPSWEEP-SURFACE's unjudged kills: Cannot find package '@bjornpagen/testing')."
		},
		{
			file: "packages/testing/src/mutate/tree.ts",
			original:
				"held.has(inTree) ? path.normalize(path.relative(path.dirname(at), inTree)) : target",
			replacement: "target",
			why: "Every link of a tree resolves to the checkout's target, so its workspace packages are the checkout's, without the mutant."
		}
	]
})
