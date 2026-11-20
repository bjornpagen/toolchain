/**
 * A typecheck's verdict is a function of the files it checks (tool-typecheck.ts): toolchain-typecheck, run twice in
 * one directory as a package's typecheck runs again after an edit, refuses the second version of a file whose import's
 * last use moved into an inferred type (TS6196), as a check from scratch does, where TypeScript 7.1.0-beta's
 * incremental check passed it over the build info the first run left (METIS-BOOT, 2026-11-20: an unused `import type`
 * passed metis's commit and push gates; metis 1b93823's scripts/typecheck-stateless.ts, ported here); in a project that
 * is no composite one and in a composite one, whose build info TypeScript keeps whatever it is told; and build mode,
 * which reads build info to skip what it judges up to date, is refused. Each case writes a workspace of its own and runs
 * the dev tools' wrapper from the checkout. Oracle: a second implementation, the typecheck from scratch, which refuses
 * the second version (TS6196) and passes the first.
 */
import { assert } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Effect } from "effect"
import { checkedTwice, projects, refusedWith } from "#typecheck.fixtures.ts"

export const typecheckStateless = property.exhaust(projects, {
	box: "a project and a composite project, each checked at its first version and again at its second in one directory, then in build mode",
	needs: { dir: Scratch.dir, checkout: Checkout.dir },
	situations: [],
	check:
		({ dir, checkout }) =>
		(project) =>
			Effect.gen(function* () {
				const directory = yield* dir
				const root = yield* checkout
				const runs = yield* checkedTwice(root, directory, project)
				assert.deepEqual(
					{
						first: runs.first.status,
						second: refusedWith(runs.second, "TS6196"),
						built: refusedWith(runs.built, "refuses build mode")
					},
					{ first: 0, second: true, built: true }
				)
			}),
	oracle: {
		kind: "second-implementation",
		name: "the typecheck from scratch, which passes the first version and refuses the second's unused import (TS6196)"
	},
	kept: [],
	kills: [
		{
			file: "packages/devtools/src/tool-typecheck.ts",
			original: `\t\t\t[...args, "--tsBuildInfoFile", \`\${directory}/typecheck.tsbuildinfo\`],\n`,
			replacement: "\t\t\targs,\n",
			why: "A run reads the build info the project's tsconfig names, as every typecheck did: a composite project's second check reads the first's and passes the unused import (METIS-BOOT's hole); the property fails for the composite project."
		},
		{
			file: "packages/devtools/src/tool-typecheck.ts",
			original: "\t\tif (Arr.some(args, (arg) => BUILD_MODE.has(arg))) {\n",
			replacement: "\t\tif (false) {\n",
			why: "Build mode passes through to tsrs, which refuses the run's own build info file with TS5094 and says nothing of why a build is no check from scratch; the property fails on the build."
		}
	]
})
