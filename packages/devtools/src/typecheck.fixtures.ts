import { assert, defined } from "@bjornpagen/testing/assert"
import { element, finite } from "@bjornpagen/testing/gen"
import { allowanceVariable } from "@bjornpagen/testing/workers"
import {
	Array as Arr,
	Effect,
	FileSystem,
	Option,
	Path,
	Schema,
	Stream,
	String as Str
} from "effect"
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
 * tree is what the case runs) in `directory` with `args` and the variables `env` beside this process's, its tool,
 * effect-tsgo, from the checkout's root, and the node that runs this process on the PATH for the tool's own `env node`.
 */
const typechecked = (
	packageRoot: string,
	directory: string,
	args: ReadonlyArray<string>,
	env: Readonly<Record<string, string>>
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const path = yield* Path.Path
			const handle = yield* ChildProcess.make(
				process.execPath,
				[`${packageRoot}/src/tool-typecheck.ts`, ...args],
				{
					cwd: directory,
					env: {
						...env,
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
		const first = yield* typechecked(packageRoot, directory, args, {})
		yield* fs.writeFileString(`${directory}/read.ts`, UNUSED)
		const second = yield* typechecked(packageRoot, directory, args, {})
		const built = yield* typechecked(packageRoot, directory, ["-b"], {})
		return { first, second, built }
	})

/** Whether a run refused, naming `needle` in what it printed. */
export const refusedWith = (checked: Checked, needle: string): boolean =>
	checked.status !== 0 && Str.includes(needle)(checked.printed)

/**
 * What the one-checker property (typecheck.test.ts aSharedTypeIsBuiltOnce) draws and runs: a program whose cost is one
 * shared inferred type, the type of a function's return in shared.ts that no declaration states, built by a chain of
 * generic calls each adding a member (SHARED_STEPS of them), as a level of a schema is built over the one below it, and
 * modules that each read one member of it, the way a reader reads it: through an alias of the function's return type,
 * as qti-pie's ledger reads its Delivery level (`ReturnType<typeof deliveryOf>`), or through the inferred type of the
 * value it is, as a module reads a level built at its top (pantry's QtiLom).
 */
export type SharedRead =
	| "through an alias of its function's return type"
	| "through the value it types"

/** Both reads, one case each. */
export const sharedReads = finite((source): SharedRead =>
	source.draw(
		element([
			"through an alias of its function's return type",
			"through the value it types"
		] as const)
	)
)

/**
 * The generic calls that build the shared type, each adding one member: enough that deriving it again outweighs a
 * reader's own expression many times over (about 1,200 types a checker at 100, a reader's own expression one or none).
 */
const SHARED_STEPS = 100

/**
 * The share the case's typecheck runs at, as a gate's unit gives its run (allowanceVariable): four, so a typecheck that
 * took a checker for each thread of its share would check the program with four.
 */
const CASE_SHARE = 4

/**
 * The readers of the case's smaller program, twice its share, and its larger program's twice that: every checker of a
 * typecheck at its share, however it deals out the files, holds a reader of the first half.
 */
const READERS = 2 * CASE_SHARE

/** shared.ts: the chain that builds the shared type, and what its readers import of it. */
const sharedModule = (read: SharedRead): string =>
	Arr.join(
		[
			"const extend = <S, const K extends string>(s: S, k: K): S & { readonly [P in K]: P } =>",
			"	({ ...s, [k]: k }) as S & { readonly [P in K]: P }",
			"export const sharedOf = () => {",
			"	const s0 = {}",
			...Arr.makeBy(SHARED_STEPS, (i) => `\tconst s${i + 1} = extend(s${i}, "k${i}")`),
			`\treturn s${SHARED_STEPS}`,
			"}",
			read === "through an alias of its function's return type"
				? "export type Shared = ReturnType<typeof sharedOf>"
				: "export const shared = sharedOf()",
			""
		],
		"\n"
	)

/** Reader i: a module reading member i of the shared type (round the members). */
const readerModule = (read: SharedRead, i: number): string =>
	read === "through an alias of its function's return type"
		? `import type { Shared } from "./shared.ts"\nexport const read${i} = (s: Shared) => s.k${i % SHARED_STEPS}\n`
		: `import { shared } from "./shared.ts"\nexport const read${i} = shared.k${i % SHARED_STEPS}\n`

/** The label of the line --extendedDiagnostics prints the types a check made on: "Types:  1912". */
const TYPES_LABEL = "Types:"

/** The count a line of the extended diagnostics states, where it is the types' line. */
const typesOn = (line: string): Option.Option<number> => {
	const trimmed = Str.trim(line)
	return Str.startsWith(TYPES_LABEL)(trimmed)
		? Option.some(Number(Str.trim(Str.slice(TYPES_LABEL.length)(trimmed))))
		: Option.none()
}

/**
 * The types toolchain-typecheck's check of shared.ts and `readers` readers made, its memory in types, as
 * --extendedDiagnostics counts them over every checker: the program written into `directory`, emptied first, and
 * checked at the case's share. A check that fails, or that prints no count, fails the case.
 */
const typesMade = (packageRoot: string, directory: string, read: SharedRead, readers: number) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem
		yield* fs.remove(directory, { recursive: true, force: true })
		yield* fs.makeDirectory(directory, { recursive: true })
		const tsconfig = yield* tsconfigOf(packageRoot, "a project")
		yield* Effect.forEach(
			[
				["pnpm-workspace.yaml", "packages: []\n"],
				["tsconfig.json", `${tsconfig}\n`],
				["shared.ts", sharedModule(read)],
				...Array.from({ length: readers }, (_, i) => [`r${i}.ts`, readerModule(read, i)] as const)
			] as const,
			([name, text]) => fs.writeFileString(`${directory}/${name}`, text),
			{ discard: true }
		)
		const checked = yield* typechecked(
			packageRoot,
			directory,
			["--extendedDiagnostics", "--pretty", "false"],
			{
				[allowanceVariable]: `${CASE_SHARE}`
			}
		)
		assert.equal(
			checked.status,
			0,
			`the program of ${readers} readers checks clean: ${checked.printed}`
		)
		const counted = Arr.findFirst(Str.split("\n")(checked.printed), typesOn)
		return defined(Option.getOrUndefined(counted), `a count of types in: ${checked.printed}`)
	})

/**
 * The types the check of shared.ts makes alone, with READERS readers and with twice as many, `read` each way, each
 * program in a directory of its own under `directory`; and what the wrapper answered a caller that asked for four
 * checkers over the program alone.
 */
export const sharedChecked = (packageRoot: string, directory: string, read: SharedRead) =>
	Effect.gen(function* () {
		const alone = yield* typesMade(packageRoot, `${directory}/alone`, read, 0)
		const first = yield* typesMade(packageRoot, `${directory}/first`, read, READERS)
		const second = yield* typesMade(packageRoot, `${directory}/second`, read, 2 * READERS)
		const counted = yield* typechecked(
			packageRoot,
			`${directory}/alone`,
			["--checkers", `${CASE_SHARE}`],
			{}
		)
		return { alone, first, second, counted }
	})
