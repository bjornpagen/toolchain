import { Array as Arr, Effect, Option } from "effect"
import { Digest } from "effect/crypto"
import { agree, exact } from "#oracle.ts"
import { property } from "#property.ts"
import {
	aimedWorkspaces,
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
			original: "closuresOf({ tree, conditions, runtime: process.version, roots: [path] })",
			replacement: 'closuresOf({ tree, conditions, runtime: "", roots: [path] })',
			why: "a module closure hashed for no runtime: a template's identity no longer the hash a verdict key holds"
		}
	]
})
