import { Array as Arr, Effect, Option } from "effect"
import { Digest } from "effect/crypto"
import { realPathOf } from "#mutate/mutated.ts"
import { agree, exact } from "#oracle.ts"
import { property } from "#property.ts"
import {
	aimedWorkspaces,
	changedFilesOf,
	changedModuleOf,
	changedWorkspaces,
	changeSituationOf,
	closuresIn,
	moduleSituationsOf,
	moduleUrlOf,
	workspaces,
	writtenTo,
	filesOf,
	loadSituationsOf,
	loadsOf,
	hashing,
	nodeLoads,
	rootsOf,
	scratch,
	touchedWorkspaces,
	touchOf,
	treeOf,
	writtenTree
} from "#runner/closure.fixtures.ts"
import { closuresOf, ModuleSyntax, workingTree } from "#runner/closure.ts"
import { moduleClosureAt } from "#runner/module-closure.ts"

/**
 * A module's closure is what Node loads when it loads the module: its files, the external packages it loads directly
 * and the built-ins, each through the route Node takes (relative paths exactly, `imports` maps with a bare package
 * target, `exports` patterns and self-reference, the conditions Node sets and the runner config adds), with no
 * type-only import among them and every inline type import's module loaded. Oracle: Node 26's own module loader, which
 * runs a generated workspace written as pnpm installs it and records every resolution it makes.
 */
export const closureIsWhatNodeLoads = property.explore(aimedWorkspaces, {
	needs: { hashing, directory: scratch },
	situations: [
		"a type-only import Node never loads",
		"an inline type import that loads its module",
		"an import cycle",
		"the library's export pattern by self-reference",
		"an imports map naming a bare package",
		"a conditional the config's condition chooses",
		"a conditional Node's own condition chooses",
		"a conditional that falls to its default",
		"an external's own dependency Node loads beside it",
		"a built-in named bare",
		"a JSON module",
		"a dynamic import"
	],
	check:
		({ hashing: services, directory }, c) =>
		(workspace) =>
			Effect.gen(function* () {
				c.noteAll(loadSituationsOf(workspace))
				const written = yield* directory
				const loads = yield* nodeLoads(written, workspace, filesOf(workspace, { kind: "nothing" }))
				const roots = yield* Effect.fromOption(rootsOf(workspace))
				const tree = yield* writtenTree(written)
				const parser = yield* services
				const closures = yield* closuresIn(workspace, tree, roots, parser)
				const entry = yield* Effect.fromOption(
					Option.fromUndefinedOr(closures.get(Arr.headNonEmpty(roots)))
				)
				yield* agree(
					[
						["Node's loader", loads],
						["the closure", loadsOf(entry)]
					],
					exact
				)
			}),
	oracle: {
		kind: "second-implementation",
		name: "Node 26's module loader running the written workspace, its resolutions recorded by a module hook"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/closure.ts",
			original: "parent.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword",
			replacement: "false",
			why: "an `import type` held in the closure: Node erases it and never loads its module"
		},
		{
			file: "packages/testing/src/runner/closure.ts",
			original: "return parent.isTypeOnly ? Option.none() : Option.some(node.text)",
			replacement: "return Option.some(node.text)",
			why: "an `export type` held in the closure: Node erases it and never loads its module"
		},
		{
			file: "packages/testing/src/runner/closure.ts",
			original: "const held = texts.get(content)",
			replacement: "const held = texts.values().next().value",
			why: "a parse kept by its module's path alone: a module whose text differs from the one first parsed at that path is read with the imports of the first"
		},
		{
			file: "packages/testing/src/runner/closure.ts",
			original: 'const NODE_CONDITIONS = ["node", "import", "module-sync", "default"] as const',
			replacement: 'const NODE_CONDITIONS = ["node", "module-sync", "default"] as const',
			why: "a conditional map read without Node's own `import` condition resolves to another file than Node loads"
		}
	]
})

/**
 * A module's closure hash changes exactly when something its closure holds changes: a module or data file it loads
 * (itself, through re-exports and conditionals, around an import cycle), or the lockfile entry of an external package
 * it loads or that one depends on; an edit behind a type-only import, or anywhere it does not reach, leaves it, and so
 * does hashing the roots in another order. Oracle: reachability over the generated workspace's model, which states
 * what every import reaches.
 */
export const closureHashFollowsTheClosure = property.explore(touchedWorkspaces, {
	needs: { hashing },
	situations: [
		"nothing touched",
		"a module's own edit",
		"an edit reached through another module",
		"an edit behind a type-only import",
		"an edit inside an import cycle",
		"a data file edit it reaches",
		"a lockfile entry it loads",
		"a lockfile entry behind an external's dependency",
		"an edit it does not reach"
	],
	check:
		({ hashing: services }, c) =>
		({ workspace, touch }) =>
			Effect.gen(function* () {
				const parser = yield* services
				const roots = yield* Effect.fromOption(rootsOf(workspace))
				const before = yield* closuresIn(
					workspace,
					treeOf(filesOf(workspace, { kind: "nothing" })),
					roots,
					parser
				)
				const after = yield* closuresIn(
					workspace,
					treeOf(filesOf(workspace, touch)),
					Arr.reverse(roots),
					parser
				)
				for (const [index, root] of roots.entries()) {
					const { reaches, situation } = touchOf(workspace, touch, index)
					c.note(situation)
					const was = yield* Effect.fromOption(Option.fromUndefinedOr(before.get(root)))
					const is = yield* Effect.fromOption(Option.fromUndefinedOr(after.get(root)))
					yield* agree(
						[
							[`whether the model's closure of ${root} holds the touch`, reaches],
							[`whether ${root}'s closure hash changed`, was.hash !== is.hash]
						],
						exact
					)
				}
			}),
	oracle: {
		kind: "second-implementation",
		name: "reachability over the generated workspace's model of what each import reaches"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/closure.ts",
			original: "parent.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword",
			replacement: "false",
			why: "an `import type` held in the closure: Node erases it and never loads its module"
		},
		{
			file: "packages/testing/src/runner/closure.ts",
			original: "return parent.isTypeOnly ? Option.none() : Option.some(node.text)",
			replacement: "return Option.some(node.text)",
			why: "an `export type` held in the closure: Node erases it and never loads its module"
		},
		{
			file: "packages/testing/src/runner/closure.ts",
			original: "const held = texts.get(content)",
			replacement: "const held = texts.values().next().value",
			why: "a parse kept by its module's path alone: a module whose text differs from the one first parsed at that path is read with the imports of the first"
		},
		{
			file: "packages/testing/src/runner/closure.ts",
			original: "pending.push(dependency)",
			replacement: "void dependency",
			why: "an external package hashed by its own lockfile entry alone: a bump of a package it depends on goes unseen"
		},
		{
			file: "packages/testing/src/runner/closure.ts",
			original: "return reached === place",
			replacement: "return true",
			why: "a component hashed without the closures it reaches: an edit below it goes unseen"
		}
	]
})

/**
 * The runner's ModuleClosure, which a need reads a module's identity from (a template, by the module that declares it),
 * gives each module of a workspace written to disk the closure hash closure.ts computes for it there, under the
 * process's conditions and Node's version, and the same hash when asked again. Oracle: closuresOf over the written
 * workspace, the function a verdict key's closures come from.
 */
export const moduleClosureIsTheClosureHash = property.explore(workspaces, {
	needs: { hashing, directory: scratch },
	situations: ["a module of the library package", "a module in an import cycle"],
	check:
		({ hashing: services, directory }, c) =>
		(workspace) =>
			Effect.gen(function* () {
				c.noteAll(moduleSituationsOf(workspace))
				const written = yield* directory
				yield* writtenTo(written, filesOf(workspace, { kind: "nothing" }))
				const roots = yield* Effect.fromOption(rootsOf(workspace))
				const parser = yield* services
				const tree = yield* workingTree(written)
				const expected = yield* closuresOf({
					tree,
					conditions: [],
					runtime: process.version,
					roots
				}).pipe(
					Effect.provideService(ModuleSyntax, parser.syntax),
					Effect.provideService(Digest.Digest, parser.digest)
				)
				const closures = yield* moduleClosureAt(written, Option.none())
				for (const [index, root] of roots.entries()) {
					const url = moduleUrlOf(written, workspace, index)
					const first = yield* closures.hashOf(url)
					const again = yield* closures.hashOf(url)
					const want = yield* Effect.fromOption(Option.fromUndefinedOr(expected.get(root)))
					yield* agree(
						[
							[`closuresOf's hash of ${root}`, [want.hash, want.hash]],
							[`ModuleClosure's hash of ${root}, asked twice`, [first, again]]
						],
						exact
					)
				}
			}),
	oracle: {
		kind: "second-implementation",
		name: "closuresOf over the written workspace, under no conditions and this Node's version"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/module-closure.ts",
			original: ".walkOf({ tree, conditions, runtime: process.version, roots: [path] })",
			replacement: '.walkOf({ tree, conditions, runtime: "", roots: [path] })',
			why: "a module closure hashed for no runtime: a template's identity no longer the hash a verdict key holds"
		}
	]
})

/**
 * A pool's ModuleClosure gives each module the hash closure.ts computes over the files its workers load, however the
 * process's walk of the module was first read (runner/module-closure.ts sharedWalk): a workspace written to disk is
 * hashed, then hashed again by a pool serving one module's changed text as a mutant, then by a pool over the same
 * directory with the change written, a module's text with its imports kept or drawn again, a data file or a lockfile
 * entry. Oracle: closuresOf walking each set of files afresh, under the process's conditions and Node's version.
 */
export const moduleClosureFollowsWhatItsPoolLoads = property.explore(changedWorkspaces, {
	needs: { hashing, directory: scratch },
	situations: [
		"nothing changed",
		"a module's text, its imports kept",
		"a module's imports",
		"a data file",
		"a lockfile entry"
	],
	check:
		({ hashing: services, directory }, c) =>
		(changed) =>
			Effect.gen(function* () {
				c.note(changeSituationOf(changed.change))
				const { workspace } = changed
				const written = yield* directory
				const plain = filesOf(workspace, { kind: "nothing" })
				const after = changedFilesOf(changed)
				yield* writtenTo(written, plain)
				const roots = yield* Effect.fromOption(rootsOf(workspace))
				const parser = yield* services
				const fresh = (files: ReadonlyArray<readonly [path: string, text: string]>) =>
					closuresOf({ tree: treeOf(files), conditions: [], runtime: process.version, roots }).pipe(
						Effect.provideService(ModuleSyntax, parser.syntax),
						Effect.provideService(Digest.Digest, parser.digest)
					)
				const wantBefore = yield* fresh(plain)
				const wantAfter = yield* fresh(after)
				const served = yield* Effect.transposeOption(
					Option.map(changedModuleOf(changed), ({ path, text }) =>
						Effect.map(realPathOf(`${written}/${path}`), (target) => ({ target, text }))
					)
				)
				const first = yield* moduleClosureAt(written, Option.none())
				const mutant = yield* moduleClosureAt(written, served)
				const beforeHashes = yield* Effect.forEach(roots, (_, index) =>
					first.hashOf(moduleUrlOf(written, workspace, index))
				)
				const servedHashes = yield* Effect.forEach(roots, (_, index) =>
					mutant.hashOf(moduleUrlOf(written, workspace, index))
				)
				yield* writtenTo(written, after)
				const onDisk = yield* moduleClosureAt(written, Option.none())
				const diskHashes = yield* Effect.forEach(roots, (_, index) =>
					onDisk.hashOf(moduleUrlOf(written, workspace, index))
				)
				const wanted = (closures: typeof wantBefore) =>
					Effect.forEach(roots, (root) =>
						Effect.map(
							Effect.fromOption(Option.fromUndefinedOr(closures.get(root))),
							(held) => held.hash
						)
					)
				const before = yield* wanted(wantBefore)
				const changedHashes = yield* wanted(wantAfter)
				yield* agree(
					[
						["closuresOf over the written files", before],
						["the first pool's hashes", beforeHashes]
					],
					exact
				)
				yield* agree(
					[
						[
							Option.isSome(served)
								? "closuresOf over the files with the mutant's text"
								: "closuresOf over the written files, no module's text changed",
							Option.isSome(served) ? changedHashes : before
						],
						["the hashes of a pool serving the changed module's text", servedHashes]
					],
					exact
				)
				yield* agree(
					[
						["closuresOf over the changed files", changedHashes],
						["the hashes of a pool over the directory, the change written", diskHashes]
					],
					exact
				)
			}),
	oracle: {
		kind: "second-implementation",
		name: "closuresOf walking each set of files afresh, under no conditions and this Node's version"
	},
	kept: [],
	kills: [
		{
			file: "packages/testing/src/runner/closure.ts",
			original: "const now = yield* readingOf(bytes)",
			replacement: "const now = was",
			why: "a shared walk read as holding over any tree: a mutant's text or a change on disk goes unseen, and the pool hashes the closure its workers do not load"
		},
		{
			file: "packages/testing/src/runner/closure.ts",
			original: "onSome: (content) => ({ ...node, content })",
			replacement: "onSome: () => node",
			why: "a module whose bytes changed and whose imports did not keeps its old bytes in the walk, so its closure hashes the text before the change"
		},
		{
			file: "packages/testing/src/runner/closure.ts",
			original: "if (!loadAlike(specifiers, Arr.getUnsafe(walk.walked, at).specifiers)) {",
			replacement: "if (!loadAlike(specifiers, specifiers)) {",
			why: "a module whose imports changed keeps its old links, so its closure holds what it no longer loads and lacks what it now does"
		},
		{
			file: "packages/testing/src/runner/module-closure.ts",
			original: "onNone: () => walkOf",
			replacement: "onNone: () => Effect.succeed(shared)",
			why: "a shared walk that no longer holds is hashed anyway: a lockfile entry or a module's imports changed and the pool hashes the closure as it was"
		}
	]
})
