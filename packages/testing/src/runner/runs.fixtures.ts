import { Array as Arr, Effect, FileSystem } from "effect"

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
					`\tinclude: [${Arr.join(
						Array.from({ length: modules }, (_, at) => `"reads-${at}.test.ts"`),
						", "
					)}],`,
					"\tsmallStack: [],",
					"\tconditions: [],",
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
