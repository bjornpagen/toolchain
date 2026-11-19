/**
 * The workspace gate's effect-plugin-block rule (src/workspace/tsconfigs.ts), searched over workspaces drawn from the
 * shapes it reads: a root tsconfig.json that declares the Effect plugin once, never, or more than once, beside other
 * plugins or none, and packages under it, each with no tsconfig, one that extends the root, one that extends a
 * package's Effect-free base, one that declares plugins of its own (an empty list among them, which drops the root's
 * block as surely as any), or one that extends a tsconfig that is not there, listed in the toolchain's effectFree or
 * not. Every directory carries the number of effect-plugin-block findings the rule gives it, one for each way the
 * plugin block is not the root's alone and none for a directory that holds it as it should, and the gate's findings
 * over the workspace, counted at that directory, must be exactly that many, with none at any other.
 *
 * Oracle: the specification, the rule's contract: the root tsconfig.json holds the one Effect plugin block, every
 * package has a tsconfig.json that declares no plugin of its own and extends what exists. Features: a directory that
 * holds the block as it should, a package that declares plugins, one that declares an empty list, a package with no
 * tsconfig, one that extends a tsconfig that is not there, and a root that does not declare the plugin once.
 */
import { assert } from "@bjornpagen/testing/assert"
import { property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Array as Arr, Effect } from "effect"
import {
	directoriesOf,
	pluginBlockCounts,
	workspaces,
	written
} from "#workspace/tsconfigs.fixtures.ts"

export const pluginBlockFindings = property.explore(workspaces, {
	needs: { dir: Scratch.dir },
	situations: [
		"a directory that holds the block as it should",
		"a package that declares plugins",
		"a package that declares an empty plugin list",
		"a package with no tsconfig",
		"a package that extends a tsconfig that is not there",
		"a root that does not declare the plugin once"
	],
	check:
		({ dir }, c) =>
		(workspace) =>
			Effect.gen(function* () {
				const directories = directoriesOf(workspace)
				c.noteAll(Arr.map(directories, (one) => one.kind))
				const scratch = yield* dir
				const root = yield* written(scratch, workspace)
				const counted = yield* pluginBlockCounts(root, workspace)
				assert.deepEqual(counted, [...Arr.map(directories, (one) => one.findings), 0])
			}),
	oracle: {
		kind: "specification",
		name: "the rule's contract: the root tsconfig.json holds the one Effect plugin block, and every package's tsconfig.json declares no plugin of its own"
	},
	kept: [],
	kills: [
		{
			file: "packages/devtools/src/workspace/tsconfigs.ts",
			original: "\t\t\tdecoded.compilerOptions?.plugins === undefined",
			replacement:
				"\t\t\tdecoded.compilerOptions?.plugins === undefined ||\n\t\t\t\tdecoded.compilerOptions.plugins.length > 0",
			why: "A package's own compiler plugins are read as none, so a package that declares plugins beside the root's one Effect plugin block draws no effect-plugin-block finding; the directory property fails."
		}
	]
})
