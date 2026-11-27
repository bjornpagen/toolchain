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
 *
 * And a typecheck builds each type its program needs once (shared/threads.ts ONE_CHECKER): over a program whose cost is
 * one shared inferred type, a function's return that no declaration states, built by a chain of generic calls, its
 * readers each pay for their own expression alone, so the first readers make no more types than as many more do, at a
 * share of four (one fewer, at times, where the checker interns one of their types with one it made before). A checker for each thread of the share builds the type again in every checker that holds a reader,
 * about 1,200 types each, so the first readers made that many more for each of three checkers and the next readers
 * none (TYPECOST, 2026-11-27: qti-pie's ledger, one package run alone at 64 checkers, 15.3 GB and 477 million
 * instantiations, each checker deriving pantry's and the ledger's levels again, where one checker makes 45.6 million
 * in 1.3 GB). A caller's own count of checkers, which tsrs would take over the wrapper's, is refused. Oracle: a universal
 * law, the program's counts at three sizes compared.
 */
import { assert } from "@bjornpagen/testing/assert"
import { Checkout } from "@bjornpagen/testing/checkout"
import { property } from "@bjornpagen/testing/property"
import { Scratch } from "@bjornpagen/testing/resources"
import { Effect } from "effect"
import {
	checkedTwice,
	projects,
	refusedWith,
	sharedChecked,
	sharedReads
} from "#typecheck.fixtures.ts"

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
			original: '\t["-b", buildMode],\n\t["--build", buildMode],\n',
			replacement: "",
			why: "Build mode passes through to tsrs, which refuses the run's own build info file with TS5094 and says nothing of why a build is no check from scratch; the property fails on the build."
		}
	]
})

export const aSharedTypeIsBuiltOnce = property.exhaust(sharedReads, {
	box: "a program of one shared inferred type, read through an alias of its function's return type and through the value it types, checked alone, with twice its share of readers and with twice as many, at a share of four, and alone at a caller's four checkers",
	needs: { dir: Scratch.dir, checkout: Checkout.dir },
	situations: [],
	check:
		({ dir, checkout }) =>
		(read) =>
			Effect.gen(function* () {
				const directory = yield* dir
				const root = yield* checkout
				const made = yield* sharedChecked(root, directory, read)
				assert.ok(
					made.first - made.alone <= made.second - made.first,
					`the first readers make no more types than as many more do: ${made.alone} alone, ${made.first} with the first, ${made.second} with both`
				)
				assert.ok(
					refusedWith(made.counted, "refuses --checkers"),
					`a caller's count of checkers is refused: ${made.counted.printed}`
				)
			}),
	oracle: {
		kind: "universal",
		name: "a law any typecheck that builds each type once obeys: a reader of a shared inferred type pays for its own expression alone, so the first readers make no more types than as many more do"
	},
	kept: [],
	kills: [
		{
			file: "packages/devtools/src/shared/threads.ts",
			original: "\t\tthreadArguments: () => []\n\t}\n} as const",
			replacement: `\t\tthreadArguments: (threads) => ["--checkers", \`\${threads}\`]\n\t}\n} as const`,
			why: "tsrs is handed a checker for each thread of its share, as it was: each of the four checkers that holds a reader builds the shared type again, so the first readers make about 3,600 types more than the next (qti-pie's ledger at 64: 15.3 GB where one checker takes 1.3); the property fails both ways of reading."
		},
		{
			file: "packages/devtools/src/shared/threads.ts",
			original: '\t\tleading: ["tsrs", ...ONE_CHECKER],\n',
			replacement: '\t\tleading: ["tsrs"],\n',
			why: "tsrs is left at its default of four checkers, TypeScript's, which builds the shared type in each of them; the property fails both ways of reading."
		},
		{
			file: "packages/devtools/src/tool-typecheck.ts",
			original: '\t[\n\t\t"--checkers",\n',
			replacement: '\t[\n\t\t"--no-such-argument",\n',
			why: "A caller's --checkers passes through after the wrapper's one checker, and tsrs takes the last, so a script could hand a program four checkers again; the property fails both ways of reading."
		}
	]
})
