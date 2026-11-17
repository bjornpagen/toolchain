/**
 * Worker trees (mutate/tree.ts): a tree holds exactly the files git shows in the checkout, tracked or untracked and not
 * ignored, a submodule's included (an uninitialized one holds none) and a file deleted from the working tree left out,
 * each with its text, a symbolic link as the same link; its node_modules resolve a workspace package to the tree's own
 * copy and an installed package to the checkout's; and a mutant written into a tree stands there, and only there, until
 * its scope closes and the file's own text is back.
 */
import { Array as Arr, Effect, FileSystem, Path, String as Str } from "effect"
import { deepStrictEqual } from "#assert.ts"
import { realPathOf } from "#mutate/mutated.ts"
import { checkoutGen, filesIn, made, STATES, SUBMODULES } from "#mutate/tree.fixtures.ts"
import { mutantIn, treeOf } from "#mutate/tree.ts"
import { property } from "#property.ts"

export const workerTree = property.explore(checkoutGen, {
	needs: {},
	situations: [...STATES, "a symbolic link", ...SUBMODULES],
	check: (_resources, c) => (checkout) =>
		Effect.gen(function* () {
			c.noteAll(Arr.map(checkout.files, (file) => file.state))
			if (checkout.link) {
				c.note("a symbolic link")
			}
			c.note(checkout.submodule)
			const fs = yield* FileSystem.FileSystem
			const path = yield* Path.Path
			const scratch = yield* fs.makeTempDirectoryScoped({ prefix: "toolchain-tree-test-" })
			const home = yield* realPathOf(scratch)
			yield* fs.makeDirectory(path.join(home, "checkout"))
			yield* fs.makeDirectory(path.join(home, "tree"))
			const directory = yield* realPathOf(path.join(home, "checkout"))
			const root = yield* realPathOf(path.join(home, "tree"))
			yield* made(directory, checkout)
			const tree = yield* treeOf(directory, root)
			const inCheckout = yield* filesIn(directory)
			const shown = Arr.filter(inCheckout, ([at]) => !Str.startsWith("ignored-")(path.basename(at)))
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
			const files = yield* filesIn(root)
			const link = checkout.link ? [yield* fs.readLink(path.join(root, "linked.ts"))] : []
			const workspace = yield* fs.realPath(path.join(root, "node_modules/@scope/pkg"))
			const installed = yield* fs.realPath(path.join(root, "packages/pkg/node_modules/dep"))
			const after = yield* fs.readFileString(path.join(root, "packages/pkg/index.ts"))
			deepStrictEqual(
				{ files, link, workspace, installed, during, after },
				{
					files: shown,
					link: checkout.link ? ["packages/pkg/index.ts"] : [],
					workspace: path.join(root, "packages/pkg"),
					installed: path.join(directory, "node_modules/dep"),
					during: ["export const pkg = 2\n", "export const pkg = 1\n"],
					after: "export const pkg = 1\n"
				}
			)
		}),
	oracle: {
		kind: "specification",
		name: "the tree's files are those git shows in the checkout, with their text; workspace links resolve in the tree, installed packages in the checkout; a mutant stands for its scope alone"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/mutate/tree.ts",
			original: 'if (entry.type === "SymbolicLink") {',
			replacement: 'if (entry.type === "SymbolicLink" && false) {',
			why: "A workspace package's link in node_modules is linked to the checkout's, so the tree's code loads the checkout's package."
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
			original: "() => Effect.orDie(fs.writeFileString(place, own))",
			replacement: "() => Effect.void",
			why: "The tree keeps a mutant after its scope closes."
		}
	]
})
