import { pathToFileURL } from "node:url"
import { Array as Arr, Effect, FileSystem, Option, Schema } from "effect"
import { plantedBudget } from "#planted.fixtures.ts"
import type { RunNeed } from "#property.ts"
import { UNRUN_BUDGET } from "#runner/budgets.fixtures.ts"
import { ModuleClosure } from "#runner/services.ts"

/** The file a planted run need's open appends its process's id to, in the package root its run's workers run in. */
export const OPENED = "opened"

/**
 * Writes into `directory` a package a run can load and gives the directory: a runner config with no services, a module
 * declaring a run need (property.ts RunNeed) whose open appends its process's id to OPENED in the directory it is given
 * and gives that id as its value, and `modules` test modules, each one property whose need reads the run need's value
 * (Need.overRun) and whose every case fails unless that value is the first id OPENED holds. Each module is a module no
 * other worker holds, so the run forks a worker for each. Each import is the file URL this module resolves, as
 * pool.fixtures.ts's planted packages' are; it is written where a case runs, never kept in the checkout.
 */
export const countedRunRoot = (directory: string, modules: number) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const effect = import.meta.resolve("effect")
		yield* fs.writeFileString(
			`${directory}/test.config.ts`,
			Arr.join(
				[
					`import { Layer } from "${effect}"`,
					`import { defineRunner, noMutation } from "${import.meta.resolve("#runner/config.ts")}"`,
					"export default defineRunner({",
					`\tbudget: { kind: "cpu", run: ${String(UNRUN_BUDGET)}, import: ${String(UNRUN_BUDGET)} },`,
					`\tinclude: [${Arr.join(
						Array.from({ length: modules }, (_, at) => `"reads-${at}.test.ts"`),
						", "
					)}],`,
					"\tsmallStack: [],",
					"\tconditions: [],",
					"\tenvironment: [],",
					"\tlayer: Layer.empty,",
					"\tmutation: noMutation",
					"})",
					""
				],
				"\n"
			)
		)
		yield* fs.writeFileString(
			`${directory}/counted.ts`,
			Arr.join(
				[
					`import { Effect, FileSystem, Schema } from "${effect}"`,
					`import { Need, NeedFailed, type RunNeed } from "${import.meta.resolve("#property.ts")}"`,
					"const counted: RunNeed<string> = {",
					'\tkey: "runs.fixtures.ts counted",',
					"\tbudget: 60_000,",
					"\tvalue: Schema.String,",
					"\topen: (directory) =>",
					"\t\tEffect.mapError(",
					"\t\t\tEffect.flatMap(FileSystem.FileSystem, (fs) =>",
					`\t\t\t\tEffect.as(fs.writeFileString(\`\${directory}/${OPENED}\`, \`\${process.pid}\\n\`, { flag: "a" }), String(process.pid))`,
					"\t\t\t),",
					'\t\t\t(error) => NeedFailed.make({ need: "runs.fixtures.ts counted", message: error.message })',
					"\t\t)",
					"}",
					"export const readsCounted = Need.overRun(counted, {",
					'\tkey: "runs.fixtures.ts reads counted",',
					"\tbudget: 60_000,",
					"\topen: (value) => Effect.succeed(Effect.succeed(value))",
					"})",
					""
				],
				"\n"
			)
		)
		yield* Effect.forEach(
			Array.from({ length: modules }, (_, at) => at),
			(at) =>
				fs.writeFileString(
					`${directory}/reads-${at}.test.ts`,
					Arr.join(
						[
							`import { Effect, FileSystem, String as Str } from "${effect}"`,
							`import { finite, int } from "${import.meta.resolve("#gen.ts")}"`,
							`import { property } from "${import.meta.resolve("#property.ts")}"`,
							'import { readsCounted } from "./counted.ts"',
							"export const reads = property.exhaust(finite(int(0, 1)), {",
							'\tbox: "two values",',
							"\tneeds: { counted: readsCounted },",
							"\tsituations: [],",
							"\tcheck: ({ counted }) => () =>",
							"\t\tEffect.gen(function* () {",
							"\t\t\tconst value = yield* counted",
							"\t\t\tconst fs = yield* FileSystem.FileSystem",
							`\t\t\tconst first = Str.split(yield* fs.readFileString(\`\${import.meta.dirname}/${OPENED}\`), "\\n")[0]`,
							"\t\t\tif (value !== first) {",
							`\t\t\t\treturn yield* Effect.fail(\`the run need's value \${value} is not the first open's \${String(first)}\`)`,
							"\t\t\t}",
							"\t\t}),",
							'\toracle: { kind: "specification", name: "a property planted to read a run need\'s value" },',
							"\tkept: [],",
							"\tkills: []",
							"})",
							""
						],
						"\n"
					)
				),
			{ discard: true }
		)
		return directory
	})

/**
 * Writes into `directory` a workspace (its lockfile, which marks it) whose module `entry.ts` imports a chain of `depth`
 * modules, `link-1.ts` to `link-<depth>.ts`, each importing the next, the last giving `value`: the program a skipping
 * run need's open digests the closure of (skipping), the last link rewritten between runs (lastLinkOf) to change the
 * closure with every other file unchanged.
 */
export const closureWorkspaceIn = (directory: string, depth: number, value: number) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		yield* fs.writeFileString(`${directory}/pnpm-lock.yaml`, "lockfileVersion: '9.0'\n")
		yield* fs.writeFileString(
			`${directory}/package.json`,
			'{ "name": "closure", "type": "module" }\n'
		)
		yield* fs.writeFileString(
			`${directory}/entry.ts`,
			'import { link } from "./link-1.ts"\n\nexport const entry = link\n'
		)
		for (let at = 1; at < depth; at += 1) {
			yield* fs.writeFileString(
				`${directory}/link-${at}.ts`,
				`import { link as next } from "./link-${at + 1}.ts"\n\nexport const link = next\n`
			)
		}
		yield* fs.writeFileString(lastLinkOf(directory, depth), `export const link = ${value}\n`)
	})

/** The last module of a closure workspace's chain of `depth` (closureWorkspaceIn), the one a case rewrites. */
export const lastLinkOf = (directory: string, depth: number): string =>
	`${directory}/link-${depth}.ts`

/** What a skipping run need's open did: ran its body, or skipped it, the closure's digest what it recorded. */
const Did = Schema.Literals(["ran", "skipped"])

/**
 * A run need that makes what `entry.ts`'s closure determines once a closure: its open digests the closure
 * (ModuleClosure hashOf), skips its body where `recorded` holds that digest, and otherwise records it, as a compile of a
 * program's sources would before compiling them.
 */
export const skipping: RunNeed<typeof Did.Type> = {
	key: "runs.fixtures.ts skipping",
	budget: plantedBudget,
	value: Did,
	open: (directory) =>
		Effect.gen(function* () {
			const fs = yield* FileSystem.FileSystem
			const closures = yield* ModuleClosure
			const digest = yield* closures.hashOf(pathToFileURL(`${directory}/entry.ts`).href)
			const recorded = yield* Effect.option(fs.readFileString(`${directory}/recorded`))
			if (Option.contains(recorded, digest)) {
				return "skipped"
			}
			yield* Effect.orDie(fs.writeFileString(`${directory}/recorded`, digest))
			return "ran"
		})
}
