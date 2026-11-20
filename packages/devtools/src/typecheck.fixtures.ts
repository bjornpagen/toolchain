import { element, finite } from "@bjornpagen/testing/gen"
import { Effect, FileSystem, Path, Schema, Stream, String as Str } from "effect"
import { ChildProcess } from "effect/process"

/**
 * What the stateless-typecheck property (typecheck.test.ts) draws and runs: a project in a workspace of the case's own
 * that toolchain-typecheck checks twice in one directory, as a package's typecheck runs again after an edit. The first
 * version of its checked file uses the type it imports; the second drops that use and exports a value whose inferred
 * type, from another module, names the type, which TypeScript 7.1.0-beta's incremental check passes over the first
 * version's build info, where a check from scratch refuses the unused import (TS6196; METIS-BOOT, 2026-11-20, metis
 * 1b93823's scripts/typecheck-stateless.ts).
 */

/**
 * A project the property checks: one that is no composite project, which the shared base makes incremental no more,
 * and a composite one, whose declarations go to types/ and whose build info TypeScript keeps whatever it is told.
 */
export type Project = "a project" | "a composite project"

/** Both projects, one case each. */
export const projects = finite((source): Project =>
	source.draw(element(["a project", "a composite project"] as const))
)

/** The type the checked file imports. */
const POINT = "export type Point = { x: number }\n"

/** A module whose export's inferred type names Point. */
const READER =
	'import type { Point } from "./point.ts"\nexport const reader = () => (point: Point): number => point.x\n'

/** The checked file's first version, which uses the type it imports. */
const USING =
	'import type { Point } from "./point.ts"\nexport const read = (point: Point): number => point.x\n'

/** Its second, whose import's last use is gone and whose export's inferred type, from `reader`, names the type. */
const UNUSED =
	'import type { Point } from "./point.ts"\nimport { reader } from "./reader.ts"\nexport const read = reader()\n'

/** A project's tsconfig as the property writes it. */
const Tsconfig = Schema.Struct({
	extends: Schema.String,
	compilerOptions: Schema.Record(
		Schema.String,
		Schema.Union([Schema.Boolean, Schema.String, Schema.Array(Schema.String)])
	),
	include: Schema.Array(Schema.String)
})

/** A tsconfig as JSON text. */
const tsconfigText = Schema.encodeEffect(Schema.fromJsonString(Tsconfig))

/**
 * The tsconfig of `project`, over the shared base of the dev tools in the checkout `packageRoot`: no ambient types,
 * since the workspace installs none, and no plugin; a composite project emits its declarations to types/ and keeps its
 * build info beside them, as grizzle's packages do.
 */
const tsconfigOf = (packageRoot: string, project: Project) =>
	tsconfigText({
		extends: `${packageRoot}/tsconfig.base.json`,
		compilerOptions: {
			types: [],
			plugins: [],
			...(project === "a composite project"
				? {
						composite: true,
						noEmit: false,
						emitDeclarationOnly: true,
						outDir: "types",
						tsBuildInfoFile: "types/tsconfig.tsbuildinfo"
					}
				: {})
		},
		include: ["*.ts"]
	})

/** What a run of toolchain-typecheck answered: its exit status and everything it printed. */
export type Checked = Readonly<{ status: number; printed: string }>

/**
 * Runs toolchain-typecheck from the checkout `packageRoot` (Checkout.dir, so a mutant of the dev tools in a worker
 * tree is what the case runs) in `directory` with `args`, its tool, effect-tsgo, from the checkout's root, and the node
 * that runs this process on the PATH for the tool's own `env node`.
 */
const typechecked = (packageRoot: string, directory: string, args: ReadonlyArray<string>) =>
	Effect.scoped(
		Effect.gen(function* () {
			const path = yield* Path.Path
			const handle = yield* ChildProcess.make(
				process.execPath,
				[`${packageRoot}/src/tool-typecheck.ts`, ...args],
				{
					cwd: directory,
					env: {
						PATH: `${packageRoot}/../../node_modules/.bin:${path.dirname(process.execPath)}:/usr/bin:/bin`
					},
					extendEnv: true,
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe"
				}
			)
			const [stdout, stderr, status] = yield* Effect.all(
				[
					Stream.mkString(Stream.decodeText(handle.stdout)),
					Stream.mkString(Stream.decodeText(handle.stderr)),
					handle.exitCode
				],
				{ concurrency: "unbounded" }
			)
			return { status: Number(status), printed: `${stdout}${stderr}` } satisfies Checked
		})
	)

/**
 * `project` in a workspace under `directory`, checked by toolchain-typecheck as its package's typecheck checks it, at its
 * first version and then its second, in that directory, and in build mode last: what each run answered.
 */
export const checkedTwice = (packageRoot: string, directory: string, project: Project) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		const args = project === "a composite project" ? ["-p", "tsconfig.json"] : []
		const tsconfig = yield* tsconfigOf(packageRoot, project)
		yield* Effect.forEach(
			[
				["pnpm-workspace.yaml", "packages: []\n"],
				["tsconfig.json", `${tsconfig}\n`],
				["point.ts", POINT],
				["reader.ts", READER],
				["read.ts", USING]
			] as const,
			([name, text]) => fs.writeFileString(`${directory}/${name}`, text),
			{ discard: true }
		)
		const first = yield* typechecked(packageRoot, directory, args)
		yield* fs.writeFileString(`${directory}/read.ts`, UNUSED)
		const second = yield* typechecked(packageRoot, directory, args)
		const built = yield* typechecked(packageRoot, directory, ["-b"])
		return { first, second, built }
	})

/** Whether a run refused, naming `needle` in what it printed. */
export const refusedWith = (checked: Checked, needle: string): boolean =>
	checked.status !== 0 && Str.includes(needle)(checked.printed)
