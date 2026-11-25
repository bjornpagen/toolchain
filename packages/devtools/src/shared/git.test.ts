/**
 * The inputs a check may read inside a root's submodules (src/shared/git.ts submoduleInputsUnder), searched over roots
 * drawn from the contract: up to two submodules that .gitmodules names, files held in them or not and files of the
 * root's own, and the repository-relative paths a style option names among them (a submodule's file that is there, one
 * that is not, a submodule's directory, a file of the root's own). The inputs are exactly the named files that lie in a
 * submodule and are on disk, each once, in path order: a missing one, a directory, a root file (which git lists) and a
 * submodule's file no option names never are, so a check reads a named submodule file and judges nothing else of the
 * submodule's.
 *
 * Oracle: the specification, submoduleInputsUnder's JSDoc. Features: a submodule's file named, a submodule's missing file
 * named, a submodule's directory named, a root file named, a submodule's file not named.
 *
 * And the packages a root calls its own (ownPackagesUnder, which the Repository service's packages are, so no gate
 * judges another repository's): over workspaces of up to two submodules (a vendored toolchain and edullm's qti-pie)
 * and packages at a submodule's root, under it, under a repository it vendors in turn, and of the root's own, one of
 * whose names a submodule's prefixes, the own packages are exactly those at or under no submodule .gitmodules names.
 *
 * And the files of one name a check of everything a repository runs reads at any depth (filesNamedUnder, which the
 * catalog agreement reads every pnpm workspace by): over trees of real repositories, a root with a workspace of its own
 * deeper in its tree or not, a vendored toolchain cloned, left uninitialized or with its directory gone, and a vendored
 * qti-pie that vendors grizzle in turn, cloned or left uninitialized, the files found are exactly every workspace
 * manifest a repository of the tree holds on disk: none under node_modules, which .gitignore ignores, none whose name
 * only ends like one.
 */
import { assert } from "@bjornpagen/testing/assert"
import { property } from "@bjornpagen/testing/property"
import { Effect } from "effect"
import {
	expectedOf,
	featuresOf,
	inputsOf,
	manifestsFoundIn,
	ownExpectedOf,
	ownPackagesOf,
	packageFeaturesOf,
	repositories,
	treeExpectedOf,
	treeFeaturesOf,
	trees,
	workspaces
} from "#shared/git.fixtures.ts"

/** Read exactly the named files that lie in a submodule and are on disk. */
export const submoduleInputs = property.explore(repositories, {
	needs: {},
	situations: [
		"a submodule's file named",
		"a submodule's missing file named",
		"a submodule's directory named",
		"a root file named",
		"a submodule's file not named"
	],
	check: (_resources, c) => (repository) =>
		Effect.scoped(
			Effect.gen(function* () {
				c.noteAll(featuresOf(repository))
				const { root, inputs } = yield* inputsOf(repository)
				const read: ReadonlyArray<string> = inputs
				assert.deepEqual(read, expectedOf(root, repository))
			})
		),
	oracle: { kind: "specification", name: "submoduleInputsUnder's stated contract" },
	kept: [],
	kills: [
		{
			file: "packages/devtools/src/shared/git.ts",
			original: "\t\t\tinSubmodule(submodules)\n\t\t)\n\t)",
			replacement: "\t\t\t() => true\n\t\t)\n\t)",
			why: "A named file of the root's own is read as a submodule's input too, as if every named path were one; the property's roots whose options name a file of their own fail."
		},
		{
			file: "packages/devtools/src/shared/git.ts",
			original:
				"\treturn yield* Effect.filter(Arr.sort(candidates, Order.String), (file) =>\n\t\tfs.exists(file).pipe(Effect.mapError(inspectionFailure(file)))\n\t)",
			replacement: "\treturn Arr.sort(candidates, Order.String)",
			why: "A named submodule file that is not on disk is read as an input, which the engine then fails to read; the property's roots naming a submodule's missing file fail."
		},
		{
			file: "packages/devtools/src/shared/git.ts",
			original: 'Arr.filter(named, (path) => !Str.endsWith("/")(path))',
			replacement: "named",
			why: "A named submodule directory is read as one input file; the property's roots naming a submodule's directory fail."
		}
	]
})

/** Keep exactly the packages at or under no submodule, a nested repository's among those dropped. */
export const ownPackages = property.explore(workspaces, {
	needs: {},
	situations: [
		"a submodule's own package",
		"a package under a submodule",
		"a nested repository's package",
		"an own package a submodule's name prefixes",
		"a submodule not listed in .gitmodules"
	],
	check: (_resources, c) => (workspace) =>
		Effect.scoped(
			Effect.gen(function* () {
				c.noteAll(packageFeaturesOf(workspace))
				const { root, own } = yield* ownPackagesOf(workspace)
				const kept: ReadonlyArray<string> = own
				assert.deepEqual(kept, ownExpectedOf(root, workspace))
			})
		),
	oracle: { kind: "specification", name: "ownPackagesUnder's stated contract" },
	kept: [],
	kills: [
		{
			file: "packages/devtools/src/shared/git.ts",
			original: "\treturn Arr.filter(packages, (root) => !inSubmodule(submodules)(root))",
			replacement: "\treturn packages",
			why: "Every workspace package is the root's own, a submodule's among them, as before: edullm's gate judged qti-pie's tsconfigs and its vendored grizzle's packages; the property's workspaces with a package in a submodule fail."
		},
		{
			file: "packages/devtools/src/shared/git.ts",
			original: `file === path || Str.startsWith(\`\${path}/\`)(file)`,
			replacement: "Str.startsWith(path)(file)",
			why: "A package whose name a submodule's path prefixes (packages/qti-pie-notes beside packages/qti-pie) is read as the submodule's and never judged; the property's workspaces with such a package fail."
		}
	]
})

/** Find every file of the name a repository of the tree holds, at any depth of submodules, and nothing else. */
export const filesNamed = property.exhaust(trees, {
	box: "a root with or without a deeper workspace of its own, a vendored toolchain cloned, uninitialized, gone or absent, and a vendored qti-pie alone, vendoring grizzle cloned or uninitialized, or absent",
	needs: {},
	situations: [
		"an own workspace deeper in the tree",
		"a cloned submodule's workspace",
		"an uninitialized submodule",
		"a submodule whose directory is gone",
		"a submodule's submodule's workspace",
		"an uninitialized submodule of a submodule"
	],
	check: (_resources, c) => (tree) =>
		Effect.scoped(
			Effect.gen(function* () {
				c.noteAll(treeFeaturesOf(tree))
				const { root, found } = yield* manifestsFoundIn(tree)
				assert.deepEqual(found, treeExpectedOf(root, tree))
			})
		),
	oracle: { kind: "specification", name: "filesNamedUnder's stated contract" },
	kept: [],
	kills: [
		{
			file: "packages/devtools/src/shared/git.ts",
			original:
				"\t\tconst nested = yield* Effect.forEach(submodules, (submodule) =>\n\t\t\tfilesNamedUnder(submodule, name)\n\t\t)\n",
			replacement: "\t\tconst nested: ReadonlyArray<ReadonlyArray<string>> = []\n",
			why: "A submodule's files are never read: in a working tree the root lists a submodule as its gitlink alone, so a vendored qti-pie's workspace goes unseen and the catalog agreement judges nothing; the trees with a cloned submodule fail."
		},
		{
			file: "packages/devtools/src/shared/git.ts",
			original: `\t\t\t[...Arr.filter(own, Str.endsWith(\`/\${name}\`)), ...Arr.flatten(nested)],\n`,
			replacement: "\t\t\t[...Arr.filter(own, Str.endsWith(name)), ...Arr.flatten(nested)],\n",
			why: "A file whose name only ends like the one sought (docs/not-pnpm-workspace.yaml) is found as one; every tree fails."
		},
		{
			file: "packages/devtools/src/shared/git.ts",
			original:
				"\t\tconst submodules = yield* Effect.filter(listed, (submodule) =>\n\t\t\tfs.exists(submodule).pipe(Effect.mapError(inspectionFailure(submodule)))\n\t\t)\n",
			replacement: "\t\tconst submodules = listed\n",
			why: "A submodule .gitmodules lists whose directory is gone is listed by git run inside it, which fails: the gate fails on a tree it should read; the trees whose toolchain's directory is gone fail."
		}
	]
})
